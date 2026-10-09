// Affiliate commission ingestion by signed batch (producer contract pixsettle-commission-batch/1; docs/affiliate-payouts.md §9).
// Pure validation only: no DB, no HTTP, no chain. Written by the scheduled Claude round (patch 3) and absorbed here;
// the only change is the beneficiary prefix: aff_ = affiliate, par_ = partner paid by percentage.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { parseContractJson, canonicalJson, sha256 } from '../../pilot-shadow/guard.js'

export const EVENT_SCHEMA = 'pixsettle-commission-event/1'
export const BATCH_SCHEMA = 'pixsettle-commission-batch/1'
export const MAX_BATCH_BYTES = 4 * 1024 * 1024
export const MAX_EVENTS = 5000
export const MAX_AMOUNT_MINOR = 1_000_000_000_000
export const STATUSES = ['pending', 'review', 'active', 'voided', 'lost'] as const
export const REASONS = ['referee_not_new', 'payer_is_affiliate', 'referee_is_affiliate', 'affiliate_insider', 'referee_insider',
  'affiliate_inactive', 'affiliate_blocked_before_release', 'no_store_gain', 'order_voided', 'med', 'master', 'capped'] as const

export type CommissionStatus = typeof STATUSES[number]
export type CommissionEvent = {
  schema: typeof EVENT_SCHEMA; origin: string; store: string; type: 'commission.observed'
  id: string; order_id: string; affiliate_id: string; amount_minor: number; currency: 'BRL'; status: CommissionStatus
  created_at: string; source_updated_at: string; release_at: string | null; released_at: string | null; voided_at: string | null
  reason_code: string | null; revision: string; event_id: string
}
export type CommissionBatch = {
  schema: typeof BATCH_SCHEMA; origin: string; store: string; mode: 'shadow'; bank_settlement: false; key_id: string
  created_at: string; events: CommissionEvent[]; events_sha256: string; count: number; previous_batch_sha256: string | null; sig: string
}
export type CommissionKey = { key_id: string; scope: 'commission'; origin: string; stores: readonly string[]; secret: Buffer }
export type ValidatedBatch = { batch: CommissionBatch; batch_sha256: string }

/** Every rejection carries a stable code (contract §4) and a short technical detail. */
export class CommissionError extends Error {
  constructor(readonly code: string, readonly detail = '', readonly http = 422) { super(`${code}${detail ? ': ' + detail : ''}`); this.name = 'CommissionError' }
}

const EVENT_FIELDS = ['schema', 'origin', 'store', 'type', 'id', 'order_id', 'affiliate_id', 'amount_minor', 'currency', 'status',
  'created_at', 'source_updated_at', 'release_at', 'released_at', 'voided_at', 'reason_code', 'revision', 'event_id']
const BATCH_FIELDS = ['schema', 'origin', 'store', 'mode', 'bank_settlement', 'key_id', 'created_at', 'events', 'events_sha256',
  'count', 'previous_batch_sha256', 'sig']
const RX = {
  origin: /^src_[a-z0-9]{1,16}$/, store: /^store_[0-9]{1,3}$/, key_id: /^k_[a-z0-9]{1,16}$/, sha: /^[0-9a-f]{64}$/,
  com: /^com_[0-9a-f]{32}$/, aff: /^(aff|par)_[0-9a-f]{32}$/, ord: /^ord_[0-9a-f]{16}$/, cev: /^cev_[0-9a-f]{64}$/,
  utc: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/,
}
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
function exact(o: Record<string, any>, fields: string[], where: string) {
  for (const k of Object.keys(o)) if (!fields.includes(k)) throw new CommissionError('commission_field_unexpected', `${where}.${k}`)
  for (const k of fields) if (!Object.hasOwn(o, k)) throw new CommissionError('commission_field_missing', `${where}.${k}`)
}
export function utcOk(v: unknown): v is string {
  const m = typeof v === 'string' ? RX.utc.exec(v) : null
  if (!m) return false
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number]
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && h < 24 && mi < 60 && s < 60
}

/** revision = sha256(canon(event without revision/event_id)); event_id = 'cev_' + sha256(canon(event with revision)). */
export function eventIdentity(e: Record<string, any>): { revision: string; event_id: string } {
  const { revision: _r, event_id: _e, ...base } = e
  const revision = sha256(canonicalJson(base))
  return { revision, event_id: 'cev_' + sha256(canonicalJson({ ...base, revision })) }
}

function checkEvent(e: unknown, i: number, origin: string, store: string): CommissionEvent {
  const w = `events[${i}]`
  if (!isObj(e)) throw new CommissionError('commission_event_shape', w)
  exact(e, EVENT_FIELDS, w)
  if (e.schema !== EVENT_SCHEMA || e.type !== 'commission.observed') throw new CommissionError('commission_event_type', w)
  if (e.origin !== origin || e.store !== store) throw new CommissionError('commission_scope_mismatch', w)
  if (typeof e.id !== 'string' || !RX.com.test(e.id)) throw new CommissionError('commission_reference_invalid', `${w}.id`)
  if (typeof e.affiliate_id !== 'string' || !RX.aff.test(e.affiliate_id)) throw new CommissionError('commission_reference_invalid', `${w}.affiliate_id`)
  if (typeof e.order_id !== 'string' || !RX.ord.test(e.order_id)) throw new CommissionError('commission_reference_invalid', `${w}.order_id`)
  if (typeof e.amount_minor !== 'number' || !Number.isSafeInteger(e.amount_minor) || e.amount_minor < 0 || e.amount_minor > MAX_AMOUNT_MINOR) throw new CommissionError('commission_amount_invalid', w)
  if (e.currency !== 'BRL') throw new CommissionError('commission_currency_invalid', w)
  if (!(STATUSES as readonly string[]).includes(e.status)) throw new CommissionError('commission_status_invalid', w)
  for (const k of ['created_at', 'source_updated_at']) if (!utcOk(e[k])) throw new CommissionError('commission_timestamp_invalid', `${w}.${k}`)
  for (const k of ['release_at', 'released_at', 'voided_at']) if (e[k] !== null && !utcOk(e[k])) throw new CommissionError('commission_timestamp_invalid', `${w}.${k}`)
  if (e.reason_code !== null && !(REASONS as readonly string[]).includes(e.reason_code)) throw new CommissionError('commission_reason_invalid', w)
  if (typeof e.revision !== 'string' || typeof e.event_id !== 'string' || !RX.sha.test(e.revision) || !RX.cev.test(e.event_id)) throw new CommissionError('commission_identity_invalid', w)
  const id = eventIdentity(e)
  if (id.revision !== e.revision || id.event_id !== e.event_id) throw new CommissionError('commission_identity_mismatch', w)
  return e as CommissionEvent
}

