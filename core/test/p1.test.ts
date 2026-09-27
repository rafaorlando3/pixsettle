// Critérios de aceite P1 do contrato v0.3 (seção 9), com PostgreSQL real e cadeia falsa determinística.
import { describe, it, expect, afterEach } from 'vitest'
import { setup, deliver, settleAll, counts, advanceTime, asaasEvent } from './helpers.js'
import { createOrder } from '../src/flows/orders.js'
import { advanceSettlement } from '../src/flows/settle.js'
import { drain } from '../src/outbox.js'
import { CrashError } from '../src/context.js'

let env: Awaited<ReturnType<typeof setup>>
afterEach(async () => { await env?.drop() })

async function paidOrder(amount = 10090n) {
  const orderId = await createOrder(env.ctx, env.merchantId, { externalRef: 'pedido-' + Math.random(), amountMinor: amount, description: 'teste' })
  const ch = (await env.db.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [orderId])).rows[0]
  env.provider.pay(ch.provider_payment_id)
  return { orderId, paymentId: ch.provider_payment_id as string }
}

describe('P1 contrato v0.3', () => {
  it('1. mesmo webhook 5 vezes: 1 liquidação e 4 duplicatas registradas', async () => {
    env = await setup()
    const { orderId, paymentId } = await paidOrder()
    const body = asaasEvent('evt_1', 'PAYMENT_RECEIVED', paymentId, 'RECEIVED')
    const res = []
    for (let i = 0; i < 5; i++) res.push(await deliver(env.ctx, body))
    expect(res.filter(r => r.duplicate)).toHaveLength(4)
    await settleAll(env.ctx, env.chain)
    const c = await counts(env.db, orderId)
    expect(c.order.status).toBe('settled')
    expect(c.settlements).toHaveLength(1)
    expect(c.attempts).toHaveLength(1)
    expect(env.chain.mined.filter(t => t.status === 'success')).toHaveLength(1)
    const ev = (await env.db.query(`SELECT duplicate_count, processing_state FROM provider_events WHERE provider_event_id='evt_1'`)).rows[0]
    expect(ev).toEqual({ duplicate_count: 4, processing_state: 'processed' })
  })

  it('2. dois workers pegam a mesma liquidação: uma intenção, um nonce, uma transferência', async () => {
    env = await setup()
    const { orderId, paymentId } = await paidOrder()
    await deliver(env.ctx, asaasEvent('evt_2', 'PAYMENT_RECEIVED', paymentId, 'RECEIVED'))
    await drain(env.ctx, 5, ['process_provider_event'])
    const stl = (await env.db.query(`SELECT id FROM settlements WHERE order_id=$1`, [orderId])).rows[0].id
    await Promise.all([advanceSettlement(env.ctx, stl), advanceSettlement(env.ctx, stl), advanceSettlement(env.ctx, stl)])
    // e dois workers de fila ao mesmo tempo
    await Promise.all([drain(env.ctx), drain(env.ctx)])
    await settleAll(env.ctx, env.chain)
    const c = await counts(env.db, orderId)
    expect(c.attempts).toHaveLength(1)
    expect(new Set(c.attempts.map((a: any) => a.nonce)).size).toBe(1)
    expect(env.chain.transfersByMemo.size).toBe(1)
    expect([...env.chain.transfersByMemo.values()]).toEqual([1])
  })

  for (const point of ['after_pre_sign_check', 'after_sign_before_persist', 'after_broadcast_pending_before_rpc', 'after_rpc_before_record']) {
    it(`3. queda em ${point}: recupera sem novo nonce e sem segundo pagamento`, async () => {
      env = await setup()
      const { orderId, paymentId } = await paidOrder()
      await deliver(env.ctx, asaasEvent('evt_3', 'PAYMENT_RECEIVED', paymentId, 'RECEIVED'))
      env.crash.add(point)
      await expect(drain(env.ctx)).rejects.toBeInstanceOf(CrashError)
      await advanceTime(env.db) // o lock do job "morto" expira
      await settleAll(env.ctx, env.chain)
      const c = await counts(env.db, orderId)
      expect(c.order.status).toBe('settled')
      expect(c.attempts).toHaveLength(1)
      expect(c.attempts[0].status).toBe('confirmed')
      expect(env.chain.mined.filter(t => t.status === 'success')).toHaveLength(1)
    })
  }

  it('3b. resposta da RPC perdida depois de aceitar: fica desconhecido, reconcilia pelo hash, um pagamento', async () => {
    env = await setup()
    const { orderId, paymentId } = await paidOrder()
    await deliver(env.ctx, asaasEvent('evt_3b', 'PAYMENT_RECEIVED', paymentId, 'RECEIVED'))
    env.chain.failNextBroadcast = 'timeout_after_accept'
    await settleAll(env.ctx, env.chain)
    const c = await counts(env.db, orderId)
    expect(c.order.status).toBe('settled')
    expect(c.attempts).toHaveLength(1)
    expect(env.chain.mined.filter(t => t.status === 'success')).toHaveLength(1)
    const tr = (await env.db.query(`SELECT to_state FROM state_transitions WHERE entity='attempt' ORDER BY id`)).rows.map(r => r.to_state)
    expect(tr).toContain('unknown')
  })

  it('3c. RPC fora do ar na conferência: nunca marca sucesso', async () => {
    env = await setup()
    const { orderId, paymentId } = await paidOrder()
    await deliver(env.ctx, asaasEvent('evt_3c', 'PAYMENT_RECEIVED', paymentId, 'RECEIVED'))
    env.chain.observeDown = true
    await settleAll(env.ctx, env.chain, 4)
    let c = await counts(env.db, orderId)
    expect(c.order.status).toBe('settling')
    expect(['broadcast_sent', 'unknown']).toContain(c.attempts[0].status)
    env.chain.observeDown = false
    await settleAll(env.ctx, env.chain)
    c = await counts(env.db, orderId)
    expect(c.order.status).toBe('settled')
  })

  it('4. valor pago diferente: retido com motivo, sem liquidação', async () => {
    env = await setup()
    const orderId = await createOrder(env.ctx, env.merchantId, { externalRef: 'p4', amountMinor: 10090n, description: 't' })
    const ch = (await env.db.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [orderId])).rows[0]
    env.provider.pay(ch.provider_payment_id, { valueMinor: 10000n })
    await deliver(env.ctx, asaasEvent('evt_4', 'PAYMENT_RECEIVED', ch.provider_payment_id, 'RECEIVED'))
    await settleAll(env.ctx, env.chain)
    const c = await counts(env.db, orderId)
    expect(c.order.hold_reason).toBe('amount_mismatch')
    expect(c.settlements).toHaveLength(0)
    expect(env.chain.mined).toHaveLength(0)
  })

  it('5. transferência na cadeia com identidade divergente: revisão manual, sem segundo pagamento', async () => {
    env = await setup()
    const { orderId, paymentId } = await paidOrder()
    await deliver(env.ctx, asaasEvent('evt_5', 'PAYMENT_RECEIVED', paymentId, 'RECEIVED'))
    const realObserve = env.chain.observe.bind(env.chain)
    env.chain.observe = async (h, i) => { const o = await realObserve(h, i); return o ? { ...o, identityOk: false, mismatches: ['evento de outro token'] } : o }
    await settleAll(env.ctx, env.chain)
    const c = await counts(env.db, orderId)
    expect(c.attempts).toHaveLength(1)
    expect(c.attempts[0].status).toBe('manual_review')
    expect(c.settlements[0]).toMatchObject({ status: 'manual_review', hold_reason: 'identity_mismatch' })
    expect(env.chain.mined).toHaveLength(1)
  })

  it('6. Pix chega direto como recebido e evento antigo chega depois: uma liquidação, sem regressão', async () => {
    env = await setup()
    const { orderId, paymentId } = await paidOrder()
    await deliver(env.ctx, asaasEvent('evt_6a', 'PAYMENT_RECEIVED', paymentId, 'RECEIVED'))
    await settleAll(env.ctx, env.chain)
    await deliver(env.ctx, asaasEvent('evt_6b', 'PAYMENT_CONFIRMED', paymentId, 'CONFIRMED'))
    await deliver(env.ctx, asaasEvent('evt_6c', 'PAYMENT_CREATED', paymentId, 'PENDING'))
    await settleAll(env.ctx, env.chain)
    const c = await counts(env.db, orderId)
    expect(c.order.status).toBe('settled')
    expect(c.settlements).toHaveLength(1)
    const ch = (await env.db.query(`SELECT observed_state FROM pix_charges WHERE order_id=$1`, [orderId])).rows[0]
    expect(ch.observed_state).toBe('received')
    // e se o provedor "voltar" para CONFIRMED, é stale
    env.provider.charges.get(paymentId)!.status = 'CONFIRMED'
    await deliver(env.ctx, asaasEvent('evt_6d', 'PAYMENT_CONFIRMED', paymentId, 'CONFIRMED'))
    await settleAll(env.ctx, env.chain)
    const ev = (await env.db.query(`SELECT processing_state FROM provider_events WHERE provider_event_id='evt_6d'`)).rows[0]
    expect(ev.processing_state).toBe('stale')
    expect(env.chain.mined).toHaveLength(1)
  })

  it('7. evento persistido e processo cai antes de terminar: a outbox recupera, mesmo com duplicata', async () => {
    env = await setup()
    const { orderId, paymentId } = await paidOrder()
    await deliver(env.ctx, asaasEvent('evt_7', 'PAYMENT_RECEIVED', paymentId, 'RECEIVED'))
    env.crash.add('event_after_mark_processing')
    await expect(drain(env.ctx)).rejects.toBeInstanceOf(CrashError)
    const dup = await deliver(env.ctx, asaasEvent('evt_7', 'PAYMENT_RECEIVED', paymentId, 'RECEIVED'))
    expect(dup.duplicate).toBe(true)
    await advanceTime(env.db)
    await settleAll(env.ctx, env.chain)
    const c = await counts(env.db, orderId)
    expect(c.order.status).toBe('settled')
    expect(env.chain.mined).toHaveLength(1)
  })

  it('3.6 estorno solicitado antes de assinar: não assina nem transmite', async () => {
    env = await setup()
    const { orderId, paymentId } = await paidOrder()
    await deliver(env.ctx, asaasEvent('evt_r', 'PAYMENT_RECEIVED', paymentId, 'RECEIVED'))
    await drain(env.ctx, 5, ['process_provider_event'])
    await drain(env.ctx, 5, ['settle']) // nonce reservado
    await env.db.query(`INSERT INTO refund_cases (id, order_id, refund_type, state, amount_minor) VALUES ('rfc_TESTE', $1, 'merchant_refund', 'requested', 10090)`, [orderId])
    await settleAll(env.ctx, env.chain)
    const c = await counts(env.db, orderId)
    expect(c.attempts[0].status).toBe('suspended')
    expect(env.chain.signCalls).toBe(0)
    expect(env.chain.mined).toHaveLength(0)
  })

  it('3.6 estorno surge entre assinar e transmitir: bytes preservados, nada transmitido', async () => {
    env = await setup()
    const { orderId, paymentId } = await paidOrder()
    await deliver(env.ctx, asaasEvent('evt_r2', 'PAYMENT_RECEIVED', paymentId, 'RECEIVED'))
    await drain(env.ctx, 5, ['process_provider_event'])
    await drain(env.ctx, 5, ['settle'])
    await drain(env.ctx, 5, ['sign_attempt'])
    await env.db.query(`INSERT INTO refund_cases (id, order_id, refund_type, state, amount_minor) VALUES ('rfc_TESTE2', $1, 'merchant_refund', 'requested', 10090)`, [orderId])
    await settleAll(env.ctx, env.chain)
    const a = (await env.db.query(`SELECT a.status, a.raw_tx IS NOT NULL AS has_raw FROM settlement_attempts a JOIN settlements s ON s.id=a.settlement_id WHERE s.order_id=$1`, [orderId])).rows[0]
    expect(a).toEqual({ status: 'suspended', has_raw: true })
    expect(env.chain.broadcastCalls).toBe(0)
  })

  it('revert comprovado: nova tentativa com novo nonce, um pagamento no fim', async () => {
    env = await setup()
    const { orderId, paymentId } = await paidOrder()
    await deliver(env.ctx, asaasEvent('evt_rv', 'PAYMENT_RECEIVED', paymentId, 'RECEIVED'))
    env.chain.revertNext = true
    await settleAll(env.ctx, env.chain)
    const c = await counts(env.db, orderId)
    expect(c.attempts.map((a: any) => a.status)).toEqual(['attempt_reverted', 'confirmed'])
    expect(c.attempts[0].nonce).not.toBe(c.attempts[1].nonce)
    expect(env.chain.mined.filter(t => t.status === 'success')).toHaveLength(1)
  })
})
