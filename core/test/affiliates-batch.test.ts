// Validação pura do lote assinado (escrita pela rodada agendada do Claude, patch 3; absorvida sem mudança de regra).
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { SECRET, KEY, ev, batch } from './affiliates-batch-fixture.js'
import { canonicalJson, sha256 } from '../src/pilot-shadow/guard.js'
import { validateBatch, checkChain, CommissionError } from '../src/affiliates/batches/batch.js'

const code = (fn: () => unknown) => { try { fn(); return 'ok' } catch (e) { return e instanceof CommissionError ? e.code : 'other:' + (e as Error).message } }

describe('affiliate commission batch (contract §3-§4)', () => {
  it('accepts a valid batch and hashes the exact bytes', () => {
    const raw = batch([ev(1), ev(2), ev(3)])
    const v = validateBatch(raw, 'k_comtest', [KEY])
    expect(v.batch.count).toBe(3)
    expect(v.batch_sha256).toBe(sha256(raw))
  })
  it('enforces the chain', () => {
    const first = validateBatch(batch([ev(1)]), 'k_comtest', [KEY])
    expect(code(() => checkChain(first, null))).toBe('ok')
    const second = validateBatch(batch([ev(1, { status: 'active', source_updated_at: '2026-10-05T00:00:00Z' })], { previous_batch_sha256: first.batch_sha256 }), 'k_comtest', [KEY])
    expect(code(() => checkChain(second, first.batch_sha256))).toBe('ok')
    expect(code(() => checkChain(second, null))).toBe('commission_chain_gap')
  })
  it.each([
    ['bad signature', () => validateBatch(batch([ev(1)], {}, Buffer.from('another-test-key-0123456789abcdef012345')), 'k_comtest', [KEY]), 'commission_signature_invalid'],
    ['header key mismatch', () => validateBatch(batch([ev(1)]), 'k_other', [KEY]), 'commission_key_invalid'],
    ['wrong key scope', () => validateBatch(batch([ev(1)]), 'k_comtest', [{ ...KEY, scope: 'e1' as 'commission' }]), 'commission_key_invalid'],
    ['not canonical (whitespace)', () => validateBatch(Buffer.from(batch([ev(1)]).toString().replace('{', '{ ')), 'k_comtest', [KEY]), 'commission_batch_not_canonical'],
    ['no trailing LF', () => validateBatch(batch([ev(1)]).subarray(0, -1), 'k_comtest', [KEY]), 'commission_batch_framing'],
    ['tampered revision', () => validateBatch(batch([{ ...ev(1), amount_minor: 9 }]), 'k_comtest', [KEY]), 'commission_identity_mismatch'],
    ['unknown reason', () => validateBatch(batch([ev(1, { reason_code: 'whatever' })]), 'k_comtest', [KEY]), 'commission_reason_invalid'],
    ['bad status', () => validateBatch(batch([ev(1, { status: 'paid' })]), 'k_comtest', [KEY]), 'commission_status_invalid'],
    ['invalid date', () => validateBatch(batch([ev(1, { release_at: '2026-02-30T00:00:00Z' })]), 'k_comtest', [KEY]), 'commission_timestamp_invalid'],
    ['local offset date', () => validateBatch(batch([ev(1, { created_at: '2026-10-01T12:00:00-03:00' })]), 'k_comtest', [KEY]), 'commission_timestamp_invalid'],
    ['extra field', () => validateBatch(batch([ev(1, { cpf: 'x' })]), 'k_comtest', [KEY]), 'commission_field_unexpected'],
    ['two revisions of one id', () => validateBatch(batch([ev(1), ev(1, { status: 'active' })]), 'k_comtest', [KEY]), 'commission_duplicate_revision'],
    ['count mismatch', () => validateBatch(batch([ev(1)], { count: 2 }), 'k_comtest', [KEY]), 'commission_count_mismatch'],
    ['events hash mismatch', () => validateBatch(batch([ev(1)], { events_sha256: '0'.repeat(64) }), 'k_comtest', [KEY]), 'commission_events_hash_mismatch'],
    ['scope mismatch', () => validateBatch(batch([ev(1, { store: 'store_2' })]), 'k_comtest', [KEY]), 'commission_scope_mismatch'],
    ['float amount', () => validateBatch(Buffer.from(batch([ev(1)]).toString().replace('"count":1', '"count":1.0')), 'k_comtest', [KEY]), 'commission_number_invalid'],
  ])('rejects: %s', (_name, fn, want) => { expect(code(fn)).toBe(want) })
  it('rejects unsorted events', () => {
    const a = ev(1), b = ev(2)
    const [lo, hi] = a.event_id < b.event_id ? [a, b] : [b, a]
    const body: Record<string, unknown> = { schema: 'pixsettle-commission-batch/1', origin: 'src_test1', store: 'store_1', mode: 'shadow', bank_settlement: false,
      key_id: 'k_comtest', created_at: '2026-10-09T06:00:00Z', events: [hi, lo], events_sha256: sha256([hi, lo].map(e => canonicalJson(e) + '\n').join('')), count: 2, previous_batch_sha256: null }
    const raw = Buffer.from(canonicalJson({ ...body, sig: createHmac('sha256', SECRET).update(canonicalJson(body)).digest('hex') }) + '\n')
    expect(code(() => validateBatch(raw, 'k_comtest', [KEY]))).toBe('commission_order_invalid')
  })
})
