// Conciliação periódica com o provedor (contrato 5.1 item 5) e expiração ativa do pedido (3.4).
// O webhook é o caminho rápido; esta varredura é a rede de segurança: a fila do Asaas pausa após
// 15 falhas seguidas e apaga eventos com mais de 14 dias, então não dá para depender só dela.
import { withTx, recordTransition, type Tx } from '../db.js'
import { applyObservation } from './events.js'
import { ProviderError } from '../providers/types.js'
import type { Ctx } from '../context.js'

export type SweepConfig = { batch: number; expiryGraceMs: number; recentReceivedMs: number }
export const defaultSweep: SweepConfig = { batch: 200, expiryGraceMs: 30_000, recentReceivedMs: 2 * 86_400_000 }

/** Cobranças que ainda podem mudar no provedor ($1 = corte de "recebida há pouco"). Única fonte da regra:
 *  usada pela varredura e pela decisão do worker de ficar ocioso. */
const WATCH_WHERE = `c.creation_state='created' AND c.provider_payment_id IS NOT NULL AND (
              c.observed_state IN ('created','overdue','confirmed')
           OR (c.observed_state IN ('received','partially_refunded') AND c.updated_at > $1)
           OR EXISTS (SELECT 1 FROM refund_cases rc WHERE rc.order_id=o.id AND rc.state IN ('requested','submitting','unknown')))
          AND o.status <> 'expired' AND o.hold_reason IS DISTINCT FROM 'provider_charge_missing'`

/**
 * Ainda há o que conciliar sem aviso nosso? Pedido aguardando pagamento (pode vencer) ou cobrança
 * observável. Sem isso, a varredura não tem trabalho e o worker pode ficar ocioso (zero consultas).
 */
export async function sweepNeeded(ctx: Ctx, cfg: SweepConfig = defaultSweep): Promise<boolean> {
  const r = await ctx.db.query(
    `SELECT EXISTS (SELECT 1 FROM orders WHERE status='awaiting_payment' AND hold_reason IS NULL)
         OR EXISTS (SELECT 1 FROM pix_charges c JOIN orders o ON o.id=c.order_id WHERE ${WATCH_WHERE}) AS need`,
    [new Date(ctx.now().getTime() - cfg.recentReceivedMs)])
  return r.rows[0].need === true
}

/** Enfileira sem duplicar: não cria job se já existe um pendente para a mesma entidade. */
async function enqueueOnce(tx: Tx, topic: string, entityId: string) {
  await tx.query(
    `INSERT INTO outbox (topic, entity_id, payload) SELECT $1,$2,'{}'
      WHERE NOT EXISTS (SELECT 1 FROM outbox WHERE topic=$1 AND entity_id=$2 AND done_at IS NULL)`, [topic, entityId])
}

/**
 * Uma rodada: escolhe cobranças que ainda podem mudar (pendentes, recebidas há pouco, com devolução aberta)
 * e pedidos vencidos, e enfileira a observação/expiração. Seguro com várias instâncias (dedupe na outbox).
 */
export async function sweep(ctx: Ctx, cfg: SweepConfig = defaultSweep): Promise<{ observe: number; expire: number }> {
  return withTx(ctx.db, async tx => {
    const due = (await tx.query(
      `SELECT o.id FROM orders o WHERE o.status='awaiting_payment' AND o.hold_reason IS NULL AND o.expires_at < $1 ORDER BY o.expires_at LIMIT $2`,
      [new Date(ctx.now().getTime() - cfg.expiryGraceMs), cfg.batch])).rows
    for (const r of due) await enqueueOnce(tx, 'expire_order', r.id)
    const watch = (await tx.query(
      `SELECT c.id FROM pix_charges c JOIN orders o ON o.id=c.order_id
        WHERE ${WATCH_WHERE}
        ORDER BY c.last_observed_at NULLS FIRST LIMIT $2`,
      [new Date(ctx.now().getTime() - cfg.recentReceivedMs), cfg.batch])).rows
    for (const r of watch) await enqueueOnce(tx, 'observe_charge', r.id)
    return { observe: watch.length, expire: due.length }
  })
}

/**
 * Job observe_charge: consulta o provedor e aplica. Se o estado mudou sem nenhum webhook desde a última
 * observação, registra falha de vida do webhook (alerta em /internal/diagnostics).
 */
