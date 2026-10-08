import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { openSync, readSync, closeSync } from 'node:fs'
import { SCHEMA, EVENT_TYPES, type ShadowEvent, type ShadowAttestation, type TrustedShadowContext, type TrioInput, type ValidatedTrio, type TrioValidationResult, type TrioBinding, type ShadowBatchReceipt } from './types.js'
export { SCHEMA } from './types.js'
export const MAX_EVENTS = 5000, MAX_LINE_BYTES = 2048, MAX_LOTE_BYTES = 5000 * 2049
export const MAX_ATT_BYTES = 8192, MAX_PRONTO_BYTES = 1024, MAX_KEYRING_BYTES = 65536, MAX_ERRORS = 50
const MAX_AMOUNT = 10n ** 12n
const TYPES: readonly string[] = EVENT_TYPES
const MATRIX: Record<string, { req: string[]; opt: string[] }> = {
  order_created: { req: ['order_ref'], opt: ['expires_at'] }, pix_received: { req: ['order_ref', 'payment_ref'], opt: [] },
  refund: { req: ['order_ref', 'refers_to'], opt: [] }, med: { req: ['order_ref', 'refers_to'], opt: [] },
  order_cancelled: { req: ['order_ref'], opt: [] }, partner_withdrawal: { req: ['party_ref'], opt: [] },
  wallet_charge: { req: ['payment_ref', 'party_ref'], opt: ['payer_self_identified'] },
}
const LINKS = ['order_ref', 'payment_ref', 'refers_to', 'party_ref', 'expires_at', 'payer_self_identified']
const REQUIRED = ['schema', 'origin', 'store', 'cursor', 'event_id', 'type', 'at', 'amount_minor', 'currency']
const FIELDS = [...REQUIRED, 'order_ref', 'payment_ref', 'refers_to', 'expires_at', 'party_ref', 'payer_self_identified']
const ATT_FIELDS = ['schema', 'origin', 'store', 'key_id', 'signed_at', 'sha256', 'bytes', 'count', 'overlap_count', 'totals_minor', 'first_cursor', 'last_cursor', 'from', 'to', 'scan_from', 'sig']
const KEY_FIELDS = ['env', 'origin', 'stores', 'valid_from', 'valid_until', 'revoked']
const PRONTO_FIELDS = ['schema', 'lote', 'lote_sha256', 'atestado', 'atestado_sha256']
const RX = {
  origin: /^src_[a-z0-9]{1,16}$/, store: /^store_[0-9]{1,3}$/, key_id: /^k_[a-z0-9]{1,16}$/,
  sha256: /^[0-9a-f]{64}$/, instant: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/,
  cursor: /^(\d{8}T\d{6}Z)\/(evt_[0-9a-f]{16})$/,
}
const ENV_RX = /^[A-Z][A-Z0-9_]{0,63}$/
const own = (o: object, k: string) => Object.hasOwn(o, k)
const obj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof JsonFloat) && !(v instanceof JsonInteger)
const match = (v: unknown, rx: RegExp) => typeof v === 'string' && rx.test(v)
const exactFields = (o: Record<string, any>, f: string[]) => Object.keys(o).length === f.length && f.every(k => own(o, k))
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
/** Python distinguishes JSON 15.0/1e2 from integer 15/100. Preserve that distinction before validation. */
class JsonFloat { constructor(readonly raw: string, readonly value: number) {} }
class JsonInteger { constructor(readonly raw: string, readonly value: bigint) {} }
export function parseContractJson(data: Buffer | string): any {
  let text = typeof data === 'string' ? data : decoder.decode(data)
  // Python json.loads accepts these float tokens. Preserve their type, then reject them as integers.
  let marker = '__e1_nonfinite__'; while (text.includes(marker)) marker += '_'
  const special = new Map<string, JsonFloat>(); let transformed = '', quoted = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) { transformed += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue }
    if (c === '"') { quoted = true; transformed += c; continue }
    const token = ['-Infinity', 'Infinity', 'NaN'].find(t => text.startsWith(t, i))
    if (token) { const tag = marker + special.size; special.set(tag, new JsonFloat(token, token === 'NaN' ? NaN : token === '-Infinity' ? -Infinity : Infinity)); transformed += JSON.stringify(tag); i += token.length - 1 } else transformed += c
  }
  text = transformed
  return (JSON.parse as any)(text, (_k: string, v: any, context?: { source?: string }) => {
    if (typeof v === 'string' && special.has(v)) return special.get(v)
    if (typeof v !== 'number') return v
    if (!context?.source) throw new Error('numeric_parser_unavailable')
    if (/[.eE]/.test(context.source)) return new JsonFloat(context.source, v)
    return Number.isSafeInteger(v) ? v : new JsonInteger(context.source, BigInt(context.source))
  })
}
const intValue = (v: any): bigint | null => typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : v instanceof JsonInteger ? v.value : null
const intEq = (v: any, n: number | bigint) => intValue(v) === BigInt(n)
export function canonicalJson(v: any): string {
  if (v instanceof JsonInteger) return v.raw
  if (v instanceof JsonFloat) return Number.isFinite(v.value) ? v.raw : Number.isNaN(v.value) ? 'NaN' : v.value < 0 ? '-Infinity' : 'Infinity'
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (obj(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
  if (typeof v === 'bigint') return v.toString()
  return JSON.stringify(v)
}
export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
export function attestSig(att: Record<string, any>, key: Buffer): string {
  const body = Object.fromEntries(Object.entries(att).filter(([k]) => k !== 'sig'))
  return createHmac('sha256', key).update(canonicalJson(body), 'utf8').digest('hex')
}
export function instantUtc(s: unknown): number | null {
  if (typeof s !== 'string') return null
  const m = RX.instant.exec(s); if (!m) return null
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number]
  if (y === 0) { const error = new Error('calendar'); error.name = 'ValueError'; throw error }
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (mo < 1 || mo > 12 || d < 1 || d > days[mo - 1]! || h > 23 || mi > 59 || se > 59) return null
  let offset = 0
  if (m[7] !== 'Z') {
    const oh = Number(m[9]), om = Number(m[10]); if (oh > 14 || om > 59 || oh === 14 && om !== 0) return null
    offset = (oh * 3600 + om * 60) * (m[8] === '+' ? 1 : -1)
  }
  const dt = new Date(0); dt.setUTCFullYear(y, mo - 1, d); dt.setUTCHours(h, mi, se, 0)
  return dt.getTime() / 1000 - offset
}
const instantZ = (s: unknown) => typeof s === 'string' && s.endsWith('Z') ? instantUtc(s) : null
const pseudo = (v: unknown, prefix: string) => match(v, new RegExp('^' + prefix + '_[0-9a-f]{16}$'))
function cursorOf(sec: number, id: string): string {
  const dt = new Date(sec * 1000)
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return pad(dt.getUTCFullYear(), 4) + pad(dt.getUTCMonth() + 1) + pad(dt.getUTCDate()) + 'T' + pad(dt.getUTCHours()) + pad(dt.getUTCMinutes()) + pad(dt.getUTCSeconds()) + 'Z/' + id
}
export const nextCheckpoint = (saved: string | null, last: string): string => saved === null || last > saved ? last : saved
export class TooLarge extends Error { constructor() { super('file_too_large'); this.name = 'TooLarge' } }
export function readBounded(path: string, limit: number): Buffer {
  const fd = openSync(path, 'r'); const out = Buffer.alloc(limit + 1); let n = 0
  try { while (n < out.length) { const got = readSync(fd, out, n, out.length - n, null); if (!got) break; n += got } } finally { closeSync(fd) }
  if (n > limit) throw new TooLarge()
  return out.subarray(0, n)
}
function checkEvent(ev: any, i: number): string[] {
  if (!obj(ev)) return [`l${i}:not_object`]
  const e: string[] = []; const pre = `l${i}:`
  const nx = Object.keys(ev).filter(k => !FIELDS.includes(k)).length
  if (nx) e.push(pre + 'extra_field:n=' + nx)
  for (const k of REQUIRED) if (!own(ev, k)) e.push(pre + 'missing:' + k)
  if (ev.schema !== SCHEMA) e.push(pre + 'schema')
  if (!match(ev.origin, RX.origin)) e.push(pre + 'origin')
  if (!match(ev.store, RX.store)) e.push(pre + 'store')
  const t = ev.type; if (Array.isArray(t) || obj(t)) throw new TypeError('contract_type')
  if (!TYPES.includes(t)) e.push(pre + 'type')
  const at = instantZ(ev.at); if (at === null) e.push(pre + 'at')
  if (own(ev, 'expires_at')) { const ex = instantZ(ev.expires_at); if (t !== 'order_created' || ex === null || at !== null && ex < at) e.push(pre + 'expires_at') }
  const a = intValue(ev.amount_minor); if (a === null || a <= 0n || a > MAX_AMOUNT) e.push(pre + 'amount_minor')
  if (ev.currency !== 'BRL') e.push(pre + 'currency')
  for (const [k, p] of Object.entries({ event_id: 'evt', order_ref: 'ord', payment_ref: 'pay', refers_to: 'pay' })) if (own(ev, k) && !pseudo(ev[k], p)) e.push(pre + 'pseudonym:' + k)
  const party = t === 'partner_withdrawal' ? 'par' : t === 'wallet_charge' ? 'cli' : null
  if (own(ev, 'party_ref') && (!party || !pseudo(ev.party_ref, party))) e.push(pre + 'pseudonym:party_ref')
  const matrix = typeof t === 'string' && own(MATRIX, t) ? MATRIX[t] : null
  if (matrix) { for (const k of matrix.req) if (!own(ev, k)) e.push(pre + k + '_required'); for (const k of LINKS) if (own(ev, k) && ![...matrix.req, ...matrix.opt].includes(k)) e.push(pre + k + '_not_allowed_for_type') }
  if (own(ev, 'payer_self_identified') && typeof ev.payer_self_identified !== 'boolean') e.push(pre + 'payer_self_identified')
  if (!match(ev.cursor, RX.cursor)) e.push(pre + 'cursor')
  else if (at !== null && pseudo(ev.event_id, 'evt') && ev.cursor !== cursorOf(at, ev.event_id)) e.push(pre + 'cursor_mismatch')
  return e
}
export interface ResolvedKey { key: Buffer | null; origin: unknown; stores: unknown; valid_from: unknown; valid_until: unknown; revoked: unknown }
export function parseKeyring(data: Buffer, environ: Readonly<Record<string, string | undefined>>): Record<string, ResolvedKey> {
  if (data.length > MAX_KEYRING_BYTES) throw new Error('keyring')
  let meta: any; try { meta = parseContractJson(data) } catch { throw new Error('keyring') }
  if (!obj(meta) || !Object.keys(meta).length) throw new Error('keyring')
  for (const [kid, ent] of Object.entries(meta)) {
    if (!match(kid, RX.key_id) || !obj(ent) || !exactFields(ent, KEY_FIELDS) || !match(ent.env, ENV_RX) || !match(ent.origin, RX.origin) || !Array.isArray(ent.stores) || !ent.stores.length || !ent.stores.every((s: unknown) => match(s, RX.store))) throw new Error('keyring')
    const vf = instantUtc(ent.valid_from), vu = instantUtc(ent.valid_until)
    if (vf === null || vu === null || vf >= vu || typeof ent.revoked !== 'boolean') throw new Error('keyring')
  }
  const ring = Object.create(null)
  for (const [kid, ent] of Object.entries(meta) as [string, Record<string, any>][]) { const s = environ[ent.env]; ring[kid] = { ...ent, key: typeof s === 'string' && s ? Buffer.from(s, 'utf8') : null } }
  return ring
}
export function validateFeed(raw: unknown, att: any, keyring: Record<string, ResolvedKey> | null = null, expect: readonly string[] | null = null): [string[], boolean] {
  try { return validateInner(raw, att, keyring, expect) } catch (e) { return [[e instanceof Error && e.name === 'ValueError' ? 'unreadable:ValueError' : 'unreadable:TypeError'], false] }
}
function validateInner(rawValue: unknown, att: any, keyring: Record<string, ResolvedKey> | null, expect: readonly string[] | null): [string[], boolean] {
  if (!Buffer.isBuffer(rawValue)) return [['lote_not_bytes'], false]
  const raw = rawValue, errors: string[] = []
  if (raw.length > MAX_LOTE_BYTES) return [['lote_too_large'], false]
  if (raw.length && raw[raw.length - 1] !== 10) errors.push('lote_last_line_without_newline')
  const evs: Record<string, any>[] = [], ids = new Set<string>(), totals: Record<string, bigint> = {}, cursors: string[] = []
  let n = 0, pos = 0
  while (pos < raw.length) {
    let nl = raw.indexOf(10, pos); if (nl >= Math.min(raw.length, pos + MAX_LINE_BYTES + 1)) nl = -1
    n++; if (n > MAX_EVENTS) return [[...errors, 'lote_too_many_events'], false]
    if (nl < 0) { if (raw.length - pos > MAX_LINE_BYTES) return [[...errors, `l${n}:line_too_long`], false]; nl = raw.length }
    const chunk = raw.subarray(pos, nl); pos = nl + 1
    let line: string; try { line = decoder.decode(chunk) } catch { return [[...errors, `l${n}:not_utf8`], false] }
    if (errors.length > MAX_ERRORS) return [[...errors.slice(0, MAX_ERRORS), 'too_many_errors'], false]
    let ev: any; try { ev = parseContractJson(line) } catch { errors.push(`l${n}:json`); continue }
    errors.push(...checkEvent(ev, n)); if (!obj(ev)) continue
    evs.push(ev)
    if (typeof ev.event_id === 'string') { if (ids.has(ev.event_id)) errors.push(`l${n}:duplicate_event_id`); ids.add(ev.event_id) }
    if (typeof ev.cursor === 'string') cursors.push(ev.cursor)
    const amount = intValue(ev.amount_minor); if (amount !== null && TYPES.includes(ev.type)) totals[ev.type] = (totals[ev.type] ?? 0n) + amount
  }
  if (!n) errors.push('lote_empty')
  if (cursors.some((c, i) => i > 0 && c <= cursors[i - 1]!)) errors.push('cursor_not_strictly_increasing')
  for (const e of evs) if (Array.isArray(e.origin) || obj(e.origin) || Array.isArray(e.store) || obj(e.store)) throw new TypeError('contract_scope')
  if (new Set(evs.map(e => canonicalJson([e.origin ?? null, e.store ?? null]))).size > 1) errors.push('lote_mixes_origin_or_store')
  if (!obj(att)) return [[...errors, 'att:not_object'], false]
  const nx = Object.keys(att).filter(k => !ATT_FIELDS.includes(k)).length; if (nx) errors.push('att:extra_field:n=' + nx)
  for (const k of ATT_FIELDS) if (!own(att, k)) errors.push('att:missing:' + k)
  if (att.schema !== SCHEMA) errors.push('att:schema')
  for (const k of ['origin', 'store', 'key_id', 'sha256'] as const) if (!match(att[k], RX[k])) errors.push('att:' + k)
  if (evs.length && (att.origin !== evs[0]!.origin || att.store !== evs[0]!.store)) errors.push('att:binding_origin_store')
  if (att.sha256 !== sha256(raw)) errors.push('att:sha256_mismatch')
  if (!intEq(att.bytes, raw.length)) errors.push('att:bytes')
  if (!intEq(att.count, n)) errors.push('att:count')
  const oc = intValue(att.overlap_count); if (oc === null || oc < 0n || oc > BigInt(n)) errors.push('att:overlap_count')
  const tm = att.totals_minor
  if (!obj(tm) || Object.keys(tm).length !== Object.keys(totals).length || !Object.entries(tm).every(([k, v]) => TYPES.includes(k) && intValue(v) !== null && intValue(v) === totals[k])) errors.push('att:totals_minor')
  if (cursors.length && (att.first_cursor !== cursors[0] || att.last_cursor !== cursors[cursors.length - 1])) errors.push('att:cursor_range')
  const f = instantZ(att.from), t = instantZ(att.to), signed = instantZ(att.signed_at)
  if (f === null || t === null || f >= t) errors.push('att:window')
  if (signed === null || t !== null && signed < t) errors.push('att:signed_at')
  const scan = instantZ(att.scan_from)
  if (scan === null || f !== null && scan < f || t !== null && scan >= t) errors.push('att:scan_from')
  else if (cursors.length && RX.cursor.test(cursors[0]!)) { const c = cursors[0]!; const at = instantUtc(c.slice(0, 4) + '-' + c.slice(4, 6) + '-' + c.slice(6, 8) + 'T' + c.slice(9, 11) + ':' + c.slice(11, 13) + ':' + c.slice(13, 15) + 'Z'); if (at === null || at < scan) errors.push('att:scan_from_after_first_event') }
  if (f !== null && t !== null) for (const [i, ev] of evs.entries()) { const a = instantZ(ev.at); if (a !== null && !(f <= a && a < t)) errors.push(`l${i + 1}:at_outside_window`) }
  if (!match(att.sig, RX.sha256)) return [[...errors, 'att:sig_format'], false]
  if (keyring === null) return [errors, false]
  if (!Array.isArray(expect) || expect.length !== 2) return [[...errors, 'expect_missing'], false]
  if (att.origin !== expect[0] || att.store !== expect[1]) errors.push('att:unexpected_origin_store')
  const ent = typeof att.key_id === 'string' && obj(keyring) && own(keyring, att.key_id) ? keyring[att.key_id] : null
  if (!obj(ent) || !Buffer.isBuffer(ent.key) || ent.key.length < 32) return [[...errors, 'att:key_unknown'], false]
  if (ent.revoked !== false) errors.push('att:key_revoked')
  if (ent.origin !== att.origin || !Array.isArray(ent.stores) || !ent.stores.includes(att.store)) errors.push('att:key_scope')
  const vf = instantUtc(ent.valid_from), vu = instantUtc(ent.valid_until)
  if (vf === null || vu === null || signed === null || !(vf <= signed && signed < vu)) errors.push('att:key_period')
  const sig = Buffer.from(att.sig, 'hex'), want = Buffer.from(attestSig(att, ent.key), 'hex')
  const ok = sig.length === want.length && timingSafeEqual(sig, want); if (!ok) errors.push('att:sig_invalid')
  return [errors, ok && !errors.length]
}
export function checkPronto(pronto: Buffer, lote: Buffer, att: Buffer, loteName: string, attName: string): string[] {
  let p: any; try { p = parseContractJson(pronto) } catch { return ['pronto:json'] }
  if (!obj(p) || !exactFields(p, PRONTO_FIELDS)) return ['pronto:fields']
  const e: string[] = []
  if (p.schema !== SCHEMA) e.push('pronto:schema')
  if (p.lote !== loteName || p.atestado !== attName) e.push('pronto:names')
  if (p.lote_sha256 !== sha256(lote)) e.push('pronto:lote_sha256')
  if (p.atestado_sha256 !== sha256(att)) e.push('pronto:atestado_sha256')
  return e
}
interface Material { input: TrioInput; key: Buffer; lineHashes: readonly string[] }
const materials = new WeakMap<ValidatedTrio, Material>()
function freezeDeep<T>(v: T): T { if (v !== null && typeof v === 'object') { for (const c of Object.values(v)) freezeDeep(c); Object.freeze(v) } return v }
const validName = (v: unknown, prefix: string, suffix: string) => typeof v === 'string' && new RegExp('^' + prefix + '-[A-Za-z0-9_-]+\\.' + suffix + '$').test(v) && !/QUARENTENA|\.tmp|\.parcial/.test(v)
export function validateTrio(input: TrioInput, trusted: TrustedShadowContext): TrioValidationResult {
  try {
    if (!input || !Buffer.isBuffer(input.lote) || !Buffer.isBuffer(input.atestado) || !Buffer.isBuffer(input.pronto)) return { ok: false, exitCode: 1, errors: ['trio:not_bytes'], signed: false }
    if (input.lote.length > MAX_LOTE_BYTES || input.atestado.length > MAX_ATT_BYTES || input.pronto.length > MAX_PRONTO_BYTES) return { ok: false, exitCode: 1, errors: ['trio:file_too_large'], signed: false }
    if (!validName(input.loteName, 'LOTE', 'jsonl') || !validName(input.atestadoName, 'ATESTADO', 'json') || !validName(input.prontoName, 'PRONTO', 'json')) return { ok: false, exitCode: 1, errors: ['trio:names'], signed: false }
    if (!trusted || !match(trusted.origin, RX.origin) || !match(trusted.store, RX.store)) return { ok: false, exitCode: 1, errors: ['expect_missing'], signed: false }
    const copied: TrioInput = { ...input, lote: Buffer.from(input.lote), atestado: Buffer.from(input.atestado), pronto: Buffer.from(input.pronto) }
    let ring: Record<string, ResolvedKey>
    try { ring = parseKeyring(Buffer.from(canonicalJson(trusted.keyring)), trusted.secrets) } catch { return { ok: false, exitCode: 1, errors: ['keyring:invalid'], signed: false } }
    let att: any; try { att = parseContractJson(copied.atestado) } catch { att = null }
    const [errors, signed] = validateFeed(copied.lote, att, ring, [trusted.origin, trusted.store])
    errors.push(...checkPronto(copied.pronto, copied.lote, copied.atestado, copied.loteName, copied.atestadoName))
    if (errors.length) return { ok: false, exitCode: 1, errors, signed }
    if (!signed) return { ok: false, exitCode: 2, errors: [], signed: false }
    const binding: TrioBinding = { lote_name: copied.loteName, atestado_name: copied.atestadoName, pronto_name: copied.prontoName, lote_sha256: sha256(copied.lote), atestado_sha256: sha256(copied.atestado), pronto_sha256: sha256(copied.pronto), trio_sha256: '' }
    binding.trio_sha256 = sha256(canonicalJson(binding))
    const events = copied.lote.toString('utf8').split('\n').slice(0, -1).map(line => parseContractJson(line)) as ShadowEvent[]
    const validated: ValidatedTrio = freezeDeep({ events, attestation: att as ShadowAttestation, binding })
    const lineHashes: string[] = []; let pos = 0
    while (pos < copied.lote.length) { const nl = copied.lote.indexOf(10, pos); lineHashes.push(sha256(copied.lote.subarray(pos, nl))); pos = nl + 1 }
    materials.set(validated, { input: copied, key: Buffer.from(ring[att.key_id]!.key!), lineHashes: Object.freeze(lineHashes) })
    return { ok: true, exitCode: 0, errors: [], signed: true, validated }
  } catch { return { ok: false, exitCode: 1, errors: ['trio:invalid'], signed: false } }
}
/** Recheck current trusted scope/key before DB access; rejects structural forgery and mutation/rotation. */
export function authorizedMaterial(v: ValidatedTrio, trusted: TrustedShadowContext): { key: Buffer; lineHashes: readonly string[] } {
  const m = materials.get(v); if (!m) throw new Error('shadow_unvalidated')
  const again = validateTrio(m.input, trusted)
  if (!again.ok || again.validated.binding.trio_sha256 !== v.binding.trio_sha256) throw new Error('shadow_context_changed')
  return { key: Buffer.from(m.key), lineHashes: m.lineHashes }
}
export function receiptPayload(receipt: ShadowBatchReceipt): string { const { sig: _sig, ...body } = receipt; return canonicalJson(body) }
export function signReceipt(receipt: ShadowBatchReceipt, key: Buffer): string { return createHmac('sha256', key).update(receiptPayload(receipt)).digest('hex') }
export function verifyShadowReceipt(receipt: unknown, validated: ValidatedTrio, trusted: TrustedShadowContext): boolean {
  try {
    const { key } = authorizedMaterial(validated, trusted); if (!obj(receipt) || !match(receipt.sig, RX.sha256)) return false
    const a = validated.attestation, b = validated.binding
    const fields = [...Object.keys(b), 'schema', 'mode', 'bank_settlement', 'origin', 'store', 'key_id', 'count', 'accepted', 'duplicates', 'rejected', 'result', 'codes', 'first_cursor', 'last_cursor', 'checkpoint', 'committed_at', 'sig']
    if (!exactFields(receipt, fields) || receipt.schema !== 'pixsettle-shadow-receipt/1' || receipt.mode !== 'shadow' || receipt.bank_settlement !== false || receipt.origin !== trusted.origin || receipt.store !== trusted.store || receipt.key_id !== a.key_id || receipt.count !== a.count || receipt.first_cursor !== a.first_cursor || receipt.last_cursor !== a.last_cursor || !['accepted', 'rejected'].includes(receipt.result) || !Array.isArray(receipt.codes) || !Number.isSafeInteger(receipt.rejected) || !Number.isSafeInteger(receipt.accepted) || !Number.isSafeInteger(receipt.duplicates) || receipt.accepted < 0 || receipt.duplicates < 0 || receipt.accepted + receipt.duplicates + receipt.rejected !== a.count || instantZ(receipt.committed_at) === null) return false
    if (receipt.result === 'accepted' && (receipt.rejected !== 0 || receipt.codes.length || !match(receipt.checkpoint, RX.cursor) || receipt.checkpoint < a.last_cursor)) return false
    if (receipt.result === 'rejected' && (receipt.accepted !== 0 || receipt.duplicates !== 0 || receipt.rejected !== a.count || !receipt.codes.length || !receipt.codes.every((c: unknown) => typeof c === 'string' && /^l[0-9]{1,4}:conflito$/.test(c)) || receipt.checkpoint !== null && !match(receipt.checkpoint, RX.cursor))) return false
    if (Object.entries(b).some(([k, value]) => receipt[k] !== value)) return false
    const want = Buffer.from(signReceipt(receipt as ShadowBatchReceipt, key), 'hex'), got = Buffer.from(receipt.sig, 'hex')
    return want.length === got.length && timingSafeEqual(want, got)
  } catch { return false }
}
