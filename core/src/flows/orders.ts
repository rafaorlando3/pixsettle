// Criação de pedido e cobrança (contrato 3.1). Timeout na criação nunca gera segunda cobrança.
import { withTx, recordTransition, enqueue, type Tx } from '../db.js'
import { newId } from '../ids.js'
import { ProviderError } from '../providers/types.js'
import type { Ctx } from '../context.js'

export type CreateOrderInput = { externalRef: string; amountMinor: bigint; description: string }

export async function createOrder(ctx: Ctx, merchantId: string, input: CreateOrderInput) {
  if (input.amountMinor <= 0n) throw new DomainError('invalid_amount', 'valor deve ser positivo')
  const now = ctx.now()
  const orderId = newId('ord'), chargeId = newId('chg'), quoteId = newId('quo')
  await withTx(ctx.db, async tx => {
    await tx.query(
      `INSERT INTO orders (id, merchant_id, external_ref, description, amount_minor, status, expires_at, provider_env, chain_env)
       VALUES ($1,$2,$3,$4,$5,'created',$6,$7,'testnet')`,
      [orderId, merchantId, input.externalRef, input.description, input.amountMinor.toString(), new Date(now.getTime() + ctx.cfg.orderTtlMs), ctx.provider.env],
    )
    await tx.query(
      `INSERT INTO quotes (id, order_id, rate_num, rate_den, source, valid_until) VALUES ($1,$2,$3,$4,'simulated',$5)`,
      [quoteId, orderId, ctx.cfg.simRateNum.toString(), ctx.cfg.simRateDen.toString(), new Date(now.getTime() + ctx.cfg.quoteTtlMs)],
    )
    await tx.query(
      `INSERT INTO pix_charges (id, order_id, provider, creation_state, amount_minor) VALUES ($1,$2,$3,'creating',$4)`,
      [chargeId, orderId, ctx.provider.name, input.amountMinor.toString()],
    )
    await recordTransition(tx, 'order', orderId, null, 'created', 'api')
    await recordTransition(tx, 'charge_creation', chargeId, null, 'creating', 'api')
  }).catch(e => {
    if ((e as { code?: string }).code === '23505') throw new DomainError('duplicate_external_ref', 'external_ref já usado por este lojista')
    throw e
  })

  const dueDate = new Date(now.getTime() + ctx.cfg.orderTtlMs).toISOString().slice(0, 10)
  try {
    const created = await ctx.provider.createCharge({ orderId, amountMinor: input.amountMinor, description: input.description, dueDate })
    await withTx(ctx.db, async tx => {
      await markCreated(tx, chargeId, orderId, created.paymentId, created.qrPayload, created.qrExpiresAt, 'provider_response')
    })
  } catch (e) {
    if (e instanceof ProviderError && e.outcomeUnknown) {
      await withTx(ctx.db, async tx => {
        await tx.query(`UPDATE pix_charges SET creation_state='creation_unknown', last_provider_error=$2, updated_at=now() WHERE id=$1`, [chargeId, JSON.stringify({ code: e.code, message: e.message })])
        await recordTransition(tx, 'charge_creation', chargeId, 'creating', 'creation_unknown', 'provider_timeout', e.message)
        await enqueue(tx, 'reconcile_charge_creation', chargeId)
      })
    } else {
      const pe = e instanceof ProviderError ? e : null
      await withTx(ctx.db, async tx => {
        await tx.query(`UPDATE pix_charges SET creation_state='creation_failed', last_provider_status=$2, last_provider_error=$3, updated_at=now() WHERE id=$1`,
          [chargeId, pe?.status ?? null, JSON.stringify({ code: pe?.code ?? 'error', message: (e as Error).message, body: pe?.body ?? null })])
        await recordTransition(tx, 'charge_creation', chargeId, 'creating', 'creation_failed', 'provider_error', (e as Error).message)
      })
    }
  }
  return orderId
}

async function markCreated(tx: Tx, chargeId: string, orderId: string, paymentId: string, qr: string, qrExpiresAt: Date, source: string) {
  const r = await tx.query(`SELECT creation_state FROM pix_charges WHERE id=$1 FOR UPDATE`, [chargeId])
  const from = r.rows[0].creation_state as string
  if (from === 'created') return
  await tx.query(
    `UPDATE pix_charges SET creation_state='created', observed_state='created', provider_payment_id=$2, qr_payload=$3, qr_expires_at=$4, updated_at=now() WHERE id=$1`,
    [chargeId, paymentId, qr, qrExpiresAt],
  )
  await recordTransition(tx, 'charge_creation', chargeId, from, 'created', source)
  const o = await tx.query(`SELECT status FROM orders WHERE id=$1 FOR UPDATE`, [orderId])
  if (o.rows[0].status === 'created') {
    // O prazo do pedido não passa do vencimento do QR informado pelo provedor.
    await tx.query(`UPDATE orders SET status='awaiting_payment', expires_at=LEAST(expires_at, $2), updated_at=now() WHERE id=$1`, [orderId, qrExpiresAt])
    await recordTransition(tx, 'order', orderId, 'created', 'awaiting_payment', source)
  }
}

/** Conciliação da criação desconhecida (contrato 3.1): busca vazia não prova falha. */
export async function reconcileChargeCreation(ctx: Ctx, chargeId: string) {
  const c = (await ctx.db.query(`SELECT order_id, creation_state FROM pix_charges WHERE id=$1`, [chargeId])).rows[0]
  if (!c || !['creation_unknown', 'creation_review'].includes(c.creation_state)) return
  const found = await ctx.provider.findByExternalReference(c.order_id)
  // QR real da cobrança encontrada (fora da transação: chamada de rede). Falhou? O job tenta de novo.
  const qr = found.length === 1 ? await ctx.provider.getPixQr(found[0]!.id) : null
  await withTx(ctx.db, async tx => {
    const cur = (await tx.query(`SELECT creation_state FROM pix_charges WHERE id=$1 FOR UPDATE`, [chargeId])).rows[0].creation_state
    if (!['creation_unknown', 'creation_review'].includes(cur)) return
    if (found.length === 1) {
      const p = found[0]!
      await markCreated(tx, chargeId, c.order_id, p.id, qr!.qrPayload, qr!.qrExpiresAt, 'reconcile_creation')
    } else {
      const to = found.length === 0 ? 'creation_review' : 'creation_conflict'
      if (cur === to) return
      await tx.query(`UPDATE pix_charges SET creation_state=$2, updated_at=now() WHERE id=$1`, [chargeId, to])
      await tx.query(`UPDATE orders SET hold_reason=$2, updated_at=now() WHERE id=$1`, [c.order_id, to])
      await recordTransition(tx, 'charge_creation', chargeId, cur, to, 'reconcile_creation', `${found.length} cobrança(s) com externalReference ${c.order_id}`)
    }
  })
}

export class DomainError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 422) { super(message) }
}
