// Worker da outbox: pega um job com FOR UPDATE SKIP LOCKED, marca lock, executa, conclui ou agenda retry.
import { withTx } from './db.js'
import { CrashError, type Ctx } from './context.js'
import { processProviderEvent } from './flows/events.js'
import { reconcileChargeCreation } from './flows/orders.js'
import { advanceSettlement, signAttempt, broadcastAttempt, reconcileAttempt } from './flows/settle.js'

export type Job = { id: string; topic: string; entity_id: string; payload: any; attempts: number }
type Handler = (ctx: Ctx, job: Job) => Promise<void | { retryInMs: number; payload?: any }>

export const handlers: Record<string, Handler> = {
  process_provider_event: (ctx, j) => processProviderEvent(ctx, j.entity_id),
  reconcile_charge_creation: (ctx, j) => reconcileChargeCreation(ctx, j.entity_id),
  settle: (ctx, j) => advanceSettlement(ctx, j.entity_id),
  sign_attempt: (ctx, j) => signAttempt(ctx, j.entity_id),
  broadcast_attempt: (ctx, j) => broadcastAttempt(ctx, j.entity_id),
  reconcile_attempt: async (ctx, j) => {
    const tryNo = Number(j.payload?.try ?? 0)
    const r = await reconcileAttempt(ctx, j.entity_id, tryNo)
    if (r === 'retry') return { retryInMs: Math.min(60_000, 2_000 * 2 ** Math.min(tryNo, 5)), payload: { try: tryNo + 1 } }
  },
}

/** Executa um job. Retorna o tópico executado ou null se a fila estava vazia. */
export async function runOnce(ctx: Ctx, topics?: string[]): Promise<string | null> {
  const job = await withTx(ctx.db, async tx => {
    const r = await tx.query(
      `SELECT id, topic, entity_id, payload, attempts FROM outbox
       WHERE done_at IS NULL AND available_at <= now() AND (locked_until IS NULL OR locked_until < now())
         AND ($1::text[] IS NULL OR topic = ANY($1))
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
