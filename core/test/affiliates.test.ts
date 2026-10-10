// Fase 2: comissões de afiliados em dólar digital (docs/affiliate-payouts.md, seção 7).
import { describe, it, expect, afterEach } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { setup, settleAll } from './helpers.js'
import { buildApp } from '../src/app.js'
import { registerAffiliates } from '../src/affiliates/routes.js'
import { configureAffiliateJournal } from '../src/affiliates/journal.js'
import { resumeAffiliateSettlements } from '../src/affiliates/service.js'
import { drain } from '../src/outbox.js'
import { rollback } from '../src/rollback.js'
import { SimulatedQuoteSource, BinanceUsdtBrlQuoteSource, parsePrice4, makeQuote, quoteSourceFromEnv, BINANCE_PUBLIC_DATA_URL } from '../src/affiliates/quotes.js'
import { fixUsdUnits, pixNet, ratesFromPrice4, fmtUsd, fmtBrl } from '../src/affiliates/money.js'
import { signReceipt, verifyEnvelope } from '../../settlement/src/receipt.js'

const ISSUER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const // chave pública de TESTE
const ISSUER = privateKeyToAccount(ISSUER_KEY).address
const drops: Array<() => Promise<void>> = []
afterEach(async () => { for (const d of drops.splice(0)) await d() })

async function env(over: { settle?: boolean; price4?: bigint; affiliatesOff?: boolean; noPublic?: boolean } = {}) {
  const e = await setup()
  drops.push(e.drop)
  e.ctx.cfg.issuer = { id: 'pixsettle-test', address: ISSUER }
  e.chain.signReceipt = (payload: any) => signReceipt(payload, ISSUER_KEY)
  const quotes = new SimulatedQuoteSource(over.price4 ?? 52000n) // R$ 5,2000 por dólar
  if (!over.affiliatesOff) e.ctx.affiliates = { quotes, settle: over.settle ?? true, lockTtlMs: 120_000 }
  configureAffiliateJournal({ settle: !over.affiliatesOff && (over.settle ?? true) }) // como o server.ts faz na subida
  const key = 'key-' + randomUUID()
  await e.db.query(`UPDATE merchants SET api_key_hash=$2 WHERE id=$1`, [e.merchantId, createHash('sha256').update(key).digest('hex')])
  await e.db.query(`INSERT INTO affiliate_policies (merchant_id, pool_address) VALUES ($1, '0x00000000000000000000000000000000000000A1')`, [e.merchantId])
  const app = buildApp(e.ctx, { asaasWebhookToken: 'tok-webhook-teste', diagnosticsToken: 'diag-teste' })
  registerAffiliates(app, e.ctx, { publicMerchantId: over.noPublic ? null : e.merchantId })
  const H = { authorization: `Bearer ${key}` }
  const post = (url: string, payload: any = {}) => app.inject({ method: 'POST', url, headers: H, payload })
  const get = (url: string) => app.inject({ method: 'GET', url, headers: H })
  const put = (url: string, payload: any) => app.inject({ method: 'PUT', url, headers: H, payload })
  return { ...e, app, quotes, post, get, put }
}
const commission = (over: Record<string, unknown> = {}) => ({
  source_event_id: 'rwd_' + randomUUID().slice(0, 8), beneficiary_ref: 'afl_' + 'a'.repeat(12), kind: 'affiliate', order_ref: 'EQ-1001',
  amount: { amount: '5000', currency: 'BRL', scale: 2 }, occurred_at: '2026-10-09T12:00:00.000Z', ...over,
})

describe('dinheiro: conversão fixada e saque exato (inteiros, para baixo)', () => {
  it('R$ 50,00 a R$ 5,2000 viram 9,615384 dólares; taxa de conversão sai antes', () => {
    const { buy, sell } = ratesFromPrice4(52000n)
    expect(fixUsdUnits(5000n, 0, buy)).toEqual({ usdUnits: 9_615_384n, feeMinor: 0n }) // 50 / 5,2 = 9,615384...
    expect(fixUsdUnits(5000n, 100, buy)).toEqual({ usdUnits: 9_519_230n, feeMinor: 50n }) // 1% = R$ 0,50 a menos
    expect(fmtUsd(9_615_384n)).toBe('9.61')
    const n = pixNet(9_615_384n, sell, 0, 0n)
    expect(n).toEqual({ grossMinor: 4999n, feeMinor: 0n, netMinor: 4999n }) // volta R$ 49,99: o centavo some no arredondamento, nunca aparece
    expect(pixNet(9_615_384n, sell, 100, 50n)).toEqual({ grossMinor: 4999n, feeMinor: 99n, netMinor: 4900n })
    expect(fmtBrl(4900n)).toBe('49.00')
    expect(() => fixUsdUnits(1n, 0, { rateNum: 1n, rateDen: 1_000_000n })).toThrow(/ficou zero/)
    expect(() => pixNet(10n, sell, 0, 1000n)).toThrow(/não positivo/)
  })
  it('preço com 4 casas e cotação da Binance com cache, lado pior e falha explicada', async () => {
    expect(parsePrice4('5.2')).toBe(52000n); expect(parsePrice4('5.20004')).toBe(52000n); expect(parsePrice4('abc')).toBeNull()
    let calls = 0
    const requestedUrls: string[] = []
    const ok = JSON.stringify({ bidPrice: '5.1900', askPrice: '5.2100' })
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => { requestedUrls.push(String(input)); expect((init?.headers as any) ?? {}).toEqual({}); calls++; return new Response(calls === 1 ? ok : 'down', { status: calls === 1 ? 200 : 503 }) }) as unknown as typeof fetch
    const src = new BinanceUsdtBrlQuoteSource({ fetchImpl, maxAgeMs: 1000, staleOkMs: 5000 })
    const t0 = new Date('2026-10-09T12:00:00Z')
    const q1 = await src.quote(t0); expect(q1.ok && q1.quote.price4).toBe(52100n) // compra pelo ask
    expect(q1.ok && q1.quote.sell.rateNum).toBe(51900n) // venda pelo bid
    const q2 = await src.quote(new Date(t0.getTime() + 500)); expect(calls).toBe(1); expect(q2.ok && q2.quote.ageS).toBe(0)
    const q3 = await src.quote(new Date(t0.getTime() + 3000)); expect(calls).toBe(2); expect(q3.ok && q3.quote.ageS).toBe(3) // fora do ar: última boa, com idade
    const q4 = await src.quote(new Date(t0.getTime() + 9000)); expect(q4).toMatchObject({ ok: false, code: 'quote_unavailable', httpStatus: 503 }); expect(!q4.ok && q4.detail).toMatch(/HTTP 503/)
    // E1 (v8): toda chamada, fresca ou com erro, vai ao serviço público de dados da Binance, sem chave e sem cabeçalho de autorização
    expect(requestedUrls).toEqual(Array(3).fill('https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=USDTBRL'))
    expect(src.url).toBe(BINANCE_PUBLIC_DATA_URL)
    expect(makeQuote('simulated', 52000n, t0).hash).toHaveLength(64)
  })
  it('E1 (v8): 451, tempo esgotado, JSON inválido ou ask < bid nunca viram cotação; sem última boa é quote_unavailable com o status HTTP', async () => {
    const t0 = new Date('2026-10-09T12:00:00Z')
    const mk = (fn: () => Promise<Response>) => new BinanceUsdtBrlQuoteSource({ fetchImpl: fn as unknown as typeof fetch, maxAgeMs: 1000, staleOkMs: 5000 })
    const r451 = await mk(async () => new Response('<html>Unavailable For Legal Reasons</html>', { status: 451 })).quote(t0)
    expect(r451).toMatchObject({ ok: false, code: 'quote_unavailable', httpStatus: 451 }); expect(!r451.ok && r451.detail).toMatch(/HTTP 451/)
    const rTimeout = await mk(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) }).quote(t0)
    expect(rTimeout).toMatchObject({ ok: false, code: 'quote_unavailable' }); expect(!rTimeout.ok && rTimeout.httpStatus).toBeUndefined(); expect(!rTimeout.ok && rTimeout.detail).toMatch(/timeout/)
    const rJson = await mk(async () => new Response('not json', { status: 200 })).quote(t0)
    expect(rJson).toMatchObject({ ok: false, code: 'quote_unavailable', httpStatus: 200 })
    const rInverted = await mk(async () => new Response(JSON.stringify({ bidPrice: '5.30', askPrice: '5.20' }), { status: 200 })).quote(t0)
    expect(rInverted).toMatchObject({ ok: false, code: 'quote_unavailable' }); expect(!rInverted.ok && rInverted.detail).toMatch(/bid\/ask/)
    // última boa só dentro da tolerância, com idade explícita; depois dela, falha de novo com o status atual
    let n = 0
    const flaky = mk(async () => { n++; return n === 1 ? new Response(JSON.stringify({ bidPrice: '5.10', askPrice: '5.12' }), { status: 200 }) : new Response('blocked', { status: 451 }) })
    expect(await flaky.quote(t0)).toMatchObject({ ok: true })
    const stale = await flaky.quote(new Date(t0.getTime() + 4000)); expect(stale.ok && stale.quote.ageS).toBe(4)
    const dead = await flaky.quote(new Date(t0.getTime() + 6000)); expect(dead).toMatchObject({ ok: false, httpStatus: 451 })
  })
  it('E1 (v8): a fábrica AFFILIATE_QUOTE_SOURCE=binance_usdtbrl usa o serviço público de dados; AFFILIATE_QUOTE_URL só aceita outro host oficial da Binance com o mesmo caminho', () => {
    const def = quoteSourceFromEnv({ AFFILIATE_QUOTE_SOURCE: 'binance_usdtbrl' }) as BinanceUsdtBrlQuoteSource
    expect(def.name).toBe('binance_usdtbrl'); expect(def.url).toBe('https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=USDTBRL')
    const gcp = quoteSourceFromEnv({ AFFILIATE_QUOTE_SOURCE: 'binance_usdtbrl', AFFILIATE_QUOTE_URL: 'https://api-gcp.binance.com/api/v3/ticker/bookTicker?symbol=USDTBRL' }) as BinanceUsdtBrlQuoteSource
    expect(gcp.url).toBe('https://api-gcp.binance.com/api/v3/ticker/bookTicker?symbol=USDTBRL')
    for (const bad of ['http://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=USDTBRL', 'https://evil.example/api/v3/ticker/bookTicker?symbol=USDTBRL', 'https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCBRL', 'https://data-api.binance.vision.evil.example/api/v3/ticker/bookTicker?symbol=USDTBRL'])
      expect(() => quoteSourceFromEnv({ AFFILIATE_QUOTE_SOURCE: 'binance_usdtbrl', AFFILIATE_QUOTE_URL: bad })).toThrow(/AFFILIATE_QUOTE_URL inválida/)
    expect((quoteSourceFromEnv({ AFFILIATE_QUOTE_SOURCE: 'binance_usdtbrl', AFFILIATE_QUOTE_URL: '  ' }) as BinanceUsdtBrlQuoteSource).url).toBe(BINANCE_PUBLIC_DATA_URL)
    expect(quoteSourceFromEnv({}).name).toBe('simulated')
  })
  // Prova ao vivo, só quando pedida (AFFILIATE_QUOTE_LIVE=1): o serviço público responde USDTBRL fresco, sem chave. Na Render é o smoke do Codex que prova.
  it.skipIf(process.env.AFFILIATE_QUOTE_LIVE !== '1')('E1 (v8) ao vivo: data-api.binance.vision devolve USDTBRL fresco com bid <= ask', async () => {
    const src = new BinanceUsdtBrlQuoteSource()
    const r = await src.quote(new Date())
    expect(r.ok, r.ok ? 'ok' : r.detail).toBe(true)
    if (r.ok) { expect(r.quote.ageS).toBe(0); expect(r.quote.price4 > 10000n && r.quote.price4 < 200000n).toBe(true); expect(r.quote.sell.rateNum <= r.quote.price4).toBe(true) }
  })
})

