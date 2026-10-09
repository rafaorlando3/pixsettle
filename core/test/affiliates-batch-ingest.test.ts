// Lote assinado -> revisões -> domínio: a ingestão nunca depende da cotação; a aplicação é idempotente, ordenada e explicada.
import { describe, it, expect, afterEach } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { setup, settleAll } from './helpers.js'
import { buildApp } from '../src/app.js'
import { KEY, ev, batch } from './affiliates-batch-fixture.js'
import { validateBatch } from '../src/affiliates/batches/batch.js'
import { ingestCommissionBatch, applyCommissionRevisions, signCommissionReceipt, APPLY_TOPIC } from '../src/affiliates/batches/ingest.js'
import { registerCommissionBatches, batchConfig, streamMap } from '../src/affiliates/batches/routes.js'
import { registerAffiliates } from '../src/affiliates/routes.js'
import { SimulatedQuoteSource } from '../src/affiliates/quotes.js'
import { configureAffiliateJournal } from '../src/affiliates/journal.js'
import { drain } from '../src/outbox.js'

const RECEIPT_KEY = Buffer.from('receipt-key-test-0123456789abcdef0123456789')
const drops: Array<() => Promise<void>> = []
afterEach(async () => { for (const d of drops.splice(0)) await d() })

async function env(mapped = true) {
  const e = await setup(); drops.push(e.drop)
  e.ctx.affiliates = { quotes: new SimulatedQuoteSource(50000n), settle: true, lockTtlMs: 120_000, streams: mapped ? { 'src_test1|store_1': e.merchantId } : {} }
  configureAffiliateJournal({ settle: true })
  await e.db.query(`INSERT INTO affiliate_policies (merchant_id, pool_address) VALUES ($1, '0x00000000000000000000000000000000000000A1')`, [e.merchantId])
  const key = 'key-' + randomUUID()
  await e.db.query(`UPDATE merchants SET api_key_hash=$2 WHERE id=$1`, [e.merchantId, createHash('sha256').update(key).digest('hex')])
  const ingest = async (raw: Buffer) => ingestCommissionBatch(e.db, validateBatch(raw, 'k_comtest', [KEY]), RECEIPT_KEY)
  const apply = () => applyCommissionRevisions(e.ctx, 'src_test1', 'store_1')
  const domain = async () => (await e.db.query(`SELECT source_event_id AS src, status, amount_minor::text AS brl, usd_units::text AS usd FROM affiliate_commissions ORDER BY source_event_id`)).rows
  const applications = async () => (await e.db.query(`SELECT commission_id AS src, result FROM affiliate_commission_applications ORDER BY applied_at, commission_id`)).rows
  return { ...e, key, ingest, apply, domain, applications }
}

