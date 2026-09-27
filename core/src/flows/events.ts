// Eventos do provedor (contrato 5.1) e aplicação da observação ao pedido (3.2 a 3.6).
import { withTx, recordTransition, enqueue, type Tx } from '../db.js'
import { newId } from '../ids.js'
import { OBSERVED_RANK, mapObserved, type ProviderPayment } from '../providers/types.js'
import type { Ctx } from '../context.js'
import { onRefundObserved } from './refunds.js'

/** Só o que precisamos do webhook; dados do pagador ficam de fora. */
export function sanitizeAsaasEvent(body: any) {
  const p = body?.payment ?? {}
  return {
    id: String(body?.id ?? ''), event: String(body?.event ?? ''),
    payment: { id: p.id ?? null, status: p.status ?? null, billingType: p.billingType ?? null, value: p.value ?? null, externalReference: p.externalReference ?? null, paymentDate: p.paymentDate ?? null, clientPaymentDate: p.clientPaymentDate ?? null },
  }
}

/** Grava evento, estado e outbox na MESMA transação. Duplicata: 200, e reprocessa se ficou pendente. */
export async function ingestProviderEvent(ctx: Ctx, provider: string, body: any): Promise<{ duplicate: boolean; state: string }> {
  const ev = sanitizeAsaasEvent(body)
  if (!ev.id || !ev.event) throw new Error('evento sem id ou tipo')
  return withTx(ctx.db, async tx => {
    const r = await tx.query(
      `INSERT INTO provider_events (provider, provider_event_id, event_type, provider_payment_id, payload, processing_state)
       VALUES ($1,$2,$3,$4,$5,'received_event')
       ON CONFLICT (provider, provider_event_id) DO UPDATE SET duplicate_count = provider_events.duplicate_count + 1
       RETURNING id, processing_state, (xmax = 0) AS inserted`,
      [provider, ev.id, ev.event, ev.payment.id, JSON.stringify(ev)],
    )
    const row = r.rows[0]
    if (row.inserted || ['received_event', 'error'].includes(row.processing_state)) {
      await enqueue(tx, 'process_provider_event', String(row.id))
    }
    return { duplicate: !row.inserted, state: row.processing_state }
  })
}

export async function processProviderEvent(ctx: Ctx, eventRowId: string) {
  const start = await withTx(ctx.db, async tx => {
    const e = (await tx.query(`SELECT * FROM provider_events WHERE id=$1 FOR UPDATE`, [eventRowId])).rows[0]
    if (!e || ['processed', 'stale'].includes(e.processing_state)) return null
    await tx.query(`UPDATE provider_events SET processing_state='processing', attempts=attempts+1 WHERE id=$1`, [eventRowId])
    return e
  })
  if (!start) return
  ctx.crashAt?.('event_after_mark_processing')
  let payment: ProviderPayment
  try {
    payment = await ctx.provider.getPayment(start.provider_payment_id)
  } catch (err) {
    await ctx.db.query(`UPDATE provider_events SET processing_state='error', last_error=$2 WHERE id=$1`,
      [eventRowId, JSON.stringify({ message: (err as Error).message, status: (err as any).status ?? null, body: (err as any).body ?? null })])
    throw err
  }
  await withTx(ctx.db, async tx => {
    const outcome = await applyObservation(tx, ctx, payment, `event:${start.event_type}`)
    await tx.query(`UPDATE provider_events SET processing_state=$2, processed_at=now(), last_error=NULL WHERE id=$1`,
      [eventRowId, outcome === 'stale' ? 'stale' : 'processed'])
  })
}

/**
 * Aplica o estado CONSULTADO no provedor. Nunca regride. Usado pelo webhook e pela conciliação periódica.
 */
export async function applyObservation(tx: Tx, ctx: Ctx, p: ProviderPayment, source: string): Promise<'applied' | 'stale' | 'unknown_payment'> {
  let charge = (await tx.query(`SELECT * FROM pix_charges WHERE provider_payment_id=$1 FOR UPDATE`, [p.id])).rows[0]
  if (!charge && p.externalReference) {
    const c = (await tx.query(`SELECT * FROM pix_charges WHERE order_id=$1 AND creation_state IN ('creation_unknown','creation_review') FOR UPDATE`, [p.externalReference])).rows[0]
    if (c) {
      await tx.query(`UPDATE pix_charges SET provider_payment_id=$2, creation_state='created', updated_at=now() WHERE id=$1`, [c.id, p.id])
      await recordTransition(tx, 'charge_creation', c.id, c.creation_state, 'created', source, 'cobrança encontrada por evento do provedor')
      charge = { ...c, provider_payment_id: p.id, creation_state: 'created' }
    }
  }
  if (!charge) return 'unknown_payment'
  const order = (await tx.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [charge.order_id])).rows[0]

  const next = mapObserved(p.status)
  const cur = charge.observed_state as string | null
  if (!next) return 'stale'
  if (cur && next !== cur) {
    const regress = (OBSERVED_RANK[next] ?? 0) < (OBSERVED_RANK[cur] ?? 0) || (next === 'deleted' && !['created', 'overdue'].includes(cur))
    if (regress) return 'stale'
  }
  if (next !== cur) {
    await tx.query(`UPDATE pix_charges SET observed_state=$2, last_observed_at=now(), updated_at=now() WHERE id=$1`, [charge.id, next])
    await recordTransition(tx, 'charge_observed', charge.id, cur, next, source)
  } else if (!['received', 'partially_refunded', 'refunded'].includes(next)) {
    // Estorno repetido segue (revisão R7): o valor devolvido pode ter mudado, ou um caso ficou pendente
    // esperando a liquidação concluir. onRefundObserved é idempotente pelo total já confirmado.
    return 'stale'
  }

  if (next === 'received') return onReceived(tx, ctx, order, p, source)
  if (next === 'refunded' || next === 'partially_refunded') {
    return onRefundObserved(tx, ctx, order, p, source, (reason, detail) => hold(tx, order.id, reason, source, detail))
  }
  return 'applied'
}

