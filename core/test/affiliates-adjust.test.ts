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

// v7.2 (10/10/2026): correções da revisão X-1205. F1: a criação continua idempotente depois do ajuste (valor original
// imutável). F4: occurred_at inválido é 422 antes de qualquer transação, inclusive nos caminhos sem efeito.
const amt = (amount: string) => ({ amount, currency: 'BRL', scale: 2 })
async function footprint(e: Awaited<ReturnType<typeof env>>, id: string) {
  const c = (await e.db.query(`SELECT amount_minor::text AS a, created_amount_minor::text AS o, usd_units::text AS u, status FROM affiliate_commissions WHERE id=$1`, [id])).rows[0]
  const led = (await e.db.query(`SELECT kind, usd_units::text AS u, op_key FROM affiliate_ledger WHERE ref_id=$1 ORDER BY id`, [id])).rows
  const tr = (await e.db.query(`SELECT count(*)::int AS n FROM state_transitions WHERE entity_id=$1`, [id])).rows[0].n
  const stl = (await e.db.query(`SELECT count(*)::int AS n FROM settlements WHERE kind='affiliate_payout' AND memo LIKE $1 || '%'`, ['0x' + Buffer.from(id, 'ascii').toString('hex')])).rows[0].n
  const all = (await e.db.query(`SELECT count(*)::int AS n FROM affiliate_commissions`)).rows[0].n
  return { c, led, tr, stl, all }
}

