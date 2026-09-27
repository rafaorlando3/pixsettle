// Adaptador Asaas contra um Asaas FALSO local (formatos da documentação). Chave real só com o Rafael.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { setup, settleAll, deliver, asaasEvent, counts } from './helpers.js'
import { FakeAsaas } from './fakes/fakeAsaas.js'
import { AsaasPixProvider, AsaasSandboxPayer, toReais, toMinor } from '../src/providers/asaas.js'
import { createOrder } from '../src/flows/orders.js'
import { requestRefund } from '../src/flows/refunds.js'
import { drain } from '../src/outbox.js'
import { ProviderError } from '../src/providers/types.js'
import { buildApp } from '../src/app.js'
import { registerDemo } from '../src/demo.js'

let env: Awaited<ReturnType<typeof setup>> | undefined
let fake: FakeAsaas
beforeEach(async () => { fake = await new FakeAsaas().start() })
afterEach(async () => { await env?.drop(); env = undefined; await fake.stop() })

const opts = () => ({ apiKey: fake.receiverKey, customerId: 'cus_000000000001', baseUrl: fake.url, timeoutMs: 300 })
async function start() {
  env = await setup()
  env.ctx.provider = new AsaasPixProvider(opts())
  return env
}
const chargeOf = (orderId: string) => env!.db.query(`SELECT * FROM pix_charges WHERE order_id=$1`, [orderId]).then(r => r.rows[0])