describe('API: comissão nasce em dólar no Pix, libera, paga na cadeia e emite recibo', () => {
  it('cria idempotente, fixa a cotação, libera, liquida com memo e recibo verificável; rotas somem com o módulo desligado', async () => {
    const e = await env()
    const c = commission()
    const r1 = await e.post('/api/v1/affiliates/commissions', c)
    expect(r1.statusCode).toBe(201)
    const body = r1.json()
    expect(body).toMatchObject({ status: 'pending', amount: { brl: '50.00' }, usd: { units: '9615384', usd: '9.61' }, quote: { source: 'simulated', fee_bps: 0 }, beneficiary_ref: c.beneficiary_ref })
    expect(body.trace.source_event_id).toBe(c.source_event_id)
    e.quotes.set(60000n) // a cotação muda; a comissão já fixada não muda
    const r2 = await e.post('/api/v1/affiliates/commissions', c)
    expect(r2.statusCode).toBe(200); expect(r2.json().usd.units).toBe('9615384'); expect(r2.json().id).toBe(body.id)
    expect((await e.db.query(`SELECT count(*)::int AS n FROM affiliate_commissions`)).rows[0].n).toBe(1)
    const v0 = (await e.get(`/api/v1/affiliates/beneficiaries/${c.beneficiary_ref}`)).json()
    expect(v0.balances).toMatchObject({ pending: { units: '9615384' }, available: { units: '0' } })
    expect(v0.balances.pending.brl_now).toBe('57.69') // R$ pela cotação de agora (6,0000)

    const rel = await e.post(`/api/v1/affiliates/commissions/${body.id}/release`, { occurred_at: '2026-10-11T12:00:00.000Z' })
    expect(rel.statusCode).toBe(200)
    expect(rel.json()).toMatchObject({ status: 'settling', payout: { status: 'intent_recorded', to: '0x00000000000000000000000000000000000000A1' } })
    expect(rel.json().payout.memo.startsWith('0x' + Buffer.from(body.id).toString('hex'))).toBe(true)
    expect((await e.post(`/api/v1/affiliates/commissions/${body.id}/release`)).statusCode).toBe(200) // idempotente
    await settleAll(e.ctx, e.chain)
    const done = (await e.get(`/api/v1/affiliates/commissions/${body.id}`)).json()
    expect(done.status).toBe('settled'); expect(done.payout.status).toBe('confirmed'); expect(done.payout.tx_hash).toMatch(/^0x/); expect(done.payout.receipt_id).toMatch(/^rct_/)
    expect(e.chain.transfersByMemo.get(done.payout.memo)).toBe(1) // exatamente uma transferência por comissão
    const rc = await e.app.inject({ method: 'GET', url: `/pilot/api/affiliates/receipts/${done.payout.receipt_id}` })
    expect(rc.statusCode).toBe(200)
    expect(await verifyEnvelope(rc.json(), [ISSUER])).toEqual({ ok: true, recovered: ISSUER })
    expect(rc.json().payload).toMatchObject({ receipt_type: 'affiliate_commission_payout', commission: { id: body.id, custody: 'pool', amount: { brl: '50.00' }, quote: { mode: 'backfill' } }, amounts: { usd: '9.61' }, beneficiary: { ref: c.beneficiary_ref } })
    expect(JSON.stringify(rc.json())).not.toContain(c.order_ref) // recibo público sem a referência do pedido do lojista
    const v1 = (await e.get(`/api/v1/affiliates/beneficiaries/${c.beneficiary_ref}`)).json()
    expect(v1.balances).toMatchObject({ pending: { units: '0' }, available: { units: '9615384' }, withdrawn: { units: '0' } })
    // público: agregado e beneficiário sem ids de origem
    const agg = (await e.app.inject({ method: 'GET', url: '/pilot/api/affiliates' })).json()
    expect(agg).toMatchObject({ beneficiaries: 1, commissions: 1, by_status: { settled: 1 }, usd_settled_on_chain: { usd: '9.61' }, exceptions_for_human: 0 })
    const pub = (await e.app.inject({ method: 'GET', url: `/pilot/api/affiliates/${c.beneficiary_ref}` })).json()
    expect(pub.commissions[0].source_event_id).toBeUndefined(); expect(pub.commissions[0].order_ref).toBeUndefined(); expect(pub.payout).toEqual({ mode: 'pool' })
    expect(JSON.stringify(pub)).not.toContain(c.source_event_id)
    // módulo desligado: nenhuma rota
    const off = await env({ affiliatesOff: true })
    expect((await off.post('/api/v1/affiliates/commissions', commission())).statusCode).toBe(404)
    expect((await off.app.inject({ method: 'GET', url: '/pilot/api/affiliates' })).statusCode).toBe(404)
  })

  it('corpo inválido, ref pessoal, cotação indisponível e lojista errado são recusados com código e motivo', async () => {
    const e = await env()
    expect((await e.post('/api/v1/affiliates/commissions', commission({ amount: { amount: '12.5', currency: 'BRL' } }))).json().error.code).toBe('invalid_body')
    expect((await e.post('/api/v1/affiliates/commissions', commission({ beneficiary_ref: 'joao' }))).json().error.code).toBe('invalid_beneficiary_ref')
    expect((await e.post('/api/v1/affiliates/commissions', commission({ kind: 'editor' }))).json().error.code).toBe('invalid_kind')
    e.ctx.affiliates!.quotes = { name: 'down', quote: async () => ({ ok: false, code: 'quote_unavailable', detail: 'fonte fora do ar' }) }
    const r = await e.post('/api/v1/affiliates/commissions', commission())
    expect(r.statusCode).toBe(503); expect(r.json().error).toMatchObject({ code: 'quote_unavailable' }); expect(r.json().error.message).toContain('fonte fora do ar')
    expect((await e.app.inject({ method: 'POST', url: '/api/v1/affiliates/commissions', payload: commission() })).statusCode).toBe(401)
    expect((await e.db.query(`SELECT count(*)::int AS n FROM affiliate_commissions`)).rows[0].n).toBe(0)
  })

  it('anulação antes de pagar reverte os mesmos dólares e trava a liquidação; depois de paga vira exceção para humano', async () => {
    const e = await env()
    const a = (await e.post('/api/v1/affiliates/commissions', commission())).json()
    const v = await e.post(`/api/v1/affiliates/commissions/${a.id}/void`, { reason_code: 'order_refunded' })
    expect(v.statusCode).toBe(200); expect(v.json()).toMatchObject({ status: 'voided', reason_code: 'order_refunded' })
    expect((await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)).json().error.code).toBe('commission_not_pending')
    const bal = (await e.get(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}`)).json().balances
    expect(bal).toMatchObject({ pending: { units: '0' }, available: { units: '0' } })
    const ledger = (await e.db.query(`SELECT kind, usd_units::text AS u FROM affiliate_ledger WHERE ref_id=$1 ORDER BY id`, [a.id])).rows
    expect(ledger).toEqual([{ kind: 'credit_pending', u: '9615384' }, { kind: 'void', u: '-9615384' }])
    // liberada e com intenção gravada, nenhuma tentativa ainda: o void encerra a liquidação com motivo e nada vai para a cadeia
    const b = (await e.post('/api/v1/affiliates/commissions', commission({ source_event_id: 'rwd_b' }))).json()
    await e.post(`/api/v1/affiliates/commissions/${b.id}/release`)
    const vb = await e.post(`/api/v1/affiliates/commissions/${b.id}/void`, { reason_code: 'med_claim' })
    expect(vb.statusCode).toBe(200); expect(vb.json()).toMatchObject({ status: 'voided', payout: { status: 'failed', hold_reason: 'commission_voided' } })
    await settleAll(e.ctx, e.chain)
    expect(e.chain.mined.length).toBe(0)
    // paga na cadeia: exceção registrada, nada volta sozinho
    const c2 = (await e.post('/api/v1/affiliates/commissions', commission({ source_event_id: 'rwd_c' }))).json()
    await e.post(`/api/v1/affiliates/commissions/${c2.id}/release`)
    await settleAll(e.ctx, e.chain)
    const r = await e.post(`/api/v1/affiliates/commissions/${c2.id}/void`, { reason_code: 'med_claim' })
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('already_settled')
    expect((await e.get(`/api/v1/affiliates/commissions/${c2.id}`)).json().status).toBe('settled')
    expect((await e.app.inject({ method: 'GET', url: '/pilot/api/affiliates' })).json().exceptions_for_human).toBe(1)
    expect((await e.post(`/api/v1/affiliates/commissions/${c2.id}/void`, { reason_code: 'med_claim' })).statusCode).toBe(409) // repetir não duplica a exceção
    expect((await e.app.inject({ method: 'GET', url: '/pilot/api/affiliates' })).json().exceptions_for_human).toBe(1)
  })

  it('com AFFILIATE_SETTLE desligado a intenção fica gravada com motivo e nada vai para a cadeia', async () => {
    const e = await env({ settle: false })
    const a = (await e.post('/api/v1/affiliates/commissions', commission())).json()
    const rel = (await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)).json()
    expect(rel).toMatchObject({ status: 'released', payout: { status: 'intent_recorded', hold_reason: 'affiliate_settle_off' } })
    await settleAll(e.ctx, e.chain)
    expect(e.chain.mined.length).toBe(0)
    expect((await e.get(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}`)).json().balances.available.units).toBe('9615384')
  })
})

