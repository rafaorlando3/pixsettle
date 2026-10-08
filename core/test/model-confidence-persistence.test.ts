import { afterEach, describe, expect, it } from 'vitest'
import { setup } from './helpers.js'
import { withTx } from '../src/db.js'
import { openException, judgeWithModel, buildModelInput } from '../src/copilot/judge.js'
import { RecordingModel, ScriptedModel } from '../src/copilot/model.js'
import { hashOf, type Verdict } from '../src/copilot/verdict.js'
import { rollback } from '../src/rollback.js'
import { migrate } from '../src/migrate.js'

const migration = '012_copilot_confidence.sql'
const drops: Array<() => Promise<void>> = []
afterEach(async () => { for (const drop of drops.splice(0)) await drop() })

async function seed(confidence: number, changeContext = false, legacyPrecision = false) {
  const env = await setup(); drops.push(env.drop)
  if (legacyPrecision) await rollback(env.db, migration)
  let exceptionId = ''
  const verdict: Verdict = { action: 'hold_request_balance', confidence, requires_human: false, rationale: 'The structured balance needs an operator review.', evidence_refs: ['e1'] }
  const live = new ScriptedModel('synthetic-confidence-fixture', async () => {
    if (changeContext) await env.db.query(`UPDATE exceptions SET facts=jsonb_set(facts,'{manual,received_minor}','"500"'::jsonb) WHERE id=$1`, [exceptionId])
    return JSON.stringify(verdict)
  })
  env.ctx.copilot = { model: new RecordingModel(live, env.db) }
  const facts = { kind: 'manual_divergent' as const, store: 'synthetic_fixture', manual: { amount_minor: '1000', received_minor: '600', status: 'divergent' } }
  const evidence = [{ id: 'e1', fact: 'Synthetic fixture: the recorded balance differs.' }]
  exceptionId = (await withTx(env.db, tx => openException(tx, env.ctx, {
    merchantId: env.merchantId, orderId: null, kind: facts.kind, fingerprint: 'synthetic-confidence-fixture', summary: 'Synthetic balance fixture',
    facts, evidence, detectedAt: env.ctx.now(), source: 'synthetic_test',
  }))).id
  expect((await env.db.query('SELECT status,copilot_state FROM exceptions WHERE id=$1', [exceptionId])).rows[0]).toEqual({ status: 'open', copilot_state: 'pending_model' })
  const snapshot = (await env.db.query('SELECT kind,facts,evidence FROM exceptions WHERE id=$1', [exceptionId])).rows[0]
  const input = buildModelInput(snapshot.kind, snapshot.facts, snapshot.evidence)
  expect(await judgeWithModel(env.ctx, exceptionId, 0)).toBe('done')
  expect(live.calls).toHaveLength(1)
  return { ...env, exceptionId, input }
}

const reconstruct = (row: any): Verdict => ({ action: row.action, confidence: Number(row.confidence), requires_human: row.requires_human, rationale: row.rationale, evidence_refs: row.evidence_refs })
const rows = (db: any) => db.query('SELECT * FROM copilot_verdicts ORDER BY id').then((r: any) => r.rows)
const precision = (db: any) => db.query(`SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='copilot_verdicts'::regclass AND attname='confidence'`).then((r: any) => r.rows[0].type)

