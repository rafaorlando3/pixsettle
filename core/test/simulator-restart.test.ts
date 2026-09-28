// Cenário 5 da matriz (docs/coverage.md): reinício do processo com o Pix SIMULADO persistido no banco.
// Cada "reinício" é um provedor novo, com memória vazia, apontando para o mesmo banco.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setup, settleAll, deliver, asaasEvent, counts } from './helpers.js'
import { createOrder } from '../src/flows/orders.js'
import { requestRefund } from '../src/flows/refunds.js'
import { sweep } from '../src/flows/sweep.js'
import { SimulatedPixProvider } from '../src/providers/simulated.js'
import { buildApp } from '../src/app.js'
import { registerWeb } from '../src/web.js'
import { registerDemo } from '../src/demo.js'
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
  return restart()
}
/** "Reinício": provedor novo, memória vazia, mesmo banco. */
function restart() {
  const p = new SimulatedPixProvider({ store: env.db })
  env.ctx.provider = p
  return p
}
async function newOrder(amount = 10090n) {
  const orderId = await createOrder(env.ctx, env.merchantId, { externalRef: 'r-' + randomUUID(), amountMinor: amount, description: 't' })
  const pid = (await env.db.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [orderId])).rows[0].provider_payment_id as string
  return { orderId, pid }
}
const simRow = (pid: string) => env.db.query(`SELECT status, paid_minor::text, refunded_minor::text, order_id FROM simulated_pix_charges WHERE id=$1`, [pid]).then(r => r.rows[0])