export async function observeCharge(ctx: Ctx, chargeId: string) {
  const c = (await ctx.db.query(`SELECT id, provider_payment_id, observed_state, last_observed_at, updated_at, created_at FROM pix_charges WHERE id=$1`, [chargeId])).rows[0]
  if (!c?.provider_payment_id) return
  let p
  try { p = await ctx.provider.getPayment(c.provider_payment_id) } catch (e) {
    if (e instanceof ProviderError && e.status === 404) return holdMissing(ctx, chargeId, e.message)
    throw e
  }
  await withTx(ctx.db, async tx => {
    const before = (await tx.query(`SELECT observed_state FROM pix_charges WHERE id=$1 FOR UPDATE`, [chargeId])).rows[0].observed_state
    await applyObservation(tx, ctx, p, 'sweep')
    const after = (await tx.query(`SELECT observed_state FROM pix_charges WHERE id=$1`, [chargeId])).rows[0].observed_state
    if (after !== before) {
      const since = c.last_observed_at ?? c.created_at
      const hooks = (await tx.query(`SELECT count(*)::int AS n FROM provider_events WHERE provider_payment_id=$1 AND received_at >= $2`, [c.provider_payment_id, since])).rows[0].n
      if (hooks === 0) await recordTransition(tx, 'webhook_liveness', chargeId, before, 'missed', 'sweep', `provedor mostra ${p.rawStatus} e nenhum webhook chegou desde ${new Date(since).toISOString()}`)
    }
    await tx.query(`UPDATE pix_charges SET last_observed_at=now() WHERE id=$1`, [chargeId])
  })
}

async function holdMissing(ctx: Ctx, chargeId: string, detail: string) {
  await withTx(ctx.db, async tx => {
    const o = (await tx.query(`SELECT o.id FROM orders o JOIN pix_charges c ON c.order_id=o.id WHERE c.id=$1 FOR UPDATE OF o`, [chargeId])).rows[0]
    const r = await tx.query(`UPDATE orders SET hold_reason='provider_charge_missing', updated_at=now() WHERE id=$1 AND hold_reason IS NULL`, [o.id])
    if (r.rowCount) await recordTransition(tx, 'order_hold', o.id, null, 'provider_charge_missing', 'sweep', detail)
  })
}

/**
 * Job expire_order: pede ao provedor para excluir a cobrança vencida e só então marca o pedido expirado.
 * Se o provedor recusar porque já foi paga (corrida no limite do prazo), observa e aplica a regra de prazo.
 */
export async function expireOrder(ctx: Ctx, orderId: string) {
  const o = (await ctx.db.query(`SELECT o.status, o.hold_reason, o.expires_at, c.id AS charge_id, c.provider_payment_id FROM orders o JOIN pix_charges c ON c.order_id=o.id WHERE o.id=$1`, [orderId])).rows[0]
  if (!o || o.status !== 'awaiting_payment' || o.hold_reason) return
  if (new Date(o.expires_at).getTime() > ctx.now().getTime()) return
  let deleteError: string | null = null
  try { await ctx.provider.deleteCharge(o.provider_payment_id) } catch (e) {
    if (e instanceof ProviderError && e.outcomeUnknown) throw e // não sabemos: o job tenta de novo
    deleteError = (e as Error).message // ex.: já paga; a observação abaixo decide
  }
  let p
  try { p = await ctx.provider.getPayment(o.provider_payment_id) } catch (e) {
    // Cobrança sumiu do provedor: não dá para provar pagamento nem exclusão. Retém para revisão, com motivo.
    if (e instanceof ProviderError && e.status === 404) return holdMissing(ctx, o.charge_id, e.message)
    throw e
  }
  await withTx(ctx.db, async tx => {
    await applyObservation(tx, ctx, p, 'expire')
    const cur = (await tx.query(`SELECT status FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0]
    if (cur.status === 'awaiting_payment' && p.status === 'DELETED') {
      await tx.query(`UPDATE orders SET status='expired', updated_at=now() WHERE id=$1`, [orderId])
      await recordTransition(tx, 'order', orderId, 'awaiting_payment', 'expired', 'expire', 'cobrança excluída no provedor')
    } else if (cur.status === 'awaiting_payment') {
      // O provedor não confirmou a exclusão e não há pagamento: fica aguardando a próxima rodada, com motivo.
      await recordTransition(tx, 'expire_attempt', orderId, null, 'pending', 'expire', `provedor em ${p.rawStatus}${deleteError ? `; exclusão: ${deleteError}` : ''}`)
    }
  })
}