describe('validated confidence survives PostgreSQL persistence and lossless rollback', () => {
  it('reproduces the previous PostgreSQL rounding and broken persisted hash through the same judge', async () => {
    const { db } = await seed(0.8499, false, true), row = (await rows(db))[0]
    expect(await precision(db)).toBe('numeric(4,3)')
    expect(row.confidence).toBe('0.850')
    expect(hashOf(reconstruct(row))).not.toBe(row.verdict_hash)
    expect(JSON.parse((await db.query('SELECT response FROM copilot_replay')).rows[0].response.text).confidence).toBe(0.8499)
  })

  it('records 0.8499 after guard/context CAS, reproduces the stored hash, and never auto-applies', async () => {
    const { db, exceptionId, input } = await seed(0.8499)
    const stored = await rows(db); expect(stored).toHaveLength(1)
    const row = stored[0]
    expect(await precision(db)).toBe('numeric')
    expect(row).toMatchObject({ engine: 'model', confidence: '0.8499', input_hash: hashOf(input), requires_human: false })
    expect(hashOf(reconstruct(row))).toBe(row.verdict_hash)
    const replay = (await db.query('SELECT response FROM copilot_replay WHERE input_hash=$1', [hashOf(input)])).rows
    expect(replay).toHaveLength(1)
    expect(JSON.parse(replay[0].response.text)).toEqual(reconstruct(row))
    expect((await db.query('SELECT status,copilot_state,resolution FROM exceptions WHERE id=$1', [exceptionId])).rows[0]).toEqual({ status: 'awaiting_human', copilot_state: 'model_done', resolution: null })
    expect((await db.query(`SELECT count(*)::int AS n FROM exceptions WHERE status IN ('auto_applied','resolved') OR resolution->>'by'='auto'`)).rows[0].n).toBe(0)
    expect((await db.query(`SELECT count(*)::int AS n FROM settlements`)).rows[0].n).toBe(0)
    await expect(db.query(`UPDATE copilot_verdicts SET confidence=0.85 WHERE id=$1`, [row.id])).rejects.toThrow(/append_only/)
    await expect(db.query(`INSERT INTO copilot_verdicts(id,exception_id,engine,action,confidence,requires_human,rationale,evidence_refs,input_hash,verdict_hash) SELECT id||'_invalid',exception_id,engine,action,1.0001,requires_human,rationale,evidence_refs,input_hash,verdict_hash FROM copilot_verdicts WHERE id=$1`, [row.id])).rejects.toMatchObject({ code: '23514' })
  })

  it('a changed context produces neither an immutable verdict nor a replay recording', async () => {
    const { db, exceptionId } = await seed(0.8499, true)
    expect(await rows(db)).toEqual([])
    expect((await db.query('SELECT count(*)::int AS n FROM copilot_replay')).rows[0].n).toBe(0)
    expect((await db.query('SELECT status,copilot_state,last_error FROM exceptions WHERE id=$1', [exceptionId])).rows[0]).toMatchObject({ status: 'awaiting_human', copilot_state: 'model_error', last_error: { reason: 'context_changed' } })
  })

  it('refuses a lossy down migration atomically, preserving value, hash, type and migration marker', async () => {
    const { db } = await seed(0.8499), before = await rows(db)
    await expect(rollback(db, migration)).rejects.toThrow(/copilot_confidence_precision_loss/)
    expect(await precision(db)).toBe('numeric')
    expect(await rows(db)).toEqual(before)
    expect((await db.query('SELECT count(*)::int AS n FROM schema_migrations WHERE name=$1', [migration])).rows[0].n).toBe(1)
    expect(hashOf(reconstruct((await rows(db))[0]))).toBe(before[0].verdict_hash)
  })

  it.each([0, 0.85, 1])('returns and reapplies without changing a safe confidence %s or its hash', async confidence => {
    const { db } = await seed(confidence), before = (await rows(db))[0]
    expect(await rollback(db, migration)).toEqual({ undone: migration })
    expect(await precision(db)).toBe('numeric(4,3)')
    const reverted = (await rows(db))[0]
    expect(Number(reverted.confidence)).toBe(confidence)
    expect(hashOf(reconstruct(reverted))).toBe(before.verdict_hash)
    expect((await db.query('SELECT count(*)::int AS n FROM schema_migrations WHERE name=$1', [migration])).rows[0].n).toBe(0)
    expect(await migrate(db)).toEqual([migration])
    expect(await precision(db)).toBe('numeric')
    expect(hashOf(reconstruct((await rows(db))[0]))).toBe(before.verdict_hash)
  })
})
