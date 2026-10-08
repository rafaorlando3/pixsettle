// Orquestração do copiloto: abrir/mesclar exceção -> regras -> (modelo no resíduo) -> política -> aplicar.
// Veredito é imutável e com hash; a aplicação fica no estado da exceção e no histórico (state_transitions).
import { withTx, recordTransition, enqueue, type Tx } from '../db.js'
import { newId } from '../ids.js'
import type { Ctx } from '../context.js'
import { ACTIONS, REVERSIBLE, canAutoApply, hashOf, validateVerdict, type Evidence, type ExceptionKind, type Verdict } from './verdict.js'
import { applyRules, type ExceptionFacts } from './rules.js'
import { ModelError, RecordingModel, type ModelInput } from './model.js'

export const SEVERITY: Record<ExceptionKind, 'info' | 'low' | 'medium' | 'high'> = {
  duplicate_charge: 'low', duplicate_payment: 'high', amount_mismatch: 'high', late_payment: 'medium', expired_unpaid: 'info',
  charge_failed: 'info', refund_requested: 'medium', med_reported: 'high', manual_divergent: 'high', withdrawal_failed: 'medium', withdrawal_reversal: 'low',
}
export const MODEL_MAX_TRIES = 1

export type OpenExceptionInput = {
  merchantId: string; orderId: string | null; kind: ExceptionKind; fingerprint: string; summary: string
  facts: ExceptionFacts; evidence: Evidence[]; detectedAt: Date; source: string
}

/**
 * Abre a exceção (ou mescla evidência nova numa aberta com a mesma impressão digital), roda as regras e aplica a política.
 * Tudo na transação do chamador: a exceção nasce junto com o fato que a causou.
 */
export async function openException(tx: Tx, ctx: Ctx, input: OpenExceptionInput): Promise<{ id: string; created: boolean }> {
  const existing = (await tx.query(`SELECT id, status, copilot_state FROM exceptions WHERE fingerprint=$1 FOR UPDATE`, [input.fingerprint])).rows[0]
  if (existing) {
    if (['resolved', 'dismissed'].includes(existing.status)) return { id: existing.id, created: false }
    // Evidência nova numa exceção ainda aberta: atualiza fatos e evidência; o veredito anterior fica no histórico.
    await tx.query(`UPDATE exceptions SET facts=$2, evidence=$3, summary=$4, updated_at=now() WHERE id=$1`,
      [existing.id, JSON.stringify(input.facts), JSON.stringify(input.evidence), input.summary])
    await recordTransition(tx, 'exception', existing.id, existing.status, existing.status, input.source, 'evidência atualizada')
    // Sem decisão humana e sem veredito do modelo em curso ou feito: reabre e deixa as regras julgarem os fatos novos.
    // (Com veredito do modelo já dado, os fatos ficam atualizados e o humano decide com eles; não se gasta modelo de novo.)
    if (['rules_only', 'model_off', 'model_error', 'pending_rules'].includes(existing.copilot_state) && existing.status !== 'open') {
      await tx.query(`UPDATE exceptions SET status='open', copilot_state='pending_rules', resolution=NULL, resolved_at=NULL, last_error=NULL WHERE id=$1`, [existing.id])
      await recordTransition(tx, 'exception', existing.id, existing.status, 'open', input.source, 'reaberta por evidência nova')
      await judgeByRules(tx, ctx, existing.id, input.source)
    }
    return { id: existing.id, created: false }
  }
  const id = newId('exc')
  await tx.query(
    `INSERT INTO exceptions (id, merchant_id, order_id, kind, severity, status, copilot_state, fingerprint, summary, evidence, facts, detected_at)
     VALUES ($1,$2,$3,$4,$5,'open','pending_rules',$6,$7,$8,$9,$10)`,
    [id, input.merchantId, input.orderId, input.kind, SEVERITY[input.kind], input.fingerprint, input.summary, JSON.stringify(input.evidence), JSON.stringify(input.facts), input.detectedAt])
  await recordTransition(tx, 'exception', id, null, 'open', input.source, input.summary)
  await judgeByRules(tx, ctx, id, input.source)
  return { id, created: true }
}

