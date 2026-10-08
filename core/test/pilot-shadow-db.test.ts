import { describe, it, expect, afterEach } from 'vitest'
import { freshDb } from './helpers.js'
import { event, trio, trusted, checked } from './pilot-shadow-fixtures.js'
import { ingestShadowBatch, shadowStreamLockKey, ShadowEventConflict } from '../src/pilot-shadow/db.js'
import { verifyShadowReceipt, sha256, attestSig } from '../src/pilot-shadow/guard.js'
import { migrate } from '../src/migrate.js'
import { rollback, lastApplied } from '../src/rollback.js'
import type { Db } from '../src/db.js'
const drops: Array<() => Promise<void>> = []
afterEach(async () => { for (const drop of drops.splice(0)) await drop() })
async function dbNew() { const f = await freshDb(); drops.push(f.drop); return f.db }
const counts = async (db: Db) => (await db.query(`SELECT (SELECT count(*)::int FROM pilot_shadow_streams) AS streams,(SELECT count(*)::int FROM pilot_shadow_events) AS events,(SELECT count(*)::int FROM pilot_shadow_batches) AS batches`)).rows[0]
const coreTables = ['orders','outbox','quotes','receipts','merchants','pix_charges','settlements','refund_cases','ledger_entries','provider_events','idempotency_keys','checkout_sessions','state_transitions','settlement_attempts','simulated_pix_charges','pilot_sources','pilot_stores','attested_events','pilot_charges','exceptions','copilot_verdicts','copilot_replay','pilot_batches']
async function coreSnapshot(db: Db) { const out: Record<string, any> = {}; for (const t of coreTables) out[t] = (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${t} t`)).rows[0].rows; return out }
describe('shadow atomic storage and receipts', () => {
  it('stores a signed bound receipt and replays exactly; two issuers with identical event IDs stay distinct; core does not change', async () => {
    const db = await dbNew(), before = await coreSnapshot(db), ctx = trusted(), v = checked(trio([event(1), event(2)]), ctx)
    const a = await ingestShadowBatch(db, v, ctx); expect(a).toMatchObject({ busy: false, replayed: false, accepted: 2, duplicates: 0 }); expect(verifyShadowReceipt(a.receipt, v, ctx)).toBe(true)
    const b = await ingestShadowBatch(db, v, ctx); expect(b).toMatchObject({ replayed: true, accepted: 0, duplicates: 2, receipt: a.receipt }); expect(await counts(db)).toEqual({ streams: 1, events: 2, batches: 1 })
    const ctx2 = trusted('src_2'), v2 = checked(trio([event(1, undefined, ctx2)], ctx2), ctx2)
    expect((await ingestShadowBatch(db, v2, ctx2)).accepted).toBe(1); expect(await counts(db)).toEqual({ streams: 2, events: 3, batches: 2 })
    expect(await coreSnapshot(db)).toEqual(before)
    expect(verifyShadowReceipt(a.receipt, v2, ctx2)).toBe(false)
    expect(verifyShadowReceipt({ ...a.receipt, accepted: 3 }, v, ctx)).toBe(false)
    const anotherTrio = checked(trio([event(1), event(2)], ctx, { overlap_count: 2 }), ctx)
    expect(verifyShadowReceipt(a.receipt, anotherTrio, ctx)).toBe(false)
  })
  it('overlap and older batches deduplicate without rewinding checkpoints', async () => {
    const db = await dbNew(), ctx = trusted()
    const e1 = event(1), e2 = event(2, '2026-10-06T14:00:00Z'), e3 = event(3, '2026-10-06T15:00:00Z')
    await ingestShadowBatch(db, checked(trio([e2, e3]), ctx), ctx)
    const overlap = await ingestShadowBatch(db, checked(trio([e1, e2], ctx, { overlap_count: 1 }), ctx), ctx)
    expect(overlap).toMatchObject({ accepted: 1, duplicates: 1, checkpoint: e3.cursor }); expect(overlap.receipt?.checkpoint).toBe(e3.cursor)
    const old = await ingestShadowBatch(db, checked(trio([e1], ctx, { overlap_count: 1 }), ctx), ctx)
    expect(old).toMatchObject({ accepted: 0, duplicates: 1, checkpoint: e3.cursor }); expect(await counts(db)).toEqual({ streams: 1, events: 3, batches: 3 })
    await expect(db.query('UPDATE pilot_shadow_streams SET checkpoint=$1', [e1.cursor])).rejects.toThrow('shadow_checkpoint_rewind')
  })
  it('takes the stream lock before reading/writing; other streams continue and release permits retry', async () => {
    const db = await dbNew(), ctx = trusted(), v = checked(), blocker = await db.connect()
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock($1::bigint)', [shadowStreamLockKey(ctx.origin, ctx.store)])
      expect(await ingestShadowBatch(db, v, ctx)).toEqual({ busy: true, replayed: false, accepted: 0, duplicates: 0, checkpoint: null, receipt: null }); expect(await counts(db)).toEqual({ streams: 0, events: 0, batches: 0 })
      const other = trusted('src_2'); expect((await ingestShadowBatch(db, checked(trio([event(1, undefined, other)], other), other), other)).accepted).toBe(1)
      await blocker.query('COMMIT')
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    expect((await ingestShadowBatch(db, v, ctx)).accepted).toBe(1)
    expect((await db.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND granted")).rows[0].n).toBe(0)
  })
  it('concurrent overlapping batches never deadlock; busy results are safe to retry', async () => {
    const db = await dbNew(), ctx = trusted(); const events = Array.from({ length: 80 }, (_, i) => event(i + 1))
    const a = checked(trio(events.slice(0, 70)), ctx), b = checked(trio(events.slice(10)), ctx)
    const results = await Promise.all([ingestShadowBatch(db, a, ctx), ingestShadowBatch(db, b, ctx)])
    for (const [i, r] of results.entries()) if (r.busy) expect((await ingestShadowBatch(db, i === 0 ? a : b, ctx)).busy).toBe(false)
    expect(await counts(db)).toEqual({ streams: 1, events: 80, batches: 2 })
  })
  it('a reused ID with different event payload rolls back all new events/batch/checkpoint', async () => {
    const db = await dbNew(), ctx = trusted(); await ingestShadowBatch(db, checked(trio([event(2)]), ctx), ctx)
    const before = await counts(db), checkpoint = (await db.query('SELECT checkpoint FROM pilot_shadow_streams')).rows[0].checkpoint
    const v = checked(trio([event(1), { ...event(2), amount_minor: 1600 }, event(3)]), ctx)
    await expect(ingestShadowBatch(db, v, ctx)).rejects.toBeInstanceOf(ShadowEventConflict)
    expect(await counts(db)).toEqual({ ...before, batches: before.batches + 1 }); expect((await db.query('SELECT checkpoint FROM pilot_shadow_streams')).rows[0].checkpoint).toBe(checkpoint)
    const rejected = (await db.query("SELECT receipt FROM pilot_shadow_batches WHERE result='rejected'")).rows[0].receipt
    expect(rejected).toMatchObject({ result: 'rejected', codes: ['l2:conflito'], accepted: 0, duplicates: 0, rejected: 3, checkpoint }); expect(verifyShadowReceipt(rejected, v, ctx)).toBe(true)
    try { await ingestShadowBatch(db, v, ctx); expect.fail('must reject replay') } catch (e) { expect(e).toBeInstanceOf(ShadowEventConflict); expect((e as ShadowEventConflict).receipt).toEqual(rejected) }
    expect(await counts(db)).toEqual({ ...before, batches: before.batches + 1 })
  })
  it('different exact line bytes conflict even when parsed JSON is identical; no partial events or core writes', async () => {
    const db = await dbNew(), ctx = trusted(), input = trio(), first = checked(input, ctx); await ingestShadowBatch(db, first, ctx)
    const before = await coreSnapshot(db)
    const raw = Buffer.from(input.lote.toString().replace(':1500', ': 1500'))
    const att = JSON.parse(input.atestado.toString()); att.sha256 = sha256(raw); att.bytes = raw.length; att.sig = attestSig(att, Buffer.from(ctx.secrets.SHADOW_TEST_SECRET!))
    const ab = Buffer.from(JSON.stringify(att)), p = JSON.parse(input.pronto.toString()); p.lote_sha256 = sha256(raw); p.atestado_sha256 = sha256(ab)
    const second = checked({ ...input, lote: raw, atestado: ab, pronto: Buffer.from(JSON.stringify(p)) }, ctx)
    await expect(ingestShadowBatch(db, second, ctx)).rejects.toBeInstanceOf(ShadowEventConflict)
    expect(await counts(db)).toEqual({ streams: 1, events: 1, batches: 2 }); expect(await coreSnapshot(db)).toEqual(before)
    const row = (await db.query('SELECT line_sha256 FROM pilot_shadow_events')).rows[0]
    expect(row.line_sha256).toBe(sha256(input.lote.subarray(0, input.lote.length - 1)))
  })

  it('a failure writing the receipt rolls back streams/events/checkpoint in the same transaction', async () => {
    const db = await dbNew(); await db.query("CREATE FUNCTION test_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_receipt_failure'; END; $$; CREATE TRIGGER test_receipt_fail BEFORE INSERT ON pilot_shadow_batches FOR EACH ROW EXECUTE FUNCTION test_receipt_fail()")
    await expect(ingestShadowBatch(db, checked(), trusted())).rejects.toThrow('synthetic_receipt_failure'); expect(await counts(db)).toEqual({ streams: 0, events: 0, batches: 0 })
  })
  it('events and committed receipts are append only; stored receipt tampering is refused on replay', async () => {
    const db = await dbNew(), ctx = trusted(), v = checked(); await ingestShadowBatch(db, v, ctx)
    for (const sql of ['UPDATE pilot_shadow_events SET amount_minor=1600', 'DELETE FROM pilot_shadow_events', "UPDATE pilot_shadow_batches SET receipt='{}'", 'DELETE FROM pilot_shadow_batches']) await expect(db.query(sql)).rejects.toThrow('shadow_append_only')
    await db.query('ALTER TABLE pilot_shadow_batches DISABLE TRIGGER pilot_shadow_batches_immutable'); await db.query("UPDATE pilot_shadow_batches SET receipt=jsonb_set(receipt,'{sig}',to_jsonb(repeat('0',64)))")
    await expect(ingestShadowBatch(db, v, ctx)).rejects.toThrow('shadow_receipt_invalid'); expect(await counts(db)).toEqual({ streams: 1, events: 1, batches: 1 })
  })
  it('008 rollback/reapply removes only shadow tables, preserving the complete core snapshot', async () => {
    const db = await dbNew(), before = await coreSnapshot(db); await ingestShadowBatch(db, checked(), trusted())
    while ((await lastApplied(db))! > '008_pilot_shadow.sql') await rollback(db, (await lastApplied(db))!)
    expect(await rollback(db, '008_pilot_shadow.sql')).toEqual({ undone: '008_pilot_shadow.sql' })
    for (const t of ['pilot_shadow_streams','pilot_shadow_events','pilot_shadow_batches']) expect((await db.query('SELECT to_regclass($1) AS t', [t])).rows[0].t).toBeNull()
    expect(await coreSnapshot(db)).toEqual(before); expect(await migrate(db)).toContain('008_pilot_shadow.sql'); expect(await counts(db)).toEqual({ streams: 0, events: 0, batches: 0 })
  })
})
