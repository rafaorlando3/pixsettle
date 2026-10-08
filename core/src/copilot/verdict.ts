// Vocabulário e validação do veredito do copiloto de exceções.
//
// Princípios (regra do time, 06/10/2026): a IA decide com evidência, é medida contra a mesma tarefa sem IA,
// tem guarda (limiar, confirmação humana para o irreversível, fallback com motivo) e aparece na demo.
// Nada aqui aceita texto livre como ação: a ação vem de uma lista fechada por tipo de exceção.
import { createHash } from 'node:crypto'
import canonicalizeLib from 'canonicalize'
const canonicalize = canonicalizeLib as unknown as (v: unknown) => string | undefined

export type ExceptionKind =
  | 'duplicate_charge' | 'duplicate_payment' | 'amount_mismatch' | 'late_payment' | 'expired_unpaid'
  | 'charge_failed' | 'refund_requested' | 'med_reported' | 'manual_divergent' | 'withdrawal_failed' | 'withdrawal_reversal'

/** Ações por tipo. As REVERSÍVEIS podem ser aplicadas sem humano (só mudam estado interno e retenção);
 *  as demais movem dinheiro ou liberam liquidação e exigem confirmação humana sempre. */
export const ACTIONS: Record<ExceptionKind, readonly string[]> = {
  duplicate_charge: ['close_benign_retry', 'flag_review', 'escalate'],
  duplicate_payment: ['refund_duplicate', 'credit_customer', 'escalate'],
  amount_mismatch: ['hold_request_balance', 'refund_partial', 'refund_excess', 'accept_as_paid', 'escalate'],
  late_payment: ['refund_late', 'accept_late', 'escalate'],
  expired_unpaid: ['close_expired', 'flag_review'],
  charge_failed: ['close_superseded', 'close_expired', 'flag_review'],
  refund_requested: ['approve_refund', 'reject_refund', 'escalate'],
  med_reported: ['contest_with_evidence', 'accept_refund', 'escalate'],
  manual_divergent: ['hold_request_balance', 'refund_partial', 'accept_as_paid', 'escalate'],
  withdrawal_failed: ['close_reversed', 'retry_withdrawal', 'flag_review', 'escalate'],
  withdrawal_reversal: ['close_reversed', 'flag_review', 'escalate'],
}
export const REVERSIBLE = new Set(['close_benign_retry', 'flag_review', 'hold_request_balance', 'close_expired', 'close_superseded', 'close_reversed'])
/** Limiar de confiança para aplicar sozinho uma ação reversível. */
export const AUTO_APPLY_MIN_CONFIDENCE = 0.85

export type Evidence = { id: string; fact: string; ref?: Record<string, string | number | null> }
export type Verdict = {
  action: string
  confidence: number
  requires_human: boolean
  rationale: string
  evidence_refs: string[]
}
export type ValidationResult = { ok: true; verdict: Verdict } | { ok: false; reason: string }

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const hashOf = (obj: unknown) => sha256(canonicalize(obj) ?? '')

/** Validação estrita: ação fechada por tipo, confiança numérica, referências só às evidências dadas. */
export function validateVerdict(kind: ExceptionKind, raw: unknown, evidence: Evidence[]): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'verdict_not_object' }
  const v = raw as Record<string, unknown>
  const fields = new Set(['action', 'confidence', 'requires_human', 'rationale', 'evidence_refs'])
  if (Object.keys(v).some(k => !fields.has(k))) return { ok: false, reason: 'verdict_extra_fields' }
  const allowed = ACTIONS[kind]
  if (typeof v.action !== 'string' || !allowed.includes(v.action)) return { ok: false, reason: 'action_not_allowed' }
  const conf = typeof v.confidence === 'number' ? v.confidence : NaN
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) return { ok: false, reason: 'confidence_out_of_range' }
  if (typeof v.requires_human !== 'boolean') return { ok: false, reason: 'requires_human_not_boolean' }
  if (typeof v.rationale !== 'string' || v.rationale.trim().length < 8) return { ok: false, reason: 'rationale_missing' }
  if (v.rationale.length > 800) return { ok: false, reason: 'rationale_too_long' }
  const refs = Array.isArray(v.evidence_refs) ? v.evidence_refs : null
  if (!refs || refs.some(r => typeof r !== 'string')) return { ok: false, reason: 'evidence_refs_missing' }
  const known = new Set(evidence.map(e => e.id))
  const bad = (refs as string[]).filter(r => !known.has(r))
  if (bad.length) return { ok: false, reason: 'evidence_ref_unknown' }
  if (refs.length === 0) return { ok: false, reason: 'evidence_refs_empty' }
  // Guarda: ação irreversível nunca dispensa humano, diga o modelo o que disser.
  const requiresHuman = !REVERSIBLE.has(v.action) || v.requires_human === true
  return { ok: true, verdict: { action: v.action, confidence: conf, requires_human: requiresHuman, rationale: v.rationale.trim(), evidence_refs: Array.from(new Set(refs as string[])) } }
}

/** Política de aplicação: só reversível, com confiança mínima, e sem conflito entre regras e modelo. */
export function canAutoApply(v: Verdict, other?: Verdict | null): { ok: boolean; reason: string } {
  if (v.requires_human) return { ok: false, reason: 'requires_human' }
  if (!REVERSIBLE.has(v.action)) return { ok: false, reason: 'irreversible_action' }
  if (v.confidence < AUTO_APPLY_MIN_CONFIDENCE) return { ok: false, reason: `confidence_below_${AUTO_APPLY_MIN_CONFIDENCE}` }
  if (other && other.action !== v.action) return { ok: false, reason: `disagreement:${other.action}` }
  return { ok: true, reason: 'policy_ok' }
}

/** Texto curto, humano, da ação (tela e recibo de decisão). */
export const ACTION_LABEL: Record<string, string> = {
  close_benign_retry: 'Close: retries, only one paid', flag_review: 'Flag for review', escalate: 'Escalate to operator',
  refund_duplicate: 'Refund the duplicate payment', credit_customer: 'Credit the customer wallet',
  hold_request_balance: 'Hold and ask for the balance', refund_partial: 'Refund the partial payment', refund_excess: 'Refund the excess',
  accept_as_paid: 'Accept as paid', refund_late: 'Refund (paid after expiry)', accept_late: 'Accept late payment',
  close_expired: 'Close: expired unpaid', close_superseded: 'Close: superseded by a paid charge',
  approve_refund: 'Approve the refund', reject_refund: 'Reject the refund', contest_with_evidence: 'Contest the MED with evidence',
  accept_refund: 'Accept the MED refund', close_reversed: 'Close: reversed back to balance', retry_withdrawal: 'Retry the withdrawal',
}
