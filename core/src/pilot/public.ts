// Public responses use a closed projection, including rows written before privacy fixes.
import { ACTIONS, ACTION_LABEL } from '../copilot/verdict.js'
export const PUBLIC_RATIONALE = 'Decision recorded; inspect action and evidence references.'
const actions = new Set([...Object.values(ACTIONS).flat(), 'dismiss'])
const states = new Set(['open', 'auto_applied', 'awaiting_human', 'resolved', 'dismissed', 'created', 'awaiting_payment', 'paid', 'settling', 'settled', 'expired', 'late_paid', 'refunded'])
const copilotStates = new Set(['pending_rules', 'rules_only', 'model_off', 'pending_model', 'model_done', 'model_error'])
const string = (v: unknown, rx: RegExp) => typeof v === 'string' && rx.test(v) ? v : null
const enumValue = (v: unknown, values: Set<string>) => typeof v === 'string' && values.has(v) ? v : null
const timestamp = (v: unknown) => {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v)) return null
  return Number.isFinite(Date.parse(v)) ? v : null
}
const id = (v: unknown) => string(v, /^[a-z]{3}_[0-9A-Z]{26}$/)
const hash = (v: unknown) => string(v, /^[a-f0-9]{64}$/)
const refs = (v: unknown) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && /^e\d{1,4}$/.test(x)) : []
export function publicVerdict(v: Record<string, any>): Record<string, any> {
  const action = enumValue(v.action, actions)
  return {
    id: id(v.id), engine: enumValue(v.engine, new Set(['rules', 'model', 'operator', 'replay'])),
    model: string(v.model, /^[A-Za-z0-9._:/-]{1,120}$/), action,
    action_label: action ? ACTION_LABEL[action] ?? 'Review required' : 'Review required',
    confidence: typeof v.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1 ? v.confidence : null,
    requires_human: typeof v.requires_human === 'boolean' ? v.requires_human : true,
    rationale: PUBLIC_RATIONALE, evidence_refs: refs(v.evidence_refs),
    input_hash: hash(v.input_hash), verdict_hash: hash(v.verdict_hash),
    latency_ms: typeof v.latency_ms === 'number' && Number.isFinite(v.latency_ms) && v.latency_ms >= 0 ? v.latency_ms : null,
    created_at: timestamp(v.created_at),
  }
}
export function publicException(e: Record<string, any>): Record<string, any> {
  const resolution = e.resolution && typeof e.resolution === 'object' ? e.resolution : null
  return {
    id: id(e.id), kind: enumValue(e.kind, new Set(Object.keys(ACTIONS))),
    severity: enumValue(e.severity, new Set(['info', 'low', 'medium', 'high'])),
    status: enumValue(e.status, states), copilot_state: enumValue(e.copilot_state, copilotStates),
    summary: 'Exception recorded; inspect kind, amounts and decision.',
    detected_at: timestamp(e.detected_at), updated_at: timestamp(e.updated_at), resolved_at: timestamp(e.resolved_at),
    order_id: id(e.order_id), order_status: enumValue(e.order_status, states),
    order_amount_minor: string(e.order_amount_minor, /^\d{1,15}$/), paid_at: timestamp(e.paid_at),
    ord: string(e.ord, /^[a-z]_[a-z]{8,40}$/), store: string(e.store, /^[a-z0-9-]{1,40}$/),
    hold_reason: e.hold_reason ? 'hold_recorded' : null,
    resolution: resolution ? { action: enumValue(resolution.action, actions),
      by: enumValue(resolution.by, new Set(['auto', 'operator'])), at: timestamp(resolution.at),
      agreed_with_copilot: typeof resolution.agreed_with_copilot === 'boolean' ? resolution.agreed_with_copilot : null,
      note: 'Decision recorded.' } : null,
    last_error: e.last_error ? { reason: 'model_unavailable_or_review_required' } : null,
    evidence: Array.isArray(e.evidence) ? e.evidence.filter((v: any) => v && typeof v.id === 'string' && /^e\d{1,4}$/.test(v.id))
      .map((v: any) => ({ id: v.id, fact: 'Evidence recorded.' })) : [],
    verdict: e.verdict ? publicVerdict(e.verdict) : null,
  }
}
export function publicTimeline(t: Record<string, any>): Record<string, any> {
  return { from_state: enumValue(t.from_state, states), to_state: enumValue(t.to_state, states),
    reason: 'State transition recorded.', source: 'recorded', created_at: timestamp(t.created_at) }
}
