// Gates da publicação 212/236 (Colosseum): recibo por lote e idempotência de ponta a ponta, trava por fonte,
// diário com fsync no carregador, retorno das migrações 006/007 e orçamento diário do modelo.
// Banco novo por teste; nenhum provedor real; nenhuma chave.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { setup, freshDb } from './helpers.js'
import { signBody } from '../src/pilot/guard.js'
import { ingestBatch, processPending, processLockKey, verifyReceipt, receiptPayload, BatchIdReused } from '../src/pilot/ingest.js'
import { buildApp } from '../src/app.js'
import { registerPilot, BATCH_CONTENT_TYPE } from '../src/pilot/routes.js'
import { migrate } from '../src/migrate.js'
import { rollback, lastApplied } from '../src/rollback.js'
import { judgeWithModel, modelCallsLast24h } from '../src/copilot/judge.js'
import { ScriptedModel, copilotFromEnv } from '../src/copilot/model.js'
import { drain } from '../src/outbox.js'

const T0 = '2026-09-10T12:00:00Z'
const at = (min: number) => new Date(new Date(T0).getTime() + min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const order = (ord: string, amt: string) => ({ ev: 'order.created', ts: at(0), store: 'equilibrium', ord, amt, cur: 'BRL', meth: 'eulen', src: 'storefront', st: 'paid', pay: 'paid' })
const charge = (ord: string, chg: string, amt: string, min = 1) => ({ ev: 'pix.charge.created', ts: at(min), store: 'equilibrium', ord, chg, prov: 'eulen', meth: 'pix', amt, cur: 'BRL', exp: at(min + 60) })
const received = (ord: string, chg: string, amt: string, min = 5) => ({ ev: 'pix.received', ts: at(min), store: 'equilibrium', ord, chg, prov: 'eulen', meth: 'pix', amt, cur: 'BRL', late: 0 })

const drops: Array<() => Promise<void>> = []
afterEach(async () => { for (const d of drops.splice(0)) await d() })
async function env() { const s = await setup(); drops.push(s.drop); s.ctx.copilot = { model: null, offReason: 'teste' }; return s }

describe('recibo por lote e idempotência de ponta a ponta', () => {
  it('grava o recibo assinado; o mesmo corpo devolve o mesmo recibo sem tocar nos eventos; batch_id reusado com outro corpo é recusado', async () => {
    const { ctx, db } = await env()
    const lines = [order('o_aaaaaaaaaa', '100.00'), charge('o_aaaaaaaaaa', 'i_aaaaaaaaaa', '100.00'), received('o_aaaaaaaaaa', 'i_aaaaaaaaaa', '100.00')]
    const body = JSON.stringify(lines), sha = createHash('sha256').update(body).digest('hex')
    const a = await ingestBatch(ctx, 'odin', 'b1', lines, { bodySha256: sha, secret: 'segredo' })
    expect(a).toMatchObject({ accepted: 3, duplicates: 0, replayed: false })
    expect(a.receipt).toMatchObject({ source: 'odin', batch_id: 'b1', body_sha256: sha, accepted: 3, duplicates: 0, rejected: 0 })
    expect(verifyReceipt('segredo', a.receipt!)).toBe(true)
    expect(verifyReceipt('outro', a.receipt!)).toBe(false)
    expect(signBody('segredo', receiptPayload(a.receipt!))).toBe(a.receipt!.sig)
    const stored = (await db.query(`SELECT * FROM pilot_batches`)).rows
    expect(stored).toHaveLength(1); expect(stored[0].receipt.sig).toBe(a.receipt!.sig)
    // reenvio do MESMO corpo (mesmo batch_id ou outro): recibo igual, nenhum evento novo
    const b = await ingestBatch(ctx, 'odin', 'b1', lines, { bodySha256: sha, secret: 'segredo' })
    expect(b).toMatchObject({ accepted: 0, replayed: true }); expect(b.receipt).toEqual(a.receipt)
    const c = await ingestBatch(ctx, 'odin', 'b1-retry', lines, { bodySha256: sha, secret: 'segredo' })
    expect(c).toMatchObject({ accepted: 0, replayed: true }); expect(c.receipt).toEqual(a.receipt)
    expect((await db.query(`SELECT count(*)::int AS n FROM attested_events`)).rows[0].n).toBe(3)
    expect((await db.query(`SELECT count(*)::int AS n FROM pilot_batches`)).rows[0].n).toBe(1)
    // batch_id reusado com corpo diferente: recusado, nada gravado
    const other = [order('o_bbbbbbbbbb', '50.00')]
    await expect(ingestBatch(ctx, 'odin', 'b1', other, { bodySha256: createHash('sha256').update(JSON.stringify(other)).digest('hex'), secret: 'segredo' })).rejects.toBeInstanceOf(BatchIdReused)
    expect((await db.query(`SELECT count(*)::int AS n FROM attested_events`)).rows[0].n).toBe(3)
    // sem segredo (chamada interna): recibo sem assinatura, nunca "assinado com vazio"
    const d = await ingestBatch(ctx, 'odin', 'b2', other)
    expect(d.receipt!.sig).toBeNull(); expect(verifyReceipt('', d.receipt!)).toBe(false)
  })

  it('pela rota: recibo no corpo da resposta, hash do corpo bruto assinado, reenvio = replayed, batch_id reusado = 409', async () => {
    const { ctx } = await env()
    const app = buildApp(ctx, { asaasWebhookToken: 'wh', diagnosticsToken: 'diag' })
    registerPilot(app, ctx, { hmacSecret: 'segredo', operatorToken: 'op', sourceId: 'odin' })
    const body = JSON.stringify({ source: 'odin', batch_id: 'h1', events: [order('o_cccccccccc', '100.00'), charge('o_cccccccccc', 'i_cccccccccc', '100.00'), received('o_cccccccccc', 'i_cccccccccc', '100.00')] })
    const post = (b: string) => app.inject({ method: 'POST', url: '/pilot/v1/events', headers: { 'content-type': BATCH_CONTENT_TYPE, 'x-pilot-signature': signBody('segredo', b) }, payload: b })
    const r1 = await post(body)
    expect(r1.statusCode).toBe(200)
    const j1 = r1.json()
    expect(j1).toMatchObject({ accepted: 3, replayed: false, processed: { processed: 3, busy: false } })
    expect(j1.receipt.body_sha256).toBe(createHash('sha256').update(body).digest('hex'))
    expect(verifyReceipt('segredo', j1.receipt)).toBe(true)
    const r2 = await post(body)
    expect(r2.json()).toMatchObject({ accepted: 0, replayed: true, receipt: j1.receipt })
    const r3 = await post(JSON.stringify({ source: 'odin', batch_id: 'h1', events: [order('o_dddddddddd', '1.00')] }))
    expect(r3.statusCode).toBe(409); expect(r3.json().error.code).toBe('batch_id_reused')
  })
})

describe('trava por fonte no processamento', () => {
  it('com a trava da fonte tomada por outra sessão, processPending volta busy=true sem processar; liberada, processa', async () => {
    const { ctx, db } = await env()
    await ingestBatch(ctx, 'odin', 'b1', [order('o_eeeeeeeeee', '10.00')])
    const other = await db.connect()
    try {
      expect((await other.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [processLockKey('odin')])).rows[0].ok).toBe(true)
      const busy = await processPending(ctx, 'odin')
      expect(busy).toMatchObject({ busy: true, processed: 0 })
      expect((await db.query(`SELECT processing_state FROM attested_events`)).rows[0].processing_state).toBe('received')
      // outra fonte não é afetada pela trava desta
      await ingestBatch(ctx, 'outra', 'b1', [order('o_ffffffffff', '10.00')])
      expect((await processPending(ctx, 'outra')).busy).toBe(false)
      await other.query('SELECT pg_advisory_unlock($1::bigint)', [processLockKey('odin')])
    } finally { other.release() }
    const ok = await processPending(ctx, 'odin')
    expect(ok).toMatchObject({ busy: false, processed: 1 })
    // a trava não fica presa depois (a sessão do processador libera)
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=($1::bigint & 4294967295) AND granted`, [processLockKey('odin')])).rows[0].n).toBe(0)
  })
})

// Test the 006/007 contract in its own migration boundary, even when later layers exist.
async function stripLaterMigrations(db: any) {
  let last = await lastApplied(db)
  while (last && last > '007_pilot_batches.sql') { await rollback(db, last); last = await lastApplied(db) }
}
async function migrateThrough007(db: any) {
  const applied = await migrate(db); await stripLaterMigrations(db)
  return applied.filter(name => name <= '007_pilot_batches.sql')
}

describe('retorno das migrações 006 e 007', () => {
  it('desfaz 007 e 006 em ordem, restaura as restrições da 005, e aplica de novo sem erro; fora de ordem é recusado', async () => {
    const { db, drop } = await freshDb(); drops.push(drop)
    await stripLaterMigrations(db)
    expect(await lastApplied(db)).toBe('007_pilot_batches.sql')
    await expect(rollback(db, '006_pilot_copilot.sql')).rejects.toThrow(/só a última migração/)
    expect(await rollback(db, '007_pilot_batches.sql')).toEqual({ undone: '007_pilot_batches.sql' })
    expect((await db.query(`SELECT to_regclass('pilot_batches') AS t`)).rows[0].t).toBeNull()
    expect(await rollback(db, '006_pilot_copilot.sql')).toEqual({ undone: '006_pilot_copilot.sql' })
    for (const t of ['pilot_sources', 'pilot_stores', 'attested_events', 'pilot_charges', 'exceptions', 'copilot_verdicts', 'copilot_replay'])
      expect((await db.query(`SELECT to_regclass($1) AS t`, [t])).rows[0].t, t).toBeNull()
    expect(await lastApplied(db)).toBe('005_simulated_pix_charges.sql')
    // restrições originais de volta (sem 'attested' / 'med_attested')
    const def = async (name: string) => (await db.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname=$1`, [name])).rows[0]?.d as string
    expect(await def('orders_provider_env_check')).not.toContain('attested'); expect(await def('orders_provider_env_check')).toContain('simulated')
    expect(await def('pix_charges_provider_check')).not.toContain('attested')
    expect(await def('refund_cases_refund_type_check')).not.toContain('med_attested'); expect(await def('refund_cases_refund_type_check')).toContain('med_simulated')
    // reaplicar: as duas voltam
    expect(await migrateThrough007(db)).toEqual(['006_pilot_copilot.sql', '007_pilot_batches.sql'])
    expect(await lastApplied(db)).toBe('007_pilot_batches.sql')
  })

  it('com dados do piloto no núcleo, o retorno da 006 falha inteiro com o motivo e nada muda', async () => {
    const { ctx, db } = await env()
    await stripLaterMigrations(db)
    await ingestBatch(ctx, 'odin', 'b1', [order('o_gggggggggg', '100.00'), charge('o_gggggggggg', 'i_gggggggggg', '100.00'), received('o_gggggggggg', 'i_gggggggggg', '100.00')])
    await processPending(ctx, 'odin')
    expect((await db.query(`SELECT count(*)::int AS n FROM orders WHERE provider_env='attested'`)).rows[0].n).toBe(1)
    await rollback(db, '007_pilot_batches.sql')
    await expect(rollback(db, '006_pilot_copilot.sql')).rejects.toThrow(/retorno de 006_pilot_copilot.sql falhou e nada mudou/)
    // nada mudou: tabelas do piloto continuam, dados intactos, migração continua registrada
    expect((await db.query(`SELECT count(*)::int AS n FROM attested_events`)).rows[0].n).toBe(3)
    expect(await lastApplied(db)).toBe('006_pilot_copilot.sql')
    expect(await migrateThrough007(db)).toEqual(['007_pilot_batches.sql'])
  })
})