async function judgeByRules(tx: Tx, ctx: Ctx, exceptionId: string, source: string) {
  const e = (await tx.query(`SELECT * FROM exceptions WHERE id=$1 FOR UPDATE`, [exceptionId])).rows[0]
  const facts = e.facts as ExceptionFacts, evidence = e.evidence as Evidence[]
  const out = applyRules(facts, evidence)
  if ('verdict' in out) {
    const v = validateVerdict(e.kind, out.verdict, evidence)
    if (!v.ok) throw new Error(`regra produziu veredito inválido (${v.reason}) para ${e.kind}`)
    await recordVerdict(tx, exceptionId, 'rules', null, v.verdict, hashOf(facts), null, null)
    await tx.query(`UPDATE exceptions SET copilot_state='rules_only', updated_at=now() WHERE id=$1`, [exceptionId])
    await applyPolicy(tx, ctx, exceptionId, v.verdict, null, source)
    return
  }
  // Resíduo: o modelo decide, fora desta transação (rede). Sem modelo configurado: fica explícito na tela.
  if (!ctx.copilot?.model) {
    await tx.query(`UPDATE exceptions SET status='awaiting_human', copilot_state='model_off', last_error=$2, updated_at=now() WHERE id=$1`,
      [exceptionId, JSON.stringify({ reason: ctx.copilot?.offReason ?? 'modelo não configurado', why: out.why })])
    await recordTransition(tx, 'exception', exceptionId, 'open', 'awaiting_human', source, `sem modelo: ${ctx.copilot?.offReason ?? 'não configurado'}`)
    return
  }
  await tx.query(`UPDATE exceptions SET copilot_state='pending_model', last_error=$2, updated_at=now() WHERE id=$1`, [exceptionId, JSON.stringify({ why: out.why })])
  await enqueue(tx, 'copilot_judge', exceptionId, { try: 0 })
}

