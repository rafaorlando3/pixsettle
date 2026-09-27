// P2: devoluções (contrato 3.3, 3.4, 3.6, 6 e 7). Pix simulado, cadeia falsa, PostgreSQL real.
import { describe, it, expect, afterEach } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { setup, settleAll, deliver, asaasEvent, counts } from './helpers.js'
import { createOrder } from '../src/flows/orders.js'
import { requestRefund } from '../src/flows/refunds.js'
import { drain } from '../src/outbox.js'
import { buildApp } from '../src/app.js'
import { newId } from '../src/ids.js'
import { signReceipt, verifyEnvelope } from '../../settlement/src/receipt.js'
import { privateKeyToAccount } from 'viem/accounts'

const ISSUER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const // chave pública de TESTE
const ISSUER = privateKeyToAccount(ISSUER_KEY).address

let env: Awaited<ReturnType<typeof setup>>
afterEach(async () => { await env?.drop() })

async function start() {
  env = await setup()
  env.ctx.cfg.issuer = { id: 'pixsettle-test', address: ISSUER }
  env.chain.signReceipt = (payload: any) => signReceipt(payload, ISSUER_KEY)
}
async function order(amount = 10090n, opts: { payAt?: Date } = {}) {
  const orderId = await createOrder(env.ctx, env.merchantId, { externalRef: 'r-' + randomUUID(), amountMinor: amount, description: 't' })
  const ch = (await env.db.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [orderId])).rows[0]
  env.provider.pay(ch.provider_payment_id, opts.payAt ? { at: opts.payAt } : {})
  await deliver(env.ctx, asaasEvent('evt_' + orderId, 'PAYMENT_RECEIVED', ch.provider_payment_id, 'RECEIVED'))
  return { orderId, paymentId: ch.provider_payment_id as string }
}
const refundsOf = (orderId: string) => env.db.query(`SELECT refund_type, state, amount_minor::text AS amount FROM refund_cases WHERE order_id=$1 ORDER BY created_at, id`, [orderId]).then(r => r.rows)
const ledger = () => env.db.query(`SELECT kind, sum(amount_units)::text AS v FROM ledger_entries WHERE merchant_id=$1 GROUP BY kind ORDER BY kind`, [env.merchantId]).then(r => Object.fromEntries(r.rows.map(x => [x.kind, x.v])))
const refundReceipts = (orderId: string) => env.db.query(`SELECT id, previous_receipt_id, envelope FROM receipts WHERE order_id=$1 AND receipt_type='refund_notice' ORDER BY created_at, id`, [orderId]).then(r => r.rows)
const merchantRefund = (orderId: string, amount: bigint) => requestRefund(env.ctx, env.merchantId, orderId, { type: 'merchant_refund', amountMinor: amount, source: 'test' })

