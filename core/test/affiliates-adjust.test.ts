// v7.1 (10/10/2026): ajuste para baixo antes da liberação, pela mesma cotação (teto do lojista ou abatimento de valor devido).
import { describe, it, expect, afterEach } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setup } from './helpers.js'
import { buildApp } from '../src/app.js'
import { registerAffiliates } from '../src/affiliates/routes.js'
import { configureAffiliateJournal } from '../src/affiliates/journal.js'
import { SimulatedQuoteSource } from '../src/affiliates/quotes.js'
import { launchQuoteHash } from '../src/affiliates/service.js'

const drops: Array<() => Promise<void>> = []
afterEach(async () => { for (const d of drops.splice(0)) await d() })

const TX = '5b2d9c1e7f3a4b6c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e'

async function env(over: { launch?: boolean; price4?: bigint } = {}) {
  const e = await setup()
  drops.push(e.drop)
  const quotes = new SimulatedQuoteSource(over.price4 ?? 52130n) // R$ 5,2130 por dólar agora
  e.ctx.affiliates = { quotes, settle: false, lockTtlMs: 120_000, launchQuote: over.launch ?? true }
  configureAffiliateJournal({ settle: false })
  const key = 'key-' + randomUUID()
  await e.db.query(`UPDATE merchants SET api_key_hash=$2 WHERE id=$1`, [e.merchantId, createHash('sha256').update(key).digest('hex')])
  await e.db.query(`INSERT INTO affiliate_policies (merchant_id, pool_address, conversion_fee_bps) VALUES ($1, '0x00000000000000000000000000000000000000A1', 150)`, [e.merchantId])
  const app = buildApp(e.ctx, { asaasWebhookToken: 'tok-webhook-teste', diagnosticsToken: 'diag-teste' })
  registerAffiliates(app, e.ctx, { publicMerchantId: e.merchantId })
  const H = { authorization: `Bearer ${key}` }
  const post = (url: string, payload: any = {}) => app.inject({ method: 'POST', url, headers: H, payload })
  const get = (url: string) => app.inject({ method: 'GET', url, headers: H })
  return { ...e, app, quotes, post, get }
}

/** Conversão real de hoje: R$ 208,48 pagos, 39,884516 USDC na tesouraria = R$ 5,2271 por dólar. */
const launchQuote = (over: Record<string, unknown> = {}) => ({
  mode: 'launch', rate_num: 39_884_516, rate_den: 20_848, source: 'conversao_real', at: new Date(Date.now() - 20 * 60_000).toISOString(),
  evidence: { brl_paid_minor: 20_848, usd_units_received: 39_884_516, tx: ['0x' + TX] }, ...over,
})
const commission = (over: Record<string, unknown> = {}) => ({
  source_event_id: 'ar_' + randomUUID().slice(0, 8), beneficiary_ref: 'aff_' + 'b'.repeat(32), kind: 'affiliate', order_ref: 'ord_' + 'c'.repeat(16),
  amount: { amount: '3657', currency: 'BRL', scale: 2 }, occurred_at: '2026-10-09T15:00:00.000Z', ...over,
})

describe('v7.1: ajuste para baixo antes da liberação', () => {
  it('reduz pela mesma cotação e taxa, para baixo, grava no razão e declara a capacidade', async () => {
    const e = await env()
    const c = (await e.post('/api/v1/affiliates/commissions', commission({ amount: { amount: '5000', currency: 'BRL', scale: 2 } }))).json() // sem lançamento: taxa da política (1,5%)
    const r = await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, { amount: { amount: '3000', currency: 'BRL', scale: 2 }, reason_code: 'debt_offset', occurred_at: new Date().toISOString() })
    expect(r.statusCode).toBe(200)
    const a = r.json()
    expect(a.amount.amount).toBe('3000')
    const fee = (3000n * 150n) / 10_000n
    expect(a.usd.units).toBe((((3000n - fee) * BigInt(c.quote.rate_num)) / BigInt(c.quote.rate_den)).toString())
    expect(a.quote.rate_num).toBe(c.quote.rate_num) // mesma cotação
    const led = (await e.db.query(`SELECT kind, usd_units::text AS u FROM affiliate_ledger WHERE ref_id=$1 ORDER BY id`, [c.id])).rows
    expect(led.map(l => l.kind)).toEqual(['credit_pending', 'adjustment'])
    expect(BigInt(led[1].u)).toBe(BigInt(a.usd.units) - BigInt(c.usd.units))
    const ben = (await e.get('/api/v1/affiliates/beneficiaries/' + 'aff_' + 'b'.repeat(32))).json()
    expect(ben.balances.pending.units).toBe(a.usd.units)
    expect((await e.get('/api/v1/affiliates/summary')).json().capabilities).toContain('adjust')
  })

  it('mesmo valor é 200 sem efeito; aumentar, zerar ou ajustar depois de liberada é recusado', async () => {
    const e = await env()
    const c = (await e.post('/api/v1/affiliates/commissions', commission({ quote: launchQuote() }))).json()
    const body = (amount: string) => ({ amount: { amount, currency: 'BRL', scale: 2 }, reason_code: 'capped' })
    expect((await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, body('3000'))).statusCode).toBe(200)
    expect((await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, body('3000'))).statusCode).toBe(200)
    expect((await e.db.query(`SELECT count(*)::int AS n FROM affiliate_ledger WHERE kind='adjustment' AND ref_id=$1`, [c.id])).rows[0].n).toBe(1)
    const up = await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, body('3500'))
    expect(up.statusCode).toBe(409); expect(up.json().error.code).toBe('adjust_increase_refused')
    expect((await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, body('0'))).statusCode).toBe(422)
    expect((await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, { amount: { amount: '100', currency: 'BRL', scale: 2 }, reason_code: 'Motivo Ruim' })).statusCode).toBe(422)
    // lançamento: a cotação do lançamento continua a mesma, sem taxa
    const after = (await e.get(`/api/v1/affiliates/commissions/${c.id}`)).json()
    expect(after.quote.mode).toBe('launch'); expect(after.usd.units).toBe(((3000n * 39_884_516n) / 20_848n).toString())
    await e.post(`/api/v1/affiliates/commissions/${c.id}/release`, {})
    const late = await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, body('2000'))
    expect(late.statusCode).toBe(409); expect(late.json().error.code).toBe('commission_not_pending')
  })
})
