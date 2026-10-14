// Corrective S0 regression cases. Authored statically; not executed on the Mac.
// These strings are synthetic fixtures, not customer data.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { scanPii } from '../src/pii.js'
import { canonical, commitment, memoFor, SealError, seal, validate, verifyAgainst } from '../src/seal.js'

type Vector = { name: string; record: any; salt: string; canonical: string; commitment: string }
const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8')) as { valid: Vector[] }
const base = vectors.valid[0]!
const email = 's0-check@example.invalid'
const cpf = '529.982.247-25' // Same checksum fixture already present in the golden vectors.
const fresh = () => structuredClone(base.record)

function rejected(record: unknown, check: (value: unknown) => unknown = validate): SealError {
  try { check(record) } catch (error) {
    expect(error).toBeInstanceOf(SealError)
    return error as SealError
  }
  throw new Error('Expected record rejection')
}

function noPersonalKey(error: SealError) {
  const diagnostic = `${String(error)}\n${JSON.stringify({ message: error.message, path: error.path, findings: error.findings })}`
  expect(diagnostic).not.toContain(email)
  expect(diagnostic).not.toContain(cpf)
}

// No concurrent tests: restore the intrinsic prototype even after assertion failure.
function withInherited(key: string, value: unknown, check: () => void) {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key)
  Object.defineProperty(Object.prototype, key, { value, writable: true, configurable: true, enumerable: false })
  try { check() } finally {
    if (previous) Object.defineProperty(Object.prototype, key, previous)
    else Reflect.deleteProperty(Object.prototype, key)
  }
}

describe('personal keys never enter diagnostics', () => {
  it('redacts a personal ancestor for both key and descendant findings', () => {
    const record = fresh()
    record.saw.inputs[email] = { note: cpf }
    const findings = scanPii(record)
    expect(findings).toContainEqual({ path: '$.saw.inputs[redacted_key]', kind: 'email' })
    expect(findings).toContainEqual({ path: '$.saw.inputs[redacted_key].note', kind: 'cpf' })
    expect(JSON.stringify(findings)).not.toContain(email)
    expect(JSON.stringify(findings)).not.toContain(cpf)
    for (const check of [validate, (value: unknown) => seal(value, base.salt), (value: unknown) => commitment(value, base.salt)]) {
      const error = rejected(record, check)
      expect(error.reason).toBe('personal_data_found')
      noPersonalKey(error)
    }
  })

  for (const key of [email, cpf]) {
    it(`sanitizes a ${key === email ? 'mail' : 'document'} key rejected by only`, () => {
      const record = fresh()
      record[key] = null
      const error = rejected(record)
      expect(error.reason).toBe('unknown_field')
      expect(error.path).toBe('$[redacted_key]')
      noPersonalKey(error)
    })

    it(`sanitizes a ${key === email ? 'mail' : 'document'} missing-evidence key before PII scan`, () => {
      const record = fresh()
      record.missing[key] = 'pending'
      const error = rejected(record)
      expect(error.reason).toBe('missing_value_must_be_null')
      expect(error.path).toBe('$.missing[redacted_key]')
      noPersonalKey(error)
    })

    it(`refuses a ${key === email ? 'mail' : 'document'} missing-evidence key even with null value`, () => {
      const record = fresh()
      record.missing[key] = null
      const error = rejected(record)
      expect(error.reason).toBe('personal_data_found')
      noPersonalKey(error)
    })
  }

  for (const [value, reason] of [[1.25, 'float_not_allowed'], [NaN, 'number_not_finite']] as const) {
    it(`redacts numeric failure ${reason} before schema validation`, () => {
      const record = fresh()
      record.saw.inputs[email] = value
      const error = rejected(record)
      expect(error.reason).toBe(reason)
      expect(error.path).toBe('$.saw.inputs[redacted_key]')
      noPersonalKey(error)
    })
  }
})

