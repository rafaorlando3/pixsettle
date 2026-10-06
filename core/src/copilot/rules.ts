// Regras determinísticas do copiloto: decidem o óbvio com confiança alta; o resto vai ao modelo.
// Cada regra cita as evidências que usou (ids e1, e2...), como o modelo também é obrigado a fazer.
import type { ExceptionKind, Evidence, Verdict } from './verdict.js'

/** Fatos estruturados da exceção (sem dado pessoal). Valores monetários em centavos (string decimal). */
export type ExceptionFacts = {
  kind: ExceptionKind
  store: string
  order?: { amount_minor: string; status: string; created_at: string | null; expires_at: string | null; paid_at: string | null }
  charges?: Array<{ chg: string; state: string; amount_minor: string; created_at: string | null; expires_at: string | null; paid_at: string | null; paid_minor: string | null; provider: string }>
  payment?: { chg: string; amount_minor: string; paid_at: string | null; expected_minor: string }
  refund?: { amount_minor: string | null; state: string; how?: string }
  med?: { amount_minor: string | null; reported_at: string | null; status: string; order_status: string | null; days_since_payment: number | null }
  manual?: { amount_minor: string; received_minor: string | null; status: string }
  withdrawal?: { amount_minor: string | null; fee_minor: string | null; state: string; source: string; provider: string; reversed_minor?: string | null }
  context?: Record<string, string | number | boolean | null>
}

export type RuleOutcome = { verdict: Verdict } | { needsModel: true; why: string }

const big = (s: string | null | undefined) => (s === null || s === undefined || s === '' ? null : BigInt(s))

export function applyRules(facts: ExceptionFacts, evidence: Evidence[]): RuleOutcome {
  const ids = evidence.map(e => e.id)
  const first = ids[0] ?? 'e1'
  switch (facts.kind) {
    case 'duplicate_charge': {
      const ch = facts.charges ?? []
      const paid = ch.filter(c => c.state === 'paid')
      const open = ch.filter(c => c.state === 'created')
      if (paid.length === 1 && open.length === 0) {
        return { verdict: { action: 'close_benign_retry', confidence: 0.97, requires_human: false, rationale: `${ch.length} charges were created for this order; exactly one was paid and every other one ended ${describeStates(ch)}. This is the checkout retrying, not a double payment.`, evidence_refs: ids } }
      }
      if (paid.length === 0 && open.length === 0) {
        return { verdict: { action: 'close_benign_retry', confidence: 0.9, requires_human: false, rationale: `${ch.length} charges were created and none was paid (${describeStates(ch)}); nothing to reconcile beyond the unpaid order.`, evidence_refs: ids } }
      }
      if (paid.length >= 2) return { needsModel: true, why: 'more than one charge paid for the same order' }
      return { needsModel: true, why: 'a charge is still open while others exist' }
    }
    case 'expired_unpaid': {
      const o = facts.order
      if (o && !o.paid_at && !['paid', 'settling', 'settled', 'refunded', 'late_paid'].includes(o.status)) {
        return { verdict: { action: 'close_expired', confidence: 0.95, requires_human: false, rationale: 'The charge expired and no payment was ever received for the order; the order can be closed as unpaid.', evidence_refs: ids } }
      }
      return { needsModel: true, why: 'order shows a payment despite the expired charge' }
    }
    case 'charge_failed': {
      const o = facts.order
      const later = (facts.charges ?? []).some(c => c.state === 'paid')
      if (later) return { verdict: { action: 'close_superseded', confidence: 0.96, requires_human: false, rationale: 'A charge failed at the provider but a later charge for the same order was paid; the failure was superseded.', evidence_refs: ids } }
      if (o && !o.paid_at) return { verdict: { action: 'close_expired', confidence: 0.9, requires_human: false, rationale: 'The charge failed at the provider and the order was never paid; nothing to recover, close as unpaid.', evidence_refs: ids } }
      return { needsModel: true, why: 'failed charge with an unclear order state' }
    }
    case 'withdrawal_reversal':
      return { verdict: { action: 'close_reversed', confidence: 0.9, requires_human: false, rationale: 'The withdrawal was reversed and the amount returned to the wallet balance; no money is missing, keep the record for audit.', evidence_refs: ids } }
    case 'amount_mismatch': {
      const p = facts.payment
      if (p) {
        const paid = big(p.amount_minor), exp = big(p.expected_minor)
        if (paid !== null && exp !== null && paid < exp && exp - paid <= 100n) {
          // Diferença de até R$ 1,00 a menos: reter e pedir o saldo é a ação segura e reversível; o resto é do humano.
          return { verdict: { action: 'hold_request_balance', confidence: 0.9, requires_human: false, rationale: `Paid ${fmt(paid)} against ${fmt(exp)}: a ${fmt(exp - paid)} shortfall. Hold the order and ask the payer for the balance; refunding or accepting is a human call.`, evidence_refs: ids } }
        }
      }
      return { needsModel: true, why: 'amount difference needs judgement (size, direction, timing)' }
    }
    case 'duplicate_payment':
    case 'late_payment':
    case 'refund_requested':
    case 'med_reported':
    case 'manual_divergent':
    case 'withdrawal_failed':
      return { needsModel: true, why: `${facts.kind} always needs judgement; the rules only hold and gather evidence` }
    default:
      return { needsModel: true, why: `no rule for ${String((facts as any).kind)}` }
  }
  // inacessível, mantido para o compilador
  // eslint-disable-next-line no-unreachable
  return { needsModel: true, why: first }
}

function describeStates(ch: ExceptionFacts['charges']) {
  const c: Record<string, number> = {}
  for (const x of ch ?? []) c[x.state] = (c[x.state] ?? 0) + 1
  return Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ')
}
const fmt = (minor: bigint) => `R$ ${(Number(minor) / 100).toFixed(2)}`
