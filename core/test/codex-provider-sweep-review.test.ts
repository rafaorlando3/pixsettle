// Revisão local: estados de devolução e resultados ambíguos do adaptador.
// Banco real descartável; provedor HTTP e cadeia simulados; nenhuma rede pública.
import { it, expect, afterEach } from 'vitest'
import { setup, deliver, asaasEvent } from './helpers.js'
import { FakeAsaas } from './fakes/fakeAsaas.js'
import { createOrder } from '../src/flows/orders.js'
import { requestRefund, executeRefund } from '../src/flows/refunds.js'
import { AsaasPixProvider, AsaasSandboxPayer } from '../src/providers/asaas.js'
import { applyObservation } from '../src/flows/events.js'
import { reconcileAttempt } from '../src/flows/settle.js'
import { sweep } from '../src/flows/sweep.js'
import { withTx } from '../src/db.js'
import { drain } from '../src/outbox.js'

let env: Awaited<ReturnType<typeof setup>>
let fake: FakeAsaas | undefined
afterEach(async () => { await env?.drop(); await fake?.stop(); fake = undefined })

async function create(ref: string) {
  const orderId = await createOrder(env.ctx, env.merchantId, { externalRef: ref, amountMinor: 10090n, description: 'review' })
  const charge = (await env.db.query('SELECT * FROM pix_charges WHERE order_id=$1', [orderId])).rows[0]
  return { orderId, charge, pid: charge.provider_payment_id as string }
}
async function broadcast(orderId: string, pid: string) {
  await deliver(env.ctx, asaasEvent('evt_' + orderId, 'PAYMENT_RECEIVED', pid, 'RECEIVED'))
  await drain(env.ctx, 20, ['process_provider_event', 'settle', 'sign_attempt', 'broadcast_attempt'])
  return (await env.db.query('SELECT a.id FROM settlement_attempts a JOIN settlements s ON s.id=a.settlement_id WHERE s.order_id=$1', [orderId])).rows[0].id as string
}

it('R7: devolucao total observada durante envio deve conciliar depois da confirmacao da cadeia', async () => {
  env = await setup()
  const { orderId, pid } = await create('r7')
  env.provider.pay(pid)
  const attemptId = await broadcast(orderId, pid)
  env.provider.providerRefund(pid, 10090n)
  const payment = await env.provider.getPayment(pid)
  await withTx(env.db, tx => applyObservation(tx, env.ctx, payment, 'review_full_refund'))
  expect((await env.db.query('SELECT state FROM refund_cases WHERE order_id=$1', [orderId])).rows).toEqual([{ state: 'unknown' }])
  env.chain.mine()
  await reconcileAttempt(env.ctx, attemptId, 0)
  expect((await env.db.query('SELECT status FROM settlement_attempts WHERE id=$1', [attemptId])).rows[0].status).toBe('confirmed')
  await sweep(env.ctx)
  await drain(env.ctx, 10, ['observe_charge'])
  await sweep(env.ctx)
  await drain(env.ctx, 10, ['observe_charge'])
  const cases = (await env.db.query('SELECT state,amount_minor::text AS amount FROM refund_cases WHERE order_id=$1', [orderId])).rows
  const accounting = (await env.db.query("SELECT kind FROM ledger_entries WHERE order_id=$1 AND kind IN ('reserve_consumed_simulated','debt_simulated') ORDER BY kind", [orderId])).rows
  console.log('R7_EVIDENCE', JSON.stringify({ cases, accounting, chainTransfers: env.chain.mined.length }))
  expect.soft(cases).toEqual([{ state: 'confirmed', amount: '10090' }])
  expect(accounting).toEqual([{ kind: 'debt_simulated' }, { kind: 'reserve_consumed_simulated' }])
})

it('R8: resposta 200 truncada depois do aceite nao libera segunda devolucao', async () => {
  env = await setup()
  fake = await new FakeAsaas().start()
  let corruptNextRefundResponse = true
  const opts = { apiKey: fake.receiverKey, customerId: 'cus_local_review', baseUrl: fake.url, timeoutMs: 1000 }
  const fetchImpl: typeof fetch = async (input, init) => {
    const res = await fetch(input, init)
    if (corruptNextRefundResponse && init?.method === 'POST' && String(input).endsWith('/refund')) {
      corruptNextRefundResponse = false
      expect(res.status).toBe(200)
      await res.text() // serviço local terminou o estorno; perde-se apenas a resposta ao adaptador
      return new Response('{"id":', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return res
  }
  env.ctx.provider = new AsaasPixProvider({ ...opts, fetchImpl })
  const { orderId, pid, charge } = await create('r8')
  await new AsaasSandboxPayer(opts).pay(pid, charge.qr_payload, 10090n)
  const attemptId = await broadcast(orderId, pid)
  env.chain.mine()
  await reconcileAttempt(env.ctx, attemptId, 0)
  const r1 = await requestRefund(env.ctx, env.merchantId, orderId, { type: 'merchant_refund', amountMinor: 1000n, source: 'review' })
  if (!r1.ok) throw new Error(r1.code)
  await executeRefund(env.ctx, r1.refundCaseId)
  const firstState = (await env.db.query('SELECT state FROM refund_cases WHERE id=$1', [r1.refundCaseId])).rows[0].state
  // Só tentamos outra vez se o sistema informou falha definitiva.
  // Uma correção também pode conciliar imediatamente e confirmar o primeiro caso.
  let secondRequestAccepted = false
  if (firstState === 'failed') {
    const r2 = await requestRefund(env.ctx, env.merchantId, orderId, { type: 'merchant_refund', amountMinor: 1000n, source: 'review_retry' })
    secondRequestAccepted = r2.ok
    if (r2.ok) await executeRefund(env.ctx, r2.refundCaseId)
  }
  const refunded = fake.payments.get(pid)!.refunds.filter(r => r.status === 'DONE').reduce((a, r) => a + Math.round(r.value * 100), 0)
  console.log('R8_EVIDENCE', JSON.stringify({ firstState, secondRequestAccepted, requestedMinor: 1000, refundedMinor: refunded }))
  expect.soft(firstState).not.toBe('failed')
  expect(refunded).toBe(1000)
})