/** parseContractJson wraps floats, non-finite and unsafe integers in class instances: refuse them all. */
function plainJson(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isSafeInteger(v)
  if (Array.isArray(v)) return v.every(plainJson)
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.values(v as object).every(plainJson)
  return false
}

function hmacOk(body: Record<string, any>, sig: string, secret: Buffer): boolean {
  const { sig: _s, ...rest } = body
  const want = createHmac('sha256', secret).update(canonicalJson(rest), 'utf8').digest()
  const got = Buffer.from(sig, 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * Validates the exact request bytes (contract §4, steps 1 to 5). The chain check (step 6) needs
 * storage and is done by the ingestion transaction with lastAccepted.
 */
export function validateBatch(raw: Buffer, headerKeyId: string | undefined, keys: readonly CommissionKey[]): ValidatedBatch {
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > MAX_BATCH_BYTES) throw new CommissionError('commission_batch_size', String(raw?.length ?? 0), 413)
  if (raw[raw.length - 1] !== 0x0a || raw.indexOf(0x0a) !== raw.length - 1) throw new CommissionError('commission_batch_framing', 'exactly one trailing LF')
  let parsed: unknown
  try { parsed = parseContractJson(raw.subarray(0, raw.length - 1)) } catch { throw new CommissionError('commission_batch_json') }
  // Byte-exact canonical form rejects duplicate keys, reordering, whitespace and non-integer numbers in one rule.
  if (canonicalJson(parsed) + '\n' !== raw.toString('utf8')) throw new CommissionError('commission_batch_not_canonical')
  if (!plainJson(parsed)) throw new CommissionError('commission_number_invalid', 'only safe integers are allowed')
  if (!isObj(parsed)) throw new CommissionError('commission_batch_shape')
  exact(parsed, BATCH_FIELDS, 'batch')
  const b = parsed
  if (b.schema !== BATCH_SCHEMA || b.mode !== 'shadow' || b.bank_settlement !== false) throw new CommissionError('commission_batch_shape', 'schema/mode')
  if (typeof b.origin !== 'string' || !RX.origin.test(b.origin) || typeof b.store !== 'string' || !RX.store.test(b.store)) throw new CommissionError('commission_scope_mismatch', 'batch')
  if (typeof b.key_id !== 'string' || !RX.key_id.test(b.key_id) || b.key_id !== headerKeyId) throw new CommissionError('commission_key_invalid', 'header/batch key_id', 401)
  const key = keys.find(k => k.key_id === b.key_id)
  if (!key || key.scope !== 'commission' || key.origin !== b.origin || !key.stores.includes(b.store)) throw new CommissionError('commission_key_invalid', 'scope', 401)
  if (typeof b.sig !== 'string' || !RX.sha.test(b.sig) || !hmacOk(b, b.sig, key.secret)) throw new CommissionError('commission_signature_invalid', '', 401)
  if (!utcOk(b.created_at)) throw new CommissionError('commission_timestamp_invalid', 'batch.created_at')
  if (b.previous_batch_sha256 !== null && (typeof b.previous_batch_sha256 !== 'string' || !RX.sha.test(b.previous_batch_sha256))) throw new CommissionError('commission_batch_shape', 'previous_batch_sha256')
  if (!Array.isArray(b.events) || b.events.length < 1 || b.events.length > MAX_EVENTS || b.count !== b.events.length) throw new CommissionError('commission_count_mismatch')
  const events = b.events.map((e: unknown, i: number) => checkEvent(e, i, b.origin, b.store))
  const ids = new Set<string>()
  for (let i = 0; i < events.length; i++) {
    if (i > 0 && !(events[i - 1]!.event_id < events[i]!.event_id)) throw new CommissionError('commission_order_invalid', `events[${i}]`)
    if (ids.has(events[i]!.id)) throw new CommissionError('commission_duplicate_revision', `events[${i}]`)
    ids.add(events[i]!.id)
  }
  if (sha256(events.map((e: CommissionEvent) => canonicalJson(e) + '\n').join('')) !== b.events_sha256) throw new CommissionError('commission_events_hash_mismatch')
  return { batch: b as CommissionBatch, batch_sha256: sha256(raw) }
}

/** Contract §4 step 6. lastAccepted is the last accepted batch_sha256 for (origin, store), or null. */
export function checkChain(v: ValidatedBatch, lastAccepted: string | null): void {
  if (v.batch.previous_batch_sha256 !== lastAccepted) {
    throw new CommissionError('commission_chain_gap', `expected_previous=${lastAccepted ?? 'null'}`, 409)
  }
}
