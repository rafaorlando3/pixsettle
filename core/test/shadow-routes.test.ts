import { describe, it, expect, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { freshDb } from './helpers.js'
import { event, trio, trusted, TEST_SECRET } from './pilot-shadow-fixtures.js'
import { registerShadow } from '../src/pilot-shadow/routes.js'
import { encodeTrio, SHADOW_CONTENT_TYPE, MAX_FRAME } from '../src/pilot-shadow/frame.js'
import { sha256 } from '../src/pilot-shadow/guard.js'
import { shadowStreamLockKey } from '../src/pilot-shadow/db.js'
import { corePassthroughEnv } from '../scripts/start-all.js'
import { wakeOnWrites } from '../src/worker.js'
import type { Db } from '../src/db.js'
const TOKEN = 'private-synthetic-token-' + 'a'.repeat(40)
function config(): Record<string, string | undefined> {
  const c = trusted(); return { PILOT_SHADOW_KEYRING_JSON: JSON.stringify({ k_test1: { ...c.keyring.k_test1, env: 'PILOT_SHADOW_KEY_TEST' } }),
    PILOT_SHADOW_TOKENS_JSON: JSON.stringify([{ env: 'PILOT_SHADOW_TOKEN_TEST', origin: c.origin, stores: [c.store] }]), PILOT_SHADOW_KEY_TEST: TEST_SECRET, PILOT_SHADOW_TOKEN_TEST: TOKEN }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean() })
