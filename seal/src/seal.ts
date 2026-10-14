// Proof Before Pay, spec pbp.seal/1. TypeScript twin of the Python reference (python/pbp_seal/record.py).
// commitment = sha256( "pbp.seal/1\n" + salt_hex + "\n" + JCS(record) ); only "pbp1:<commitment>" goes on chain.
// Validation errors carry a stable reason and a JSON path, never the value. Both languages must agree on
// every vector in test/vectors.json (canonical bytes, commitment, reason and path).
import { createHash, randomBytes } from 'node:crypto'
import canonicalizeLib from 'canonicalize'
import { diagnosticKeyPath, scanPii, type Finding } from './pii.js'
import { isJsonArray, isJsonObject as isObj } from './json.js'

const canonicalize = canonicalizeLib as unknown as (v: unknown) => string | undefined

export const SPEC = 'pbp.seal/1'
export const MEMO_PREFIX = 'pbp1:'
const HEX64 = /^[0-9a-f]{64}$/
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ID = /^[A-Za-z0-9_\-:.]{1,64}$/
const DIGITS = /^(0|[1-9]\d{0,17})$/
const CUR = /^[A-Z]{3}$/
const FLOAT_PATHS = new Set(['$.decision.confidence', '$.model.temperature'])
const KINDS = new Set(['decision', 'approval', 'rule_change'])

export class SealError extends Error {
  constructor(public reason: string, public path = '$', public findings: Finding[] = []) {
    super(`${reason} at ${path}`)
  }
}

type Obj = Record<string, unknown>
const hasOwn = (o: Obj, key: string) => Object.hasOwn(o, key)

function validTimestamp(at: string): boolean {
  if (!AT.test(at)) return false
  const milliseconds = Date.parse(at)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === at
}

function need(o: Obj, key: string, typ: 'string' | 'object' | 'array' | 'boolean', path: string): any {
  if (!hasOwn(o, key)) throw new SealError('missing_field', diagnosticKeyPath(path, key))
  const v = o[key]
  const ok = typ === 'object' ? isObj(v) : typ === 'array' ? isJsonArray(v) : typeof v === typ
  if (!ok) throw new SealError('wrong_type', diagnosticKeyPath(path, key))
  return v
}

function only(o: Obj, allowed: string[], path: string) {
  const extra = Object.keys(o).filter(k => !allowed.includes(k)).sort()
  if (extra.length) throw new SealError('unknown_field', diagnosticKeyPath(path, extra[0]!))
}

function walkNumbers(v: unknown, path = '$'): void {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new SealError('number_not_finite', path)
    if (!Number.isInteger(v)) { if (!FLOAT_PATHS.has(path)) throw new SealError('float_not_allowed', path); return }
    if (!Number.isSafeInteger(v)) throw new SealError('int_out_of_safe_range', path)
    return
  }
  if (isJsonArray(v)) { v.forEach((x, i) => walkNumbers(x, `${path}[${i}]`)); return }
  if (isObj(v)) { for (const [k, x] of Object.entries(v)) walkNumbers(x, diagnosticKeyPath(path, k)); return }
  throw new SealError('unsupported_type', path)
}