async function hold(tx: Tx, orderId: string, reason: string, source: string, detail?: string) {
  await tx.query(`UPDATE orders SET hold_reason=$2, updated_at=now() WHERE id=$1`, [orderId, reason])
  await recordTransition(tx, 'order_hold', orderId, null, reason, source, detail)
}

async function onReceived(tx: Tx, ctx: Ctx, order: any, p: ProviderPayment, source: string): Promise<'applied' | 'stale'> {
  if (!['created', 'awaiting_payment', 'expired'].includes(order.status)) return 'stale' // já tratado
  if (order.hold_reason) return 'stale'
  if (p.billingType !== 'PIX') { await hold(tx, order.id, 'billing_type_mismatch', source, p.billingType); return 'applied' }
  if (p.externalReference !== order.id) { await hold(tx, order.id, 'link_mismatch', source, String(p.externalReference)); return 'applied' }
  if (p.valueMinor !== BigInt(order.amount_minor)) { await hold(tx, order.id, 'amount_mismatch', source, `pago ${p.valueMinor}, cobrado ${order.amount_minor}`); return 'applied' }

  const now = ctx.now()
  const expiresAt = new Date(order.expires_at)
  let onTime: boolean | null
  if (p.paidAt) onTime = p.paidAt.getTime() <= expiresAt.getTime()
  else if (now.getTime() <= expiresAt.getTime()) onTime = true // recebido antes deste instante, que ainda está no prazo
  else onTime = null
  if (onTime === null) { await hold(tx, order.id, 'timing_unresolved', source, `provedor informou só a data ${p.paidDate}`); return 'applied' }
  if (!onTime) {
    await tx.query(`UPDATE orders SET status='late_paid', paid_at=$2, updated_at=now() WHERE id=$1`, [order.id, p.paidAt])
    await recordTransition(tx, 'order', order.id, order.status, 'late_paid', source)
    const rfc = newId('rfc')
    await tx.query(`INSERT INTO refund_cases (id, order_id, refund_type, state, amount_minor) VALUES ($1,$2,'late_payment_refund','requested',$3)`, [rfc, order.id, order.amount_minor])
    await recordTransition(tx, 'refund_case', rfc, null, 'requested', source, 'pagamento depois do prazo')
    await enqueue(tx, 'request_refund', rfc)
    return 'applied'
  }
  const q = (await tx.query(`SELECT * FROM quotes WHERE order_id=$1`, [order.id])).rows[0]
  const validUntil = new Date(q.valid_until)
  const quoteOk = p.paidAt ? p.paidAt.getTime() <= validUntil.getTime() : now.getTime() <= validUntil.getTime()
  if (!quoteOk) { await hold(tx, order.id, p.paidAt ? 'quote_expired' : 'quote_timing_unresolved', source); return 'applied' }

  await tx.query(`UPDATE orders SET status='paid', paid_at=$2, updated_at=now() WHERE id=$1`, [order.id, p.paidAt])
  await recordTransition(tx, 'order', order.id, order.status, 'paid', source)
  await createSettlementIntent(tx, ctx, order, q, source)
  return 'applied'
}

export function computeAmounts(amountMinor: bigint, rateNum: bigint, rateDen: bigint, reserveBps: number) {
  const gross = (amountMinor * rateNum) / rateDen // floor
  const reserve = (gross * BigInt(reserveBps)) / 10000n
  const fees = 0n // tarifas simuladas explícitas: zero nesta versão
  const net = gross - reserve - fees
  if (net <= 0n || net + reserve + fees !== gross) throw new Error('identidade contábil violada')
  return { gross, reserve, fees, net }
}

async function createSettlementIntent(tx: Tx, ctx: Ctx, order: any, q: any, source: string) {
  const m = (await tx.query(`SELECT payout_address, reserve_bps FROM merchants WHERE id=$1`, [order.merchant_id])).rows[0]
  const a = computeAmounts(BigInt(order.amount_minor), BigInt(q.rate_num), BigInt(q.rate_den), m.reserve_bps)
  const id = newId('stl')
  const memo = '0x' + Buffer.concat([Buffer.from(id, 'ascii'), Buffer.alloc(32 - id.length)]).toString('hex')
  await tx.query(
    `INSERT INTO settlements (id, order_id, chain_id, token, sender, recipient, amount_units, memo, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'intent_recorded')`,
    [id, order.id, ctx.chain.chainId, ctx.chain.token, ctx.chain.treasury, m.payout_address, a.net.toString(), memo],
  )
  await recordTransition(tx, 'settlement', id, null, 'intent_recorded', source, JSON.stringify({ gross: a.gross.toString(), reserve_simulated: a.reserve.toString(), net: a.net.toString() }))
  await tx.query(`UPDATE orders SET status='settling', updated_at=now() WHERE id=$1`, [order.id])
  await recordTransition(tx, 'order', order.id, 'paid', 'settling', source)
  await enqueue(tx, 'settle', id)
}
