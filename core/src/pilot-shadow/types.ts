/** E1 1.3 shadow contract. HMAC authenticates an authorized issuer, not bank settlement. */
export const SCHEMA = 'pixsettle-shadow-feed/1.3' as const
export const EVENT_TYPES = ['order_created', 'pix_received', 'refund', 'med', 'partner_withdrawal', 'wallet_charge', 'order_cancelled'] as const
export type ShadowEventType = typeof EVENT_TYPES[number]
export interface ShadowEvent {
  schema: typeof SCHEMA; origin: string; store: string; cursor: string; event_id: string
  type: ShadowEventType; at: string; amount_minor: number; currency: 'BRL'
  order_ref?: string; payment_ref?: string; refers_to?: string; expires_at?: string
  party_ref?: string; payer_self_identified?: boolean
}
export interface ShadowAttestation {
  schema: typeof SCHEMA; origin: string; store: string; key_id: string; signed_at: string
  sha256: string; bytes: number; count: number; overlap_count: number
  totals_minor: Partial<Record<ShadowEventType, number>>; first_cursor: string; last_cursor: string
  from: string; to: string; scan_from: string; sig: string
}
export interface ShadowKeyMetadata {
  env: string; origin: string; stores: string[]; valid_from: string; valid_until: string; revoked: boolean
}
export interface TrustedShadowContext {
  origin: string; store: string
  keyring: Readonly<Record<string, ShadowKeyMetadata>>
  secrets: Readonly<Record<string, string | undefined>>
}
export interface TrioInput {
  lote: Buffer; atestado: Buffer; pronto: Buffer
  loteName: string; atestadoName: string; prontoName: string
}
export interface TrioBinding {
  lote_name: string; atestado_name: string; pronto_name: string
  lote_sha256: string; atestado_sha256: string; pronto_sha256: string; trio_sha256: string
}
/** Only guard.validateTrio creates a runtime-valid instance; structural casts are refused by ingestion. */
export interface ValidatedTrio {
  readonly events: readonly Readonly<ShadowEvent>[]
  readonly attestation: Readonly<ShadowAttestation>
  readonly binding: Readonly<TrioBinding>
}
export type TrioValidationResult =
  | { ok: false; exitCode: 1 | 2; errors: string[]; signed: boolean }
  | { ok: true; exitCode: 0; errors: []; signed: true; validated: ValidatedTrio }
export interface ShadowBatchReceipt extends TrioBinding {
  schema: 'pixsettle-shadow-receipt/1'; mode: 'shadow'; bank_settlement: false
  origin: string; store: string; key_id: string; count: number
  result: 'accepted' | 'rejected'; codes: string[]
  accepted: number; duplicates: number; rejected: number
  first_cursor: string; last_cursor: string; checkpoint: string | null; committed_at: string; sig: string
}
export interface ShadowIngestResult {
  busy: boolean; replayed: boolean; accepted: number; duplicates: number
  checkpoint: string | null; receipt: ShadowBatchReceipt | null
}