async function recordVerdict(tx: Tx, exceptionId: string, engine: 'rules' | 'model' | 'replay' | 'operator', model: string | null, v: Verdict, inputHash: string, latencyMs: number | null, usage: Record<string, number> | null) {
  const id = newId('vrd')
  const persistedVerdict = engine === 'model' || engine === 'operator'
    ? { ...v, rationale: 'Decision recorded; inspect action and evidence references.' } : v
  await tx.query(
    `INSERT INTO copilot_verdicts (id, exception_id, engine, model, action, confidence, requires_human, rationale, evidence_refs, input_hash, verdict_hash, latency_ms, usage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, exceptionId, engine, model, v.action, v.confidence, v.requires_human, persistedVerdict.rationale, JSON.stringify(v.evidence_refs), inputHash, hashOf(persistedVerdict), latencyMs, usage ? JSON.stringify(usage) : null])
  return id
}

/** Política: reversível com confiança -> aplica sozinho; senão espera humano, com o motivo gravado. */
async function applyPolicy(tx: Tx, ctx: Ctx, exceptionId: string, v: Verdict, other: Verdict | null, source: string) {
  const e = (await tx.query(`SELECT status, order_id, kind FROM exceptions WHERE id=$1 FOR UPDATE`, [exceptionId])).rows[0]
  if (['resolved', 'dismissed'].includes(e.status)) return
  const p = canAutoApply(v, other)
  if (p.ok) {
    const closes = v.action.startsWith('close_')
    const resolution = { action: v.action, by: 'auto', note: p.reason, at: ctx.now().toISOString() }
    await tx.query(`UPDATE exceptions SET status=$2, resolution=$3, resolved_at=$4, updated_at=now() WHERE id=$1`,
      [exceptionId, closes ? 'resolved' : 'auto_applied', JSON.stringify(resolution), closes ? ctx.now() : null])
    await recordTransition(tx, 'exception', exceptionId, e.status, closes ? 'resolved' : 'auto_applied', source, `${v.action} (${p.reason}, confiança ${v.confidence})`)
    return
  }
  await tx.query(`UPDATE exceptions SET status='awaiting_human', updated_at=now() WHERE id=$1`, [exceptionId])
  await recordTransition(tx, 'exception', exceptionId, e.status, 'awaiting_human', source, `${v.action} proposto; ${p.reason}`)
}

// ---------- modelo (job da outbox) ----------

const SYSTEM = `You are the exception copilot of PixSettle, a Pix reconciliation system for merchants on the Brazil-Paraguay border.
You receive the structured facts of ONE exception (amounts in cents of BRL, timestamps in UTC) and a numbered list of evidence lines.
Decide the next action from the allowed list only. Rules you must follow:
1. Money never moves on your word alone: any refund, credit, release or acceptance is a proposal that a human confirms. Reversible actions (holds, flags, closing a benign case) may be applied automatically when you are confident.
2. Cite only the evidence ids you were given, and only those you actually used.
3. If the facts do not support a decision, choose "escalate" (or "flag_review" where allowed) and say what is missing. Never invent facts.
4. Confidence is your honest probability that the action is right, between 0 and 1.
Answer with exactly one JSON object and nothing else:
{"action": "<one of the allowed actions>", "confidence": 0.0, "requires_human": true, "rationale": "<2 to 5 sentences, plain English>", "evidence_refs": ["e1"]}`

export function buildModelInput(kind: ExceptionKind, facts: ExceptionFacts, evidence: Evidence[]): ModelInput {
  const user = [
    `Exception kind: ${kind}`,
    `Allowed actions: ${ACTIONS[kind].join(', ')}`,
    `Reversible (may be auto-applied): ${ACTIONS[kind].filter(a => REVERSIBLE.has(a)).join(', ') || 'none'}`,
    '', 'Facts (JSON):', JSON.stringify(facts, null, 1),
    '', 'Evidence:', ...evidence.map(e => `${e.id}: ${e.fact}`),
  ].join('\n')
  return { system: SYSTEM, user }
}

/** Extrai o único objeto JSON da resposta (aceita uma cerca de código em volta). */
export function parseModelJson(text: string): unknown {
  let t = text.trim()
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(t)
  if (m) t = m[1]!.trim()
  try { return JSON.parse(t) } catch { /* tenta o primeiro objeto */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) } catch { /* abaixo */ } }
  throw new ModelError('invalid_response', 'resposta do modelo não é um objeto JSON')
}

/** Job copilot_judge: chama o modelo, valida, grava o veredito e aplica a política. Erro = retry com motivo visível. */
export async function judgeWithModel(ctx: Ctx, exceptionId: string, tryNo: number): Promise<'done' | 'retry'> {
  // Public replay projects stored decisions. It never runs a mutating model job.
  if (ctx.cfg?.publicReplayReadOnly || ctx.copilot?.model?.mode === 'replay') return 'done'
  const e = (await ctx.db.query(`SELECT * FROM exceptions WHERE id=$1`, [exceptionId])).rows[0]
  if (!e || e.copilot_state !== 'pending_model' || !['open'].includes(e.status)) return 'done'
  const model = ctx.copilot?.model
  const fail = async (reason: string, final: boolean) => {
    await withTx(ctx.db, async tx => {
      const cur = (await tx.query(`SELECT copilot_state FROM exceptions WHERE id=$1 FOR UPDATE`, [exceptionId])).rows[0]
      if (cur.copilot_state !== 'pending_model') return
      await tx.query(`UPDATE exceptions SET copilot_state=$2, status=$3, last_error=$4, updated_at=now() WHERE id=$1`,
        [exceptionId, final ? 'model_error' : 'pending_model', final ? 'awaiting_human' : 'open', JSON.stringify({ reason, try: tryNo + 1, at: ctx.now().toISOString() })])
      if (final) await recordTransition(tx, 'exception', exceptionId, 'open', 'awaiting_human', 'copilot_model', `modelo falhou ${tryNo + 1}x: ${reason}`)
    })
  }
  if (!model) { await fail(ctx.copilot?.offReason ?? 'modelo não configurado', true); return 'done' }
  // Orçamento diário (só modo vivo): chamadas = vereditos do modelo + falhas finais nas últimas 24 h. Esgotado = humano, com motivo.
  const budget = ctx.copilot?.budgetCallsPerDay
  if (budget !== undefined && model.mode === 'live') {
    const used = await modelCallsLast24h(ctx)
    if (used >= budget) { await fail(`orçamento diário do modelo esgotado (${used}/${budget} chamadas em 24 h)`, true); return 'done' }
  }
  const facts = e.facts as ExceptionFacts, evidence = e.evidence as Evidence[]
  const input = buildModelInput(e.kind, facts, evidence)
  let out
  try { out = await model.complete(input) } catch (err) {
    const code = err instanceof ModelError && ['config', 'http', 'timeout', 'invalid_response', 'replay_miss'].includes(err.code) ? err.code : 'internal_error'
    const status = err instanceof ModelError && Number.isInteger(err.status) && err.status! >= 100 && err.status! <= 599 ? `:${err.status}` : ''
    const msg = `model_${code}${status}`
    await fail(msg, true)
    return 'done'
  }
  let parsed: unknown
  try { parsed = parseModelJson(out.text) } catch { await fail('model_invalid_json', true); return 'done' }
  const v = validateVerdict(e.kind, parsed, evidence)
  if (!v.ok) { await fail(`veredito recusado: ${v.reason}`, true); return 'done' }
  await withTx(ctx.db, async tx => {
    const cur = (await tx.query(`SELECT copilot_state, status, kind, facts, evidence FROM exceptions WHERE id=$1 FOR UPDATE`, [exceptionId])).rows[0]
    if (!cur || cur.copilot_state !== 'pending_model' || cur.status !== 'open') return
    if (hashOf(buildModelInput(cur.kind, cur.facts, cur.evidence)) !== hashOf(input)) {
      await tx.query(`UPDATE exceptions SET copilot_state='model_error', status='awaiting_human', last_error=$2, updated_at=now() WHERE id=$1`,
        [exceptionId, JSON.stringify({ reason: 'context_changed', at: ctx.now().toISOString() })])
      await recordTransition(tx, 'exception', exceptionId, 'open', 'awaiting_human', 'copilot_model', 'context_changed')
      return
    }
    if (model instanceof RecordingModel) await model.recordValidated(input, v.verdict, out, tx)
    await recordVerdict(tx, exceptionId, 'model', model.name, v.verdict, hashOf(input), out.latencyMs, out.usage ?? null)
    await tx.query(`UPDATE exceptions SET copilot_state='model_done', last_error=NULL, updated_at=now() WHERE id=$1`, [exceptionId])
    const rules = (await tx.query(`SELECT action, confidence, requires_human, rationale, evidence_refs FROM copilot_verdicts WHERE exception_id=$1 AND engine='rules' ORDER BY created_at DESC LIMIT 1`, [exceptionId])).rows[0]
    await applyPolicy(tx, ctx, exceptionId, v.verdict, rules ? { ...rules, confidence: Number(rules.confidence) } : null, 'copilot_model')
  })
  return 'done'
}

export async function modelCallsLast24h(ctx: Ctx): Promise<number> {
  const r = (await ctx.db.query(
    `SELECT (SELECT count(*) FROM copilot_verdicts WHERE engine='model' AND created_at > $1::timestamptz - interval '24 hours')
          + (SELECT count(*) FROM exceptions WHERE copilot_state='model_error' AND updated_at > $1::timestamptz - interval '24 hours') AS n`, [ctx.now().toISOString()])).rows[0]
  return Number(r.n)
}

/** Decisão do operador: gravada como veredito 'operator', encerra a exceção. Não move dinheiro aqui (piloto sombra). */
export async function decideByOperator(ctx: Ctx, exceptionId: string, action: string, note: string): Promise<{ ok: true; agreed: boolean | null } | { ok: false; code: string; message: string }> {
  if (ctx.cfg?.publicReplayReadOnly || ctx.copilot?.model?.mode === 'replay') return { ok: false, code: 'replay_readonly', message: 'replay permits read access only' }
  return withTx(ctx.db, async tx => {
    const e = (await tx.query(`SELECT * FROM exceptions WHERE id=$1 FOR UPDATE`, [exceptionId])).rows[0]
    if (!e) return { ok: false as const, code: 'not_found', message: 'exceção não encontrada' }
    if (['resolved', 'dismissed'].includes(e.status)) return { ok: false as const, code: 'already_closed', message: `exceção já ${e.status}` }
    if (!ACTIONS[e.kind as ExceptionKind].includes(action) && action !== 'dismiss') return { ok: false as const, code: 'action_not_allowed', message: `ação ${action} não vale para ${e.kind}` }
    const last = (await tx.query(`SELECT action FROM copilot_verdicts WHERE exception_id=$1 AND engine IN ('model','replay','rules') ORDER BY created_at DESC LIMIT 1`, [exceptionId])).rows[0]
    const agreed = last ? last.action === action : null
    const v: Verdict = { action, confidence: 1, requires_human: false, rationale: 'Operator decision recorded.', evidence_refs: (e.evidence as Evidence[]).map(x => x.id).slice(0, 1) }
    if (action !== 'dismiss') await recordVerdict(tx, exceptionId, 'operator', null, v, hashOf(e.facts), null, null)
    const to = action === 'dismiss' ? 'dismissed' : 'resolved'
    await tx.query(`UPDATE exceptions SET status=$2, resolution=$3, resolved_at=now(), updated_at=now() WHERE id=$1`,
      [exceptionId, to, JSON.stringify({ action, by: 'operator', note: 'Operator decision recorded.', at: ctx.now().toISOString(), agreed_with_copilot: agreed })])
    await recordTransition(tx, 'exception', exceptionId, e.status, to, 'operator', `${action}${agreed === null ? '' : agreed ? ' (concorda com o copiloto)' : ' (discorda do copiloto)'}`)
    return { ok: true as const, agreed }
  })
}
