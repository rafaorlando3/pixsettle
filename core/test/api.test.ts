// P1 #8 (recibo emitido e verificável) e #9 (isolamento entre lojistas), via HTTP.
import { describe, it, expect, afterEach } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { setup, settleAll, asaasEvent } from './helpers.js'
import { buildApp } from '../src/app.js'
import { newId } from '../src/ids.js'
import { signReceipt, verifyEnvelope } from '../../settlement/src/receipt.js'
import { privateKeyToAccount } from 'viem/accounts'

const ISSUER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const // chave pública de TESTE
const ISSUER = privateKeyToAccount(ISSUER_KEY).address

let env: Awaited<ReturnType<typeof setup>>
afterEach(async () => { await env?.drop() })

async function withApp() {
  env = await setup()
  env.ctx.cfg.issuer = { id: 'pixsettle-test', address: ISSUER }
  env.chain.signReceipt = (payload: any) => signReceipt(payload, ISSUER_KEY)
  const app = buildApp(env.ctx, { asaasWebhookToken: 'tok-webhook-teste', diagnosticsToken: 'diag-teste' })
  const keyA = 'sk_a_' + randomUUID(), keyB = 'sk_b_' + randomUUID()
  await env.db.query(`UPDATE merchants SET api_key_hash=$2 WHERE id=$1`, [env.merchantId, createHash('sha256').update(keyA).digest('hex')])
  const merchantB = newId('mer')
  await env.db.query(`INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ($1,'Loja B',$2,'0x000000000000000000000000000000000000dEaD')`, [merchantB, createHash('sha256').update(keyB).digest('hex')])
  return { app, keyA, keyB }
}

const order = (app: any, key: string, idem: string, ref = 'ref-1', amount = '10090') =>
  app.inject({ method: 'POST', url: '/api/v1/orders', headers: { authorization: `Bearer ${key}`, 'idempotency-key': idem }, payload: { external_ref: ref, amount: { amount, currency: 'BRL' }, description: 'teste' } })

describe('API', () => {
  it('9. lojista B não vê pedido do A; checkout_token não abre livro-razão', async () => {
    const { app, keyA, keyB } = await withApp()
    const r = await order(app, keyA, 'k1'); expect(r.statusCode).toBe(201)
    const { order_id, checkout_token } = r.json()
    expect((await app.inject({ method: 'GET', url: `/api/v1/orders/${order_id}`, headers: { authorization: `Bearer ${keyA}` } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/v1/orders/${order_id}`, headers: { authorization: `Bearer ${keyB}` } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/merchants/me/ledger`, headers: { authorization: `Bearer ${checkout_token}` } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/v1/orders', headers: { authorization: `Bearer ${checkout_token}`, 'idempotency-key': 'x' }, payload: {} })).statusCode).toBe(401)
    const pub = await app.inject({ method: 'GET', url: `/api/v1/checkout/${checkout_token}` })
    expect(pub.statusCode).toBe(200)
    expect(Object.keys(pub.json()).sort()).toEqual(['amount', 'expires_at', 'pix_payload', 'status'])
  })

  it('idempotência: mesma chave e corpo devolve a mesma resposta; corpo diferente dá 409; escopo por lojista', async () => {
    const { app, keyA, keyB } = await withApp()
    const a1 = await order(app, keyA, 'k-idem'); const a2 = await order(app, keyA, 'k-idem')
    expect(a2.json().order_id).toBe(a1.json().order_id)
    expect((await order(app, keyA, 'k-idem', 'ref-1', '999')).statusCode).toBe(409)
    const b1 = await order(app, keyB, 'k-idem') // mesma chave, outro lojista: pedido novo
    expect(b1.statusCode).toBe(201); expect(b1.json().order_id).not.toBe(a1.json().order_id)
  })

  it('webhook exige asaas-access-token', async () => {
    const { app } = await withApp()
    expect((await app.inject({ method: 'POST', url: '/webhooks/asaas', payload: { id: 'e', event: 'PAYMENT_RECEIVED' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/webhooks/asaas', headers: { 'asaas-access-token': 'errado-do-mesmo-tam' }, payload: {} })).statusCode).toBe(401)
  })

  it('8. fluxo completo pela API: pedido, Pix, liquidação e recibo verificável', async () => {
    const { app, keyA } = await withApp()
    const { order_id } = (await order(app, keyA, 'k-full', 'ref-full')).json()
    const ch = (await env.db.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [order_id])).rows[0]
    env.provider.pay(ch.provider_payment_id)
    const w = await app.inject({ method: 'POST', url: '/webhooks/asaas', headers: { 'asaas-access-token': 'tok-webhook-teste' }, payload: asaasEvent('evt_api', 'PAYMENT_RECEIVED', ch.provider_payment_id, 'RECEIVED') })
    expect(w.json()).toEqual({ received: true, duplicate: false })
    await settleAll(env.ctx, env.chain)
    const o = (await app.inject({ method: 'GET', url: `/api/v1/orders/${order_id}`, headers: { authorization: `Bearer ${keyA}` } })).json()
    expect(o.status).toBe('settled')
    expect(o.receipt_id).toMatch(/^rct_/)
    const envl = (await app.inject({ method: 'GET', url: `/r/${o.receipt_id}` })).json()
    expect(await verifyEnvelope(envl, [ISSUER])).toEqual({ ok: true, recovered: ISSUER })
    expect(JSON.stringify(envl)).not.toContain('ref-full') // sem external_ref no recibo público
    const net = BigInt(envl.payload.amounts.net), res = BigInt(envl.payload.amounts.reserve_simulated), gross = BigInt(envl.payload.amounts.gross)
    expect(net + res).toBe(gross)
    const ledger = (await app.inject({ method: 'GET', url: '/api/v1/merchants/me/ledger', headers: { authorization: `Bearer ${keyA}` } })).json()
    expect(ledger.entries.map((e: any) => e.kind).sort()).toEqual(['reserve_simulated', 'settlement_net'])
  })
})
