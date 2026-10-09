import { createHmac } from 'node:crypto'
import { canonicalJson, sha256 } from '../src/pilot-shadow/guard.js'
import { eventIdentity, type CommissionKey } from '../src/affiliates/batches/batch.js'

// Synthetic fixture only. No production data. Test key, never a real secret.
export const SECRET = Buffer.from('test-commission-key-0123456789abcdef0123456789')
export const KEY: CommissionKey = { key_id: 'k_comtest', scope: 'commission', origin: 'src_test1', stores: ['store_1'], secret: SECRET }

export function ev(n: number, over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    schema: 'pixsettle-commission-event/1', origin: 'src_test1', store: 'store_1', type: 'commission.observed',
    id: 'com_' + n.toString(16).padStart(32, '0'), order_id: 'ord_' + n.toString(16).padStart(16, 'a'),
    affiliate_id: 'aff_' + (n % 2).toString(16).padStart(32, 'b'), amount_minor: 1234 * n, currency: 'BRL', status: 'pending',
    created_at: '2026-10-01T12:00:00Z', source_updated_at: '2026-10-01T12:00:00Z', release_at: null, released_at: null,
    voided_at: null, reason_code: null, ...over,
  }
  return { ...base, ...eventIdentity(base) }
}
export function batch(events: Record<string, any>[], over: Record<string, unknown> = {}, secret = SECRET) {
  const sorted = [...events].sort((a, b) => (a.event_id < b.event_id ? -1 : 1))
  const body: Record<string, unknown> = {
    schema: 'pixsettle-commission-batch/1', origin: 'src_test1', store: 'store_1', mode: 'shadow', bank_settlement: false,
    key_id: 'k_comtest', created_at: '2026-10-09T06:00:00Z', events: sorted,
    events_sha256: sha256(sorted.map(e => canonicalJson(e) + '\n').join('')), count: sorted.length, previous_batch_sha256: null, ...over,
  }
  const sig = createHmac('sha256', secret).update(canonicalJson(body)).digest('hex')
  return Buffer.from(canonicalJson({ ...body, sig }) + '\n')
}
