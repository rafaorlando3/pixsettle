import { SCHEMA, type ShadowEvent, type TrustedShadowContext, type TrioInput, type ValidatedTrio } from '../src/pilot-shadow/types.js'
import { attestSig, sha256, validateTrio } from '../src/pilot-shadow/guard.js'
export const TEST_SECRET = 'a'.repeat(40)
export function trusted(origin = 'src_1', store = 'store_1'): TrustedShadowContext {
  return { origin, store, keyring: { k_test1: { env: 'SHADOW_TEST_SECRET', origin, stores: [store], valid_from: '2026-10-01T00:00:00Z', valid_until: '2027-01-01T00:00:00Z', revoked: false } }, secrets: { SHADOW_TEST_SECRET: TEST_SECRET } }
}
export function event(n: number, at = '2026-10-06T13:00:00Z', scope = trusted()): ShadowEvent {
  const id = 'evt_' + n.toString(16).padStart(16, '0')
  return { schema: SCHEMA, origin: scope.origin, store: scope.store, event_id: id, cursor: at.replace(/[-:]/g, '') + '/' + id,
    type: 'order_created', at, amount_minor: 1500, currency: 'BRL', order_ref: 'ord_' + n.toString(16).padStart(16, '0') }
}
export function trio(events: ShadowEvent[] = [event(1)], ctx = trusted(), attChanges: Record<string, any> = {}): TrioInput {
  const lote = Buffer.from(events.map(e => JSON.stringify(e) + '\n').join(''))
  const totals: Record<string, number> = {}; for (const e of events) totals[e.type] = (totals[e.type] ?? 0) + e.amount_minor
  const att: any = { schema: SCHEMA, origin: ctx.origin, store: ctx.store, key_id: 'k_test1', signed_at: '2026-10-07T03:00:00Z',
    sha256: sha256(lote), bytes: lote.length, count: events.length, overlap_count: 0, totals_minor: totals,
    first_cursor: events[0]!.cursor, last_cursor: events.at(-1)!.cursor, from: '2026-10-06T03:00:00Z', to: '2026-10-07T03:00:00Z', scan_from: '2026-10-06T03:00:00Z', ...attChanges }
  att.sig = attestSig(att, Buffer.from(ctx.secrets.SHADOW_TEST_SECRET!))
  const atestado = Buffer.from(JSON.stringify(att))
  const names = { loteName: 'LOTE-test.jsonl', atestadoName: 'ATESTADO-test.json', prontoName: 'PRONTO-test.json' }
  const pronto = Buffer.from(JSON.stringify({ schema: SCHEMA, lote: names.loteName, lote_sha256: sha256(lote), atestado: names.atestadoName, atestado_sha256: sha256(atestado) }))
  return { lote, atestado, pronto, ...names }
}
export function checked(input: TrioInput = trio(), ctx = trusted()): ValidatedTrio { const r = validateTrio(input, ctx); if (!r.ok) throw new Error(r.errors.join(',')); return r.validated }
