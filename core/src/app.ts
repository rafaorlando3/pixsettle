// API HTTP do core (contrato 5.2). Lojista pela chave secreta; pagador pela sessão de checkout.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Ctx } from './context.js'
import { createOrder, DomainError } from './flows/orders.js'
import { ingestProviderEvent } from './flows/events.js'
import { requestRefund } from './flows/refunds.js'
import { newId } from './ids.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const err = (reply: FastifyReply, status: number, code: string, message: string, details: Record<string, unknown> = {}) =>
  reply.code(status).send({ error: { code, message, details } })

export type AppOptions = { asaasWebhookToken: string; diagnosticsToken: string; tempoRpc?: string; trustProxy?: boolean }

export function buildApp(ctx: Ctx, opts: AppOptions) {
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false, bodyLimit: 64 * 1024 })

  // CSP estrita: só o próprio servidor; a RPC da Tempo é a única origem externa (verificador do recibo).
  const rpcOrigin = new URL(opts.tempoRpc ?? 'https://rpc.moderato.tempo.xyz').origin
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('content-security-policy', `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${rpcOrigin}; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer') // o token do checkout vai na URL: não vazar por Referer
    return payload
  })

  // Lojista derivado da autenticação, nunca do corpo.
  const merchantOf = async (req: FastifyRequest): Promise<string | null> => {
    const h = String(req.headers.authorization ?? '')
    if (!h.startsWith('Bearer ')) return null
    const r = await ctx.db.query(`SELECT id FROM merchants WHERE api_key_hash=$1`, [sha256(h.slice(7))])
    return r.rows[0]?.id ?? null
  }

  app.post('/api/v1/orders', async (req, reply) => {
    const merchantId = await merchantOf(req)
    if (!merchantId) return err(reply, 401, 'unauthorized', 'chave do lojista ausente ou inválida')
    const key = String(req.headers['idempotency-key'] ?? '')
    if (!key) return err(reply, 400, 'idempotency_key_required', 'envie o cabeçalho Idempotency-Key')
    const body = req.body as any
    const reqHash = sha256(JSON.stringify(body ?? {}))
    const prior = (await ctx.db.query(`SELECT request_hash, status_code, response FROM idempotency_keys WHERE merchant_id=$1 AND operation='create_order' AND key=$2`, [merchantId, key])).rows[0]
    if (prior) {
      if (prior.request_hash !== reqHash) return err(reply, 409, 'idempotency_conflict', 'mesma Idempotency-Key com corpo diferente')
      if (prior.status_code) return reply.code(prior.status_code).send(prior.response)
      return err(reply, 409, 'in_progress', 'requisição com esta chave ainda em andamento')
    }
    try {
      await ctx.db.query(`INSERT INTO idempotency_keys (merchant_id, operation, key, request_hash) VALUES ($1,'create_order',$2,$3)`, [merchantId, key, reqHash])
    } catch { return err(reply, 409, 'in_progress', 'requisição com esta chave ainda em andamento') }
    const amount = typeof body?.amount?.amount === 'string' && /^\d+$/.test(body.amount.amount) ? BigInt(body.amount.amount) : null
    if (!amount || body?.amount?.currency !== 'BRL' || typeof body?.external_ref !== 'string') {
      await ctx.db.query(`DELETE FROM idempotency_keys WHERE merchant_id=$1 AND operation='create_order' AND key=$2`, [merchantId, key])
      return err(reply, 422, 'invalid_body', 'esperado external_ref (texto) e amount {amount: "centavos", currency: "BRL"}')
    }
    try {
      const orderId = await createOrder(ctx, merchantId, { externalRef: body.external_ref, amountMinor: amount, description: String(body.description ?? '') })
      const token = randomBytes(24).toString('base64url')
      const o = (await ctx.db.query(`SELECT o.status, o.expires_at, c.creation_state, c.qr_payload, c.qr_expires_at, q.rate_num, q.rate_den, q.valid_until FROM orders o JOIN pix_charges c ON c.order_id=o.id JOIN quotes q ON q.order_id=o.id WHERE o.id=$1`, [orderId])).rows[0]
      await ctx.db.query(`INSERT INTO checkout_sessions (id, order_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`, [newId('cks'), orderId, sha256(token), o.expires_at])
      const status = o.creation_state === 'created' ? 201 : 202
      const resp = {
        order_id: orderId, status: o.status, checkout_token: token,
        pix: o.creation_state === 'created' ? { payload: o.qr_payload, expires_at: o.qr_expires_at } : null,
        quote: { rate_num: String(o.rate_num), rate_den: String(o.rate_den), source: 'simulated', valid_until: o.valid_until },
      }
      await ctx.db.query(`UPDATE idempotency_keys SET status_code=$4, response=$5 WHERE merchant_id=$1 AND operation='create_order' AND key=$2 AND request_hash=$3`, [merchantId, key, reqHash, status, JSON.stringify(resp)])
      return reply.code(status).send(resp)
    } catch (e) {
      await ctx.db.query(`DELETE FROM idempotency_keys WHERE merchant_id=$1 AND operation='create_order' AND key=$2`, [merchantId, key])
      if (e instanceof DomainError) return err(reply, e.code === 'duplicate_external_ref' ? 409 : e.httpStatus, e.code, e.message)
      throw e
    }
  })

  // Devolução pedida pelo lojista (contrato 5.2 e 3.6). Aceita = caso aberto; confirmação só observada no provedor.
  app.post('/api/v1/orders/:id/refund', async (req, reply) => {
    const merchantId = await merchantOf(req)
    if (!merchantId) return err(reply, 401, 'unauthorized', 'chave do lojista ausente ou inválida')
    const key = String(req.headers['idempotency-key'] ?? '')
    if (!key) return err(reply, 400, 'idempotency_key_required', 'envie o cabeçalho Idempotency-Key')
    const orderId = String((req.params as any).id)
    const body = req.body as any
    const reqHash = sha256(JSON.stringify({ orderId, body: body ?? {} }))
    const op = 'refund'
    const prior = (await ctx.db.query(`SELECT request_hash, status_code, response FROM idempotency_keys WHERE merchant_id=$1 AND operation=$2 AND key=$3`, [merchantId, op, key])).rows[0]
    if (prior) {
      if (prior.request_hash !== reqHash) return err(reply, 409, 'idempotency_conflict', 'mesma Idempotency-Key com corpo diferente')
      if (prior.status_code) return reply.code(prior.status_code).send(prior.response)
      return err(reply, 409, 'in_progress', 'requisição com esta chave ainda em andamento')
    }
    try { await ctx.db.query(`INSERT INTO idempotency_keys (merchant_id, operation, key, request_hash) VALUES ($1,$2,$3,$4)`, [merchantId, op, key, reqHash]) }
    catch { return err(reply, 409, 'in_progress', 'requisição com esta chave ainda em andamento') }
    const release = () => ctx.db.query(`DELETE FROM idempotency_keys WHERE merchant_id=$1 AND operation=$2 AND key=$3`, [merchantId, op, key])
    const amount = typeof body?.amount?.amount === 'string' && /^\d+$/.test(body.amount.amount) ? BigInt(body.amount.amount) : null
    if (!amount || body?.amount?.currency !== 'BRL') { await release(); return err(reply, 422, 'invalid_body', 'esperado amount {amount: "centavos", currency: "BRL"}') }
    try {
      const r = await requestRefund(ctx, merchantId, orderId, { type: 'merchant_refund', amountMinor: amount, source: 'api' })
      if (!r.ok) { await release(); return err(reply, r.httpStatus, r.code, r.message) } // recusa fica registrada no pedido; pode tentar de novo depois
      const resp = { refund_case_id: r.refundCaseId, state: 'requested' }
      await ctx.db.query(`UPDATE idempotency_keys SET status_code=202, response=$4 WHERE merchant_id=$1 AND operation=$2 AND key=$3`, [merchantId, op, key, JSON.stringify(resp)])
      return reply.code(202).send(resp)
    } catch (e) { await release(); throw e }
  })

  app.get('/api/v1/orders/:id', async (req, reply) => {
    const merchantId = await merchantOf(req)
    if (!merchantId) return err(reply, 401, 'unauthorized', 'chave do lojista ausente ou inválida')
    const id = (req.params as any).id
    const o = (await ctx.db.query(`SELECT id, external_ref, status, hold_reason, amount_minor, expires_at, paid_at FROM orders WHERE id=$1 AND merchant_id=$2`, [id, merchantId])).rows[0]
    if (!o) return err(reply, 404, 'not_found', 'pedido não encontrado') // mesmo código para "de outro lojista"
    const timeline = (await ctx.db.query(`SELECT entity, from_state, to_state, reason, source, created_at FROM state_transitions WHERE entity_id IN (SELECT $1 UNION SELECT id FROM settlements WHERE order_id=$1 UNION SELECT id FROM pix_charges WHERE order_id=$1 UNION SELECT a.id FROM settlement_attempts a JOIN settlements s ON s.id=a.settlement_id WHERE s.order_id=$1 UNION SELECT id FROM refund_cases WHERE order_id=$1) ORDER BY id`, [id])).rows
    const settlement = (await ctx.db.query(`SELECT s.id, s.status, s.amount_units, s.memo, a.tx_hash, a.status AS attempt_status FROM settlements s LEFT JOIN settlement_attempts a ON a.settlement_id=s.id WHERE s.order_id=$1 ORDER BY a.attempt_no DESC NULLS LAST LIMIT 1`, [id])).rows[0] ?? null
    const receipts = (await ctx.db.query(`SELECT id, receipt_type, refund_case_id, created_at FROM receipts WHERE order_id=$1 ORDER BY created_at, id`, [id])).rows
    const refunds = (await ctx.db.query(`SELECT id, refund_type, state, amount_minor::text, simulation_reason, created_at, updated_at FROM refund_cases WHERE order_id=$1 ORDER BY created_at, id`, [id])).rows
    const receipt = receipts.find(r => r.receipt_type === 'settlement')?.id ?? null
    return { ...o, amount_minor: String(o.amount_minor), settlement, receipt_id: receipt, receipts, refunds, timeline }
  })

  app.get('/api/v1/merchants/me/ledger', async (req, reply) => {
    const merchantId = await merchantOf(req)
    if (!merchantId) return err(reply, 401, 'unauthorized', 'chave do lojista ausente ou inválida')
    const rows = (await ctx.db.query(`SELECT order_id, kind, amount_units::text, currency, simulated, created_at FROM ledger_entries WHERE merchant_id=$1 ORDER BY id`, [merchantId])).rows
    return { entries: rows }
  })

  // Tela do pagador: só o necessário, por token de sessão (leitura, com validade).
  app.get('/api/v1/checkout/:token', async (req, reply) => {
    const t = (await ctx.db.query(`SELECT order_id, expires_at FROM checkout_sessions WHERE token_hash=$1`, [sha256((req.params as any).token)])).rows[0]
    if (!t) return err(reply, 404, 'not_found', 'sessão de checkout inválida')
    const o = (await ctx.db.query(`SELECT o.status, o.hold_reason, o.amount_minor, o.expires_at, c.qr_payload FROM orders o JOIN pix_charges c ON c.order_id=o.id WHERE o.id=$1`, [t.order_id])).rows[0]
    // O pagador vê só o essencial: nunca o motivo interno da retenção.
    const payer = o.hold_reason ? 'under_review' : ['paid', 'settling', 'settled'].includes(o.status) ? 'paid' : o.status
    return { amount: { amount: String(o.amount_minor), currency: 'BRL', scale: 2 }, status: payer, pix_payload: o.qr_payload, expires_at: o.expires_at }
  })

  app.post('/webhooks/asaas', async (req, reply) => {
    const got = Buffer.from(String(req.headers['asaas-access-token'] ?? ''))
    const exp = Buffer.from(opts.asaasWebhookToken)
    if (got.length !== exp.length || !timingSafeEqual(got, exp)) return err(reply, 401, 'unauthorized', 'asaas-access-token inválido')
    try {
      const r = await ingestProviderEvent(ctx, 'asaas', req.body)
      return { received: true, duplicate: r.duplicate }
    } catch (e) { return err(reply, 400, 'invalid_event', (e as Error).message) }
  })

  app.get('/r/:id', async (req, reply) => {
    const r = (await ctx.db.query(`SELECT envelope FROM receipts WHERE id=$1`, [(req.params as any).id])).rows[0]
    if (!r) return err(reply, 404, 'not_found', 'recibo não encontrado')
    return r.envelope
  })

  app.get('/health', async () => {
    try { await ctx.db.query('SELECT 1'); return { status: 'ok' } } catch { return { status: 'degraded' } }
  })

  app.get('/internal/diagnostics', async (req, reply) => {
    if (String(req.headers.authorization ?? '') !== `Bearer ${opts.diagnosticsToken}`) return err(reply, 401, 'unauthorized', 'token de diagnóstico inválido')
    const q = async (s: string) => (await ctx.db.query(s)).rows
    return {
      outbox_pending: await q(`SELECT topic, count(*)::int AS n, max(attempts) AS max_attempts FROM outbox WHERE done_at IS NULL GROUP BY topic`),
      outbox_errors: await q(`SELECT id, topic, entity_id, attempts, last_error FROM outbox WHERE done_at IS NULL AND last_error IS NOT NULL ORDER BY id DESC LIMIT 20`),
      attempts_stuck: await q(`SELECT id, status, nonce, updated_at FROM settlement_attempts WHERE status IN ('suspended','unknown','manual_review','broadcast_pending') OR (status='broadcast_sent' AND updated_at < now() - interval '10 minutes')`),
      holds: await q(`SELECT id, status, hold_reason FROM orders WHERE hold_reason IS NOT NULL ORDER BY updated_at DESC LIMIT 50`),
    }
  })

  return app
}
