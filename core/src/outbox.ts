// Worker da outbox: pega um job com FOR UPDATE SKIP LOCKED, marca lock, executa, conclui ou agenda retry.
import { withTx } from './db.js'
import { CrashError, type Ctx } from './context.js'
import { processProviderEvent } from './flows/events.js'
import { reconcileChargeCreation } from './flows/orders.js'
import { advanceSettlement, signAttempt, broadcastAttempt, reconcileAttempt, TREASURY_WAIT_MS } from './flows/settle.js'
import { issueSettlementReceipt } from './flows/receipts.js'
import { executeRefund, reconcileRefund, issueRefundReceipt } from './flows/refunds.js'
import { observeCharge, expireOrder } from './flows/sweep.js'
import { judgeWithModel } from './copilot/judge.js'
import { issueAffiliateReceipt } from './affiliates/receipts.js'
import { applyCommissionRevisions, APPLY_TOPIC } from './affiliates/batches/ingest.js'

export type Job = { id: string; topic: string; entity_id: string; payload: any; attempts: number }
type Handler = (ctx: Ctx, job: Job) => Promise<void | { retryInMs: number; payload?: any }>

export const handlers: Record<string, Handler> = {
  process_provider_event: (ctx, j) => processProviderEvent(ctx, j.entity_id),
  reconcile_charge_creation: (ctx, j) => reconcileChargeCreation(ctx, j.entity_id),
  // 'wait' = tesouraria pausada (R2): o job volta depois, com diagnóstico gravado no histórico.
  settle: async (ctx, j) => (await advanceSettlement(ctx, j.entity_id)) === 'wait' ? { retryInMs: TREASURY_WAIT_MS } : undefined,
  sign_attempt: async (ctx, j) => (await signAttempt(ctx, j.entity_id)) === 'wait' ? { retryInMs: TREASURY_WAIT_MS } : undefined,
  broadcast_attempt: async (ctx, j) => (await broadcastAttempt(ctx, j.entity_id)) === 'wait' ? { retryInMs: TREASURY_WAIT_MS } : undefined,
  issue_receipt: (ctx, j) => issueSettlementReceipt(ctx, j.entity_id),
  issue_affiliate_receipt: (ctx, j) => issueAffiliateReceipt(ctx, j.entity_id), // fase 2: recibo de comissão/saque para carteira
  // Fase 2: aplica ao domínio as revisões de comissão ingeridas por lote; cotação fora do ar ou corrente sem lojista = espera crescente com motivo.
  [APPLY_TOPIC]: async (ctx, j) => {
    const tryNo = Number(j.payload?.try ?? 0)
    const [origin, store] = String(j.entity_id).split('|')
    const r = await applyCommissionRevisions(ctx, origin ?? '', store ?? '')
    if (r.retry) return { retryInMs: Math.min(300_000, 5_000 * 2 ** Math.min(tryNo, 6)), payload: { try: tryNo + 1 } }
  },
  request_refund: async (ctx, j) => { await executeRefund(ctx, j.entity_id) },
  observe_charge: (ctx, j) => observeCharge(ctx, j.entity_id),
  expire_order: (ctx, j) => expireOrder(ctx, j.entity_id),
  issue_refund_receipt: (ctx, j) => issueRefundReceipt(ctx, j.entity_id),
  reconcile_refund: async (ctx, j) => {
    const tryNo = Number(j.payload?.try ?? 0)
    const r = await reconcileRefund(ctx, j.entity_id, tryNo)
    if (r === 'retry') return { retryInMs: Math.min(60_000, 2_000 * 2 ** Math.min(tryNo, 5)), payload: { try: tryNo + 1 } }
  },
  // Copiloto: o modelo julga o resíduo fora da transação do evento; falha vira retry com motivo visível na exceção.
  copilot_judge: async (ctx, j) => {
    const tryNo = Number(j.payload?.try ?? 0)
    const r = await judgeWithModel(ctx, j.entity_id, tryNo)
    if (r === 'retry') return { retryInMs: Math.min(120_000, 3_000 * 2 ** Math.min(tryNo, 5)), payload: { try: tryNo + 1 } }
  },
  reconcile_attempt: async (ctx, j) => {
    const tryNo = Number(j.payload?.try ?? 0)
    const r = await reconcileAttempt(ctx, j.entity_id, tryNo)
    if (r === 'retry') return { retryInMs: Math.min(60_000, 2_000 * 2 ** Math.min(tryNo, 5)), payload: { try: tryNo + 1 } }
  },
}

