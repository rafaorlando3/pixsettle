// Contrato v4 (10/10/2026): cotação do LANÇAMENTO. Comissões que nasceram em reais antes do dólar viram dólar pela conversão
// real do lojista (unidades recebidas ÷ centavos pagos), marcadas `launch` com a prova; o summary declara `capabilities`.
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

describe('contrato v4: cotação do lançamento', () => {
  it('fixa pela conversão real, sem taxa de conversão extra, para baixo, com a prova e o modo launch', async () => {
    const e = await env()
    const r = await e.post('/api/v1/affiliates/commissions', commission({ quote: launchQuote() }))
    expect(r.statusCode).toBe(201)
    const c = r.json()
    expect(c.quote.mode).toBe('launch')
    expect(c.quote.source).toBe('conversao_real')
    expect(c.quote.rate_num).toBe('39884516'); expect(c.quote.rate_den).toBe('20848')
    expect(c.quote.fee_bps).toBe(0) // a política tem 1,5%, mas no lançamento o custo já está na conversão
    expect(c.usd.units).toBe(((3657n * 39_884_516n) / 20_848n).toString()) // 6,996... dólares, para baixo
    expect(c.quote.evidence).toEqual({ brl_paid_minor: '20848', usd_units_received: '39884516', tx: ['0x' + TX] })
    const row = (await e.db.query(`SELECT quote_mode, quote_hash, quote_evidence FROM affiliate_commissions WHERE id=$1`, [c.id])).rows[0]
    expect(row.quote_mode).toBe('launch')
    expect(row.quote_hash).toHaveLength(64)
    // projeção pública: sem a prova (lista permitida)
    const pub = (await e.app.inject({ method: 'GET', url: '/pilot/api/affiliates/' + 'aff_' + 'b'.repeat(32) })).json()
    expect(pub.commissions[0].quote.mode).toBe('launch')
    expect(pub.commissions[0].quote.evidence).toBeUndefined()
  })

  it('mesma prova repete 200; prova diferente, ou com e sem lançamento, é conflito 409', async () => {
    const e = await env()
    const body = commission({ quote: launchQuote() })
    expect((await e.post('/api/v1/affiliates/commissions', body)).statusCode).toBe(201)
    expect((await e.post('/api/v1/affiliates/commissions', body)).statusCode).toBe(200)
    const other = await e.post('/api/v1/affiliates/commissions', { ...body, quote: launchQuote({ rate_num: 39_000_000, evidence: { brl_paid_minor: 20_848, usd_units_received: 39_000_000, tx: ['0x' + TX] } }) })
    expect(other.statusCode).toBe(409); expect(other.json().error.code).toBe('idempotency_conflict')
    const without = await e.post('/api/v1/affiliates/commissions', { ...body, quote: undefined })
    expect(without.statusCode).toBe(409)
    // e o contrário: nasceu sem lançamento, não vira lançamento depois
    const plain = commission()
    expect((await e.post('/api/v1/affiliates/commissions', plain)).statusCode).toBe(201)
    expect((await e.post('/api/v1/affiliates/commissions', { ...plain, quote: launchQuote() })).statusCode).toBe(409)
    expect((await e.db.query(`SELECT count(*)::int AS n FROM affiliate_commissions`)).rows[0].n).toBe(2)
  })

  it('recusa antes de qualquer efeito: desligada, modo errado, prova incoerente, velha, no futuro ou longe da cotação viva', async () => {
    const off = await env({ launch: false })
    const r0 = await off.post('/api/v1/affiliates/commissions', commission({ quote: launchQuote() }))
    expect(r0.statusCode).toBe(422); expect(r0.json().error.code).toBe('launch_quote_disabled')
    const e = await env()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ mode: 'at_pix' }, 'invalid_quote_mode'],
      [{ rate_num: 'abc' }, 'invalid_launch_quote'],
      [{ rate_num: 0 }, 'invalid_launch_quote'],
      [{ rate_num: 39_884_517 }, 'invalid_launch_quote'], // não bate com a prova
      [{ evidence: { brl_paid_minor: 20_848, usd_units_received: 39_884_516, tx: [] } }, 'invalid_launch_quote'],
      [{ evidence: { brl_paid_minor: 20_848, usd_units_received: 39_884_516, tx: ['0xabc'] } }, 'invalid_launch_quote'],
      [{ source: 'Fonte Ruim' }, 'invalid_launch_quote'],
      [{ at: new Date(Date.now() + 3_600_000).toISOString() }, 'launch_quote_future'],
      [{ at: new Date(Date.now() - 8 * 86_400_000).toISOString() }, 'launch_quote_stale'],
      [{ rate_num: 34_700_000, evidence: { brl_paid_minor: 20_848, usd_units_received: 34_700_000, tx: ['0x' + TX] } }, 'launch_quote_out_of_band'], // R$ 6,01
    ]
    for (const [over, code] of cases) {
      const r = await e.post('/api/v1/affiliates/commissions', commission({ quote: launchQuote(over) }))
      expect(r.statusCode, JSON.stringify(over)).toBe(422)
      expect(r.json().error.code, JSON.stringify(over)).toBe(code)
    }
    expect((await e.db.query(`SELECT count(*)::int AS n FROM affiliate_commissions`)).rows[0].n).toBe(0)
    expect((await e.db.query(`SELECT count(*)::int AS n FROM affiliate_ledger`)).rows[0].n).toBe(0)
  })

  it('o hash da cotação cobre a prova inteira e números aceitam inteiro ou texto', async () => {
    const e = await env()
    const asText = commission({ quote: launchQuote({ rate_num: '39884516', rate_den: '20848', evidence: { brl_paid_minor: '20848', usd_units_received: '39884516', tx: ['0x' + TX.toUpperCase()] } }) })
    const r = await e.post('/api/v1/affiliates/commissions', asText)
    expect(r.statusCode).toBe(201)
    const at = new Date((asText as any).quote.at as string)
    const h = launchQuoteHash({ rateNum: 39_884_516n, rateDen: 20_848n, source: 'conversao_real', at, evidence: { brlPaidMinor: 20_848n, usdUnitsReceived: 39_884_516n, tx: ['0x' + TX] } })
    expect(r.json().quote.hash).toBe(h)
    expect(launchQuoteHash({ rateNum: 39_884_516n, rateDen: 20_848n, source: 'conversao_real', at, evidence: { brlPaidMinor: 20_848n, usdUnitsReceived: 39_884_516n, tx: ['0x' + TX.replace('5b', '5c')] } })).not.toBe(h)
  })

  it('liberação e saque por Pix seguem iguais para a comissão do lançamento (liquidação desligada)', async () => {
    const e = await env()
    const c = (await e.post('/api/v1/affiliates/commissions', commission({ quote: launchQuote() }))).json()
    const rel = await e.post(`/api/v1/affiliates/commissions/${c.id}/release`, { reason_code: 'usd_launch', occurred_at: new Date().toISOString() })
    expect(rel.statusCode).toBe(200); expect(rel.json().status).toBe('released')
    expect(rel.json().payout.hold_reason).toBe('affiliate_settle_off')
    const ben = (await e.get('/api/v1/affiliates/beneficiaries/aff_' + 'b'.repeat(32))).json()
    expect(ben.balances.available.units).toBe(c.usd.units) // disponível pro saque por Pix mesmo sem liquidar na rede
    const sim = await e.post(`/api/v1/affiliates/beneficiaries/aff_${'b'.repeat(32)}/withdrawals/simulate`, { kind: 'pix', usd_units: c.usd.units })
    expect(sim.statusCode).toBe(200)
    expect(BigInt(sim.json().net_minor)).toBeGreaterThan(3500n)
  })

  it('summary declara contrato v4, capacidades, cotação com price4 e a contagem por modo', async () => {
    const e = await env()
    await e.post('/api/v1/affiliates/commissions', commission({ quote: launchQuote() }))
    await e.post('/api/v1/affiliates/commissions', commission())
    const s = (await e.get('/api/v1/affiliates/summary')).json()
    expect(s.contract).toBe('v4')
    expect(s.capabilities).toEqual(['launch_quote'])
    expect(s.rate_now.price4).toBe('52130')
    expect(s.quote_modes).toEqual({ backfill: 1, launch: 1, at_pix: 0 })
    const off = await env({ launch: false })
    expect((await off.get('/api/v1/affiliates/summary')).json().capabilities).toEqual([])
  })

  it('a migração reversa recusa apagar comissão do lançamento', async () => {
    const e = await env()
    await e.post('/api/v1/affiliates/commissions', commission({ quote: launchQuote() }))
    const down = readFileSync(new URL('../migrations/down/014_affiliate_launch_quote.down.sql', import.meta.url), 'utf8')
    await expect(e.db.query(down)).rejects.toThrow(/launch-quoted commissions exist/)
    const n = (await e.db.query(`SELECT count(*)::int AS n FROM affiliate_commissions WHERE quote_mode='launch'`)).rows[0].n
    expect(n).toBe(1)
  })
})