describe('Asaas (sandbox)', () => {
  it('conversão de dinheiro exata e recusa de casas extras', () => {
    expect(toReais(10090n)).toBe(100.9); expect(toReais(5n)).toBe(0.05); expect(toReais(100n)).toBe(1)
    expect(toMinor(100.9)).toBe(10090n); expect(toMinor(0.1 + 0.2)).toBe(30n)
    expect(() => toMinor(1.005)).toThrow(ProviderError)
    expect(() => toMinor('10' as any)).toThrow(ProviderError)
  })

  it('recusa chave ou URL de produção', () => {
    expect(() => new AsaasPixProvider({ ...opts(), apiKey: '$aact_prod_x' })).toThrow(/sandbox/)
    expect(() => new AsaasPixProvider({ ...opts(), baseUrl: 'https://api.asaas.com/v3' })).toThrow(/produção/)
  })

  it('fluxo completo: cobrança Pix, QR real, pagamento de sandbox, webhook, liquidação e estorno parcial observado', async () => {
    await start()
    const orderId = await createOrder(env!.ctx, env!.merchantId, { externalRef: 'as-1', amountMinor: 10090n, description: 'teste' })
    const ch = await chargeOf(orderId)
    expect(ch.creation_state).toBe('created')
    expect(ch.qr_payload).toMatch(/^000201.*br\.gov\.bcb\.pix/)
    const created = fake.payments.get(ch.provider_payment_id)!
    expect(created).toMatchObject({ billingType: 'PIX', value: 100.9, externalReference: orderId, customer: 'cus_000000000001' })
    expect(fake.calls.every(c => c.key === fake.receiverKey && c.ua.startsWith('PixSettle/'))).toBe(true)

    // Pagador com segunda conta de sandbox paga o QR dinâmico.
    const payer = new AsaasSandboxPayer(opts(), fake.payerKey)
    expect(await payer.pay(ch.provider_payment_id, ch.qr_payload, 10090n)).toEqual({ via: 'payer_account' })
    await deliver(env!.ctx, asaasEvent('evt_as1', 'PAYMENT_RECEIVED', ch.provider_payment_id, 'RECEIVED'))
    await settleAll(env!.ctx, env!.chain)
    expect((await counts(env!.db, orderId)).order.status).toBe('settled')

    // Estorno parcial: o Asaas não tem estado "parcial"; deduzimos pelos estornos DONE.
    expect(await requestRefund(env!.ctx, env!.merchantId, orderId, { type: 'merchant_refund', amountMinor: 1000n, source: 'test' })).toMatchObject({ ok: true })
    await settleAll(env!.ctx, env!.chain)
    expect(fake.payments.get(ch.provider_payment_id)!.refunds).toMatchObject([{ value: 10, status: 'DONE' }])
    const p = await env!.ctx.provider.getPayment(ch.provider_payment_id)
    expect(p).toMatchObject({ status: 'PARTIALLY_REFUNDED', rawStatus: 'RECEIVED', refundedMinor: 1000n, paidAt: null, paidDate: '2026-09-27' })
    expect((await env!.db.query(`SELECT state FROM refund_cases WHERE order_id=$1`, [orderId])).rows.map(r => r.state)).toEqual(['confirmed'])
  })

  it('sem conta pagadora usa a confirmação de sandbox do recebedor', async () => {
    await start()
    const orderId = await createOrder(env!.ctx, env!.merchantId, { externalRef: 'as-2', amountMinor: 500n, description: 't' })
    const ch = await chargeOf(orderId)
    expect(await new AsaasSandboxPayer(opts()).pay(ch.provider_payment_id, ch.qr_payload, 500n)).toEqual({ via: 'sandbox_confirm' })
    expect((await env!.ctx.provider.getPayment(ch.provider_payment_id)).status).toBe('RECEIVED')
  })

  it('resposta perdida na criação: fica desconhecida e a conciliação acha a cobrança e busca o QR verdadeiro', async () => {
    await start()
    fake.fail.add('create_hang_after_commit')
    const orderId = await createOrder(env!.ctx, env!.merchantId, { externalRef: 'as-3', amountMinor: 700n, description: 't' })
    expect((await chargeOf(orderId)).creation_state).toBe('creation_unknown')
    await new Promise(r => setTimeout(r, 400)) // o Asaas falso termina de responder (tarde demais)
    await drain(env!.ctx, 5, ['reconcile_charge_creation'])
    const ch = await chargeOf(orderId)
    expect(ch.creation_state).toBe('created')
    expect(ch.qr_payload).toContain(ch.provider_payment_id)
    expect(fake.payments.size).toBe(1) // nunca uma segunda cobrança
  })

  it('QR indisponível depois de criar vira desconhecido (não falho), e erro HTTP guarda só código e descrição', async () => {
    await start()
    fake.fail.add('qr_500')
    const orderId = await createOrder(env!.ctx, env!.merchantId, { externalRef: 'as-4', amountMinor: 700n, description: 't' })
    expect((await chargeOf(orderId)).creation_state).toBe('creation_unknown')
    const bad = new AsaasPixProvider(opts())
    const e2 = await (bad as any).call('POST', '/payments', { value: 'x', billingType: 'PIX' }).catch((e: any) => e)
    expect(e2).toBeInstanceOf(ProviderError)
    expect(e2.status).toBe(400)
    expect(JSON.stringify(e2.body)).not.toContain('dado-que-nao-pode-vazar')
  })

  it('estorno pendente no provedor não confirma; confirma quando o Pix de devolução liquida', async () => {
    await start()
    const orderId = await createOrder(env!.ctx, env!.merchantId, { externalRef: 'as-5', amountMinor: 10090n, description: 't' })
    const ch = await chargeOf(orderId)
    await new AsaasSandboxPayer(opts()).pay(ch.provider_payment_id, ch.qr_payload, 10090n)
    await deliver(env!.ctx, asaasEvent('evt_as5', 'PAYMENT_RECEIVED', ch.provider_payment_id, 'RECEIVED'))
    await settleAll(env!.ctx, env!.chain)
    fake.fail.add('refund_pending')
    await requestRefund(env!.ctx, env!.merchantId, orderId, { type: 'merchant_refund', amountMinor: 10090n, source: 'test' })
    await drain(env!.ctx, 5, ['request_refund'])
    expect((await env!.db.query(`SELECT state FROM refund_cases WHERE order_id=$1`, [orderId])).rows[0].state).toBe('unknown')
    fake.fail.delete('refund_pending'); fake.settleRefunds()
    await settleAll(env!.ctx, env!.chain)
    expect((await env!.db.query(`SELECT state FROM refund_cases WHERE order_id=$1`, [orderId])).rows[0].state).toBe('confirmed')
    expect((await chargeOf(orderId)).observed_state).toBe('refunded')
  })

  it('demo com Asaas sandbox: exige pagador de sandbox, paga de verdade no sandbox e recusa pagamento a menor', async () => {
    await start()
    const app = buildApp(env!.ctx, { asaasWebhookToken: 'tok', diagnosticsToken: 'd' })
    const base = { webhookToken: 'tok', merchantAddress: '0x8ee643c15C603856A76d05020b5ccB0FceA425BF', explorer: 'https://explore.testnet.tempo.xyz' }
    await expect(registerDemo(buildApp(env!.ctx, { asaasWebhookToken: 't', diagnosticsToken: 'd' }), env!.ctx, base)).rejects.toThrow(/simulado ou o Asaas sandbox/)
    await registerDemo(app, env!.ctx, { ...base, bench: new AsaasSandboxPayer(opts()) })
    const c = (await app.inject({ method: 'POST', url: '/demo/api/orders', payload: { amount_minor: 10090 } })).json()
    expect((await app.inject({ method: 'POST', url: `/demo/api/orders/${c.order_id}/simulate`, payload: { scenario: 'underpay' } })).statusCode).toBe(409)
    const r = await app.inject({ method: 'POST', url: `/demo/api/orders/${c.order_id}/simulate`, payload: {} })
    expect(r.json()).toEqual({ scenario: 'pay', via: 'sandbox_confirm', deliveries: [] })
    const ch = await chargeOf(c.order_id)
    expect(fake.payments.get(ch.provider_payment_id)!.status).toBe('RECEIVED')
    await app.close()
  })

  it('R8: só 4xx com corpo de erro prova recusa; 5xx, 429, corpo ilegível e falha de leitura são ambíguos', async () => {
    const mk = (status: number, body: string | null, bodyError = false) => async () => {
      if (bodyError) return new Response(new ReadableStream({ start(c) { c.error(new Error('conexão caiu no meio do corpo')) } }), { status: 200 })
      return new Response(body, { status, headers: { 'content-type': 'application/json' } })
    }
    const cases: Array<[string, ReturnType<typeof mk>, boolean]> = [
      ['400 com erros', mk(400, JSON.stringify({ errors: [{ code: 'invalid_value', description: 'valor inválido' }] })), true],
      ['400 sem corpo de erro', mk(400, '{}'), false],
      ['429', mk(429, JSON.stringify({ errors: [{ code: 'too_many_requests', description: 'limite' }] })), false],
      ['500', mk(500, JSON.stringify({ errors: [{ code: 'internal', description: 'erro' }] })), false],
      ['502 HTML', mk(502, '<html>bad gateway</html>'), false],
      ['200 truncado', mk(200, '{"id":'), false],
      ['200 com falha de leitura', mk(200, null, true), false],
    ]
    for (const [name, f, proven] of cases) {
      const p = new AsaasPixProvider({ ...opts(), fetchImpl: f as any })
      const e = await p.refund('pay_x', 100n, 't').then(() => null, x => x)
      expect(e, name).toBeInstanceOf(ProviderError)
      expect([name, e.provenRejection, e.outcomeUnknown]).toEqual([name, proven, !proven])
    }
  })

  it('R8: estorno executado com resposta 5xx vira desconhecido, concilia e nunca devolve duas vezes', async () => {
    await start()
    const orderId = await createOrder(env!.ctx, env!.merchantId, { externalRef: 'as-r8', amountMinor: 10090n, description: 't' })
    const ch = await chargeOf(orderId)
    await new AsaasSandboxPayer(opts()).pay(ch.provider_payment_id, ch.qr_payload, 10090n)
    await deliver(env!.ctx, asaasEvent('evt_asr8', 'PAYMENT_RECEIVED', ch.provider_payment_id, 'RECEIVED'))
    await settleAll(env!.ctx, env!.chain)
    let broke = false
    env!.ctx.provider = new AsaasPixProvider({ ...opts(), fetchImpl: (async (u: any, i: any) => {
      const r = await fetch(u, i)
      if (!broke && i?.method === 'POST' && String(u).endsWith('/refund')) { broke = true; return new Response('{"errors":[{"code":"internal","description":"erro"}]}', { status: 503 }) }
      return r
    }) as any })
    const r = await requestRefund(env!.ctx, env!.merchantId, orderId, { type: 'merchant_refund', amountMinor: 1000n, source: 'test' })
    if (!r.ok) throw new Error(r.code)
    await drain(env!.ctx, 5, ['request_refund'])
    expect((await env!.db.query(`SELECT state FROM refund_cases WHERE id=$1`, [r.refundCaseId])).rows[0].state).toBe('unknown')
    expect(await requestRefund(env!.ctx, env!.merchantId, orderId, { type: 'merchant_refund', amountMinor: 1000n, source: 'test' })).toMatchObject({ ok: false, code: 'refund_in_progress' })
    await settleAll(env!.ctx, env!.chain)
    expect((await env!.db.query(`SELECT state FROM refund_cases WHERE id=$1`, [r.refundCaseId])).rows[0].state).toBe('confirmed')
    expect(fake.payments.get(ch.provider_payment_id)!.refunds.map(x => x.value)).toEqual([10])
  })

  it('criação com 5xx concilia pelo externalReference em vez de falhar', async () => {
    await start()
    let broke = false
    env!.ctx.provider = new AsaasPixProvider({ ...opts(), fetchImpl: (async (u: any, i: any) => {
      const r = await fetch(u, i)
      if (!broke && i?.method === 'POST' && String(u).endsWith('/payments')) { broke = true; return new Response('upstream error', { status: 504 }) }
      return r
    }) as any })
    const orderId = await createOrder(env!.ctx, env!.merchantId, { externalRef: 'as-504', amountMinor: 700n, description: 't' })
    expect((await chargeOf(orderId)).creation_state).toBe('creation_unknown')
    await drain(env!.ctx, 5, ['reconcile_charge_creation'])
    expect((await chargeOf(orderId)).creation_state).toBe('created')
    expect(fake.payments.size).toBe(1)
  })
})