describe('v7.2 F1: criação idempotente depois do ajuste', () => {
  it('criar 5.000, ajustar para 3.000 e repetir a criação original é 200 sem efeito; repetir com 3.000 é 409', async () => {
    const e = await env()
    const body = commission({ amount: amt('5000') })
    const first = await e.post('/api/v1/affiliates/commissions', body)
    expect(first.statusCode).toBe(201)
    const c = first.json()
    expect(c.original_amount.amount).toBe('5000')
    expect((await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, { amount: amt('3000'), reason_code: 'debt_offset' })).statusCode).toBe(200)
    const before = await footprint(e, c.id)
    expect(before.c).toMatchObject({ a: '3000', o: '5000' })

    const replay = await e.post('/api/v1/affiliates/commissions', body)
    expect(replay.statusCode).toBe(200) // antes da correção: 409 idempotency_conflict
    const r = replay.json()
    expect(r.id).toBe(c.id)
    expect(r.amount.amount).toBe('3000') // o ajuste fica; a repetição não desfaz nem recria
    expect(r.original_amount.amount).toBe('5000')
    expect(await footprint(e, c.id)).toEqual(before) // nada novo na razão, nas transições nem nas comissões

    const adjustedValue = await e.post('/api/v1/affiliates/commissions', { ...body, amount: amt('3000') })
    expect(adjustedValue.statusCode).toBe(409)
    expect(adjustedValue.json().error.code).toBe('idempotency_conflict')
    expect((await e.post('/api/v1/affiliates/commissions', { ...body, amount: amt('4000') })).statusCode).toBe(409)
    expect(await footprint(e, c.id)).toEqual(before)
  })

  it('o mesmo vale para a comissão do lançamento: mesma prova repete (200), outro valor ou sem a prova é 409', async () => {
    const e = await env()
    const body = commission({ quote: launchQuote() })
    const c = (await e.post('/api/v1/affiliates/commissions', body)).json()
    expect((await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, { amount: amt('3000'), reason_code: 'capped' })).statusCode).toBe(200)
    const before = await footprint(e, c.id)
    const replay = await e.post('/api/v1/affiliates/commissions', body)
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ id: c.id, amount: { amount: '3000' }, original_amount: { amount: '3657' }, quote: { mode: 'launch', hash: c.quote.hash } })
    expect((await e.post('/api/v1/affiliates/commissions', { ...body, amount: amt('3000') })).statusCode).toBe(409)
    const { quote: _q, ...noLaunch } = body as Record<string, unknown>
    expect((await e.post('/api/v1/affiliates/commissions', noLaunch)).statusCode).toBe(409)
    expect(await footprint(e, c.id)).toEqual(before)
  })

  it('ordem fixa: ajuste e liberação, depois a repetição; liberação antes do ajuste recusa o ajuste e a repetição segue 200', async () => {
    const e = await env()
    const body = commission({ amount: amt('5000') })
    const c = (await e.post('/api/v1/affiliates/commissions', body)).json()
    await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, { amount: amt('3000'), reason_code: 'debt_offset' })
    const rel = (await e.post(`/api/v1/affiliates/commissions/${c.id}/release`, {})).json()
    expect(rel.status).toBe('released')
    const stl = (await e.db.query(`SELECT amount_units::text AS u FROM settlements WHERE id=$1`, [rel.payout.settlement_id])).rows[0]
    expect(stl.u).toBe(rel.usd.units) // a intenção sai com o dólar ajustado
    const before = await footprint(e, c.id)
    expect((await e.post('/api/v1/affiliates/commissions', body)).statusCode).toBe(200)
    expect(await footprint(e, c.id)).toEqual(before)

    const body2 = commission({ amount: amt('5000') })
    const c2 = (await e.post('/api/v1/affiliates/commissions', body2)).json()
    await e.post(`/api/v1/affiliates/commissions/${c2.id}/release`, {})
    const late = await e.post(`/api/v1/affiliates/commissions/${c2.id}/adjust`, { amount: amt('3000'), reason_code: 'debt_offset' })
    expect(late.statusCode).toBe(409); expect(late.json().error.code).toBe('commission_not_pending')
    const before2 = await footprint(e, c2.id)
    expect((await e.post('/api/v1/affiliates/commissions', body2)).statusCode).toBe(200)
    expect(await footprint(e, c2.id)).toEqual(before2)
  })

  it('concorrência: repetições da criação, ajuste e liberação ao mesmo tempo terminam coerentes (8 rodadas)', async () => {
    const e = await env()
    const orders = { adjustFirst: 0, releaseFirst: 0 }
    for (let round = 0; round < 8; round++) {
      const body = commission({ amount: amt('5000') })
      const c = (await e.post('/api/v1/affiliates/commissions', body)).json()
      const calls: Array<Promise<any>> = []
      for (let i = 0; i < 4; i++) calls.push(e.post('/api/v1/affiliates/commissions', body))
      const adjustAt = calls.length; calls.push(e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, { amount: amt('3000'), reason_code: 'debt_offset' }))
      const releaseAt = calls.length; calls.push(e.post(`/api/v1/affiliates/commissions/${c.id}/release`, {}))
      for (let i = 0; i < 4; i++) calls.push(e.post('/api/v1/affiliates/commissions', body))
      const res = await Promise.all(calls)
      res.forEach((r, i) => {
        if (i === adjustAt) { expect([200, 409]).toContain(r.statusCode); if (r.statusCode === 409) expect(r.json().error.code).toBe('commission_not_pending') }
        else if (i === releaseAt) expect(r.statusCode).toBe(200)
        else { expect(r.statusCode, `repetição ${i}`).toBe(200); expect(r.json().id).toBe(c.id) }
      })
      const adjusted = res[adjustAt].statusCode === 200
      adjusted ? orders.adjustFirst++ : orders.releaseFirst++
      const f = await footprint(e, c.id)
      expect(f.c.status).toBe('released')
      expect(f.c.o).toBe('5000')
      expect(f.c.a).toBe(adjusted ? '3000' : '5000')
      expect(f.led.map((l: any) => l.kind)).toEqual(adjusted ? ['credit_pending', 'adjustment', 'release'] : ['credit_pending', 'release'])
      const credited = f.led.filter((l: any) => l.kind !== 'release').reduce((s: bigint, l: any) => s + BigInt(l.u), 0n)
      expect(credited.toString()).toBe(f.c.u) // razão = dólar da comissão
      const stl = (await e.db.query(`SELECT amount_units::text AS u FROM settlements s JOIN affiliate_commissions c ON c.settlement_id=s.id WHERE c.id=$1`, [c.id])).rows
      expect(stl).toEqual([{ u: f.c.u }]) // uma intenção, com o dólar final
      expect((await e.db.query(`SELECT count(*)::int AS n FROM affiliate_commissions WHERE source_event_id=$1`, [body.source_event_id])).rows[0].n).toBe(1)
      // depois da corrida, a criação original continua repetível sem efeito (na corrida as leituras rápidas podem ser anteriores ao ajuste)
      for (let i = 0; i < 2; i++) {
        const again = await e.post('/api/v1/affiliates/commissions', body)
        expect(again.statusCode).toBe(200); expect(again.json().id).toBe(c.id)
      }
      expect(await footprint(e, c.id)).toEqual(f)
    }
    expect(orders.adjustFirst + orders.releaseFirst).toBe(8)
  })

  it('a migração preenche o valor original pela transição de criação, e a volta recusa com comissão ajustada', async () => {
    const e = await env()
    const body = commission({ amount: amt('5000') })
    const c = (await e.post('/api/v1/affiliates/commissions', body)).json()
    const plain = (await e.post('/api/v1/affiliates/commissions', commission({ amount: amt('1200') }))).json()
    await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, { amount: amt('3000'), reason_code: 'debt_offset' })
    // estado de uma base v7.1: coluna sem valor; a 015 roda de novo e reconstrói o original pela transição de criação
    await e.db.query(`ALTER TABLE affiliate_commissions DROP CONSTRAINT affiliate_commissions_created_amount`)
    await e.db.query(`ALTER TABLE affiliate_commissions ALTER COLUMN created_amount_minor DROP NOT NULL`)
    await e.db.query(`UPDATE affiliate_commissions SET created_amount_minor = NULL`)
    await e.db.query(readFileSync(new URL('../migrations/015_affiliate_created_amount.sql', import.meta.url), 'utf8'))
    const rows = (await e.db.query(`SELECT id, amount_minor::text AS a, created_amount_minor::text AS o FROM affiliate_commissions WHERE id = ANY($1) ORDER BY amount_minor`, [[c.id, plain.id]])).rows
    expect(rows).toEqual([{ id: plain.id, a: '1200', o: '1200' }, { id: c.id, a: '3000', o: '5000' }])
    expect((await e.post('/api/v1/affiliates/commissions', body)).statusCode).toBe(200)
    // a trava do banco: valor atual nunca acima do original
    await expect(e.db.query(`UPDATE affiliate_commissions SET amount_minor = 6000 WHERE id=$1`, [c.id])).rejects.toThrow(/affiliate_commissions_created_amount/)
    const down = readFileSync(new URL('../migrations/down/015_affiliate_created_amount.down.sql', import.meta.url), 'utf8')
    await expect(e.db.query(down)).rejects.toThrow(/adjusted commissions exist/)
    expect((await e.db.query(`SELECT created_amount_minor::text AS o FROM affiliate_commissions WHERE id=$1`, [c.id])).rows[0].o).toBe('5000')
  })
})

