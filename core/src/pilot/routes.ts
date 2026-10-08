// Rotas do piloto: ingestão assinada (operador), leitura pública pseudonimizada (painel) e decisão do operador.
import type { FastifyInstance } from 'fastify'
import { timingSafeEqual, createHash } from 'node:crypto'
import type { Ctx } from '../context.js'
import { verifySignature } from './guard.js'
import { ingestBatch, processPending, BatchIdReused } from './ingest.js'
import { decideByOperator } from '../copilot/judge.js'
import { ACTIONS, ACTION_LABEL, type ExceptionKind } from '../copilot/verdict.js'
import { publicException, publicVerdict, publicTimeline } from './public.js'
import { registerShadowPublic } from '../pilot-shadow/public-api.js'

export type PilotOptions = { hmacSecret: string; operatorToken: string; sourceId?: string; v1Disabled?: boolean; readOnly?: boolean; shadowPublic?: boolean }
export const BATCH_CONTENT_TYPE = 'application/x-pixsettle-batch+json'
const err = (reply: any, status: number, code: string, message: string, details: Record<string, unknown> = {}) => reply.code(status).send({ error: { code, message, details } })

export function registerPilot(app: FastifyInstance, ctx: Ctx, opts: PilotOptions) {
  // O lote chega como texto: a assinatura é do corpo bruto, byte a byte.
  app.addContentTypeParser(BATCH_CONTENT_TYPE, { parseAs: 'string', bodyLimit: 4 * 1024 * 1024 }, (_req, body, done) => done(null, body))

  app.post('/pilot/v1/events', async (req, reply) => {
    if (opts.shadowPublic || opts.v1Disabled || opts.readOnly || ctx.copilot?.model?.mode === 'replay') return err(reply, 409, 'pilot_v1_disabled', 'pilot v1 ingestion is disabled')
    if (req.headers['content-type'] !== BATCH_CONTENT_TYPE) return err(reply, 415, 'content_type', `envie ${BATCH_CONTENT_TYPE}`)
    const raw = String(req.body ?? '')
    const sig = verifySignature(opts.hmacSecret, raw, req.headers['x-pilot-signature'] as string | undefined)
    if (!sig.ok) return err(reply, 401, 'unauthorized', `assinatura inválida: ${sig.reason}`)
    let body: any
    try { body = JSON.parse(raw) } catch { return err(reply, 400, 'invalid_json', 'corpo não é JSON') }
    const source = String(body?.source ?? opts.sourceId ?? '')
    if (!/^[a-z0-9-]{1,32}$/.test(source)) return err(reply, 422, 'invalid_source', 'source inválido')
    const batchId = String(body?.batch_id ?? '')
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(batchId)) return err(reply, 422, 'invalid_batch_id', 'batch_id inválido')
    if (!Array.isArray(body?.events) || body.events.length === 0 || body.events.length > 2000) return err(reply, 422, 'invalid_events', 'events: lista de 1 a 2000 linhas')
    // Recibo por lote: hash do corpo bruto (o que foi assinado) + assinatura do servidor com o mesmo segredo.
    let ing
    try { ing = await ingestBatch(ctx, source, batchId, body.events, { bodySha256: createHash('sha256').update(raw).digest('hex'), secret: opts.hmacSecret }) }
    catch (e) { if (e instanceof BatchIdReused) return err(reply, 409, 'batch_id_reused', e.message, { batch_id: batchId }); throw e }
    const proc = body.process === false ? null : await processPending(ctx, source)
    return { accepted: ing.accepted, duplicates: ing.duplicates, rejected: ing.rejected, processed: proc, receipt: ing.receipt, replayed: ing.replayed }
  })

  // Reprocessa pendentes (adiados por dependência, erros): o operador chama depois de um lote fora de ordem.
  app.post('/pilot/v1/process', async (req, reply) => {
    if (opts.shadowPublic || opts.v1Disabled || opts.readOnly || ctx.copilot?.model?.mode === 'replay') return err(reply, 409, 'pilot_v1_disabled', 'pilot v1 processing is disabled')
    if (!bearerOk(req, opts.operatorToken)) return err(reply, 401, 'unauthorized', 'token do operador inválido')
    const source = String((req.query as any)?.source ?? opts.sourceId ?? '')
    return processPending(ctx, source)
  })

  if (opts.shadowPublic) registerShadowPublic(app, ctx.db, { now: ctx.now, configuredModel: ctx.copilot?.model?.name })
  else {
  app.get('/pilot/api/summary', async () => summary(ctx))

  app.get('/pilot/api/exceptions', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>
    const status = q.status && ['open', 'auto_applied', 'awaiting_human', 'resolved', 'dismissed'].includes(q.status) ? q.status : null
    const kind = q.kind && (q.kind in ACTIONS) ? q.kind : null
    const store = q.store && /^[a-z0-9-]{1,40}$/.test(q.store) ? q.store : null
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) | 0))
    const rows = (await ctx.db.query(
      `SELECT e.id, e.kind, e.severity, e.status, e.copilot_state, e.summary, e.detected_at, e.updated_at, e.resolved_at, e.resolution, e.last_error,
              ps.code AS store, o.external_ref AS ord, o.status AS order_status, o.amount_minor::text AS order_amount_minor,
              (SELECT row_to_json(v) FROM (SELECT engine, model, action, confidence::float8 AS confidence, requires_human, rationale, evidence_refs, verdict_hash, created_at FROM copilot_verdicts v WHERE v.exception_id=e.id ORDER BY created_at DESC LIMIT 1) v) AS verdict
         FROM exceptions e LEFT JOIN orders o ON o.id=e.order_id LEFT JOIN pilot_stores ps ON ps.merchant_id=e.merchant_id
        WHERE ($1::text IS NULL OR e.status=$1) AND ($2::text IS NULL OR e.kind=$2) AND ($3::text IS NULL OR ps.code=$3)
        ORDER BY CASE e.status WHEN 'awaiting_human' THEN 0 WHEN 'open' THEN 1 WHEN 'auto_applied' THEN 2 ELSE 3 END, e.detected_at DESC LIMIT $4`,
      [status, kind, store, limit])).rows
    return { exceptions: rows.map(publicException) }
  })

  app.get('/pilot/api/exceptions/:id', async (req, reply) => {
    const id = String((req.params as any).id)
    const e = (await ctx.db.query(
      `SELECT e.*, ps.code AS store, o.external_ref AS ord, o.status AS order_status, o.hold_reason, o.amount_minor::text AS order_amount_minor, o.paid_at
         FROM exceptions e LEFT JOIN orders o ON o.id=e.order_id LEFT JOIN pilot_stores ps ON ps.merchant_id=e.merchant_id WHERE e.id=$1`, [id])).rows[0]
    if (!e) return err(reply, 404, 'not_found', 'exceção não encontrada')
    const verdicts = (await ctx.db.query(`SELECT id, engine, model, action, confidence::float8 AS confidence, requires_human, rationale, evidence_refs, input_hash, verdict_hash, latency_ms, created_at FROM copilot_verdicts WHERE exception_id=$1 ORDER BY created_at, id`, [id])).rows
    const timeline = (await ctx.db.query(`SELECT from_state, to_state, reason, source, created_at FROM state_transitions WHERE entity='exception' AND entity_id=$1 ORDER BY id`, [id])).rows
    const receipts = e.order_id ? (await ctx.db.query(`SELECT id, receipt_type, created_at FROM receipts WHERE order_id=$1 ORDER BY created_at`, [e.order_id])).rows : []
    const { merchant_id: _m, fingerprint: _f, ...pub } = e
    return { ...publicException(pub), allowed_actions: ACTIONS[e.kind as ExceptionKind].map(a => ({ action: a, label: ACTION_LABEL[a] ?? a })), verdicts: verdicts.map(publicVerdict), timeline: timeline.map(publicTimeline), receipts }
  })

  }
  app.post('/pilot/api/exceptions/:id/decide', async (req, reply) => {
    if (opts.shadowPublic || opts.readOnly || ctx.copilot?.model?.mode === 'replay') return err(reply, 409, 'replay_readonly', 'public replay permits read access only')
    if (!bearerOk(req, opts.operatorToken)) return err(reply, 401, 'unauthorized', 'token do operador inválido')
    const b = (req.body ?? {}) as any
    const action = String(b.action ?? '')
    if (!/^[a-z_]{3,40}$/.test(action)) return err(reply, 422, 'invalid_action', 'action inválida')
    const r = await decideByOperator(ctx, String((req.params as any).id), action, String(b.note ?? '').slice(0, 500))
    if (!r.ok) return err(reply, r.code === 'not_found' ? 404 : 409, r.code, r.message)
    return { ok: true, agreed_with_copilot: r.agreed }
  })
}