async function appFor(db: Db, env = config()) { const app = Fastify({ logger: false, bodyLimit: 64 * 1024 }); registerShadow(app, db, env); await app.ready(); cleanups.push(() => app.close()); return app }
async function fresh() { const f = await freshDb(); cleanups.push(f.drop); return { db: f.db, app: await appFor(f.db) } }
const post = (app: FastifyInstance, input = trio(), token = TOKEN, store = 'store_1') => app.inject({ method: 'POST', url: '/pilot/v2/batches?store=' + store, headers: { authorization: 'Bearer ' + token, 'content-type': SHADOW_CONTENT_TYPE }, payload: encodeTrio(input) })
const get = (app: FastifyInstance, hash: string, token = TOKEN, store = 'store_1') => app.inject({ method: 'GET', url: '/pilot/v2/batches/' + hash + '?store=' + store, headers: { authorization: 'Bearer ' + token } })
const count = async (db: Db) => (await db.query('SELECT (SELECT count(*)::int FROM pilot_shadow_batches) AS batches,(SELECT count(*)::int FROM pilot_shadow_events) AS events,(SELECT count(*)::int FROM pilot_shadow_streams) AS streams')).rows[0]
describe('private authenticated shadow v2 routes', () => {
  it('authenticates before content parsing and body limits; forbidden store also stops before parsing', async () => {
    let touched = 0; const db = { query: async () => { touched++; throw new Error('must not touch') }, connect: async () => { touched++; throw new Error('must not touch') } } as unknown as Db
    const app = await appFor(db)
    for (const authorization of [undefined, 'Bearer wrong', 'Bearer ' + 'x'.repeat(40)]) {
      const r = await app.inject({ method: 'POST', url: '/pilot/v2/batches?store=store_1', headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/json' }, payload: '{invalid PRIVATE_PII' })
      expect(r.statusCode).toBe(401); expect(r.json()).toEqual({ error: { code: 'shadow_unauthorized' } })
    }
    const large = await app.inject({ method: 'POST', url: '/pilot/v2/batches?store=store_1', headers: { 'content-type': SHADOW_CONTENT_TYPE }, payload: Buffer.alloc(MAX_FRAME + 1) }); expect(large.statusCode).toBe(401)
    const wrongStore = await app.inject({ method: 'POST', url: '/pilot/v2/batches?store=store_2', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'unsupported/private' }, payload: 'PRIVATE_PII' }); expect(wrongStore.statusCode).toBe(403)
    expect(touched).toBe(0)
  })
  it('fails closed for malformed, missing, inline-secret, unsafe-name, duplicate or out-of-scope configuration', async () => {
    const good = config(), ring = JSON.parse(good.PILOT_SHADOW_KEYRING_JSON!), tokens = JSON.parse(good.PILOT_SHADOW_TOKENS_JSON!)
    const cases = [{}, { ...good, PILOT_SHADOW_KEYRING_JSON: '{broken' }, { ...good, PILOT_SHADOW_TOKENS_JSON: '{}' }, { ...good, PILOT_SHADOW_KEY_TEST: undefined },
      { ...good, PILOT_SHADOW_KEYRING_JSON: JSON.stringify({ k_test1: { ...ring.k_test1, key: 'FORBIDDEN_INLINE_SECRET' } }) },
      { ...good, PILOT_SHADOW_KEYRING_JSON: JSON.stringify({ k_test1: { ...ring.k_test1, env: 'OTHER_SECRET' } }), OTHER_SECRET: TEST_SECRET },
      { ...good, PILOT_SHADOW_TOKENS_JSON: JSON.stringify([{ ...tokens[0], env: 'OTHER_TOKEN' }]), OTHER_TOKEN: TOKEN },
      { ...good, PILOT_SHADOW_TOKENS_JSON: JSON.stringify([{ ...tokens[0], stores: ['store_2'] }]) },
      { ...good, PILOT_SHADOW_TOKENS_JSON: JSON.stringify([tokens[0], tokens[0]]) },
      { ...good, PILOT_SHADOW_TOKENS_JSON: JSON.stringify([{ ...tokens[0], value: TOKEN }]) }]
    const db = { query: async () => { throw new Error('must not touch') } } as unknown as Db
    for (const env of cases) { const app = await appFor(db, env); const r = await get(app, 'a'.repeat(64)); expect(r.statusCode).toBe(503); expect(r.json()).toEqual({ error: { code: 'shadow_configuration_invalid' } }); expect(r.body).not.toContain(TOKEN); expect(r.body).not.toContain(TEST_SECRET) }
  })
  it('accepts, returns the signed receipt, replays without new writes and GET returns the exact authenticated receipt', async () => {
    const { db, app } = await fresh(), input = trio([event(1), event(2)]), hash = sha256(input.lote)
    const initial = await get(app, hash); expect(initial.statusCode).toBe(404); expect(initial.json()).toEqual({ error: { code: 'shadow_batch_not_found' } }); expect(await count(db)).toEqual({ batches: 0, events: 0, streams: 0 })
    const a = await post(app, input); expect(a.statusCode).toBe(200); expect(a.json()).toMatchObject({ ok: true, accepted: 2, replayed: false, receipt: { result: 'accepted', bank_settlement: false, rejected: 0 } })
    const b = await post(app, input); expect(b.statusCode).toBe(200); expect(b.json()).toMatchObject({ accepted: 0, duplicates: 2, replayed: true, receipt: a.json().receipt })
    const lookup = await get(app, hash); expect(lookup.statusCode).toBe(200); expect(lookup.json()).toEqual({ ok: true, receipt: a.json().receipt }); expect(lookup.headers['cache-control']).toBe('no-store')
    expect(await count(db)).toEqual({ batches: 1, events: 2, streams: 1 })
    for (const table of ['orders','pix_charges','outbox','receipts','settlements','attested_events']) expect((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0)
  })
  it('does not substitute submitted origin/store for trusted token scope', async () => {
    const { db, app } = await fresh()
    for (const ctx of [trusted('src_2'), trusted('src_1', 'store_2')]) { const r = await post(app, trio([event(1, undefined, ctx)], ctx)); expect(r.statusCode).toBe(422); expect(r.json().codes).toContain('att:unexpected_origin_store') }
    for (const url of ['/pilot/v2/batches', '/pilot/v2/batches?store=store_1&origin=src_2', '/pilot/v2/batches?store=store_1&store=store_2']) {
      const r = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': SHADOW_CONTENT_TYPE }, payload: encodeTrio(trio()) }); expect(r.statusCode).toBe(400)
    }
    expect(await count(db)).toEqual({ batches: 0, events: 0, streams: 0 })
  })
  it('rejects revoked/expired/scope-mismatched signing key and malformed guard inputs without leaking values', async () => {
    const { db } = await fresh(); const env = config(), ring = JSON.parse(env.PILOT_SHADOW_KEYRING_JSON!)
    for (const changes of [{ revoked: true }, { valid_until: '2026-10-07T03:00:00Z' }]) {
      const app = await appFor(db, { ...env, PILOT_SHADOW_KEYRING_JSON: JSON.stringify({ k_test1: { ...ring.k_test1, ...changes } }) }); const r = await post(app); expect(r.statusCode).toBe(422)
    }
    const app = await appFor(db), bad = trio([{ ...event(1), cpf_12345678900: 'RECEIVED_PRIVATE_VALUE' } as any]); const r = await post(app,bad)
    expect(r.statusCode).toBe(422); expect(r.json().codes).toContain('l1:extra_field:n=1'); expect(r.body).not.toContain('cpf_12345678900'); expect(r.body).not.toContain('RECEIVED_PRIVATE_VALUE'); expect(await count(db)).toEqual({ batches: 0, events: 0, streams: 0 })
  })
  it('handles binary framing/content-type/body bounds with fixed responses before storage', async () => {
    const { db, app } = await fresh()
    const bad = await app.inject({ method: 'POST', url: '/pilot/v2/batches?store=store_1', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': SHADOW_CONTENT_TYPE }, payload: Buffer.from('PRIVATE_BAD_FRAME') }); expect(bad.statusCode).toBe(422); expect(bad.body).not.toContain('PRIVATE_BAD_FRAME')
    const wrongType = await app.inject({ method: 'POST', url: '/pilot/v2/batches?store=store_1', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, payload: '{}' }); expect(wrongType.statusCode).toBe(415)
    const large = await app.inject({ method: 'POST', url: '/pilot/v2/batches?store=store_1', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': SHADOW_CONTENT_TYPE }, payload: Buffer.alloc(MAX_FRAME + 1) }); expect(large.statusCode).toBe(413)
    const aboveGlobalLimit = trio(Array.from({ length: 300 }, (_, i) => event(i + 1))); expect(encodeTrio(aboveGlobalLimit).length).toBeGreaterThan(64 * 1024); expect((await post(app,aboveGlobalLimit)).statusCode).toBe(200)
    expect(await count(db)).toEqual({ batches: 1, events: 300, streams: 1 })
  })
  it('returns signed rejection409, preserves atomicity/checkpoint and exposes exactly that receipt on GET/replay', async () => {
    const { db, app } = await fresh(); await post(app, trio([event(2)]))
    const bad = trio([event(1), { ...event(2), amount_minor: 1600 }, event(3)]), hash = sha256(bad.lote)
    const a = await post(app,bad); expect(a.statusCode).toBe(409); expect(a.json()).toMatchObject({ error: { code: 'shadow_event_conflict' }, receipt: { result: 'rejected', accepted: 0, duplicates: 0, rejected: 3, codes: ['l2:conflito'] } })
    const b = await post(app,bad); expect(b.statusCode).toBe(409); expect(b.json()).toEqual(a.json())
    const lookup = await get(app,hash); expect(lookup.statusCode).toBe(200); expect(lookup.json()).toEqual({ ok: true, receipt: a.json().receipt }); expect(await count(db)).toEqual({ batches: 2, events: 1, streams: 1 })
    expect((await db.query('SELECT checkpoint FROM pilot_shadow_streams')).rows[0].checkpoint).toBe(event(2).cursor)
  })
  it('refuses a different attestation/PRONTO binding for an already accepted lote', async () => {
    const { db, app } = await fresh(); await post(app)
    const changed = trio([event(1)], trusted(), { overlap_count: 1 }), r = await post(app,changed); expect(r.statusCode).toBe(409); expect(r.json()).toEqual({ error: { code: 'shadow_batch_binding_conflict' } }); expect(await count(db)).toEqual({ batches: 1, events: 1, streams: 1 })
  })
  it('reports a held stream lock503 with zero writes; retry after release succeeds', async () => {
    const { db, app } = await fresh(), client = await db.connect()
    try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[shadowStreamLockKey('src_1','store_1')]); const r = await post(app); expect(r.statusCode).toBe(503); expect(r.json()).toEqual({ error: { code: 'shadow_stream_busy' } }); expect(await count(db)).toEqual({ batches: 0, events: 0, streams: 0 }); await client.query('COMMIT') } finally { await client.query('ROLLBACK'); client.release() }
    expect((await post(app)).statusCode).toBe(200)
  })
  it('distinguishes absence from DB failure/timeouts, sanitizes errors and rejects a malformed lookup hash', async () => {
    const db = { query: async () => { throw new Error('ETIMEDOUT PRIVATE_DATABASE_URL PRIVATE_PASSWORD') }, connect: async () => { throw new Error('ETIMEDOUT PRIVATE_PASSWORD') } } as unknown as Db
    const app = await appFor(db); const missing = await get(app,'a'.repeat(64)); expect(missing.statusCode).toBe(503); expect(missing.json()).toEqual({ error: { code: 'shadow_storage_unavailable' } }); expect(missing.body).not.toContain('PRIVATE')
    const submit = await post(app); expect(submit.statusCode).toBe(503); expect(submit.json()).toEqual({ error: { code: 'shadow_storage_unavailable' } })
    const bad = await get(app,'not-a-hash'); expect(bad.statusCode).toBe(422); expect(bad.json()).toEqual({ error: { code: 'shadow_hash_invalid' } })
  })
  it('authenticates stored receipts and never returns a corrupted signature or injected extra field', async () => {
    const { db, app } = await fresh(), input = trio(); await post(app,input); await db.query('ALTER TABLE pilot_shadow_batches DISABLE TRIGGER pilot_shadow_batches_immutable')
    await db.query("UPDATE pilot_shadow_batches SET receipt=jsonb_set(receipt,'{private_field}',to_jsonb('PRIVATE_LEAK'::text))")
    const r = await get(app,sha256(input.lote)); expect(r.statusCode).toBe(503); expect(r.json()).toEqual({ error: { code: 'shadow_receipt_invalid' } }); expect(r.body).not.toContain('PRIVATE_LEAK')
    await db.query("UPDATE pilot_shadow_batches SET receipt=(receipt-'private_field') || jsonb_build_object('sig',repeat('0',64))")
    const s = await get(app,sha256(input.lote)); expect(s.statusCode).toBe(503); expect(s.json()).toEqual({ error: { code: 'shadow_receipt_invalid' } })
  })
  it('separates two token origins with identical event IDs and blocks cross-scope receipt queries', async () => {
    const { db } = await fresh(), env = config(), ring = JSON.parse(env.PILOT_SHADOW_KEYRING_JSON!), tokens = JSON.parse(env.PILOT_SHADOW_TOKENS_JSON!), token2 = 'private-other-token-' + 'b'.repeat(40)
    env.PILOT_SHADOW_KEYRING_JSON = JSON.stringify({ ...ring,k_test2: { ...ring.k_test1, origin: 'src_2', env: 'PILOT_SHADOW_KEY_OTHER' } }); env.PILOT_SHADOW_KEY_OTHER = 'b'.repeat(40)
    env.PILOT_SHADOW_TOKENS_JSON = JSON.stringify([...tokens,{ env:'PILOT_SHADOW_TOKEN_OTHER',origin:'src_2',stores:['store_1'] }]); env.PILOT_SHADOW_TOKEN_OTHER = token2
    const app = await appFor(db,env), c2 = trusted('src_2'); (c2.secrets as any).SHADOW_TEST_SECRET = 'b'.repeat(40)
    const one = trio(), two = trio([event(1,undefined,c2)],c2,{ key_id:'k_test2' }); expect((await post(app,one)).statusCode).toBe(200); expect((await post(app,two,token2)).statusCode).toBe(200)
    expect((await get(app,sha256(one.lote),token2)).statusCode).toBe(404); expect((await get(app,sha256(two.lote),TOKEN)).statusCode).toBe(404); expect((await get(app,sha256(two.lote),token2)).statusCode).toBe(200)
    expect(await count(db)).toEqual({ batches:2,events:2,streams:2 })
  })
  it('never wakes the payment worker for authenticated shadow acceptance/replay/rejection or any failed write', async () => {
    const f = await freshDb(); cleanups.push(f.drop); const app = Fastify({ logger:false }), wake = vi.fn()
    registerShadow(app,f.db,config()); wakeOnWrites(app,{ wake })
    app.post('/demo/write',async (_req,reply) => reply.code(201).send({ ok:true }))
    app.post('/other/fail',async (_req,reply) => reply.code(422).send({ error:{ code:'fixture_failure' } }))
    app.delete('/other/write',async (_req,reply) => reply.code(204).send())
    app.get('/other/read',async () => ({ ok:true })); await app.ready(); cleanups.push(() => app.close())
    expect((await post(app)).statusCode).toBe(200); expect((await post(app)).statusCode).toBe(200)
    expect((await post(app,trio([{ ...event(1),amount_minor:1600 }]))).statusCode).toBe(409)
    expect((await post(app,trio(),'wrong-token-'+'x'.repeat(40))).statusCode).toBe(401)
    expect((await post(app,trio([{ ...event(1),private_bad_field:'sensitive' } as any]))).statusCode).toBe(422)
    expect((await app.inject({ method:'POST',url:'/other/fail',payload:{} })).statusCode).toBe(422)
    expect(wake).not.toHaveBeenCalled()
    expect((await app.inject({ method:'POST',url:'/demo/write',payload:{} })).statusCode).toBe(201); expect(wake).toHaveBeenCalledTimes(1)
    expect((await app.inject({ method:'DELETE',url:'/other/write' })).statusCode).toBe(204); expect(wake).toHaveBeenCalledTimes(2)
    expect((await app.inject({ method:'GET',url:'/other/read' })).statusCode).toBe(200); expect(wake).toHaveBeenCalledTimes(2)
  })

  it('passes only safe shadow metadata/secret prefixes and public budget fields to core, never treasury or unrelated values', () => {
    const good = config(), forwarded = corePassthroughEnv({ ...good, COPILOT_BUDGET_MICROS:'20000000',COPILOT_CALL_RESERVE_MICROS:'100000',COPILOT_MAX_CALLS:'50',TREASURY_KEY:'PRIVATE_TREASURY',ISSUER_KEY:'PRIVATE_ISSUER',PIXSETTLE_SEED:'PRIVATE_SEED',OTHER_SECRET:'PRIVATE_OTHER','PILOT_SHADOW_KEY_bad':'PRIVATE_BAD_NAME' })
    for (const [k,v] of Object.entries(good)) expect(forwarded[k]).toBe(v)
    expect(forwarded.COPILOT_BUDGET_MICROS).toBe('20000000'); expect(forwarded.COPILOT_CALL_RESERVE_MICROS).toBe('100000'); expect(forwarded.COPILOT_MAX_CALLS).toBe('50')
    for (const name of ['TREASURY_KEY','ISSUER_KEY','PIXSETTLE_SEED','OTHER_SECRET','PILOT_SHADOW_KEY_bad']) expect(forwarded[name]).toBeUndefined()
  })
})