describe('saques: valor exato por Pix, trava de 120 s, pago ou falhou; carteira própria na cadeia', () => {
  async function funded() {
    const e = await env()
    const a = (await e.post('/api/v1/affiliates/commissions', commission())).json()
    await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)
    await settleAll(e.ctx, e.chain)
    return { e, a }
  }
  it('simula com cotação de venda, cria o saque, lojista marca pago; falha devolve o saldo; trava vence e não repete', async () => {
    const { e, a } = await funded()
    await e.db.query(`UPDATE affiliate_policies SET withdrawal_fee_bps=100, withdrawal_fee_minor=50 WHERE merchant_id=$1`, [e.merchantId])
    const sim = await e.post(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}/withdrawals/simulate`, { kind: 'pix', usd_units: '9615384' })
    expect(sim.statusCode).toBe(200)
    expect(sim.json()).toMatchObject({ gross_brl: '49.99', fee_brl: '0.99', net_brl: '49.00', rate: { side: 'sell', source: 'simulated' } })
    expect(sim.json().message).toContain('exatamente R$ 49.00')
    expect((await e.post(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}/withdrawals/simulate`, { kind: 'pix', usd_units: '9615385' })).json().error.code).toBe('insufficient_available')
    const w = await e.post('/api/v1/affiliates/withdrawals', { lock_id: sim.json().lock_id })
    expect(w.statusCode).toBe(201); expect(w.json()).toMatchObject({ kind: 'pix', status: 'requested', net: { brl: '49.00' } })
    expect((await e.post('/api/v1/affiliates/withdrawals', { lock_id: sim.json().lock_id })).json().id).toBe(w.json().id) // idempotente pela trava
    expect((await e.get(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}`)).json().balances).toMatchObject({ available: { units: '0' }, withdrawn: { units: '9615384' } })
    expect((await e.post(`/api/v1/affiliates/withdrawals/${w.json().id}/paid`, { pix_e2e_id: 'E1234567820261009' })).json()).toMatchObject({ status: 'paid', pix_e2e_id: 'E1234567820261009' })
    expect((await e.post(`/api/v1/affiliates/withdrawals/${w.json().id}/failed`, { reason_code: 'bank_rejected' })).json().error.code).toBe('withdrawal_not_requested')
    // segunda comissão: saque falha e o saldo volta
    const b = (await e.post('/api/v1/affiliates/commissions', commission({ source_event_id: 'rwd_b', amount: { amount: '1000', currency: 'BRL' } }))).json()
    await e.post(`/api/v1/affiliates/commissions/${b.id}/release`); await settleAll(e.ctx, e.chain)
    const sim2 = (await e.post(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}/withdrawals/simulate`, { kind: 'pix', usd_units: '1000000' })).json()
    const w2 = (await e.post('/api/v1/affiliates/withdrawals', { lock_id: sim2.lock_id })).json()
    expect((await e.post(`/api/v1/affiliates/withdrawals/${w2.id}/failed`, { reason_code: 'bank_rejected' })).json()).toMatchObject({ status: 'failed', reason_code: 'bank_rejected' })
    expect((await e.get(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}`)).json().balances.available.units).toBe('1923076') // 10,00 / 5,2 = 1,923076
    // trava vencida
    const sim3 = (await e.post(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}/withdrawals/simulate`, { kind: 'pix', usd_units: '1000000' })).json()
    await e.db.query(`UPDATE affiliate_quote_locks SET expires_at=now() - interval '1 second' WHERE id=$1`, [sim3.lock_id])
    const late = await e.post('/api/v1/affiliates/withdrawals', { lock_id: sim3.lock_id })
    expect(late.statusCode).toBe(409); expect(late.json().error.code).toBe('lock_expired')
    const agg = (await e.app.inject({ method: 'GET', url: '/pilot/api/affiliates' })).json()
    expect(agg.withdrawals).toMatchObject({ total: 2, pix_paid_declared: 1, brl_paid_declared: '49.00' })
    expect((await e.get(`/api/v1/affiliates/withdrawals/${w.json().id}`)).json().evidence).toBe('declared_by_merchant') // Pix pago é declaração do lojista
  })
  it('carteira própria: cadastro validado, envio liquidado na cadeia com memo do saque e recibo', async () => {
    const { e, a } = await funded()
    expect((await e.put(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}/wallet`, { address: 'abc' })).json().error.code).toBe('invalid_address')
    expect((await e.post(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}/withdrawals/simulate`, { kind: 'wallet', usd_units: '1000000' })).json().error.code).toBe('no_wallet')
    const own = '0x000000000000000000000000000000000000bEEF'
    expect((await e.put(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}/wallet`, { address: own })).statusCode).toBe(200)
    const sim = (await e.post(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}/withdrawals/simulate`, { kind: 'wallet', usd_units: '9615384' })).json()
    expect(sim).toMatchObject({ kind: 'wallet', net_minor: '0', fee_minor: '0', rate: null })
    const w = (await e.post('/api/v1/affiliates/withdrawals', { lock_id: sim.lock_id })).json()
    expect(w).toMatchObject({ kind: 'wallet', status: 'settling', payout: { to: own, status: 'intent_recorded' } })
    await settleAll(e.ctx, e.chain)
    const done = (await e.get(`/api/v1/affiliates/withdrawals/${w.id}`)).json()
    expect(done).toMatchObject({ status: 'settled', payout: { status: 'confirmed' } }); expect(done.payout.receipt_id).toMatch(/^rct_/)
    expect(e.chain.transfersByMemo.get(done.payout.memo)).toBe(1)
    const rc = (await e.app.inject({ method: 'GET', url: `/pilot/api/affiliates/receipts/${done.payout.receipt_id}` })).json()
    expect(rc.payload).toMatchObject({ receipt_type: 'affiliate_wallet_withdrawal', withdrawal: { id: w.id }, settlement: { recipient_sha256: createHash('sha256').update(own.toLowerCase()).digest('hex') } }); expect(rc.payload.settlement.to).toBeUndefined()
    expect((await e.post(`/api/v1/affiliates/withdrawals/${w.id}/paid`, { pix_e2e_id: 'E12345678' })).json().error.code).toBe('not_pix')
    const pub = (await e.app.inject({ method: 'GET', url: `/pilot/api/affiliates/${a.beneficiary_ref}` })).json()
    expect(pub.payout).toEqual({ mode: 'own_wallet' }); expect(JSON.stringify(pub.payout)).not.toContain('bEEF')
  })
})