describe('validation cannot read required evidence from a prototype', () => {
  it('rejects a non-JSON root prototype despite otherwise valid own fields', () => {
    const record = Object.assign(Object.create({ extra: 'inherited' }), fresh())
    const error = rejected(record)
    expect(error.reason).toBe('record_not_object')
    expect(error.path).toBe('$')
  })

  it('rejects a nested policy whose version is inherited', () => {
    const record = fresh()
    const { version, ...ownPolicy } = record.policy
    record.policy = Object.assign(Object.create({ version }), ownPolicy)
    const error = rejected(record)
    expect(error.reason).toBe('unsupported_type')
    expect(error.path).toBe('$.policy')
  })

  for (const fixture of [
    { key: 'v', reason: 'bad_spec_version', path: '$.v', select: (r: any) => r },
    { key: 'kind', reason: 'bad_kind', path: '$.kind', select: (r: any) => r },
    { key: 'prev', reason: 'missing_field', path: '$.prev', select: (r: any) => r },
    { key: 'version', reason: 'missing_field', path: '$.policy.version', select: (r: any) => r.policy },
    { key: 'output', reason: 'missing_field', path: '$.saw.tools[0].output', select: (r: any) => r.saw.tools[0] },
    { key: 'requires_human', reason: 'missing_field', path: '$.decision.requires_human', select: (r: any) => r.decision },
    { key: 'mode', reason: 'bad_model_mode', path: '$.model.mode', select: (r: any) => r.model },
    { key: 'temperature', reason: 'wrong_type', path: '$.model.temperature', select: (r: any) => r.model }
  ]) {
    it(`does not accept inherited ${fixture.path} on the standard prototype`, () => {
      const record = fresh()
      const owner = fixture.select(record)
      const value = owner[fixture.key]
      delete owner[fixture.key]
      withInherited(fixture.key, value, () => {
        const error = rejected(record)
        expect(error.reason).toBe(fixture.reason)
        expect(error.path).toBe(fixture.path)
      })
    })
  }

  it('does not accept a human outcome inherited from the standard prototype', () => {
    const record = structuredClone(vectors.valid.find(v => v.name === 'approval')!.record)
    const value = record.human.outcome
    delete record.human.outcome
    withInherited('outcome', value, () => {
      expect(rejected(record).reason).toBe('bad_outcome')
    })
  })

  it('does not authorize autonomy with an amount omitted from the sealed bytes', () => {
    const record = fresh()
    record.limits.autonomous_minor = '20000'
    record.decision.requires_human = false
    delete record.decision.amount_minor
    withInherited('amount_minor', '15990', () => {
      for (const check of [validate, (value: unknown) => seal(value, base.salt), (value: unknown) => commitment(value, base.salt)]) {
        expect(rejected(record, check).reason).toBe('money_above_limit_without_human')
      }
    })
  })

  it('rejects a hidden required property omitted by canonical JSON', () => {
    const record = fresh()
    Object.defineProperty(record.policy, 'version', { value: record.policy.version, enumerable: false })
    expect(rejected(record).reason).toBe('unsupported_type')
  })

  it('rejects an accessor without invoking it', () => {
    const record = fresh()
    let getterReads = 0
    Object.defineProperty(record.policy, 'version', { enumerable: true, get: () => { getterReads++; return '2026-10-01' } })
    expect(rejected(record).reason).toBe('unsupported_type')
    expect(getterReads).toBe(0)
  })

  it('keeps null-prototype JSON objects and the golden commitment compatible', () => {
    const record = Object.assign(Object.create(null), fresh())
    expect(canonical(record)).toBe(base.canonical)
    expect(commitment(record, base.salt)).toBe(base.commitment)
  })

  it('refuses a sparse evidence array instead of accepting an inherited or missing index', () => {
    const record = fresh()
    record.decision.evidence_refs = new Array(1)
    const error = rejected(record)
    expect(error.reason).toBe('unsupported_type')
    expect(error.path).toBe('$.decision.evidence_refs')
  })

  it('refuses an array accessor without invoking a personal-data-bearing exception', () => {
    const record = fresh()
    let getterReads = 0
    const array = ['safe']
    Object.defineProperty(array, '0', { enumerable: true, get: () => { getterReads++; throw new Error(email) } })
    record.saw.inputs.items = array
    const error = rejected(record)
    expect(error.reason).toBe('unsupported_type')
    expect(getterReads).toBe(0)
    noPersonalKey(error)
  })

  it('refuses an array with a custom prototype', () => {
    const record = fresh()
    const array = ['pix:a1']
    Object.setPrototypeOf(array, Object.create(Array.prototype))
    record.decision.evidence_refs = array
    expect(rejected(record).reason).toBe('unsupported_type')
  })
})