describe('Pix simulado persistido: reinício recupera a cobrança com as referências originais', () => {
  it('cria, reinicia, paga, reinicia, webhook: liquida uma vez com o mesmo pedido e a mesma cobrança', async () => {
    await start()
    const { orderId, pid } = await newOrder()
    expect(await simRow(pid)).toMatchObject({ status: 'PENDING', order_id: orderId })

    const b = restart()
    expect(b.charges.size).toBe(0)
    expect(await b.has(pid)).toBe(true)
    expect((await b.getPixQr(pid)).qrPayload).toBe(`SIMULATED-PIX|${pid}|10090`)
    await b.pay(pid)
    expect(await simRow(pid)).toMatchObject({ status: 'RECEIVED', paid_minor: '10090' })

    restart()
    await deliver(env.ctx, asaasEvent('evt_' + orderId, 'PAYMENT_RECEIVED', pid, 'RECEIVED'))
    await settleAll(env.ctx, env.chain)
    expect((await counts(env.db, orderId)).order.status).toBe('settled')
    expect(env.chain.mined).toHaveLength(1)
    const rc = (await env.db.query(`SELECT envelope FROM receipts WHERE order_id=$1 AND receipt_type='settlement'`, [orderId])).rows[0].envelope
    expect(rc.payload.order.id).toBe(orderId)
    expect(await verifyEnvelope(rc, [ISSUER])).toMatchObject({ ok: true })
    expect((await env.db.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [orderId])).rows[0].provider_payment_id).toBe(pid)
  })

  it('webhook perdido e reinício: a varredura acha o pagamento pelo banco do simulador, sem reter como cobrança sumida', async () => {
    await start()
    const { orderId, pid } = await newOrder()
    await env.ctx.provider.getPayment(pid) // aquece a memória do processo antigo
    await (env.ctx.provider as SimulatedPixProvider).pay(pid) // pago no "provedor"; nenhum webhook
    restart()
    expect(await sweep(env.ctx)).toMatchObject({ observe: 1 })
    await settleAll(env.ctx, env.chain)
    const c = await counts(env.db, orderId)
    expect(c.order).toEqual({ status: 'settled', hold_reason: null })
    expect(env.chain.mined).toHaveLength(1)
  })

  it('estorno depois de reiniciar: o provedor novo acha a cobrança, estorna uma vez e grava no banco', async () => {
    await start()
    const { orderId, pid } = await newOrder()
    await (env.ctx.provider as SimulatedPixProvider).pay(pid)
    await deliver(env.ctx, asaasEvent('evt_' + orderId, 'PAYMENT_RECEIVED', pid, 'RECEIVED'))
    await settleAll(env.ctx, env.chain)
    restart()
    expect(await requestRefund(env.ctx, env.merchantId, orderId, { type: 'merchant_refund', amountMinor: 1000n, source: 'test' })).toMatchObject({ ok: true })
    await settleAll(env.ctx, env.chain)
    expect(await simRow(pid)).toMatchObject({ status: 'PARTIALLY_REFUNDED', refunded_minor: '1000' })
    const cases = (await env.db.query(`SELECT state FROM refund_cases WHERE order_id=$1`, [orderId])).rows
    expect(cases).toEqual([{ state: 'confirmed' }])
  })

  it('demo: pedido criado antes do reinício continua pagável pelo botão da demo (antes dava 409 stale_demo_order)', async () => {
    await start()
    const mk = async () => {
      const app = buildApp(env.ctx, { asaasWebhookToken: 'tok-webhook-teste', diagnosticsToken: 'diag' })
      registerWeb(app, env.ctx, { tempoRpc: 'https://rpc.moderato.tempo.xyz', explorer: 'https://explore.testnet.tempo.xyz', demo: true })
      await registerDemo(app, env.ctx, { webhookToken: 'tok-webhook-teste', merchantAddress: '0x8ee643c15C603856A76d05020b5ccB0FceA425BF', explorer: 'https://explore.testnet.tempo.xyz' })
      return app
    }
    const app1 = await mk()
    const c = await app1.inject({ method: 'POST', url: '/demo/api/orders', payload: { amount_minor: 10090, description: 'antes do reinício' } })
    expect(c.statusCode).toBe(201)
    const { order_id } = c.json()
    await app1.close()

    restart()
    const app2 = await mk()
    const s = await app2.inject({ method: 'POST', url: `/demo/api/orders/${order_id}/simulate`, payload: { scenario: 'pay', deliveries: 3 } })
    expect(s.statusCode).toBe(200)
    expect(s.json().deliveries.map((d: any) => d.duplicate)).toEqual([false, true, true])
    await settleAll(env.ctx, env.chain)
    expect((await app2.inject({ method: 'GET', url: `/demo/api/orders/${order_id}` })).json().status).toBe('settled')
    await app2.close()
  })

  it('cobrança que nunca existiu no simulador continua 404 (a varredura retém com motivo, como antes)', async () => {
    await start()
    const b = restart()
    expect(await b.has('pay_sim_0000000000000000')).toBe(false)
    await expect(b.getPayment('pay_sim_0000000000000000')).rejects.toMatchObject({ status: 404 })
  })

  it('escrita que falha não deixa estado fantasma na memória (ITEM2-02, revisão X-0027): pagamento e estorno', async () => {
    await start()
    const { pid } = await newOrder()
    const p = env.ctx.provider as SimulatedPixProvider
    const failNextUpdate = () => {
      const q = env.db.query.bind(env.db) as any
      ;(env.db as any).query = (sql: any, ...rest: any[]) => {
        if (typeof sql === 'string' && sql.startsWith('UPDATE simulated_pix_charges')) { (env.db as any).query = q; return Promise.reject(new Error('conexão caiu antes do commit (simulado)')) }
        return q(sql, ...rest)
      }
    }
    failNextUpdate()
    await expect(p.pay(pid)).rejects.toThrow(/simulado/)
    expect((await p.getPayment(pid)).status).toBe('PENDING') // mesmo objeto
    expect((await restart().getPayment(pid)).status).toBe('PENDING') // depois de reiniciar

    const q = env.ctx.provider as SimulatedPixProvider
    await q.pay(pid)
    failNextUpdate()
    await expect(q.providerRefund(pid, 1000n)).rejects.toThrow(/simulado/)
    expect((await q.getPayment(pid)).refundedMinor).toBe(0n)
    await q.providerRefund(pid, 1000n) // repetição depois da falha: conta uma vez só
    expect((await q.getPayment(pid)).refundedMinor).toBe(1000n)
    expect((await restart().getPayment(pid)).refundedMinor).toBe(1000n)
  })

  it('o banco recusa id que não seja do simulador (isolamento dos provedores reais)', async () => {
    await start()
    await expect(env.db.query(`INSERT INTO simulated_pix_charges (id, order_id, value_minor, status) VALUES ('pay_real_1','o',1,'PENDING')`)).rejects.toThrow(/simulated_pix_charges_id_check/)
  })
})