describe('revisão 347 (Codex, 09/10): custódia, anulação segura, chaves, projeções públicas e importação', () => {
  const now = () => new Date().toISOString()

  it('P1-1 comissão paga na carteira própria sai do direito disponível: nunca conta duas vezes', async () => {
    const e = await env()
    const ref = 'afl_' + 'b'.repeat(12), own = '0x000000000000000000000000000000000000bEEF'
    const a = (await e.post('/api/v1/affiliates/commissions', commission({ beneficiary_ref: ref }))).json()
    await e.put(`/api/v1/affiliates/beneficiaries/${ref}/wallet`, { address: own })
    const rel = (await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)).json()
    expect(rel).toMatchObject({ custody: 'own_wallet', payout: { to: own } })
    await settleAll(e.ctx, e.chain)
    const v = (await e.get(`/api/v1/affiliates/beneficiaries/${ref}`)).json()
    expect(v.balances).toMatchObject({ available: { units: '0' }, paid_to_own_wallet: { units: '9615384' }, withdrawn: { units: '0' } })
    expect((await e.post(`/api/v1/affiliates/beneficiaries/${ref}/withdrawals/simulate`, { kind: 'pix', usd_units: '1' })).json().error.code).toBe('insufficient_available')
    // a custódia é decidida na liberação: carteira cadastrada DEPOIS não muda uma comissão já no pool
    const b = (await e.post('/api/v1/affiliates/commissions', commission({ beneficiary_ref: 'afl_' + 'c'.repeat(12) }))).json()
    await e.post(`/api/v1/affiliates/commissions/${b.id}/release`); await settleAll(e.ctx, e.chain)
    await e.put(`/api/v1/affiliates/beneficiaries/afl_${'c'.repeat(12)}/wallet`, { address: own })
    expect((await e.get(`/api/v1/affiliates/beneficiaries/afl_${'c'.repeat(12)}`)).json().balances.available.units).toBe('9615384')
  })

  it('P1-2 anulação durante a liquidação: tentativa assinada e não enviada fica suspensa, nada é transmitido; já enviada vira exceção', async () => {
    const e = await env()
    const a = (await e.post('/api/v1/affiliates/commissions', commission())).json()
    await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)
    await drain(e.ctx, 50, ['settle']); await drain(e.ctx, 50, ['sign_attempt']) // nonce reservado e bytes assinados, sem transmitir
    expect((await e.db.query(`SELECT status FROM settlement_attempts`)).rows.map(r => r.status)).toEqual(['signed'])
    const v = await e.post(`/api/v1/affiliates/commissions/${a.id}/void`, { reason_code: 'order_refunded' })
    expect(v.statusCode).toBe(200); expect(v.json()).toMatchObject({ status: 'voided', payout: { hold_reason: 'commission_voided' } })
    await settleAll(e.ctx, e.chain)
    expect(e.chain.mined.length).toBe(0) // os bytes assinados nunca saem
    expect((await e.db.query(`SELECT status FROM settlement_attempts`)).rows[0]).toMatchObject({ status: 'suspended' })
    expect((await e.get(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}`)).json().balances.available.units).toBe('0')
    // a tentativa suspensa pausa a fila da tesouraria (R2): outra comissão espera, com motivo, até uma pessoa resolver
    const c2 = (await e.post('/api/v1/affiliates/commissions', commission({ source_event_id: 'rwd_wait', beneficiary_ref: 'afl_' + 'd'.repeat(12) }))).json()
    await e.post(`/api/v1/affiliates/commissions/${c2.id}/release`); await settleAll(e.ctx, e.chain, 3)
    expect(e.chain.mined.length).toBe(0)
    expect((await e.db.query(`SELECT reason FROM state_transitions WHERE entity='settlement_waiting' ORDER BY id DESC LIMIT 1`)).rows[0].reason).toMatch(/^treasury_paused:/)
    // já transmitida (pendente na rede): recusa com exceção; a reconciliação segue até confirmar
    const f = await env()
    const b = (await f.post('/api/v1/affiliates/commissions', commission({ source_event_id: 'rwd_sent' }))).json()
    await f.post(`/api/v1/affiliates/commissions/${b.id}/release`)
    await drain(f.ctx, 50, ['settle']); await drain(f.ctx, 50, ['sign_attempt']); await drain(f.ctx, 50, ['broadcast_attempt'])
    const sent = (await f.db.query(`SELECT status FROM settlement_attempts`)).rows[0].status
    expect(['broadcast_pending', 'broadcast_sent']).toContain(sent)
    const r = await f.post(`/api/v1/affiliates/commissions/${b.id}/void`, { reason_code: 'order_refunded' })
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('payout_in_flight')
    expect((await f.get(`/api/v1/affiliates/commissions/${b.id}`)).json().status).toBe('settling')
    expect((await f.get('/api/v1/affiliates/summary')).json().exceptions_for_human).toBe(1)
    await settleAll(f.ctx, f.chain)
    expect((await f.get(`/api/v1/affiliates/commissions/${b.id}`)).json().status).toBe('settled'); expect(f.chain.mined.length).toBe(1)
  })

  it('P1-3 anulação com saque Pix pedido nunca deixa saldo negativo: recusa com exceção; saque falhou libera a anulação', async () => {
    const e = await env()
    const a = (await e.post('/api/v1/affiliates/commissions', commission())).json()
    await e.post(`/api/v1/affiliates/commissions/${a.id}/release`) // settling, nenhuma tentativa; o direito já existe no pool
    const sim = (await e.post(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}/withdrawals/simulate`, { kind: 'pix', usd_units: '9615384' })).json()
    const w = (await e.post('/api/v1/affiliates/withdrawals', { lock_id: sim.lock_id })).json()
    const r = await e.post(`/api/v1/affiliates/commissions/${a.id}/void`, { reason_code: 'order_refunded' })
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('withdrawal_in_progress')
    // recusa sem NENHUM efeito econômico: comissão, liquidação, tentativas e razão intactas; só a exceção durável
    const after = (await e.get(`/api/v1/affiliates/commissions/${a.id}`)).json()
    expect(after).toMatchObject({ status: 'settling', reason_code: null, voided_at: null, payout: { status: 'intent_recorded', hold_reason: null } })
    expect((await e.db.query(`SELECT count(*)::int AS n FROM settlement_attempts`)).rows[0].n).toBe(0)
    expect((await e.db.query(`SELECT kind FROM affiliate_ledger ORDER BY id`)).rows.map(r => r.kind)).toEqual(['credit_pending', 'release', 'withdraw_pix'])
    expect((await e.db.query(`SELECT count(*)::int AS n FROM state_transitions WHERE entity='settlement' AND entity_id=$1`, [after.payout.settlement_id])).rows[0].n).toBe(1) // só a intenção
    expect((await e.get(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}`)).json().balances.available.units).toBe('0')
    expect((await e.get('/api/v1/affiliates/summary')).json().exceptions_for_human).toBe(1)
    // saque falhou: o saldo volta e a anulação passa (liquidação encerrada, nada na cadeia)
    await e.post(`/api/v1/affiliates/withdrawals/${w.id}/failed`, { reason_code: 'bank_rejected' })
    expect((await e.get(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}`)).json().balances.available.units).toBe('9615384')
    expect((await e.post(`/api/v1/affiliates/commissions/${a.id}/void`, { reason_code: 'order_refunded' })).json()).toMatchObject({ status: 'voided', payout: { status: 'failed' } })
    await settleAll(e.ctx, e.chain); expect(e.chain.mined.length).toBe(0)
    expect((await e.get(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}`)).json().balances.available.units).toBe('0')
    // já paga na cadeia + saque pago: already_settled (exceção), saldo nunca negativo
    const g = await env()
    const c = (await g.post('/api/v1/affiliates/commissions', commission())).json()
    await g.post(`/api/v1/affiliates/commissions/${c.id}/release`); await settleAll(g.ctx, g.chain)
    const sim2 = (await g.post(`/api/v1/affiliates/beneficiaries/${c.beneficiary_ref}/withdrawals/simulate`, { kind: 'pix', usd_units: '9615384' })).json()
    const w2 = (await g.post('/api/v1/affiliates/withdrawals', { lock_id: sim2.lock_id })).json()
    await g.post(`/api/v1/affiliates/withdrawals/${w2.id}/paid`, { pix_e2e_id: 'E1234567820261009' })
    expect((await g.post(`/api/v1/affiliates/commissions/${c.id}/void`, { reason_code: 'order_refunded' })).json().error.code).toBe('already_settled')
    expect((await g.get(`/api/v1/affiliates/beneficiaries/${c.beneficiary_ref}`)).json().balances.available.units).toBe('0')
    // comissão liberada (sem liquidação) com saque pedido: também recusa
    const off = await env({ settle: false })
    const b = (await off.post('/api/v1/affiliates/commissions', commission())).json()
    await off.post(`/api/v1/affiliates/commissions/${b.id}/release`)
    const sim3 = (await off.post(`/api/v1/affiliates/beneficiaries/${b.beneficiary_ref}/withdrawals/simulate`, { kind: 'pix', usd_units: '9615384' })).json()
    await off.post('/api/v1/affiliates/withdrawals', { lock_id: sim3.lock_id })
    expect((await off.post(`/api/v1/affiliates/commissions/${b.id}/void`, { reason_code: 'order_refunded' })).json().error.code).toBe('withdrawal_in_progress')
  })

  it('P1-4/P1-5 chave de liquidação: ausente = nada assina nem transmite, inclusive jobs já na fila; réplica pública recusa escritas', async () => {
    const e = await env()
    const a = (await e.post('/api/v1/affiliates/commissions', commission())).json()
    await e.post(`/api/v1/affiliates/commissions/${a.id}/release`) // settling, job na fila
    configureAffiliateJournal({ settle: false }); e.ctx.affiliates!.settle = false // a instalação reinicia sem AFFILIATE_SETTLE=1
    await settleAll(e.ctx, e.chain)
    expect(e.chain.mined.length).toBe(0)
    expect((await e.db.query(`SELECT reason FROM state_transitions WHERE entity='settlement_blocked' ORDER BY id DESC LIMIT 1`)).rows[0].reason).toContain('affiliate_settle_off')
    expect((await e.get('/api/v1/affiliates/summary')).json().evidence.settlement).toBe('disabled')
    configureAffiliateJournal({ settle: true }); e.ctx.affiliates!.settle = true
    expect(await resumeAffiliateSettlements(e.ctx)).toBe(1) // o server.ts faz isso na subida com AFFILIATE_SETTLE=1
    await settleAll(e.ctx, e.chain)
    expect((await e.get(`/api/v1/affiliates/commissions/${a.id}`)).json().status).toBe('settled')
    // intenção gravada com a chave desligada também retoma
    const off = await env({ settle: false })
    const b = (await off.post('/api/v1/affiliates/commissions', commission())).json()
    expect((await off.post(`/api/v1/affiliates/commissions/${b.id}/release`)).json()).toMatchObject({ status: 'released', payout: { hold_reason: 'affiliate_settle_off' } })
    configureAffiliateJournal({ settle: true }); off.ctx.affiliates!.settle = true
    expect(await resumeAffiliateSettlements(off.ctx)).toBe(1)
    expect((await off.get(`/api/v1/affiliates/commissions/${b.id}`)).json()).toMatchObject({ status: 'settling', payout: { hold_reason: null } })
    await settleAll(off.ctx, off.chain)
    expect((await off.get(`/api/v1/affiliates/commissions/${b.id}`)).json().status).toBe('settled')
    // réplica pública sem opt-in E AFFILIATE_SETTLE=1: a autorização é uma só; intenção e tentativa já existentes não andam, resume não retoma
    const ro = await env()
    const c = (await ro.post('/api/v1/affiliates/commissions', commission())).json()
    await ro.post(`/api/v1/affiliates/commissions/${c.id}/release`)
    await drain(ro.ctx, 50, ['settle']); await drain(ro.ctx, 50, ['sign_attempt']) // tentativa assinada, nada enviado
    ro.ctx.affiliates!.writes = false; configureAffiliateJournal({ settle: true, writes: false }) // como o server.ts configura na réplica
    expect(await resumeAffiliateSettlements(ro.ctx)).toBe(0)
    await settleAll(ro.ctx, ro.chain)
    expect(ro.chain.mined.length).toBe(0)
    expect((await ro.db.query(`SELECT status FROM settlement_attempts`)).rows[0].status).toBe('suspended') // R2: bytes e nonce preservados, nada transmitido
    expect((await ro.get('/api/v1/affiliates/summary')).json().evidence.settlement).toBe('disabled')
    const d = (await ro.post('/api/v1/affiliates/commissions', commission({ source_event_id: 'rwd_d' }))); expect(d.statusCode).toBe(403)
    // réplica pública sem opt-in: leitura segue, escrita 403 com código
    e.ctx.affiliates!.writes = false
    const w = await e.post('/api/v1/affiliates/commissions', commission({ source_event_id: 'rwd_ro' }))
    expect(w.statusCode).toBe(403); expect(w.json().error.code).toBe('affiliates_read_only')
    expect((await e.post(`/api/v1/affiliates/commissions/${a.id}/void`, { reason_code: 'x_y' })).statusCode).toBe(403)
    expect((await e.get(`/api/v1/affiliates/commissions/${a.id}`)).statusCode).toBe(200)
    expect((await e.app.inject({ method: 'GET', url: '/pilot/api/affiliates' })).statusCode).toBe(200)
  })

  it('P1-6 a migração reversa recusa apagar estado econômico', async () => {
    const e = await env()
    await e.post('/api/v1/affiliates/commissions', commission())
    // v7.2: a 015 (valor original) é a última; sem comissão ajustada ela volta; a 014 (cotação do lançamento) volta sem
    // comissão do lançamento, e aí a 013 recusa
    await rollback(e.db, '015_affiliate_created_amount.sql')
    await rollback(e.db, '014_affiliate_launch_quote.sql')
    await expect(rollback(e.db, '013_affiliate_payouts.sql')).rejects.toThrow(/refusing to drop/)
    expect((await e.db.query(`SELECT count(*)::int AS n FROM affiliate_commissions`)).rows[0].n).toBe(1)
    expect((await e.db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name='013_affiliate_payouts.sql'`)).rows[0].n).toBe(1)
  })

  it('P1-7/P1-8 público: lista permitida (sem destino, sem id do Pix, sem ids do lojista), recibos só do lojista público, nada sem lojista público', async () => {
    const e = await env()
    const a = (await e.post('/api/v1/affiliates/commissions', commission())).json()
    await e.post(`/api/v1/affiliates/commissions/${a.id}/release`); await settleAll(e.ctx, e.chain)
    const sim = (await e.post(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}/withdrawals/simulate`, { kind: 'pix', usd_units: '1000000' })).json()
    const w = (await e.post('/api/v1/affiliates/withdrawals', { lock_id: sim.lock_id })).json()
    await e.post(`/api/v1/affiliates/withdrawals/${w.id}/paid`, { pix_e2e_id: 'E9999999920261009' })
    const pub = (await e.app.inject({ method: 'GET', url: `/pilot/api/affiliates/${a.beneficiary_ref}` })).json()
    const text = JSON.stringify(pub)
    expect(text).not.toContain('0x00000000000000000000000000000000000000A1'); expect(text).not.toContain('E9999999920261009')
    expect(text).not.toContain(a.source_event_id); expect(text).not.toContain('EQ-1001')
    expect(Object.keys(pub.commissions[0]).sort()).toEqual(['amount', 'custody', 'id', 'occurred_at', 'payout', 'quote', 'reason_code', 'released_at', 'status', 'usd', 'voided_at'])
    expect(Object.keys(pub.commissions[0].payout).sort()).toEqual(['hold_reason', 'memo', 'receipt_id', 'status', 'tx_hash'])
    expect(pub.withdrawals[0]).toMatchObject({ kind: 'pix', status: 'paid', evidence: 'declared_by_merchant' }); expect(pub.withdrawals[0].pix_e2e_id).toBeUndefined()
    expect((await e.app.inject({ method: 'GET', url: '/pilot/api/affiliates/joao' })).statusCode).toBe(404)
    // recibo de outro lojista não aparece no público deste
    const other = await env()
    const b = (await other.post('/api/v1/affiliates/commissions', commission())).json()
    await other.post(`/api/v1/affiliates/commissions/${b.id}/release`); await settleAll(other.ctx, other.chain)
    const rid = (await other.get(`/api/v1/affiliates/commissions/${b.id}`)).json().payout.receipt_id
    expect((await other.app.inject({ method: 'GET', url: `/pilot/api/affiliates/receipts/${rid}` })).statusCode).toBe(200)
    await e.db.query(`INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ('mer_OUTRO', 'Outro', 'x', '0x8ee643c15C603856A76d05020b5ccB0FceA425BF')`)
    await e.db.query(`UPDATE affiliate_beneficiaries SET merchant_id='mer_OUTRO'`) // o beneficiário passa a ser de outro lojista
    expect((await e.app.inject({ method: 'GET', url: `/pilot/api/affiliates/receipts/${pub.commissions[0].payout.receipt_id}` })).statusCode).toBe(404)
    expect((await e.app.inject({ method: 'GET', url: `/pilot/api/affiliates/${a.beneficiary_ref}` })).statusCode).toBe(404)
    // sem lojista público: nenhuma rota pública
    const np = await env({ noPublic: true })
    expect((await np.app.inject({ method: 'GET', url: '/pilot/api/affiliates' })).statusCode).toBe(404)
    expect((await np.post('/api/v1/affiliates/commissions', commission())).statusCode).toBe(201)
  })

  it('P1-9/P2-11/P2-12 pseudônimo opaco obrigatório, mesmo id com conteúdo diferente é conflito, repetição concorrente cria uma só', async () => {
    const e = await env()
    for (const bad of ['afl_abc', 'afl_' + 'A'.repeat(12), 'ben-' + 'a'.repeat(12), 'cpf_12345678901', 'maria.silva']) {
      expect((await e.post('/api/v1/affiliates/commissions', commission({ beneficiary_ref: bad }))).json().error.code).toBe('invalid_beneficiary_ref')
    }
    const c = commission()
    const first = (await e.post('/api/v1/affiliates/commissions', c)).json()
    const conflict = await e.post('/api/v1/affiliates/commissions', { ...c, amount: { amount: '9999', currency: 'BRL', scale: 2 } })
    expect(conflict.statusCode).toBe(409); expect(conflict.json().error.code).toBe('idempotency_conflict')
    expect((await e.post('/api/v1/affiliates/commissions', { ...c, beneficiary_ref: 'afl_' + 'e'.repeat(12) })).json().error.code).toBe('idempotency_conflict')
    expect((await e.get(`/api/v1/affiliates/commissions/${first.id}`)).json().usd.units).toBe('9615384')
    const d = commission({ source_event_id: 'rwd_race' })
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => e.post('/api/v1/affiliates/commissions', d)))
    expect(rs.filter(r => r.statusCode === 201).length).toBe(1); expect(rs.every(r => [200, 201].includes(r.statusCode))).toBe(true)
    expect(new Set(rs.map(r => r.json().id)).size).toBe(1)
    expect((await e.db.query(`SELECT count(*)::int AS n FROM affiliate_commissions WHERE source_event_id='rwd_race'`)).rows[0].n).toBe(1)
  })

  it('P2-10 cotação é "no Pix" só quando o evento chega até 15 min depois; importação histórica fica marcada backfill', async () => {
    const e = await env()
    const live = (await e.post('/api/v1/affiliates/commissions', commission({ occurred_at: now() }))).json()
    expect(live.quote.mode).toBe('at_pix')
    const old = (await e.post('/api/v1/affiliates/commissions', commission({ source_event_id: 'rwd_old', occurred_at: '2026-10-01T10:00:00.000Z' }))).json()
    expect(old.quote.mode).toBe('backfill')
    expect((await e.get('/api/v1/affiliates/summary')).json().quote_modes).toEqual({ at_pix: 1, backfill: 1, launch: 0 })
  })
})

describe('pagamento refeito: liquidação falhada ganha nova intenção para a mesma comissão, sem débito novo', () => {
  it('max_attempts no diário -> retry-payout cria nova liquidação e paga; recusas: não falhada, tentativa em voo, anulada', async () => {
    const e = await env()
    const a = (await e.post('/api/v1/affiliates/commissions', commission())).json()
    await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)
    const stl = (await e.get(`/api/v1/affiliates/commissions/${a.id}`)).json().payout.settlement_id
    expect((await e.post(`/api/v1/affiliates/commissions/${a.id}/retry-payout`)).json().error.code).toBe('payout_not_failed')
    // o diário desistiu (como faz depois de maxAttemptsPerSettlement tentativas revertidas)
    await e.db.query(`UPDATE settlements SET status='failed', hold_reason='max_attempts' WHERE id=$1`, [stl])
    await e.db.query(`DELETE FROM outbox WHERE entity_id=$1`, [stl])
    const r = await e.post(`/api/v1/affiliates/commissions/${a.id}/retry-payout`)
    expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ status: 'settling', payout: { status: 'intent_recorded', hold_reason: null } })
    const oldMemo = (await e.db.query(`SELECT memo FROM settlements WHERE id=$1`, [stl])).rows[0].memo as string
    expect(r.json().payout.settlement_id).not.toBe(stl); expect(r.json().payout.memo.slice(0, 62)).toBe(oldMemo.slice(0, 62)); expect(Buffer.from(r.json().payout.memo.slice(2), 'hex').toString('ascii')).toBe(a.id + '-2')
    await settleAll(e.ctx, e.chain)
    const done = (await e.get(`/api/v1/affiliates/commissions/${a.id}`)).json()
    expect(done.status).toBe('settled'); expect(e.chain.transfersByMemo.get(done.payout.memo)).toBe(1) // uma transferência só
    const ledger = (await e.db.query(`SELECT kind FROM affiliate_ledger WHERE beneficiary_id=(SELECT beneficiary_id FROM affiliate_commissions WHERE id=$1) ORDER BY id`, [a.id])).rows.map(r => r.kind)
    expect(ledger).toEqual(['credit_pending', 'release', 'settle']) // nada debitado ou creditado a mais
    expect((await e.get(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}`)).json().balances.available.units).toBe('9615384')
    // tentativa que pode ter saído na liquidação antiga: recusa
    const b = (await e.post('/api/v1/affiliates/commissions', commission({ source_event_id: 'rwd_b', beneficiary_ref: 'afl_' + 'f'.repeat(12) }))).json()
    await e.post(`/api/v1/affiliates/commissions/${b.id}/release`)
    const stl2 = (await e.get(`/api/v1/affiliates/commissions/${b.id}`)).json().payout.settlement_id
    await e.db.query(`UPDATE settlements SET status='failed', hold_reason='max_attempts' WHERE id=$1`, [stl2])
    await e.db.query(`INSERT INTO settlement_attempts (id, settlement_id, attempt_no, chain_id, sender, nonce_key, nonce, status) VALUES ('att_x', $1, 1, $2, $3, 0, 99, 'unknown')`, [stl2, e.ctx.chain.chainId, e.ctx.chain.treasury])
    expect((await e.post(`/api/v1/affiliates/commissions/${b.id}/retry-payout`)).json().error.code).toBe('payout_in_flight')
    // anulada: recusa
    const c = (await e.post('/api/v1/affiliates/commissions', commission({ source_event_id: 'rwd_c', beneficiary_ref: 'afl_' + '0'.repeat(12) }))).json()
    await e.post(`/api/v1/affiliates/commissions/${c.id}/void`, { reason_code: 'order_refunded' })
    expect((await e.post(`/api/v1/affiliates/commissions/${c.id}/retry-payout`)).json().error.code).toBe('commission_not_payable')
  })
})

