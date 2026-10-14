import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canonical, commitment, memoFor, parseMemo, SealError, seal, validate, verifyAgainst } from '../src/seal.js'

type V = { name: string; record: any; salt: string; canonical: string; commitment: string }
type I = { name: string; record: any; reason: string; path: string }
const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8')) as { valid: V[]; invalid: I[] }

describe('pbp.seal/1 cross-language vectors (Python is the reference)', () => {
  for (const v of vectors.valid) {
    it(`valid: ${v.name} has the same canonical bytes and commitment`, () => {
      expect(canonical(v.record)).toBe(v.canonical)
      expect(commitment(v.record, v.salt)).toBe(v.commitment)
    })
  }
  for (const v of vectors.invalid) {
    it(`invalid: ${v.name} fails with ${v.reason} at ${v.path}`, () => {
      try { validate(v.record); throw new Error('should have failed') } catch (e) {
        expect(e).toBeInstanceOf(SealError)
        expect((e as SealError).reason).toBe(v.reason)
        expect((e as SealError).path).toBe(v.path)
        expect(JSON.stringify((e as SealError).findings)).not.toContain('529.982.247-25')
      }
    })
  }
})

describe('seal and verify', () => {
  const base = vectors.valid[0]!
  it('memo roundtrip', () => {
    const s = seal(base.record, base.salt)
    expect(s.memo).toBe(memoFor(base.commitment))
    expect(parseMemo(s.memo)).toBe(base.commitment)
    expect(parseMemo('gm')).toBeNull()
  })
  it('four states', () => {
    const chain = { memo: memoFor(base.commitment), blockTime: 1000 }
    expect(verifyAgainst(base.record, base.salt, null).state).toBe('pending')
    expect(verifyAgainst(base.record, base.salt, chain, 1001).state).toBe('sealed')
    expect(verifyAgainst(base.record, base.salt, chain, 999)).toEqual({ state: 'tampered', reason: 'sealed_after_money_moved' })
    const edited = structuredClone(base.record)
    edited.missing = { payer_message: null } // someone completes the dossier later
    expect(verifyAgainst(edited, base.salt, chain)).toEqual({ state: 'tampered', reason: 'commitment_mismatch' })
    expect(verifyAgainst(base.record, base.salt, { memo: 'gm', blockTime: 1 }).state).toBe('unverifiable')
  })
})
