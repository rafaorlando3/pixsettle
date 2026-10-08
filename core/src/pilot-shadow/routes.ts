/** Private v2 entry. Authentication and trusted scope are established before body parsing. */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db.js'
import { decodeTrio, SHADOW_CONTENT_TYPE, MAX_FRAME, ShadowFrameError } from './frame.js'
import { canonicalJson, instantUtc, parseKeyring, sha256, signReceipt, validateTrio, MAX_KEYRING_BYTES } from './guard.js'
import { ingestShadowBatch, ShadowEventConflict, ShadowBatchBindingConflict, ShadowReceiptInvalid } from './db.js'
import type { ShadowBatchReceipt, ShadowKeyMetadata, TrustedShadowContext } from './types.js'
const ORIGIN = /^src_[a-z0-9]{1,16}$/, STORE = /^store_[0-9]{1,3}$/, SHA = /^[0-9a-f]{64}$/, KID = /^k_[a-z0-9]{1,16}$/
const KEY_ENV = /^PILOT_SHADOW_KEY_[A-Z0-9_]{1,47}$/, TOKEN_ENV = /^PILOT_SHADOW_TOKEN_[A-Z0-9_]{1,45}$/
const CURSOR = /^[0-9]{8}T[0-9]{6}Z\/evt_[0-9a-f]{16}$/
const obj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)
const fields = (v: Record<string, any>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k))
const match = (v: unknown, rx: RegExp) => typeof v === 'string' && rx.test(v)
const digest = (v: string) => createHash('sha256').update(v, 'utf8').digest()
const fail = (reply: FastifyReply, status: number, code: string, extra: Record<string, unknown> = {}) => reply.code(status).send({ error: { code }, ...extra })
interface TokenScope { digest: Buffer; origin: string; stores: readonly string[] }
interface Config { tokens: readonly TokenScope[]; keyring: Readonly<Record<string, ShadowKeyMetadata>>; secrets: Readonly<Record<string, string | undefined>> }
/** Only named environment secrets are resolved. Any metadata deviation invalidates the entire v2 configuration. */
function fromEnv(env: Readonly<Record<string, string | undefined>>): Config | null {
  try {
    const kr = env.PILOT_SHADOW_KEYRING_JSON, tr = env.PILOT_SHADOW_TOKENS_JSON
    if (!kr || !tr || Buffer.byteLength(kr) > MAX_KEYRING_BYTES || Buffer.byteLength(tr) > MAX_KEYRING_BYTES) return null
    const keyring = JSON.parse(kr), tokens = JSON.parse(tr)
    if (!obj(keyring) || !Array.isArray(tokens) || !tokens.length || tokens.length > 128) return null
    const secrets: Record<string, string | undefined> = Object.create(null)
    for (const entry of Object.values(keyring)) {
      if (!obj(entry) || !match(entry.env, KEY_ENV)) return null
      const secret = env[entry.env]; if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 4096) return null
      secrets[entry.env] = secret
    }
    parseKeyring(Buffer.from(kr), secrets)
    const scopes: TokenScope[] = [], seenEnvs = new Set<string>()
    for (const token of tokens) {
      if (!obj(token) || !fields(token, ['env', 'origin', 'stores']) || !match(token.env, TOKEN_ENV) || !match(token.origin, ORIGIN) || !Array.isArray(token.stores) || !token.stores.length || !token.stores.every((s: unknown) => match(s, STORE)) || new Set(token.stores).size !== token.stores.length || seenEnvs.has(token.env)) return null
      seenEnvs.add(token.env)
      const secret = env[token.env]; if (typeof secret !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(secret)) return null
      if (token.stores.some((store: string) => !Object.values(keyring).some((key: any) => key.origin === token.origin && key.stores.includes(store)))) return null
      const hash = digest(secret); if (scopes.some(s => timingSafeEqual(s.digest, hash))) return null
      scopes.push({ digest: hash, origin: token.origin, stores: Object.freeze([...token.stores]) })
    }
    for (const entry of Object.values(keyring) as ShadowKeyMetadata[]) { Object.freeze(entry.stores); Object.freeze(entry) }
    return { tokens: Object.freeze(scopes), keyring: Object.freeze(keyring), secrets: Object.freeze(secrets) }
  } catch { return null }
}
/** GET has no raw trio. Verify its exact stored shape, DB bindings and current issuer context before returning it. */
function authenticatedStoredReceipt(row: any, trusted: TrustedShadowContext): ShadowBatchReceipt | null {
  try {
    const r = row.receipt
    const names = ['lote_name','atestado_name','pronto_name','lote_sha256','atestado_sha256','pronto_sha256','trio_sha256','schema','mode','bank_settlement','origin','store','key_id','count','result','codes','accepted','duplicates','rejected','first_cursor','last_cursor','checkpoint','committed_at','sig']
    if (!obj(r) || !fields(r, names) || r.schema !== 'pixsettle-shadow-receipt/1' || r.mode !== 'shadow' || r.bank_settlement !== false || r.origin !== trusted.origin || r.store !== trusted.store || !match(r.key_id, KID) || !match(r.sig, SHA)) return null
    const stem = typeof r.pronto_name === 'string' ? /^PRONTO-([A-Za-z0-9_-]{1,190})\.json$/.exec(r.pronto_name)?.[1] : null
    if (!stem || r.lote_name !== `LOTE-${stem}.jsonl` || r.atestado_name !== `ATESTADO-${stem}.json`) return null
    for (const field of ['origin','store','key_id','lote_sha256','atestado_sha256','pronto_sha256','trio_sha256','accepted','duplicates','rejected','result','first_cursor','last_cursor','checkpoint']) if (row[field] !== r[field]) return null
    if (row.event_count !== r.count || JSON.stringify(row.codes) !== JSON.stringify(r.codes) || !match(r.lote_sha256, SHA) || !match(r.atestado_sha256, SHA) || !match(r.pronto_sha256, SHA) || !match(r.trio_sha256, SHA) || !Number.isSafeInteger(r.count) || r.count < 1 || r.count > 5000 || !Array.isArray(r.codes) || !match(r.first_cursor, CURSOR) || !match(r.last_cursor, CURSOR) || r.first_cursor > r.last_cursor) return null
    for (const field of ['accepted','duplicates','rejected']) if (!Number.isSafeInteger(r[field]) || r[field] < 0) return null
    if (r.accepted + r.duplicates + r.rejected !== r.count) return null
    if (r.result === 'accepted') { if (r.rejected !== 0 || r.codes.length || !match(r.checkpoint, CURSOR) || r.checkpoint < r.last_cursor) return null }
    else if (r.result === 'rejected') { if (r.accepted || r.duplicates || r.rejected !== r.count || !r.codes.length || !r.codes.every((c: unknown) => typeof c === 'string' && /^l[0-9]{1,4}:conflito$/.test(c)) || r.checkpoint !== null && !match(r.checkpoint, CURSOR)) return null }
    else return null
    const binding = { lote_name: r.lote_name, atestado_name: r.atestado_name, pronto_name: r.pronto_name, lote_sha256: r.lote_sha256, atestado_sha256: r.atestado_sha256, pronto_sha256: r.pronto_sha256, trio_sha256: '' }
    if (sha256(canonicalJson(binding)) !== r.trio_sha256) return null
    const entry = trusted.keyring[r.key_id], secret = entry && trusted.secrets[entry.env]
    if (!entry || entry.revoked !== false || entry.origin !== r.origin || !entry.stores.includes(r.store) || typeof secret !== 'string' || Buffer.byteLength(secret) < 32) return null
    const time = instantUtc(r.committed_at), from = instantUtc(entry.valid_from), to = instantUtc(entry.valid_until)
    if (typeof r.committed_at !== 'string' || !r.committed_at.endsWith('Z') || time === null || from === null || to === null || !(from <= time && time < to) || new Date(row.committed_at).getTime() !== time * 1000) return null
    const expected = Buffer.from(signReceipt(r as ShadowBatchReceipt, Buffer.from(secret)), 'hex'), actual = Buffer.from(r.sig, 'hex')
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? r as ShadowBatchReceipt : null
  } catch { return null }
}
export function registerShadow(app: FastifyInstance, db: Db, env: Readonly<Record<string, string | undefined>>): void {
  const config = fromEnv(env), scopes = new WeakMap<FastifyRequest, TrustedShadowContext>()
  app.register(async shadow => {
    shadow.addContentTypeParser(SHADOW_CONTENT_TYPE, { parseAs: 'buffer', bodyLimit: MAX_FRAME }, (_req, body, done) => done(null, body))
    shadow.setErrorHandler((error: any, _req, reply) => {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return fail(reply, 413, 'shadow_body_too_large')
      if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return fail(reply, 415, 'shadow_content_type')
      return fail(reply, 503, 'shadow_unavailable')
    })
    shadow.addHook('onRequest', async (req, reply) => {
      reply.header('cache-control', 'no-store')
      if (!config) return fail(reply, 503, 'shadow_configuration_invalid')
      const auth = req.headers.authorization
      if (typeof auth !== 'string' || !/^Bearer [\x21-\x7e]{32,512}$/.test(auth)) return fail(reply, 401, 'shadow_unauthorized')
      const candidate = digest(auth.slice(7)); let token: TokenScope | null = null
      for (const scope of config.tokens) if (timingSafeEqual(candidate, scope.digest)) token = scope
      if (!token) return fail(reply, 401, 'shadow_unauthorized')
      const query = req.query
      if (!obj(query) || !fields(query, ['store']) || !match(query.store, STORE)) return fail(reply, 400, 'shadow_store_invalid')
      if (!token.stores.includes(query.store)) return fail(reply, 403, 'shadow_store_forbidden')
      if (req.method === 'POST' && req.headers['content-type']?.split(';')[0]?.trim() !== SHADOW_CONTENT_TYPE) return fail(reply, 415, 'shadow_content_type')
      scopes.set(req, { origin: token.origin, store: query.store, keyring: config.keyring, secrets: config.secrets })
    })
    shadow.post('/pilot/v2/batches', { bodyLimit: MAX_FRAME }, async (req, reply) => {
      const trusted = scopes.get(req); if (!trusted) return fail(reply, 401, 'shadow_unauthorized')
      if (req.headers['content-type']?.split(';')[0]?.trim() !== SHADOW_CONTENT_TYPE || !Buffer.isBuffer(req.body)) return fail(reply, 415, 'shadow_content_type')
      let trio
      try { trio = decodeTrio(req.body) } catch (e) { return fail(reply, 422, 'shadow_frame_invalid', { codes: [e instanceof ShadowFrameError ? e.code : 'frame_invalid'] }) }
      const validated = validateTrio(trio, trusted)
      if (!validated.ok) return fail(reply, 422, 'shadow_validation_failed', { codes: validated.errors.length ? validated.errors : ['signature_unverified'] })
      try {
        const result = await ingestShadowBatch(db, validated.validated, trusted)
        if (result.busy) return fail(reply, 503, 'shadow_stream_busy')
        return reply.send({ ok: true, ...result })
      } catch (e) {
        if (e instanceof ShadowEventConflict) return fail(reply, 409, 'shadow_event_conflict', { receipt: e.receipt })
        if (e instanceof ShadowBatchBindingConflict) return fail(reply, 409, 'shadow_batch_binding_conflict')
        if (e instanceof ShadowReceiptInvalid) return fail(reply, 503, 'shadow_receipt_invalid')
        return fail(reply, 503, 'shadow_storage_unavailable')
      }
    })
    shadow.get('/pilot/v2/batches/:lote_sha256', async (req, reply) => {
      const trusted = scopes.get(req); if (!trusted) return fail(reply, 401, 'shadow_unauthorized')
      const hash = (req.params as any).lote_sha256
      if (!match(hash, SHA)) return fail(reply, 422, 'shadow_hash_invalid')
      try {
        const row = (await db.query('SELECT * FROM pilot_shadow_batches WHERE origin=$1 AND store=$2 AND lote_sha256=$3', [trusted.origin, trusted.store, hash])).rows[0]
        if (!row) return fail(reply, 404, 'shadow_batch_not_found')
        const receipt = authenticatedStoredReceipt(row, trusted)
        if (!receipt) return fail(reply, 503, 'shadow_receipt_invalid')
        return reply.send({ ok: true, receipt })
      } catch { return fail(reply, 503, 'shadow_storage_unavailable') }
    })
  })
}