describe('v7.2 F4: occurred_at inválido é 422 antes da transação', () => {
  it('ajuste, liberação e anulação recusam data inválida sem efeito, inclusive nos caminhos idempotentes', async () => {
    const e = await env()
    const c = (await e.post('/api/v1/affiliates/commissions', commission({ amount: amt('5000') }))).json()
    const same = async (fn: () => Promise<any>) => {
      const before = await footprint(e, c.id)
      const r = await fn()
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('invalid_occurred_at')
      expect(await footprint(e, c.id)).toEqual(before)
    }
    for (const bad of ['amanhã', '2026-13-45T99:00:00Z', 12345, { at: 'x' }, true]) {
      await same(() => e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, { amount: amt('3000'), reason_code: 'debt_offset', occurred_at: bad }))
    }
    expect((await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, { amount: amt('3000'), reason_code: 'debt_offset', occurred_at: new Date().toISOString() })).statusCode).toBe(200)
    // caminho sem efeito (mesmo valor): antes da correção a data inválida passava como 200
    await same(() => e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, { amount: amt('3000'), reason_code: 'debt_offset', occurred_at: 'nao-e-data' }))
    await same(() => e.post(`/api/v1/affiliates/commissions/${c.id}/release`, { occurred_at: 'nao-e-data' }))
    await same(() => e.post(`/api/v1/affiliates/commissions/${c.id}/void`, { reason_code: 'order_cancelled', occurred_at: 'nao-e-data' }))
    expect((await e.post(`/api/v1/affiliates/commissions/${c.id}/release`, {})).statusCode).toBe(200)
    await same(() => e.post(`/api/v1/affiliates/commissions/${c.id}/release`, { occurred_at: 'nao-e-data' })) // idempotente: antes 200
    // sem data (ou vazia) segue usando a hora do servidor
    expect((await e.post(`/api/v1/affiliates/commissions/${c.id}/release`, { occurred_at: '' })).statusCode).toBe(200)
    const c2 = (await e.post('/api/v1/affiliates/commissions', commission({ amount: amt('5000') }))).json()
    expect((await e.post(`/api/v1/affiliates/commissions/${c2.id}/void`, { reason_code: 'order_cancelled' })).statusCode).toBe(200)
    const v = await e.post(`/api/v1/affiliates/commissions/${c2.id}/void`, { reason_code: 'order_cancelled', occurred_at: 'nao-e-data' })
    expect(v.statusCode).toBe(422) // anulada: antes voltava 200 sem efeito
    const bad = await e.post('/api/v1/affiliates/commissions', commission({ occurred_at: 'nao-e-data' }))
    expect(bad.statusCode).toBe(422); expect(bad.json().error.code).toBe('invalid_occurred_at')
  })
})

describe('v7.2 limite de arredondamento', () => {
  it('ajuste que deixaria menos de uma unidade do token é 422 usd_below_one_unit, sem efeito (cotação extrema de ensaio)', async () => {
    const e = await env()
    const c = (await e.post('/api/v1/affiliates/commissions', commission({ amount: amt('5000') }))).json()
    // cotação extrema só para alcançar o ramo: 1 unidade por 1.000.000 de centavos
    await e.db.query(`UPDATE affiliate_commissions SET rate_num=1, rate_den=1000000 WHERE id=$1`, [c.id])
    const before = await footprint(e, c.id)
    const r = await e.post(`/api/v1/affiliates/commissions/${c.id}/adjust`, { amount: amt('1'), reason_code: 'debt_offset' })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('usd_below_one_unit')
    expect(await footprint(e, c.id)).toEqual(before)
  })
})