describe('revisão 347 v4 (Codex X-1030): corrida da anulação, recibos por vínculo real e sem destino', () => {
  it('1. anulação que chega enquanto o worker grava broadcast_pending espera a trava e recusa: nada transmitido "depois de um 200"', async () => {
    const e = await env()
    const a = (await e.post('/api/v1/affiliates/commissions', commission())).json()
    await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)
    await drain(e.ctx, 50, ['settle']); await drain(e.ctx, 50, ['sign_attempt'])
    const stl = (await e.get(`/api/v1/affiliates/commissions/${a.id}`)).json().payout.settlement_id
    const att = (await e.db.query(`SELECT id FROM settlement_attempts WHERE settlement_id=$1`, [stl])).rows[0].id
    // "worker" no meio do pré-envio: trava a liquidação e a tentativa, grava broadcast_pending e ainda não comitou
    const worker = await e.db.connect()
    await worker.query('BEGIN')
    await worker.query(`SELECT id FROM settlements WHERE id=$1 FOR UPDATE`, [stl])
    await worker.query(`SELECT id FROM settlement_attempts WHERE id=$1 FOR UPDATE`, [att])
    await worker.query(`UPDATE settlement_attempts SET status='broadcast_pending' WHERE id=$1`, [att])
    let settled = false
    const voidReq = e.post(`/api/v1/affiliates/commissions/${a.id}/void`, { reason_code: 'order_refunded' }).then(r => { settled = true; return r })
    await new Promise(r => setTimeout(r, 400))
    expect(settled).toBe(false) // a anulação está esperando a trava da liquidação, não decidiu com a contagem antiga
    await worker.query('COMMIT'); worker.release()
    const r = await voidReq
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('payout_in_flight')
    expect((await e.get(`/api/v1/affiliates/commissions/${a.id}`)).json()).toMatchObject({ status: 'settling', payout: { hold_reason: null } })
    expect((await e.db.query(`SELECT status FROM settlement_attempts WHERE id=$1`, [att])).rows[0].status).toBe('broadcast_pending')
    // ordem inversa: a anulação chega antes do pré-envio; o worker vê o hold e suspende (coberto também em P1-2)
    const f = await env()
    const b = (await f.post('/api/v1/affiliates/commissions', commission())).json()
    await f.post(`/api/v1/affiliates/commissions/${b.id}/release`)
    await drain(f.ctx, 50, ['settle']); await drain(f.ctx, 50, ['sign_attempt'])
    expect((await f.post(`/api/v1/affiliates/commissions/${b.id}/void`, { reason_code: 'order_refunded' })).statusCode).toBe(200)
    await drain(f.ctx, 50, ['broadcast_attempt'])
    expect((await f.db.query(`SELECT status FROM settlement_attempts`)).rows[0].status).toBe('suspended'); expect(f.chain.mined.length).toBe(0)
  })

  it('3. recibo pertence ao lojista pelo vínculo comissão/saque -> beneficiário; dois lojistas com a mesma referência não se cruzam', async () => {
    const A = await env(), B = await env()
    const ref = 'afl_' + '9'.repeat(12)
    const ca = (await A.post('/api/v1/affiliates/commissions', commission({ beneficiary_ref: ref }))).json()
    const cb = (await B.post('/api/v1/affiliates/commissions', commission({ beneficiary_ref: ref }))).json()
    await A.post(`/api/v1/affiliates/commissions/${ca.id}/release`); await settleAll(A.ctx, A.chain)
    await B.post(`/api/v1/affiliates/commissions/${cb.id}/release`); await settleAll(B.ctx, B.chain)
    const ra = (await A.get(`/api/v1/affiliates/commissions/${ca.id}`)).json().payout.receipt_id
    const rb = (await B.get(`/api/v1/affiliates/commissions/${cb.id}`)).json().payout.receipt_id
    expect(ra).toMatch(/^rct_/); expect(rb).toMatch(/^rct_/)
    // os dois bancos são separados; para o cruzamento real, o recibo de B é copiado para o banco de A como se fosse outro lojista com a mesma ref
    await A.db.query(`INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ('mer_B', 'B', 'hb', '0x8ee643c15C603856A76d05020b5ccB0FceA425BF')`)
    await A.db.query(`INSERT INTO affiliate_beneficiaries (id, merchant_id, beneficiary_ref, kind) VALUES ('ben_B', 'mer_B', $1, 'affiliate')`, [ref])
    const sB = (await B.db.query(`SELECT * FROM settlements WHERE kind='affiliate_payout'`)).rows[0]
    await A.db.query(`INSERT INTO settlements (id, order_id, kind, beneficiary_ref, chain_id, token, sender, recipient, amount_units, memo, status) VALUES ($1,NULL,'affiliate_payout',$2,$3,$4,$5,$6,$7,$8,'confirmed')`,
      [sB.id, ref, sB.chain_id, sB.token, sB.sender, sB.recipient, String(sB.amount_units), sB.memo])
    const cB = (await B.db.query(`SELECT * FROM affiliate_commissions`)).rows[0]
    await A.db.query(`INSERT INTO affiliate_commissions (id, merchant_id, beneficiary_id, source_event_id, amount_minor, created_amount_minor, usd_units, rate_num, rate_den, quote_source, quote_at, quote_hash, status, occurred_at, settlement_id)
      VALUES ($1,'mer_B','ben_B',$2,$3,$12,$4,$5,$6,$7,$8,$9,'settled',$10,$11)`, [cB.id, cB.source_event_id, cB.amount_minor, cB.usd_units, cB.rate_num, cB.rate_den, cB.quote_source, cB.quote_at, cB.quote_hash, cB.occurred_at, sB.id, cB.created_amount_minor])
    const rcB = (await B.db.query(`SELECT * FROM affiliate_receipts`)).rows[0]
    await A.db.query(`INSERT INTO affiliate_receipts (id, settlement_id, commission_id, digest_hex, envelope) VALUES ($1,$2,$3,$4,$5)`, [rcB.id, sB.id, cB.id, rcB.digest_hex, JSON.stringify(rcB.envelope)])
    // no banco de A: lojista A e lojista B têm a mesma ref; o recibo de B não aparece para A (API nem público), e o de A segue visível
    expect((await A.get(`/api/v1/affiliates/receipts/${rb}`)).statusCode).toBe(404)
    expect((await A.app.inject({ method: 'GET', url: `/pilot/api/affiliates/receipts/${rb}` })).statusCode).toBe(404)
    expect((await A.get(`/api/v1/affiliates/receipts/${ra}`)).statusCode).toBe(200)
    expect((await A.app.inject({ method: 'GET', url: `/pilot/api/affiliates/receipts/${ra}` })).statusCode).toBe(200)
  })

  it('4. o recibo assinado nunca carrega o destino: carteira própria e saque para carteira saem só como compromisso sha256 e tx na cadeia', async () => {
    const e = await env()
    const own = '0x000000000000000000000000000000000000bEEF'
    const a = (await e.post('/api/v1/affiliates/commissions', commission())).json()
    await e.put(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}/wallet`, { address: own })
    await e.post(`/api/v1/affiliates/commissions/${a.id}/release`); await settleAll(e.ctx, e.chain)
    const b = (await e.post('/api/v1/affiliates/commissions', commission({ source_event_id: 'rwd_pool', beneficiary_ref: 'afl_' + '7'.repeat(12) }))).json()
    await e.post(`/api/v1/affiliates/commissions/${b.id}/release`); await settleAll(e.ctx, e.chain)
    await e.put(`/api/v1/affiliates/beneficiaries/${b.beneficiary_ref}/wallet`, { address: own })
    const sim = (await e.post(`/api/v1/affiliates/beneficiaries/${b.beneficiary_ref}/withdrawals/simulate`, { kind: 'wallet', usd_units: '1000000' })).json()
    const w = (await e.post('/api/v1/affiliates/withdrawals', { lock_id: sim.lock_id })).json(); await settleAll(e.ctx, e.chain)
    const ids = [(await e.get(`/api/v1/affiliates/commissions/${a.id}`)).json().payout.receipt_id, (await e.get(`/api/v1/affiliates/withdrawals/${w.id}`)).json().payout.receipt_id]
    for (const id of ids) {
      const pub = await e.app.inject({ method: 'GET', url: `/pilot/api/affiliates/receipts/${id}` })
      expect(pub.statusCode).toBe(200)
      const text = JSON.stringify(pub.json()).toLowerCase()
      expect(text).not.toContain(own.slice(2).toLowerCase()); expect(text).not.toContain('"to"')
      expect(pub.json().payload.settlement.recipient_sha256).toBe(createHash('sha256').update(own.toLowerCase()).digest('hex'))
      expect(await verifyEnvelope(pub.json(), [ISSUER])).toEqual({ ok: true, recovered: ISSUER }) // o artefato público É o assinado, sem campo removido
    }
  })
})

describe('revisão 349 dedicada (Codex X-1037/X-1042/X-1044): vínculo lido sob a trava, primeira intenção tardia, lançador', () => {
  it('1. pagamento refeito (S0 -> S1) com a reconciliação segurando S1 e a comissão: a anulação espera e decide sem impasse (sem 40P01)', async () => {
    const e = await env()
    const a = (await e.post('/api/v1/affiliates/commissions', commission())).json()
    await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)
    const s0 = (await e.get(`/api/v1/affiliates/commissions/${a.id}`)).json().payout.settlement_id
    await e.db.query(`UPDATE settlements SET status='failed', hold_reason='max_attempts' WHERE id=$1`, [s0]); await e.db.query(`DELETE FROM outbox WHERE entity_id=$1`, [s0])
    const s1 = (await e.post(`/api/v1/affiliates/commissions/${a.id}/retry-payout`)).json().payout.settlement_id
    expect(s1).not.toBe(s0)
    // "reconciliação" segura S1 e depois a comissão (ordem do diário) e fica parada
    const rec = await e.db.connect(); await rec.query('BEGIN')
    await rec.query(`SELECT id FROM settlements WHERE id=$1 FOR UPDATE`, [s1])
    await rec.query(`SELECT id FROM affiliate_commissions WHERE settlement_id=$1 FOR UPDATE`, [s1])
    let done = false
    const voidReq = e.post(`/api/v1/affiliates/commissions/${a.id}/void`, { reason_code: 'order_refunded' }).then(r => { done = true; return r })
    await new Promise(r => setTimeout(r, 400)); expect(done).toBe(false)
    await rec.query('COMMIT'); rec.release()
    const r = await voidReq
    expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ status: 'voided', payout: { settlement_id: s1, status: 'failed', hold_reason: 'commission_voided' } })
    await settleAll(e.ctx, e.chain); expect(e.chain.mined.length).toBe(0)
    // mesma espera com uma tentativa de S1 já em voo: recusa 409, estado íntegro
    const f = await env()
    const b = (await f.post('/api/v1/affiliates/commissions', commission())).json()
    await f.post(`/api/v1/affiliates/commissions/${b.id}/release`)
    const t0 = (await f.get(`/api/v1/affiliates/commissions/${b.id}`)).json().payout.settlement_id
    await f.db.query(`UPDATE settlements SET status='failed', hold_reason='max_attempts' WHERE id=$1`, [t0]); await f.db.query(`DELETE FROM outbox WHERE entity_id=$1`, [t0])
    const t1 = (await f.post(`/api/v1/affiliates/commissions/${b.id}/retry-payout`)).json().payout.settlement_id
    await drain(f.ctx, 50, ['settle']); await drain(f.ctx, 50, ['sign_attempt'])
    const att = (await f.db.query(`SELECT id FROM settlement_attempts WHERE settlement_id=$1`, [t1])).rows[0].id
    const w = await f.db.connect(); await w.query('BEGIN')
    await w.query(`SELECT id FROM settlements WHERE id=$1 FOR UPDATE`, [t1]); await w.query(`SELECT id FROM settlement_attempts WHERE id=$1 FOR UPDATE`, [att])
    await w.query(`UPDATE settlement_attempts SET status='broadcast_pending' WHERE id=$1`, [att])
    const v2 = f.post(`/api/v1/affiliates/commissions/${b.id}/void`, { reason_code: 'order_refunded' })
    await new Promise(r => setTimeout(r, 300)); await w.query('COMMIT'); w.release()
    const r2 = await v2
    expect(r2.statusCode).toBe(409); expect(r2.json().error.code).toBe('payout_in_flight')
    expect((await f.get(`/api/v1/affiliates/commissions/${b.id}`)).json()).toMatchObject({ status: 'settling', payout: { settlement_id: t1, hold_reason: null } })
    expect((await f.db.query(`SELECT count(*)::int AS n FROM settlement_attempts WHERE status='broadcast_pending'`)).rows[0].n).toBe(1)
  })

  it('B. liberada sem destino: quando o pool (ou a carteira) aparece, release ou retry criam exatamente UMA intenção, custódia fixa, sem crédito novo', async () => {
    const e = await env()
    await e.db.query(`UPDATE affiliate_policies SET pool_address=NULL WHERE merchant_id=$1`, [e.merchantId])
    const a = (await e.post('/api/v1/affiliates/commissions', commission())).json()
    const rel = (await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)).json()
    expect(rel).toMatchObject({ status: 'released', custody: 'pool', payout: null })
    expect((await e.post(`/api/v1/affiliates/commissions/${a.id}/retry-payout`)).json().error.code).toBe('no_payout_address')
    expect((await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)).json().payout).toBeNull() // idempotente, ainda sem destino
    // carteira cadastrada DEPOIS não muda a custódia (pool); só o pool do lojista destrava
    await e.put(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}/wallet`, { address: '0x000000000000000000000000000000000000bEEF' })
    expect((await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)).json()).toMatchObject({ custody: 'pool', payout: null })
    await e.db.query(`UPDATE affiliate_policies SET pool_address='0x00000000000000000000000000000000000000A1' WHERE merchant_id=$1`, [e.merchantId])
    const again = (await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)).json()
    expect(again).toMatchObject({ status: 'settling', custody: 'pool', payout: { status: 'intent_recorded', to: '0x00000000000000000000000000000000000000A1' } })
    expect((await e.post(`/api/v1/affiliates/commissions/${a.id}/release`)).json().payout.settlement_id).toBe(again.payout.settlement_id) // uma intenção só
    expect((await e.post(`/api/v1/affiliates/commissions/${a.id}/retry-payout`)).json().error.code).toBe('payout_not_failed')
    expect((await e.db.query(`SELECT count(*)::int AS n FROM settlements WHERE kind='affiliate_payout'`)).rows[0].n).toBe(1)
    expect((await e.db.query(`SELECT kind FROM affiliate_ledger ORDER BY id`)).rows.map(r => r.kind)).toEqual(['credit_pending', 'release'])
    await settleAll(e.ctx, e.chain)
    expect((await e.get(`/api/v1/affiliates/commissions/${a.id}`)).json().status).toBe('settled'); expect(e.chain.mined.length).toBe(1)
    expect((await e.get(`/api/v1/affiliates/beneficiaries/${a.beneficiary_ref}`)).json().balances.available.units).toBe('9615384')
    // o mesmo pelo retry-payout quando o destino chega
    const g = await env()
    await g.db.query(`UPDATE affiliate_policies SET pool_address=NULL WHERE merchant_id=$1`, [g.merchantId])
    const b = (await g.post('/api/v1/affiliates/commissions', commission())).json()
    await g.post(`/api/v1/affiliates/commissions/${b.id}/release`)
    await g.db.query(`UPDATE affiliate_policies SET pool_address='0x00000000000000000000000000000000000000A1' WHERE merchant_id=$1`, [g.merchantId])
    const rt = (await g.post(`/api/v1/affiliates/commissions/${b.id}/retry-payout`)).json()
    expect(rt).toMatchObject({ status: 'settling', payout: { status: 'intent_recorded' } })
    expect((await g.db.query(`SELECT count(*)::int AS n FROM settlements WHERE kind='affiliate_payout'`)).rows[0].n).toBe(1)
  })
})