describe('calendar and proof times must be valid', () => {
  for (const at of ['2026-02-29T03:12:45.120Z', '2026-02-30T03:12:45.120Z', '2026-04-31T03:12:45.120Z', '2026-13-14T03:12:45.120Z', '2026-10-14T24:00:00.000Z']) {
    it(`rejects impossible calendar timestamp ${at}`, () => {
      const record = fresh()
      record.at = at
      const error = rejected(record)
      expect(error.reason).toBe('bad_timestamp')
      expect(error.path).toBe('$.at')
    })
  }

  const chain = { memo: memoFor(base.commitment), blockTime: 1000 }
  for (const blockTime of [NaN, Infinity, -Infinity, -1, 1.25, Number.MAX_SAFE_INTEGER + 1, '1000']) {
    it(`does not report sealed for invalid anchor time ${String(blockTime)}`, () => {
      expect(verifyAgainst(base.record, base.salt, { ...chain, blockTime: blockTime as any }, 1001))
        .toEqual({ state: 'unverifiable', reason: 'invalid_anchor_time' })
    })
  }
  it('treats missing anchor time as unavailable, not as proof of ordering', () => {
    expect(verifyAgainst(base.record, base.salt, { ...chain, blockTime: null }, 1001))
      .toEqual({ state: 'unverifiable', reason: 'anchor_time_unavailable' })
  })
  for (const moneyMovedAt of [NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1, '1001']) {
    it(`does not report sealed when event time is invalid: ${String(moneyMovedAt)}`, () => {
      expect(verifyAgainst(base.record, base.salt, chain, moneyMovedAt as any))
        .toEqual({ state: 'unverifiable', reason: 'invalid_money_moved_time' })
    })
  }
  it('preserves a valid fractional event time in Unix seconds', () => {
    expect(verifyAgainst(base.record, base.salt, chain, 1000.5)).toEqual({ state: 'sealed', reason: 'ok' })
  })
  it('compares the same anchor time that was validated, without repeated getter reads', () => {
    let getterReads = 0
    const changingChain = { memo: chain.memo, get blockTime() { getterReads++; return getterReads < 5 ? 1000 : NaN } }
    expect(verifyAgainst(base.record, base.salt, changingChain, 999))
      .toEqual({ state: 'tampered', reason: 'sealed_after_money_moved' })
    expect(getterReads).toBe(1)
  })
  it('does not expose an exception from anchor time metadata', () => {
    const brokenChain = { memo: chain.memo, get blockTime(): number { throw new Error(email) } }
    expect(verifyAgainst(base.record, base.salt, brokenChain, 1001))
      .toEqual({ state: 'unverifiable', reason: 'invalid_anchor_time' })
  })
  it('keeps the four-state response when anchor memo metadata throws', () => {
    const brokenChain = { blockTime: 1000, get memo(): string { throw new Error(email) } }
    expect(verifyAgainst(base.record, base.salt, brokenChain, 1001))
      .toEqual({ state: 'unverifiable', reason: 'anchor_memo_not_pbp' })
  })
})