describe('P2 devoluções', () => {
  it('12. pagamento depois do prazo: abre caso, devolve, confirma só observando; recibo sem transação on-chain', async () => {
    await start()
    const orderId = await createOrder(env.ctx, env.merchantId, { externalRef: 'tardio', amountMinor: 5000n, description: 't' })
    const o = (await env.db.query(`SELECT expires_at FROM orders WHERE id=$1`, [orderId])).rows[0]
    const ch = (await env.db.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [orderId])).rows[0]
    env.provider.pay(ch.provider_payment_id, { at: new Date(new Date(o.expires_at).getTime() + 60_000) })
    await deliver(env.ctx, asaasEvent('evt_late', 'PAYMENT_RECEIVED', ch.provider_payment_id, 'RECEIVED'))
    await drain(env.ctx, 5, ['process_provider_event'])
    expect(await refundsOf(orderId)).toEqual([{ refund_type: 'late_payment_refund', state: 'requested', amount: '5000' }])
    await settleAll(env.ctx, env.chain)
    expect(await refundsOf(orderId)).toEqual([{ refund_type: 'late_payment_refund', state: 'confirmed', amount: '5000' }])
    const c = await counts(env.db, orderId)
    expect(c.order.status).toBe('late_paid')
    expect(c.settlements).toHaveLength(0)
    expect(env.chain.mined).toHaveLength(0)
    const [r] = await refundReceipts(orderId)
    expect(r.envelope.payload.settlement_ref).toBeUndefined()
    expect(JSON.stringify(r.envelope)).not.toContain('tx_hash')
    expect(await verifyEnvelope(r.envelope, [ISSUER])).toEqual({ ok: true, recovered: ISSUER })
  })

  it('12b. estorno com liquidação ainda em intent_recorded: não assina, registra o motivo e encerra a liquidação', async () => {
    await start()
    const { orderId } = await order()
    await drain(env.ctx, 5, ['process_provider_event'])
    expect((await merchantRefund(orderId, 1000n))).toMatchObject({ ok: false, code: 'partial_before_settlement' })
    expect(await merchantRefund(orderId, 10090n)).toMatchObject({ ok: true })
    await settleAll(env.ctx, env.chain)
    const c = await counts(env.db, orderId)
    expect(c.attempts).toHaveLength(0)
    expect(env.chain.signCalls).toBe(0)
    expect(env.chain.mined).toHaveLength(0)
    expect(c.settlements[0]).toMatchObject({ status: 'failed', hold_reason: 'refunded_before_settlement' })
    expect(c.order.status).toBe('refunded')
    const blocked = (await env.db.query(`SELECT reason FROM state_transitions WHERE entity='settlement_blocked'`)).rows
    expect(blocked[0].reason).toMatch(/refund_case:rfc_.*:requested/)
    expect((await env.db.query(`SELECT to_state FROM state_transitions WHERE entity='refund_blocked' AND entity_id=$1`, [orderId])).rows.map(r => r.to_state)).toEqual(['partial_before_settlement'])
  })

  it('13. estorno com liquidação em unknown ou manual_review: bloqueado com motivo registrado', async () => {
    await start()
    const { orderId } = await order()
    env.chain.failNextBroadcast = 'timeout_before_accept'
    await drain(env.ctx, 20, ['process_provider_event', 'settle', 'sign_attempt', 'broadcast_attempt'])
    expect((await counts(env.db, orderId)).attempts[0].status).toBe('unknown')
    const r = await merchantRefund(orderId, 10090n)
    expect(r).toMatchObject({ ok: false, code: 'settlement_in_flight' })
    const t = (await env.db.query(`SELECT to_state, reason FROM state_transitions WHERE entity='refund_blocked' AND entity_id=$1`, [orderId])).rows
    expect(t[0].reason).toMatch(/em unknown/)
    expect(await refundsOf(orderId)).toEqual([])
  })

  it('MED simulado depois de liquidar: a reserva contábil cobre o que pode, o resto vira dívida simulada; recibos em cadeia', async () => {
    await start()
    const { orderId } = await order() // R$ 100,90 -> bruto 18.262900, reserva 1.826290, líquido 16.436610
    await settleAll(env.ctx, env.chain)
    expect((await counts(env.db, orderId)).order.status).toBe('settled')
    // Devolução parcial do lojista: R$ 10,00 -> exposição 1.810000, coberta pela reserva.
    expect(await merchantRefund(orderId, 1000n)).toMatchObject({ ok: true })
    await settleAll(env.ctx, env.chain)
    expect(await ledger()).toEqual({ reserve_consumed_simulated: '1810000', reserve_simulated: '1826290', settlement_net: '16436610' })
    expect(await merchantRefund(orderId, 9091n)).toMatchObject({ ok: false, code: 'amount_exceeds_refundable' })
    // MED do restante (R$ 90,90 -> 16.452900): reserva restante 16290, dívida 16436610.
    expect(await requestRefund(env.ctx, env.merchantId, orderId, { type: 'med_simulated', amountMinor: 9090n, source: 'test' }).catch(e => e.code)).toBe('simulation_reason_required')
    expect(await requestRefund(env.ctx, env.merchantId, orderId, { type: 'med_simulated', amountMinor: 9090n, simulationReason: 'demo: pagador abriu MED (simulado)', source: 'test' })).toMatchObject({ ok: true })
    await settleAll(env.ctx, env.chain)
    expect(await refundsOf(orderId)).toEqual([
      { refund_type: 'merchant_refund', state: 'confirmed', amount: '1000' },
      { refund_type: 'med_simulated', state: 'confirmed', amount: '9090' },
    ])
    expect(await ledger()).toEqual({ debt_simulated: '16436610', reserve_consumed_simulated: '1826290', reserve_simulated: '1826290', settlement_net: '16436610' })
    expect(env.chain.mined).toHaveLength(1) // devolução nunca gera transferência on-chain nesta versão
    const stl = (await env.db.query(`SELECT id FROM receipts WHERE order_id=$1 AND receipt_type='settlement'`, [orderId])).rows[0]
    const [r1, r2] = await refundReceipts(orderId)
    expect(r1.previous_receipt_id).toBe(stl.id)
    expect(r2.previous_receipt_id).toBe(r1.id)
    expect(r2.envelope.payload.settlement_ref.receipt_id).toBe(stl.id)
    expect(r2.envelope.payload.refund).toMatchObject({ refund_type: 'med_simulated', simulated: true, origin: 'provider_attested' })
    expect(r2.envelope.payload.accounting).toMatchObject({ reserve_consumed_simulated: '16290', debt_simulated: '16436610', simulated: true })
    for (const r of [r1, r2]) expect(await verifyEnvelope(r.envelope, [ISSUER])).toEqual({ ok: true, recovered: ISSUER })
    expect((await env.db.query(`SELECT observed_state FROM pix_charges WHERE order_id=$1`, [orderId])).rows[0].observed_state).toBe('refunded')
  })

  it('estorno feito direto no provedor: nunca descartado; com liquidação em andamento retém e não transmite', async () => {
    await start()
    const a = await order()
    await settleAll(env.ctx, env.chain)
    env.provider.providerRefund(a.paymentId, 2000n)
    await deliver(env.ctx, asaasEvent('evt_ext', 'PAYMENT_PARTIALLY_REFUNDED', a.paymentId, 'PARTIALLY_REFUNDED'))
    await settleAll(env.ctx, env.chain)
    expect(await refundsOf(a.orderId)).toEqual([{ refund_type: 'provider_refund', state: 'confirmed', amount: '2000' }])
    expect((await counts(env.db, a.orderId)).order.hold_reason).toBeNull()

    const b = await order()
    await drain(env.ctx, 20, ['process_provider_event', 'settle', 'sign_attempt']) // assinado, ainda não transmitido
    env.provider.providerRefund(b.paymentId, 10090n)
    await deliver(env.ctx, asaasEvent('evt_ext2', 'PAYMENT_REFUNDED', b.paymentId, 'REFUNDED'))
    await drain(env.ctx, 5, ['process_provider_event']) // o estorno é observado antes da transmissão
    await settleAll(env.ctx, env.chain)
    const c = await counts(env.db, b.orderId)
    expect(c.order.hold_reason).toBe('exposure_reconciliation')
    expect(c.attempts[0].status).toBe('suspended')
    expect(await refundsOf(b.orderId)).toEqual([{ refund_type: 'provider_refund', state: 'unknown', amount: '10090' }])
    expect(env.chain.mined).toHaveLength(1) // só a liquidação do pedido A
  })

  it('resposta do estorno perdida: fica unknown e a conciliação confirma pelo provedor; recusa vira failed com motivo', async () => {
    await start()
    const a = await order()
    await settleAll(env.ctx, env.chain)
    env.provider.failNext = 'refund_timeout_after_commit'
    await merchantRefund(a.orderId, 500n)
    await drain(env.ctx, 5, ['request_refund'])
    expect(await refundsOf(a.orderId)).toEqual([{ refund_type: 'merchant_refund', state: 'unknown', amount: '500' }])
    expect((await merchantRefund(a.orderId, 100n))).toMatchObject({ ok: false, code: 'refund_in_progress' })
    await settleAll(env.ctx, env.chain)
    expect(await refundsOf(a.orderId)).toEqual([{ refund_type: 'merchant_refund', state: 'confirmed', amount: '500' }])
    expect(env.provider.charges.get(a.paymentId)!.refundedMinor).toBe(500n) // um estorno só no provedor

    env.provider.failNext = 'refund_rejected'
    await merchantRefund(a.orderId, 300n)
    await settleAll(env.ctx, env.chain)
    const rows = (await env.db.query(`SELECT state, last_error FROM refund_cases WHERE order_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`, [a.orderId])).rows[0]
    expect(rows.state).toBe('failed')
    expect(rows.last_error.status).toBe(400)
    expect(await merchantRefund(a.orderId, 300n)).toMatchObject({ ok: true }) // caso falho não consome o saldo devolvível
    await settleAll(env.ctx, env.chain) // segunda parcial: o estado observado não muda, mas o valor devolvido sim
    expect((await refundsOf(a.orderId)).map(r => r.state)).toEqual(['confirmed', 'failed', 'confirmed'])
  })

  it('API de devolução: idempotente, isolada por lojista e com erro único', async () => {
    await start()
    const app = buildApp(env.ctx, { asaasWebhookToken: 'tok', diagnosticsToken: 'd' })
    const keyA = 'sk_a_' + randomUUID(), keyB = 'sk_b_' + randomUUID()
    await env.db.query(`UPDATE merchants SET api_key_hash=$2 WHERE id=$1`, [env.merchantId, createHash('sha256').update(keyA).digest('hex')])
    await env.db.query(`INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ($1,'Loja B',$2,'0x000000000000000000000000000000000000dEaD')`, [newId('mer'), createHash('sha256').update(keyB).digest('hex')])
    const { orderId } = await order()
    await settleAll(env.ctx, env.chain)
    const call = (key: string, idem: string, amount = '1000') => app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/refund`, headers: { authorization: `Bearer ${key}`, 'idempotency-key': idem }, payload: { amount: { amount, currency: 'BRL' } } })
    const r1 = await call(keyA, 'rf-1'); expect(r1.statusCode).toBe(202)
    const r2 = await call(keyA, 'rf-1'); expect(r2.json()).toEqual(r1.json())
    expect((await call(keyA, 'rf-1', '999')).statusCode).toBe(409)
    const b = await call(keyB, 'rf-b'); expect(b.statusCode).toBe(404); expect(b.json().error.code).toBe('not_found')
    expect((await call(keyA, 'rf-2', '10')).json().error.code).toBe('refund_in_progress')
    await settleAll(env.ctx, env.chain)
    const o = (await app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: { authorization: `Bearer ${keyA}` } })).json()
    expect(o.refunds.map((r: any) => r.state)).toEqual(['confirmed'])
    expect(o.receipts.map((r: any) => r.receipt_type)).toEqual(['settlement', 'refund_notice'])
    expect(o.timeline.some((t: any) => t.entity === 'refund_accounting')).toBe(true)
  })
})