describe('ingestão por lote assinado alimenta o domínio', () => {
  it('aceita, encadeia, repete exatamente; a aplicação cria, libera (liquida com memo) e anula; revisão sem mudança fica "unchanged"', async () => {
    const e = await env()
    const b1 = batch([ev(1), ev(2, { amount_minor: 5000 })])
    const r1 = await e.ingest(b1)
    expect(r1).toMatchObject({ replayed: false, receipt: { result: 'accepted', count: 2, accepted: 2, unchanged: 0, previous_batch_sha256: null } })
    expect(signCommissionReceipt({ ...r1.receipt, sig: undefined } as any, RECEIPT_KEY)).not.toBe(r1.receipt.sig) // a assinatura cobre o corpo sem o campo sig
    const { sig, ...body } = r1.receipt
    expect(signCommissionReceipt(body, RECEIPT_KEY)).toBe(sig)
    expect(await e.ingest(b1)).toMatchObject({ replayed: true, receipt: r1.receipt })
    expect((await e.db.query(`SELECT count(*)::int AS n FROM outbox WHERE topic=$1 AND done_at IS NULL`, [APPLY_TOPIC])).rows[0].n).toBe(1)
    expect(await e.domain()).toEqual([]) // nada no domínio antes da aplicação
    expect(await e.apply()).toEqual({ applied: 2, failed: 0, retry: false })
    expect(await e.domain()).toEqual([
      { src: 'com_' + '1'.padStart(32, '0'), status: 'pending', brl: '1234', usd: '2468000' },  // 12,34 / 5,0000 = 2,468000
      { src: 'com_' + '2'.padStart(32, '0'), status: 'pending', brl: '5000', usd: '10000000' },
    ])
    expect(await e.apply()).toEqual({ applied: 0, failed: 0, retry: false }) // idempotente
    // lote 2: a 1 libera, a 2 é anulada; a cadeia exige o sha do lote 1
    const b2 = batch([ev(1, { status: 'active', released_at: '2026-10-03T12:00:00Z', source_updated_at: '2026-10-03T12:00:00Z' }), ev(2, { amount_minor: 5000, status: 'voided', reason_code: 'order_voided', voided_at: '2026-10-03T13:00:00Z', source_updated_at: '2026-10-03T13:00:00Z' })], { previous_batch_sha256: r1.receipt.batch_sha256 })
    await expect(e.ingest(batch([ev(3)]))).rejects.toMatchObject({ code: 'commission_chain_gap' })
    expect((await e.ingest(b2)).receipt).toMatchObject({ accepted: 2, previous_batch_sha256: r1.receipt.batch_sha256 })
    expect(await e.apply()).toEqual({ applied: 2, failed: 0, retry: false })
    expect((await e.applications()).map(a => a.result).sort()).toEqual(['created', 'created', 'released', 'voided'])
    await settleAll(e.ctx, e.chain)
    const d = await e.domain()
    expect(d[0]).toMatchObject({ status: 'settled' }); expect(d[1]).toMatchObject({ status: 'voided' })
    expect(e.chain.mined.length).toBe(1)
    // revisão só com toque (mesmo valor, mesmo status): unchanged; já anulada observada de novo: idempotente
    const b3 = batch([ev(1, { status: 'active', released_at: '2026-10-03T12:00:00Z', source_updated_at: '2026-10-04T12:00:00Z' })], { previous_batch_sha256: (await e.db.query(`SELECT last_batch_sha256 AS s FROM affiliate_commission_streams`)).rows[0].s })
    await e.ingest(b3); expect(await e.apply()).toEqual({ applied: 1, failed: 0, retry: false })
    expect((await e.applications()).at(-1)!.result).toBe('released')
  })

  it('valor mudou depois de fixado: exceção para humano, domínio intacto; anulada na primeira observação: nada criado; corrente sem lojista: espera com motivo', async () => {
    const e = await env()
    const r1 = await e.ingest(batch([ev(1), ev(4, { status: 'voided', reason_code: 'med' })]))
    expect(await e.apply()).toEqual({ applied: 2, failed: 0, retry: false })
    expect((await e.applications()).map(a => a.result).sort()).toEqual(['created', 'skipped_void_on_first_sight'])
    expect((await e.domain()).length).toBe(1)
    await e.ingest(batch([ev(1, { amount_minor: 999, source_updated_at: '2026-10-05T00:00:00Z' })], { previous_batch_sha256: r1.receipt.batch_sha256 }))
    expect(await e.apply()).toEqual({ applied: 1, failed: 0, retry: false })
    expect((await e.applications()).at(-1)!.result).toBe('skipped_amount_changed')
    expect((await e.domain())[0]).toMatchObject({ brl: '1234', status: 'pending' })
    expect((await e.db.query(`SELECT count(*)::int AS n FROM state_transitions WHERE entity='affiliate_exception' AND to_state='affiliate_amount_changed'`)).rows[0].n).toBe(1)
    // afiliado, pedido ou data trocados com o mesmo id e valor: não é a mesma comissão; nada liberado sobre o domínio antigo
    const other = 'aff_' + 'c'.repeat(32)
    await e.ingest(batch([ev(1, { affiliate_id: other, status: 'active', released_at: '2026-10-06T00:00:00Z', source_updated_at: '2026-10-06T00:00:00Z' })], { previous_batch_sha256: (await e.db.query(`SELECT last_batch_sha256 FROM affiliate_commission_streams`)).rows[0].last_batch_sha256 }))
    expect(await e.apply()).toEqual({ applied: 1, failed: 0, retry: false })
    expect((await e.applications()).at(-1)!.result).toBe('skipped_identity_changed')
    expect((await e.domain())[0]).toMatchObject({ status: 'pending' }) // continua pendente, do afiliado original
    expect((await e.db.query(`SELECT reason FROM state_transitions WHERE entity='affiliate_exception' AND to_state='affiliate_identity_changed'`)).rows[0].reason).toContain('affiliate_id')
    await e.ingest(batch([ev(1, { order_id: 'ord_ffffffffffffffff', created_at: '2026-09-30T00:00:00Z', status: 'active', released_at: '2026-10-07T00:00:00Z', source_updated_at: '2026-10-07T00:00:00Z' })], { previous_batch_sha256: (await e.db.query(`SELECT last_batch_sha256 FROM affiliate_commission_streams`)).rows[0].last_batch_sha256 }))
    expect(await e.apply()).toEqual({ applied: 1, failed: 0, retry: false })
    expect((await e.db.query(`SELECT reason FROM state_transitions WHERE entity='affiliate_exception' AND to_state='affiliate_identity_changed' ORDER BY id DESC LIMIT 1`)).rows[0].reason).toMatch(/order_id,created_at/)
    expect((await e.domain())[0]).toMatchObject({ status: 'pending' })
    // cotação fora do ar: nada aplicado, retry; depois volta
    const u = await env()
    await u.ingest(batch([ev(7)]))
    u.ctx.affiliates!.quotes = { name: 'down', quote: async () => ({ ok: false, code: 'quote_unavailable', detail: 'fora do ar' }) }
    expect(await u.apply()).toEqual({ applied: 0, failed: 0, retry: true })
    expect(await u.applications()).toEqual([])
    u.ctx.affiliates!.quotes = new SimulatedQuoteSource(50000n)
    expect(await u.apply()).toEqual({ applied: 1, failed: 0, retry: false })
    // sem mapeamento da corrente
    const m = await env(false)
    await m.ingest(batch([ev(9)]))
    expect(await m.apply()).toEqual({ applied: 0, failed: 0, retry: true })
    expect((await m.db.query(`SELECT reason FROM state_transitions WHERE entity='affiliate_stream'`)).rows[0].reason).toContain('AFFILIATE_STREAMS_JSON')
    // o job da outbox faz o mesmo e agenda retry com motivo
    await drain(m.ctx)
    const job = (await m.db.query(`SELECT attempts, done_at, payload FROM outbox WHERE topic=$1`, [APPLY_TOPIC])).rows[0]
    expect(job.done_at).toBeNull(); expect(job.payload).toEqual({ try: 1 })
  })

  it('rota: token, chave, recusas com código, repetição e configuração incompleta; revisões e lotes são só inserção', async () => {
    const e = await env()
    const envVars = {
      AFFILIATE_KEYS_JSON: JSON.stringify({ k_comtest: { env: 'AFFILIATE_KEY_T', origin: 'src_test1', stores: ['store_1'] } }),
      AFFILIATE_KEY_T: KEY.secret.toString(), AFFILIATE_TOKENS_JSON: JSON.stringify([{ env: 'AFFILIATE_TOKEN_T', origin: 'src_test1' }]),
      AFFILIATE_TOKEN_T: 'tok-' + 'x'.repeat(40), AFFILIATE_RECEIPT_KEY: RECEIPT_KEY.toString(), AFFILIATE_STREAMS_JSON: JSON.stringify({ 'src_test1|store_1': e.merchantId }),
    }
    expect(streamMap(envVars)).toEqual({ 'src_test1|store_1': e.merchantId })
    expect(batchConfig({ ...envVars, AFFILIATE_RECEIPT_KEY: 'short' })).toBeNull()
    const app = buildApp(e.ctx, { asaasWebhookToken: 't', diagnosticsToken: 'd' })
    registerAffiliates(app, e.ctx, {}); registerCommissionBatches(app, e.ctx, envVars)
    const post = (raw: Buffer, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/pilot/affiliates/v1/batches', headers: { 'content-type': 'application/json', authorization: `Bearer ${envVars.AFFILIATE_TOKEN_T}`, 'x-pixsettle-key-id': 'k_comtest', ...headers }, payload: raw })
    const raw = batch([ev(1)])
    expect((await post(raw, { authorization: 'Bearer nope' })).statusCode).toBe(401)
    const ok = await post(raw)
    expect(ok.statusCode).toBe(200); expect(ok.headers['x-pixsettle-replayed']).toBe('false'); expect(ok.json()).toMatchObject({ result: 'accepted', accepted: 1 })
    const again = await post(raw)
    expect(again.headers['x-pixsettle-replayed']).toBe('true'); expect(again.json()).toEqual(ok.json())
    const gap = await post(batch([ev(2)]))
    expect(gap.statusCode).toBe(409); expect(gap.json().error).toMatchObject({ code: 'commission_chain_gap' })
    const bad = await post(raw, { 'x-pixsettle-key-id': 'k_other' })
    expect(bad.statusCode).toBe(401); expect(bad.json().error.code).toBe('commission_key_invalid')
    // toda recusa fica gravada (só inserção): token inválido, cadeia, chave
    const rej = (await e.db.query(`SELECT origin, key_id, code, http, capture, bytes, body_sha256 IS NOT NULL AS sha FROM affiliate_commission_rejections ORDER BY id`)).rows
    expect(rej).toEqual([
      { origin: null, key_id: 'k_comtest', code: 'commission_unauthorized', http: 401, capture: 'full', bytes: raw.length, sha: true },
      { origin: 'src_test1', key_id: 'k_comtest', code: 'commission_chain_gap', http: 409, capture: 'full', bytes: batch([ev(2)]).length, sha: true },
      { origin: 'src_test1', key_id: 'k_other', code: 'commission_key_invalid', http: 401, capture: 'full', bytes: raw.length, sha: true },
    ])
    await expect(e.db.query(`DELETE FROM affiliate_commission_rejections`)).rejects.toThrow(/affiliate_append_only/)
    // recusas ANTES do handler (415, 413) ficam gravadas com captura honesta: sem sha, tamanho só o declarado
    const r415 = await post(raw, { 'content-type': 'application/octet-stream' })
    expect(r415.statusCode).toBe(415)
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)
    const r413 = await post(big)
    expect(r413.statusCode).toBe(413)
    const pre = (await e.db.query(`SELECT code, http, capture, bytes, body_sha256 FROM affiliate_commission_rejections ORDER BY id DESC LIMIT 2`)).rows.reverse()
    expect(pre[0]).toMatchObject({ code: 'commission_content_type', http: 415, body_sha256: null }); expect(['declared', 'none']).toContain(pre[0].capture)
    expect(pre[1]).toMatchObject({ code: 'commission_batch_size', http: 413, body_sha256: null }); expect(pre[1].capture).toBe('declared'); expect(pre[1].bytes).toBe(big.length)
    await expect(e.db.query(`UPDATE affiliate_commission_revisions SET amount_minor=1`)).rejects.toThrow(/affiliate_append_only/)
    await expect(e.db.query(`DELETE FROM affiliate_commission_batches`)).rejects.toThrow(/affiliate_append_only/)
    // sem chaves: 503 com motivo; módulo desligado: 404
    const app2 = buildApp(e.ctx, { asaasWebhookToken: 't', diagnosticsToken: 'd' }); registerCommissionBatches(app2, e.ctx, {})
    expect((await app2.inject({ method: 'POST', url: '/pilot/affiliates/v1/batches', headers: { 'content-type': 'application/json' }, payload: raw })).json().error.code).toBe('commission_not_configured')
    expect((await e.db.query(`SELECT code, capture, bytes FROM affiliate_commission_rejections ORDER BY id DESC LIMIT 1`)).rows[0]).toEqual({ code: 'commission_not_configured', capture: 'full', bytes: raw.length })
    const off = await setup(); drops.push(off.drop)
    const app3 = buildApp(off.ctx, { asaasWebhookToken: 't', diagnosticsToken: 'd' }); registerCommissionBatches(app3, off.ctx, envVars)
    expect((await app3.inject({ method: 'POST', url: '/pilot/affiliates/v1/batches', headers: { 'content-type': 'application/json' }, payload: raw })).statusCode).toBe(404)
    // réplica pública sem opt-in: lote recusado com código; job de aplicação já na fila espera com motivo
    e.ctx.affiliates!.writes = false
    const ro = await post(batch([ev(2)], { previous_batch_sha256: ok.json().batch_sha256 }))
    expect(ro.statusCode).toBe(403); expect(ro.json().error.code).toBe('commission_read_only')
    expect(await e.apply()).toEqual({ applied: 0, failed: 0, retry: true })
    expect((await e.db.query(`SELECT to_state FROM state_transitions WHERE entity='affiliate_stream' ORDER BY id DESC LIMIT 1`)).rows[0].to_state).toBe('writes_off')
    e.ctx.affiliates!.writes = true
    expect(await e.apply()).toEqual({ applied: 1, failed: 0, retry: false })
  })

  it('lote maior que o bloco é drenado em ordem pela outbox, sem perder revisão; falha de domínio na fronteira fica gravada e não trava', async () => {
    const e = await env()
    e.ctx.affiliates!.applyBlock = 2
    await e.ingest(batch([ev(1), ev(2), ev(3), ev(4), ev(5)]))
    expect(await e.apply()).toEqual({ applied: 2, failed: 0, retry: false, more: true })
    expect((await e.applications()).length).toBe(2)
    await drain(e.ctx, 50, [APPLY_TOPIC]) // o job reagenda a si mesmo (retryInMs 0) até drenar
    expect((await e.applications()).map(a => a.src).sort()).toEqual([1, 2, 3, 4, 5].map(n => 'com_' + n.toString(16).padStart(32, '0')))
    // ordem da aplicação = ordem da corrente (source_updated_at, received_at, event_id), em blocos
    const evOrder = (await e.db.query(`SELECT commission_id FROM affiliate_commission_revisions ORDER BY source_updated_at, received_at, event_id`)).rows.map(r => r.commission_id)
    const appOrder = (await e.db.query(`SELECT commission_id FROM affiliate_commission_applications ORDER BY applied_at, commission_id`)).rows.map(r => r.commission_id)
    expect(appOrder.slice(0, 2).sort()).toEqual(evOrder.slice(0, 2).sort()); expect(appOrder.slice(2, 4).sort()).toEqual(evOrder.slice(2, 4).sort())
    expect((await e.db.query(`SELECT done_at FROM outbox WHERE topic=$1`, [APPLY_TOPIC])).rows[0].done_at).not.toBeNull()
    expect(await e.apply()).toEqual({ applied: 0, failed: 0, retry: false })
    // fronteira exata: 2 revisões com bloco 2 não deixam job pendurado
    const f = await env(); f.ctx.affiliates!.applyBlock = 2
    await f.ingest(batch([ev(1), ev(2)]))
    expect(await f.apply()).toEqual({ applied: 2, failed: 0, retry: false })
    // falha de domínio na fronteira (valor zero: invalid_amount) fica gravada como failed e as seguintes continuam
    const g = await env(); g.ctx.affiliates!.applyBlock = 2
    await g.ingest(batch([ev(1), ev(2, { amount_minor: 0 }), ev(3)]))
    const first = await g.apply(); expect(first.more).toBe(true); expect(first.applied + first.failed).toBe(2)
    await drain(g.ctx, 50, [APPLY_TOPIC])
    expect((await g.applications()).map(a => a.result).sort()).toEqual(['created', 'created', 'failed:invalid_amount'])
  })

  it('anulação recusada pelo domínio (pagamento em voo ou saque pedido) fica aplicada como "pulada", com exceção para humano, sem travar a corrente', async () => {
    const e = await env()
    const r1 = await e.ingest(batch([ev(1, { status: 'active', released_at: '2026-10-02T12:00:00Z' })]))
    expect(await e.apply()).toEqual({ applied: 1, failed: 0, retry: false })
    await drain(e.ctx, 50, ['settle']); await drain(e.ctx, 50, ['sign_attempt']); await drain(e.ctx, 50, ['broadcast_attempt']) // já transmitido, ainda não confirmado
    await e.ingest(batch([ev(1, { status: 'voided', reason_code: 'order_voided', voided_at: '2026-10-03T12:00:00Z', source_updated_at: '2026-10-03T12:00:00Z' }), ev(3)], { previous_batch_sha256: r1.receipt.batch_sha256 }))
    expect(await e.apply()).toEqual({ applied: 2, failed: 0, retry: false })
    expect((await e.applications()).map(a => a.result).sort()).toEqual(['created', 'created_released', 'skipped_payout_in_flight'])
    expect((await e.db.query(`SELECT count(*)::int AS n FROM state_transitions WHERE entity='affiliate_exception' AND to_state='affiliate_clawback_needed'`)).rows[0].n).toBe(1)
    await settleAll(e.ctx, e.chain)
    expect((await e.domain())[0]).toMatchObject({ status: 'settled' }) // o pagamento em voo confirma; a devolução fica para uma pessoa
  })
})