function sortedUniqueStrings(v: unknown, path: string) {
  if (!isJsonArray(v) || v.some(x => typeof x !== 'string' || !x)) throw new SealError('wrong_type', path)
  const s = [...new Set(v as string[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (s.length !== v.length || s.some((x, i) => x !== v[i])) throw new SealError('not_sorted_unique', path)
}

function common(r: Obj) {
  if (!hasOwn(r, 'v') || r.v !== SPEC) throw new SealError('bad_spec_version', '$.v')
  if (!hasOwn(r, 'kind') || typeof r.kind !== 'string' || !KINDS.has(r.kind)) throw new SealError('bad_kind', '$.kind')
  if (!validTimestamp(need(r, 'at', 'string', '$'))) throw new SealError('bad_timestamp', '$.at')
  const c = need(r, 'case', 'object', '$') as Obj
  only(c, ['id', 'exception', 'store'], '$.case')
  if (!ID.test(need(c, 'id', 'string', '$.case'))) throw new SealError('bad_case_id', '$.case.id')
  need(c, 'exception', 'string', '$.case')
  if (hasOwn(c, 'store') && typeof c.store !== 'string') throw new SealError('wrong_type', '$.case.store')
  if (!hasOwn(r, 'prev')) throw new SealError('missing_field', '$.prev')
  if (r.prev !== null && (typeof r.prev !== 'string' || !HEX64.test(r.prev))) throw new SealError('bad_prev', '$.prev')
}

function decision(r: Obj) {
  only(r, ['v', 'kind', 'case', 'at', 'saw', 'missing', 'policy', 'rules', 'model', 'decision', 'forbidden', 'limits', 'prev'], '$')
  const saw = need(r, 'saw', 'object', '$') as Obj
  only(saw, ['inputs', 'tools'], '$.saw')
  need(saw, 'inputs', 'object', '$.saw')
  const tools = need(saw, 'tools', 'array', '$.saw') as unknown[]
  tools.forEach((t, i) => {
    const p = `$.saw.tools[${i}]`
    if (!isObj(t)) throw new SealError('wrong_type', p)
    only(t, ['name', 'args', 'output'], p)
    need(t, 'name', 'string', p); need(t, 'args', 'object', p)
    if (!hasOwn(t, 'output')) throw new SealError('missing_field', `${p}.output`)
  })
  const missing = need(r, 'missing', 'object', '$') as Obj
  for (const [k, v] of Object.entries(missing)) if (v !== null) throw new SealError('missing_value_must_be_null', diagnosticKeyPath('$.missing', k))
  const pol = need(r, 'policy', 'object', '$') as Obj
  only(pol, ['id', 'version', 'sha256'], '$.policy')
  need(pol, 'id', 'string', '$.policy'); need(pol, 'version', 'string', '$.policy')
  if (!HEX64.test(need(pol, 'sha256', 'string', '$.policy'))) throw new SealError('bad_hash', '$.policy.sha256')
  if (hasOwn(r, 'rules') && r.rules !== null) { need(r, 'rules', 'object', '$'); only(r.rules as Obj, ['engine', 'version', 'result'], '$.rules') }
  if (hasOwn(r, 'model') && r.model !== null) {
    const m = need(r, 'model', 'object', '$') as Obj
    only(m, ['provider', 'id', 'temperature', 'mode'], '$.model')
    need(m, 'provider', 'string', '$.model'); need(m, 'id', 'string', '$.model')
    if (!hasOwn(m, 'mode') || m.mode !== 'live' && m.mode !== 'recorded') throw new SealError('bad_model_mode', '$.model.mode')
    if (!hasOwn(m, 'temperature') || typeof m.temperature !== 'number') throw new SealError('wrong_type', '$.model.temperature')
  }
  const d = need(r, 'decision', 'object', '$') as Obj
  only(d, ['action', 'moves_money', 'amount_minor', 'requires_human', 'confidence', 'rationale', 'evidence_refs'], '$.decision')
  need(d, 'action', 'string', '$.decision')
  const moves = need(d, 'moves_money', 'boolean', '$.decision') as boolean
  const human = need(d, 'requires_human', 'boolean', '$.decision') as boolean
  const rat = (need(d, 'rationale', 'string', '$.decision') as string).trim()
  if (rat.length < 8 || rat.length > 800) throw new SealError('rationale_length', '$.decision.rationale')
  const refs = need(d, 'evidence_refs', 'array', '$.decision') as unknown[]
  if (!refs.length || refs.some(x => typeof x !== 'string')) throw new SealError('evidence_refs_missing', '$.decision.evidence_refs')
  if (hasOwn(d, 'confidence') && (typeof d.confidence !== 'number' || d.confidence < 0 || d.confidence > 1)) throw new SealError('confidence_out_of_range', '$.decision.confidence')
  sortedUniqueStrings(need(r, 'forbidden', 'array', '$'), '$.forbidden')
  if ((r.forbidden as string[]).includes(d.action as string)) throw new SealError('action_is_forbidden', '$.decision.action')
  const lim = need(r, 'limits', 'object', '$') as Obj
  only(lim, ['autonomous_minor', 'currency'], '$.limits')
  if (!DIGITS.test(need(lim, 'autonomous_minor', 'string', '$.limits'))) throw new SealError('bad_amount', '$.limits.autonomous_minor')
  if (!CUR.test(need(lim, 'currency', 'string', '$.limits'))) throw new SealError('bad_currency', '$.limits.currency')
  if (moves) {
    const amt = hasOwn(d, 'amount_minor') ? d.amount_minor : undefined
    if (amt !== undefined && amt !== null && (typeof amt !== 'string' || !DIGITS.test(amt))) throw new SealError('bad_amount', '$.decision.amount_minor')
    const limit = lim.autonomous_minor as string
    const within = typeof amt === 'string' && limit !== '0' && BigInt(amt) <= BigInt(limit)
    if (!within && !human) throw new SealError('money_above_limit_without_human', '$.decision.requires_human')
  }
}

function approval(r: Obj) {
  only(r, ['v', 'kind', 'case', 'at', 'human', 'prev'], '$')
  const h = need(r, 'human', 'object', '$') as Obj
  only(h, ['operator', 'outcome', 'approves', 'note'], '$.human')
  if (!ID.test(need(h, 'operator', 'string', '$.human'))) throw new SealError('bad_operator_id', '$.human.operator')
  if (!hasOwn(h, 'outcome') || h.outcome !== 'approved' && h.outcome !== 'rejected') throw new SealError('bad_outcome', '$.human.outcome')
  if (!HEX64.test(need(h, 'approves', 'string', '$.human'))) throw new SealError('bad_hash', '$.human.approves')
  if (hasOwn(h, 'note') && typeof h.note !== 'string') throw new SealError('wrong_type', '$.human.note')
}

function ruleChange(r: Obj) {
  only(r, ['v', 'kind', 'case', 'at', 'rule', 'author', 'from_decision', 'prev'], '$')
  const rule = need(r, 'rule', 'object', '$') as Obj
  only(rule, ['id', 'version_from', 'version_to', 'diff_sha256'], '$.rule')
  for (const k of ['id', 'version_from', 'version_to']) need(rule, k, 'string', '$.rule')
  if (!HEX64.test(need(rule, 'diff_sha256', 'string', '$.rule'))) throw new SealError('bad_hash', '$.rule.diff_sha256')
  if (!ID.test(need(r, 'author', 'string', '$'))) throw new SealError('bad_operator_id', '$.author')
  if (!HEX64.test(need(r, 'from_decision', 'string', '$'))) throw new SealError('bad_hash', '$.from_decision')
}

export function validate(record: unknown): void {
  if (!isObj(record)) throw new SealError('record_not_object', '$')
  walkNumbers(record)
  common(record)
  const k = record.kind as string
  if (k === 'decision') decision(record)
  else if (k === 'approval') approval(record)
  else ruleChange(record)
  const findings = scanPii(record)
  if (findings.length) throw new SealError('personal_data_found', findings[0]!.path, findings)
}

export function canonical(record: unknown): string {
  const s = canonicalize(record)
  if (s === undefined) throw new SealError('not_canonicalizable', '$')
  return s
}

export const newSalt = () => randomBytes(32).toString('hex')

export function commitment(record: unknown, saltHex: string, check = true): string {
  if (!HEX64.test(saltHex)) throw new SealError('bad_salt', '$salt')
  if (check) validate(record)
  return createHash('sha256').update(`${SPEC}\n${saltHex}\n`, 'utf8').update(canonical(record), 'utf8').digest('hex')
}

export function memoFor(c: string): string {
  if (!HEX64.test(c)) throw new SealError('bad_hash', '$commitment')
  return MEMO_PREFIX + c
}

export function parseMemo(memo: unknown): string | null {
  if (typeof memo !== 'string' || !memo.startsWith(MEMO_PREFIX)) return null
  const c = memo.slice(MEMO_PREFIX.length)
  return HEX64.test(c) ? c : null
}

export function seal(record: unknown, saltHex?: string) {
  const salt = saltHex ?? newSalt()
  const c = commitment(record, salt)
  return { commitment: c, salt, memo: memoFor(c) }
}

export type VerifyState = 'sealed' | 'tampered' | 'pending' | 'unverifiable'
/** Same four states as the Python verifier; `onChain` is what the anchor transaction's memo holds. */
export function verifyAgainst(record: unknown, saltHex: string, onChain: { memo: string | null; blockTime: number | null } | null,
  moneyMovedAt?: number): { state: VerifyState; reason: string } {
  let c: string
  try { c = commitment(record, saltHex) } catch (e) { return { state: 'tampered', reason: `invalid_record:${(e as SealError).reason}` } }
  if (!onChain) return { state: 'pending', reason: 'not_anchored' }
  let blockTime: unknown
  try { blockTime = onChain.blockTime } catch { return { state: 'unverifiable', reason: 'invalid_anchor_time' } }
  if (blockTime === null) return { state: 'unverifiable', reason: 'anchor_time_unavailable' }
  if (typeof blockTime !== 'number' || !Number.isSafeInteger(blockTime) || blockTime < 0) {
    return { state: 'unverifiable', reason: 'invalid_anchor_time' }
  }
  // Event time is Unix seconds and may include fractions; it must be finite.
  if (moneyMovedAt !== undefined && (typeof moneyMovedAt !== 'number' || !Number.isFinite(moneyMovedAt)
    || moneyMovedAt < 0 || moneyMovedAt > Number.MAX_SAFE_INTEGER)) {
    return { state: 'unverifiable', reason: 'invalid_money_moved_time' }
  }
  let memo: unknown
  try { memo = onChain.memo } catch { return { state: 'unverifiable', reason: 'anchor_memo_not_pbp' } }
  const got = parseMemo(memo)
  if (!got) return { state: 'unverifiable', reason: 'anchor_memo_not_pbp' }
  if (got !== c) return { state: 'tampered', reason: 'commitment_mismatch' }
  if (moneyMovedAt !== undefined && blockTime > moneyMovedAt) return { state: 'tampered', reason: 'sealed_after_money_moved' }
  return { state: 'sealed', reason: 'ok' }
}
