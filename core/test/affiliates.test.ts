// Fase 2: comissões de afiliados em dólar digital (docs/affiliate-payouts.md, seção 7).
import { describe, it, expect, afterEach } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { setup, settleAll } from './helpers.js'
import { buildApp } from '../src/app.js'
import { registerAffiliates } from '../src/affiliates/routes.js'
import { SimulatedQuoteSource, BinanceUsdtBrlQuoteSource, parsePrice4, makeQuote } from '../src/affiliates/quotes.js'
import { fixUsdUnits, pixNet, ratesFromPrice4, fmtUsd, fmtBrl } from '../src/affiliates/money.js'
import { signReceipt, verifyEnvelope } from '../../settlement/src/receipt.js'

const ISSUER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const // chave pública de TESTE
const ISSUER = privateKeyToAccount(ISSUER_KEY).address
const drops: Array<() => Promise<void>> = []
afterEach(async () => { for (const d of drops.splice(0)) await d() })

async function env(over: { settle?: boolean; price4?: bigint; affiliatesOff?: boolean } = {}) {
  const e = await setup()
  drops.push(e.drop)
  e.ctx.cfg.issuer = { id: 'pixsettle-test', address: ISSUER }
  e.chain.signReceipt = (payload: any) => signReceipt(payload, ISSUER_KEY)
  const quotes = new SimulatedQuoteSource(over.price4 ?? 52000n) // R$ 5,2000 por dólar
  if (!over.affiliatesOff) e.ctx.affiliates = { quotes, settle: over.settle ?? true, lockTtlMs: 120_000 }
  const key = 'key-' + randomUUID()
  await e.db.query(`UPDATE merchants SET api_key_hash=$2 WHERE id=$1`, [e.merchantId, createHash('sha256').update(key).digest('hex')])
  await e.db.query(`INSERT INTO affiliate_policies (merchant_id, pool_address) VALUES ($1, '0x00000000000000000000000000000000000000A1')`, [e.merchantId])
  const app = buildApp(e.ctx, { asaasWebhookToken: 'tok-webhook-teste', diagnosticsToken: 'diag-teste' })
  registerAffiliates(app, e.ctx, { publicMerchantId: e.merchantId })
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
    const ok = JSON.stringify({ bidPrice: '5.1900', askPrice: '5.2100' })
    const fetchImpl = (async () => { calls++; return new Response(calls === 1 ? ok : 'down', { status: calls === 1 ? 200 : 503 }) }) as unknown as typeof fetch
    const src = new BinanceUsdtBrlQuoteSource({ fetchImpl, maxAgeMs: 1000, staleOkMs: 5000 })
    const t0 = new Date('2026-10-09T12:00:00Z')
    const q1 = await src.quote(t0); expect(q1.ok && q1.quote.price4).toBe(52100n) // compra pelo ask
    expect(q1.ok && q1.quote.sell.rateNum).toBe(51900n) // venda pelo bid
    const q2 = await src.quote(new Date(t0.getTime() + 500)); expect(calls).toBe(1); expect(q2.ok && q2.quote.ageS).toBe(0)
    const q3 = await src.quote(new Date(t0.getTime() + 3000)); expect(calls).toBe(2); expect(q3.ok && q3.quote.ageS).toBe(3) // fora do ar: última boa, com idade
    const q4 = await src.quote(new Date(t0.getTime() + 9000)); expect(q4).toMatchObject({ ok: false, code: 'quote_unavailable' }); expect(!q4.ok && q4.detail).toMatch(/HTTP 503/)
    expect(makeQuote('simulated', 52000n, t0).hash).toHaveLength(64)
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
    expect(rc.json().payload).toMatchObject({ receipt_type: 'affiliate_commission_payout', commission: { id: body.id, amount: { brl: '50.00' } }, amounts: { usd: '9.61' }, beneficiary: { ref: c.beneficiary_ref } })
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
    // liberada e com intenção gravada, mas ainda não paga: o void segura a liquidação com motivo
    const b = (await e.post('/api/v1/affiliates/commissions', commission({ source_event_id: 'rwd_b' }))).json()
    await e.post(`/api/v1/affiliates/commissions/${b.id}/release`)
    expect((await e.post(`/api/v1/affiliates/commissions/${b.id}/void`, { reason_code: 'med_claim' })).json().error.code).toBe('already_settled') // settling = já no diário
    // paga na cadeia: exceção registrada, nada volta sozinho
    await settleAll(e.ctx, e.chain)
    const r = await e.post(`/api/v1/affiliates/commissions/${b.id}/void`, { reason_code: 'med_claim' })
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('already_settled')
    expect((await e.get(`/api/v1/affiliates/commissions/${b.id}`)).json().status).toBe('settled')
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
    expect(agg.withdrawals).toMatchObject({ total: 2, pix_paid: 1, brl_paid: '49.00' })
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
    expect(rc.payload).toMatchObject({ receipt_type: 'affiliate_wallet_withdrawal', withdrawal: { id: w.id }, settlement: { to: own } })
    expect((await e.post(`/api/v1/affiliates/withdrawals/${w.id}/paid`, { pix_e2e_id: 'E12345678' })).json().error.code).toBe('not_pix')
    const pub = (await e.app.inject({ method: 'GET', url: `/pilot/api/affiliates/${a.beneficiary_ref}` })).json()
    expect(pub.payout).toEqual({ mode: 'own_wallet' }); expect(JSON.stringify(pub.payout)).not.toContain('bEEF')
  })
})