/** Same eligibility filter is used by the worker sleep calculation, so blocked jobs do not spin. */
export function eligibleJobWhere(ctx: Ctx): string {
  if (!ctx.cfg.publicReplayReadOnly && ctx.copilot?.model?.mode !== 'replay') return 'TRUE'
  return `topic <> 'copilot_judge'
    AND NOT EXISTS (SELECT 1 FROM orders ao WHERE ao.provider_env='attested' AND (
      ao.id=outbox.entity_id
      OR EXISTS (SELECT 1 FROM pix_charges ac WHERE ac.order_id=ao.id AND ac.id=outbox.entity_id)
      OR EXISTS (SELECT 1 FROM settlements ast WHERE ast.order_id=ao.id AND ast.id=outbox.entity_id)
      OR EXISTS (SELECT 1 FROM settlement_attempts aa JOIN settlements ast ON ast.id=aa.settlement_id WHERE ast.order_id=ao.id AND aa.id=outbox.entity_id)
      OR EXISTS (SELECT 1 FROM refund_cases ar WHERE ar.order_id=ao.id AND ar.id=outbox.entity_id)))
    AND NOT EXISTS (SELECT 1 FROM provider_events ap WHERE ap.id::text=outbox.entity_id AND ap.provider='attested')`
}

/** Executa um job. Retorna o tópico executado ou null se a fila estava vazia. */
export async function runOnce(ctx: Ctx, topics?: string[]): Promise<string | null> {
  const job = await withTx(ctx.db, async tx => {
    const r = await tx.query(
      `SELECT id, topic, entity_id, payload, attempts FROM outbox
       WHERE done_at IS NULL AND available_at <= now() AND (locked_until IS NULL OR locked_until < now())
         AND ($1::text[] IS NULL OR topic = ANY($1))
         AND ${eligibleJobWhere(ctx)}
       ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`, [topics ?? null])
    const j = r.rows[0]
    if (!j) return null
    await tx.query(`UPDATE outbox SET locked_until = now() + interval '60 seconds', attempts = attempts + 1 WHERE id=$1`, [j.id])
    return j as Job
  })
  if (!job) return null
  const h = handlers[job.topic]
  try {
    if (!h) throw new Error(`tópico sem handler: ${job.topic}`)
    const res = await h(ctx, job)
    if (res && 'retryInMs' in res) {
      await ctx.db.query(`UPDATE outbox SET locked_until=NULL, available_at = now() + ($2 || ' milliseconds')::interval, payload=$3 WHERE id=$1`, [job.id, String(res.retryInMs), JSON.stringify(res.payload ?? job.payload)])
    } else {
      await ctx.db.query(`UPDATE outbox SET done_at=now(), locked_until=NULL, last_error=NULL WHERE id=$1`, [job.id])
    }
  } catch (e) {
    if (e instanceof CrashError) throw e // processo "morreu": o lock expira e outro worker retoma
    const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(job.attempts, 6))
    await ctx.db.query(`UPDATE outbox SET locked_until=NULL, available_at = now() + ($2 || ' milliseconds')::interval, last_error=$3 WHERE id=$1`,
      [job.id, String(backoff), JSON.stringify({ message: (e as Error).message, at: new Date().toISOString() })])
  }
  return job.topic
}

/** Para testes e demo: roda até a fila esvaziar (considerando só jobs disponíveis agora). */
export async function drain(ctx: Ctx, max = 200, topics?: string[]): Promise<string[]> {
  const ran: string[] = []
  for (let i = 0; i < max; i++) { const t = await runOnce(ctx, topics); if (!t) break; ran.push(t) }
  return ran
}