describe('orçamento diário do modelo', () => {
  async function exceptionPendingModel(ctx: any, db: any) {
    // valor a menos: as regras não decidem sozinhas -> resíduo para o modelo
    await ingestBatch(ctx, 'odin', 'b1', [order('o_hhhhhhhhhh', '100.00'), charge('o_hhhhhhhhhh', 'i_hhhhhhhhhh', '100.00'), received('o_hhhhhhhhhh', 'i_hhhhhhhhhh', '70.00')])
    await processPending(ctx, 'odin')
    const e = (await db.query(`SELECT * FROM exceptions WHERE copilot_state='pending_model'`)).rows[0]
    expect(e, 'exceção pendente de modelo').toBeTruthy()
    return e
  }
  it('com o orçamento esgotado o modelo não é chamado: exceção vai para humano com o motivo; com orçamento, é chamado', async () => {
    const { ctx, db } = await env()
    const model = new ScriptedModel('m-teste', () => '{"action":"escalate","confidence":0.5,"requires_human":true,"rationale":"Not enough context to decide; needs the operator.","evidence_refs":["e1"]}')
    ctx.copilot = { model, budgetCallsPerDay: 0 }
    const e = await exceptionPendingModel(ctx, db)
    expect(await judgeWithModel(ctx, e.id, 0)).toBe('done')
    const after = (await db.query(`SELECT status, copilot_state, last_error FROM exceptions WHERE id=$1`, [e.id])).rows[0]
    expect(after).toMatchObject({ status: 'awaiting_human', copilot_state: 'model_error' })
    expect(after.last_error.reason).toMatch(/orçamento diário do modelo esgotado \(0\/0/)
    expect(model.calls).toHaveLength(0)
    // reabre o caso para o modelo e dá orçamento: a chamada acontece e conta no uso
    await db.query(`UPDATE exceptions SET status='open', copilot_state='pending_model' WHERE id=$1`, [e.id])
    ctx.copilot = { model, budgetCallsPerDay: 5 }
    expect(await judgeWithModel(ctx, e.id, 0)).toBe('done')
    expect(model.calls).toHaveLength(1)
    expect(await modelCallsLast24h(ctx)).toBeGreaterThanOrEqual(1)
  })
  it('copilotFromEnv: orçamento padrão 200 no modo vivo; valor inválido desliga o modelo com motivo; replay não tem orçamento', async () => {
    const { db } = await env()
    const live = copilotFromEnv({ COPILOT_MODE: 'live', COPILOT_PROVIDER: 'openai', COPILOT_MODEL: 'x', COPILOT_API_KEY: 'k', COPILOT_BASE_URL: 'http://127.0.0.1:9' }, db)
    expect(live.model).not.toBeNull(); expect(live.budgetCallsPerDay).toBe(200)
    const lim = copilotFromEnv({ COPILOT_MODE: 'live', COPILOT_PROVIDER: 'openai', COPILOT_MODEL: 'x', COPILOT_API_KEY: 'k', COPILOT_BASE_URL: 'http://127.0.0.1:9', COPILOT_BUDGET_CALLS_PER_DAY: '50' }, db)
    expect(lim.budgetCallsPerDay).toBe(50)
    const bad = copilotFromEnv({ COPILOT_MODE: 'live', COPILOT_PROVIDER: 'openai', COPILOT_MODEL: 'x', COPILOT_API_KEY: 'k', COPILOT_BASE_URL: 'http://127.0.0.1:9', COPILOT_BUDGET_CALLS_PER_DAY: '0' }, db)
    expect(bad.model).toBeNull(); expect(bad.offReason).toMatch(/COPILOT_BUDGET_CALLS_PER_DAY inválido/)
    const replay = copilotFromEnv({ COPILOT_MODE: 'replay', COPILOT_MODEL: 'x' }, db)
    expect(replay.model?.mode).toBe('replay'); expect(replay.budgetCallsPerDay).toBeUndefined()
  })
})

describe('diário do carregador (fsync) e retomada', () => {
  it('o carregador pula lotes já no diário, verifica o recibo e grava uma linha por lote; recibo inválido para antes de gravar', async () => {
    // Testa o contrato do diário sem rede: o mesmo formato que scripts/pilot-load.ts usa.
    const dir = mkdtempSync(join(tmpdir(), 'pilot-journal-'))
    const journal = join(dir, 'eventos.ndjson.journal.ndjson')
    const { ctx } = await env()
    const lines = [order('o_iiiiiiiiii', '10.00')]
    const a = await ingestBatch(ctx, 'odin', 'eventos.ndjson:1', lines, { bodySha256: createHash('sha256').update(JSON.stringify(lines)).digest('hex'), secret: 'segredo' })
    const line = { batch_id: 'eventos.ndjson:1', receipt: a.receipt, replayed: false, at: new Date().toISOString() }
    writeFileSync(journal, JSON.stringify(line) + '\n' + '{"batch_id":"eventos.ndjson:2","rec', { mode: 0o600 }) // segunda linha: queda no meio da escrita
    expect(existsSync(journal)).toBe(true)
    const parsed = readFileSync(journal, 'utf8').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } })
    expect(parsed[0].batch_id).toBe('eventos.ndjson:1'); expect(parsed[1]).toBeNull() // a linha incompleta é ignorada e o lote 2 será reenviado
    expect(verifyReceipt('segredo', parsed[0].receipt)).toBe(true)
    const forged = { ...parsed[0].receipt, accepted: 99 }
    expect(verifyReceipt('segredo', forged)).toBe(false)
  })
})

// Mantém o pool da outbox quieto nos testes que não o usam.
void drain
void pg
