// Páginas, QR, cabeçalhos de segurança e rotas da demo (sempre pelos caminhos reais da API).
import { describe, it, expect, afterEach } from 'vitest'
import { setup, settleAll } from './helpers.js'
import { buildApp } from '../src/app.js'
import { registerWeb } from '../src/web.js'
import { registerDemo } from '../src/demo.js'
import { signReceipt } from '../../settlement/src/receipt.js'
import { privateKeyToAccount } from 'viem/accounts'

const ISSUER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const // chave pública de TESTE
const ISSUER = privateKeyToAccount(ISSUER_KEY).address
const EXPLORER = 'https://explore.testnet.tempo.xyz'

let env: Awaited<ReturnType<typeof setup>>
afterEach(async () => { await env?.drop() })

async function withDemo() {
  env = await setup()
  env.ctx.cfg.issuer = { id: 'pixsettle-test', address: ISSUER }
  env.chain.signReceipt = (payload: any) => signReceipt(payload, ISSUER_KEY)
  const app = buildApp(env.ctx, { asaasWebhookToken: 'tok-webhook-teste', diagnosticsToken: 'diag' })
  registerWeb(app, env.ctx, { tempoRpc: 'https://rpc.moderato.tempo.xyz', explorer: EXPLORER, demo: true })
  await registerDemo(app, env.ctx, { webhookToken: 'tok-webhook-teste', merchantAddress: '0x8ee643c15C603856A76d05020b5ccB0FceA425BF', explorer: EXPLORER })
  const create = (amount_minor: number | string = 10090) => app.inject({ method: 'POST', url: '/demo/api/orders', payload: { amount_minor, description: 'teste' } })
  return { app, create }
}

describe('web e demo', () => {
  it('fluxo da demo: cria pelo endpoint real, webhook 3x, liquida, recibo e link do explorer', async () => {
    const { app, create } = await withDemo()
    const c = await create(); expect(c.statusCode).toBe(201)
    const { order_id, checkout_token } = c.json()
    const s = await app.inject({ method: 'POST', url: `/demo/api/orders/${order_id}/simulate`, payload: { scenario: 'pay', deliveries: 3 } })
    expect(s.json().deliveries.map((d: any) => d.duplicate)).toEqual([false, true, true])
    await settleAll(env.ctx, env.chain)
    const o = (await app.inject({ method: 'GET', url: `/demo/api/orders/${order_id}` })).json()
    expect(o.status).toBe('settled')
    expect(o.webhooks).toEqual({ events: 1, deliveries: 3, duplicates_ignored: 2 })
    expect(BigInt(o.amounts.net) + BigInt(o.amounts.reserve_simulated)).toBe(BigInt(o.amounts.gross))
    expect(o.chain.explorer_url).toBe(`${EXPLORER}/tx/${o.settlement.tx_hash}`)
    expect(o.receipt_id).toMatch(/^rct_/)
    // pagador: só o essencial, e já como pago
    expect((await app.inject({ method: 'GET', url: `/api/v1/checkout/${checkout_token}` })).json().status).toBe('paid')
    // pagar de novo é recusado
    expect((await app.inject({ method: 'POST', url: `/demo/api/orders/${order_id}/simulate`, payload: {} })).statusCode).toBe(409)
  })

  it('valor diferente: pedido retido, nada liquidado, pagador vê "em análise" sem o motivo interno', async () => {
    const { app, create } = await withDemo()
    const { order_id, checkout_token } = (await create()).json()
    await app.inject({ method: 'POST', url: `/demo/api/orders/${order_id}/simulate`, payload: { scenario: 'underpay' } })
    await settleAll(env.ctx, env.chain)
    const o = (await app.inject({ method: 'GET', url: `/demo/api/orders/${order_id}` })).json()
    expect(o.hold_reason).toBe('amount_mismatch')
    expect(o.settlement).toBeNull()
    const pub = (await app.inject({ method: 'GET', url: `/api/v1/checkout/${checkout_token}` })).json()
    expect(pub.status).toBe('under_review')
    expect(JSON.stringify(pub)).not.toContain('amount_mismatch')
  })

  it('valida valor, isola pedidos de outro lojista e recusa provedor que não seja simulado', async () => {
    const { app, create } = await withDemo()
    expect((await create(50)).statusCode).toBe(422)
    expect((await create('10,00')).statusCode).toBe(422)
    expect((await create(50_001)).statusCode).toBe(422)
    // pedido de outro lojista (criado direto no banco) não aparece na demo
    await env.db.query(`INSERT INTO orders (id, merchant_id, external_ref, amount_minor, status, expires_at, provider_env, chain_env) VALUES ('ord_OUTRO', $1, 'x', 100, 'awaiting_payment', now() + interval '1 hour', 'simulated', 'testnet')`, [env.merchantId])
    expect((await app.inject({ method: 'GET', url: '/demo/api/orders/ord_OUTRO' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/demo/api/orders/ord_OUTRO/simulate', payload: {} })).statusCode).toBe(404)
    const fakeCtx = { ...env.ctx, provider: { name: 'asaas' } as any }
    await expect(registerDemo(buildApp(fakeCtx, { asaasWebhookToken: 't', diagnosticsToken: 'd' }), fakeCtx, { webhookToken: 't', merchantAddress: '0x0', explorer: EXPLORER })).rejects.toThrow(/simulado/)
  })

  it('páginas e QR com CSP estrita; token inválido dá 404; asset fora da lista não é servido', async () => {
    const { app, create } = await withDemo()
    const { checkout_token } = (await create()).json()
    const p = await app.inject({ method: 'GET', url: `/pay/${checkout_token}` })
    expect(p.statusCode).toBe(200)
    expect(p.headers['content-security-policy']).toContain("script-src 'self'")
    expect(p.headers['content-security-policy']).toContain('connect-src \'self\' https://rpc.moderato.tempo.xyz')
    expect(p.headers['referrer-policy']).toBe('no-referrer')
    expect(p.body).not.toMatch(/style="/) // CSP bloqueia estilo inline
    const q = await app.inject({ method: 'GET', url: `/api/v1/checkout/${checkout_token}/qr.svg` })
    expect(q.headers['content-type']).toContain('image/svg+xml'); expect(q.body).toContain('<svg')
    expect((await app.inject({ method: 'GET', url: '/api/v1/checkout/nao-existe/qr.svg' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/assets/..%2Fpackage.json' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/assets/verify.js' })).statusCode).toBe(200)
    const meta = (await app.inject({ method: 'GET', url: '/.well-known/pixsettle.json' })).json()
    expect(meta.trusted_issuers[0].address).toBe(ISSUER)
    for (const page of ['/demo', '/receipt/rct_x']) expect((await app.inject({ method: 'GET', url: page })).body).not.toMatch(/style="/)
  })
})