function bearerOk(req: any, token: string): boolean {
  if (!token) return false
  const h = String(req.headers.authorization ?? '')
  if (!h.startsWith('Bearer ')) return false
  const a = Buffer.from(h.slice(7)), b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function summary(ctx: Ctx) {
  const q = async (s: string, p: unknown[] = []) => (await ctx.db.query(s, p)).rows
  const one = async (s: string, p: unknown[] = []) => (await ctx.db.query(s, p)).rows[0]
  const [events, stores, byEv, exceptions, copilot, orders, receipts, last, pending] = await Promise.all([
    one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE processing_state='processed')::int AS processed, count(*) FILTER (WHERE processing_state='ignored')::int AS ignored,
                count(*) FILTER (WHERE processing_state IN ('received','deferred'))::int AS pending, count(*) FILTER (WHERE processing_state='unmapped')::int AS unmapped, count(*) FILTER (WHERE processing_state='error')::int AS errors,
                min(ts) AS first_ts, max(ts) AS last_ts, max(received_at) AS last_received_at FROM attested_events`),
    q(`SELECT ps.code, ps.store_type, count(o.id)::int AS orders, count(o.id) FILTER (WHERE o.status IN ('paid','settling','settled','refunded','late_paid'))::int AS paid,
               coalesce(sum(o.amount_minor) FILTER (WHERE o.status IN ('paid','settling','settled','refunded','late_paid')),0)::text AS paid_minor,
               (SELECT count(*)::int FROM exceptions e WHERE e.merchant_id=ps.merchant_id) AS exceptions
          FROM pilot_stores ps LEFT JOIN orders o ON o.merchant_id=ps.merchant_id GROUP BY ps.code, ps.store_type, ps.merchant_id ORDER BY orders DESC, ps.code`),
    q(`SELECT ev, count(*)::int AS n FROM attested_events GROUP BY ev ORDER BY ev`),
    q(`SELECT kind, status, count(*)::int AS n FROM exceptions GROUP BY kind, status ORDER BY kind, status`),
    one(`SELECT count(*)::int AS exceptions, count(*) FILTER (WHERE status='auto_applied' OR (status='resolved' AND resolution->>'by'='auto'))::int AS auto_applied,
                count(*) FILTER (WHERE status='awaiting_human')::int AS awaiting_human, count(*) FILTER (WHERE status='resolved' AND resolution->>'by'='operator')::int AS decided_by_operator,
                count(*) FILTER (WHERE status='resolved' AND resolution->>'by'='operator' AND (resolution->>'agreed_with_copilot')::boolean)::int AS operator_agreed,
                count(*) FILTER (WHERE status='resolved' AND resolution->>'by'='operator' AND resolution->>'agreed_with_copilot'='false')::int AS operator_disagreed,
                count(*) FILTER (WHERE copilot_state='rules_only')::int AS by_rules, count(*) FILTER (WHERE copilot_state='model_done')::int AS by_model,
                count(*) FILTER (WHERE copilot_state='pending_model')::int AS model_pending, count(*) FILTER (WHERE copilot_state='model_error')::int AS model_error, count(*) FILTER (WHERE copilot_state='model_off')::int AS model_off
           FROM exceptions`),
    one(`SELECT count(*)::int AS orders, count(*) FILTER (WHERE status IN ('paid','settling','settled','refunded','late_paid'))::int AS paid, count(*) FILTER (WHERE status='settled')::int AS settled,
                count(*) FILTER (WHERE hold_reason IS NOT NULL)::int AS on_hold, coalesce(sum(amount_minor) FILTER (WHERE status IN ('paid','settling','settled','refunded','late_paid')),0)::text AS paid_minor,
                (SELECT count(*)::int FROM settlements s JOIN orders o2 ON o2.id=s.order_id WHERE o2.provider_env='attested' AND s.status='confirmed') AS settlements_confirmed
           FROM orders WHERE provider_env='attested'`),
    one(`SELECT count(*)::int AS receipts FROM receipts r JOIN orders o ON o.id=r.order_id WHERE o.provider_env='attested'`),
    one(`SELECT ev, ts, store_code, received_at FROM attested_events ORDER BY id DESC LIMIT 1`),
    one(`SELECT count(*)::int AS n FROM outbox WHERE done_at IS NULL AND topic='copilot_judge'`),
  ])
  const verdicts = await q(`SELECT engine, count(*)::int AS n FROM copilot_verdicts GROUP BY engine ORDER BY engine`)
  return {
    generated_at: ctx.now().toISOString(),
    public_read_only: ctx.cfg.publicReplayReadOnly === true || ctx.copilot?.model?.mode === 'replay',
    copilot_model: ctx.copilot?.model ? { name: ctx.copilot.model.name, mode: ctx.copilot.model.mode } : { name: null, mode: 'off', reason: ctx.copilot?.offReason ?? 'não configurado' },
    pilot_settle: ctx.cfg.pilotSettle,
    events, stores, by_event: byEv, exceptions: { by_kind_status: exceptions, ...copilot, model_jobs_pending: pending?.n ?? 0 }, verdicts,
    orders: { ...orders, receipts: receipts?.receipts ?? 0 },
    last_event: last ?? null,
  }
}
