// Fase 2: API das comissões em dólar (chave do lojista, mesma dos pedidos) e leitura pública pseudonimizada do piloto.
// Registrada só com o módulo ligado (ctx.affiliates); desligado, nenhuma rota existe.
// Leitura pública só existe com um lojista público definido (AFFILIATE_PUBLIC_MERCHANT_ID): sem ele não há agregado nem página,
// e nada do que é público sai da lista permitida (service.ts publicCommission/publicWithdrawal; recibos só do lojista público).
// Escritas (comissões, saques, carteira) respondem 403 affiliates_read_only quando a instalação é réplica pública sem opt-in explícito.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import type { Ctx } from '../context.js'
import { DomainError } from '../flows/orders.js'
import {
  createCommission, releaseCommission, voidCommission, retryCommissionPayout, registerWallet, simulateWithdrawal, createWithdrawal, markWithdrawal,
  beneficiaryView, commissionView, withdrawalView, aggregateView, REF, type BeneficiaryKind, type LaunchQuote,
} from './service.js'

export type AffiliateRouteOptions = { /** piloto público: lojista dono dos dados exibidos em /pilot/api/affiliates; null = leitura pública desligada */ publicMerchantId?: string | null }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const err = (reply: FastifyReply, status: number, code: string, message: string, details: Record<string, unknown> = {}) =>
  reply.code(status).send({ error: { code, message, details } })
const amountOf = (a: any): bigint | null => (typeof a?.amount === 'string' && /^\d{1,18}$/.test(a.amount) && a.currency === 'BRL' && (a.scale ?? 2) === 2 ? BigInt(a.amount) : null)
const unitsOf = (u: any): bigint | null => (typeof u === 'string' && /^\d{1,30}$/.test(u) ? BigInt(u) : null)
const dateOf = (s: any, fallback: Date): Date => (typeof s === 'string' && s ? new Date(s) : fallback)
/** Inteiro positivo vindo como número inteiro ou texto de dígitos (os clientes mandam dos dois jeitos); qualquer outra coisa = null. */
const posInt = (v: any): bigint | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? BigInt(v) : typeof v === 'string' && /^[1-9]\d{0,29}$/.test(v) ? BigInt(v) : null)
/** v4: `quote` opcional do corpo. Só `mode: launch` existe; erro de forma é 422 com código estável, antes de qualquer efeito. */
function launchQuoteOf(q: any): { ok: true; quote: LaunchQuote | null } | { ok: false; code: string; message: string } {
  if (q === undefined || q === null) return { ok: true, quote: null }
  if (typeof q !== 'object' || Array.isArray(q)) return { ok: false, code: 'invalid_launch_quote', message: 'quote deve ser um objeto' }
  if (q.mode !== 'launch') return { ok: false, code: 'invalid_quote_mode', message: 'quote.mode só aceita "launch" (sem quote, a cotação é a da recepção)' }
  const rateNum = posInt(q.rate_num), rateDen = posInt(q.rate_den)
  const ev = q.evidence ?? {}
  const paid = posInt(ev.brl_paid_minor), received = posInt(ev.usd_units_received)
  const at = typeof q.at === 'string' ? new Date(q.at) : new Date(NaN)
  const tx = Array.isArray(ev.tx) ? ev.tx.map((t: any) => String(t).toLowerCase()) : null
  if (!rateNum || !rateDen || !paid || !received || !tx || typeof q.source !== 'string' || Number.isNaN(at.getTime()))
    return { ok: false, code: 'invalid_launch_quote', message: 'quote de lançamento precisa de rate_num, rate_den, source, at e evidence {brl_paid_minor, usd_units_received, tx[]}' }
  return { ok: true, quote: { rateNum, rateDen, source: q.source, at, evidence: { brlPaidMinor: paid, usdUnitsReceived: received, tx } } }
}
const RECEIPT_ID = /^rct_[0-9A-Z]{26}$/

export const affiliateWritesAllowed = (ctx: Ctx) => ctx.affiliates?.writes !== false

/** Recibo pelo vínculo real: recibo -> comissão ou saque -> beneficiário -> lojista. A referência do beneficiário é única só dentro do lojista, então nunca serve de escopo. */
async function receiptOf(ctx: Ctx, id: string, merchantId: string) {
  const r = (await ctx.db.query(
    `SELECT r.envelope FROM affiliate_receipts r
       LEFT JOIN affiliate_commissions c ON c.id=r.commission_id
       LEFT JOIN affiliate_withdrawals w ON w.id=r.withdrawal_id
       JOIN affiliate_beneficiaries b ON b.id=coalesce(c.beneficiary_id, w.beneficiary_id)
      WHERE r.id=$1 AND b.merchant_id=$2`, [id, merchantId])).rows[0]
  return r?.envelope ?? null
}

export function registerAffiliates(app: FastifyInstance, ctx: Ctx, opts: AffiliateRouteOptions = {}) {
  if (!ctx.affiliates) return
  const merchantOf = async (req: FastifyRequest): Promise<string | null> => {
    const h = String(req.headers.authorization ?? '')
    if (!h.startsWith('Bearer ')) return null
    const r = await ctx.db.query(`SELECT id FROM merchants WHERE api_key_hash=$1`, [sha256(h.slice(7))])
    return r.rows[0]?.id ?? null
  }
  type Handler = (req: FastifyRequest, reply: FastifyReply, merchantId: string) => Promise<unknown>
  const guarded = (fn: Handler, mode: 'read' | 'write' = 'read') => async (req: FastifyRequest, reply: FastifyReply) => {
    const merchantId = await merchantOf(req)
    if (!merchantId) return err(reply, 401, 'unauthorized', 'chave do lojista ausente ou inválida')
    if (mode === 'write' && !affiliateWritesAllowed(ctx)) return err(reply, 403, 'affiliates_read_only', 'esta instalação é réplica pública somente leitura: comissões e saques não são aceitos aqui')
    try { return await fn(req, reply, merchantId) } catch (e) {
      if (e instanceof DomainError) return err(reply, e.httpStatus, e.code, e.message)
      throw e
    }
  }
  const write = (fn: Handler) => guarded(fn, 'write')

  app.post('/api/v1/affiliates/commissions', write(async (req, reply, merchantId) => {
    const b = req.body as any
    const amount = amountOf(b?.amount)
    if (!amount) return err(reply, 422, 'invalid_body', 'esperado amount {amount: "centavos", currency: "BRL", scale: 2}')
    const lq = launchQuoteOf(b?.quote)
    if (!lq.ok) return err(reply, 422, lq.code, lq.message)
    const r = await createCommission(ctx, merchantId, {
      sourceEventId: String(b?.source_event_id ?? ''), beneficiaryRef: String(b?.beneficiary_ref ?? ''), kind: String(b?.kind ?? 'affiliate') as BeneficiaryKind,
      orderRef: b?.order_ref == null ? null : String(b.order_ref).slice(0, 128), amountMinor: amount, occurredAt: dateOf(b?.occurred_at, ctx.now()),
      launch: lq.quote,
    })
    return reply.code(r.created ? 201 : 200).send(r.commission)
  }))
  app.get('/api/v1/affiliates/commissions/:id', guarded(async (req, _reply, merchantId) => commissionView(ctx, merchantId, String((req.params as any).id))))
  app.post('/api/v1/affiliates/commissions/:id/release', write(async (req, _reply, merchantId) =>
    releaseCommission(ctx, merchantId, String((req.params as any).id), dateOf((req.body as any)?.occurred_at, ctx.now()))))
  app.post('/api/v1/affiliates/commissions/:id/void', write(async (req, _reply, merchantId) =>
    voidCommission(ctx, merchantId, String((req.params as any).id), String((req.body as any)?.reason_code ?? ''), dateOf((req.body as any)?.occurred_at, ctx.now()))))
  app.post('/api/v1/affiliates/commissions/:id/retry-payout', write(async (req, _reply, merchantId) => retryCommissionPayout(ctx, merchantId, String((req.params as any).id))))

  app.get('/api/v1/affiliates/beneficiaries/:ref', guarded(async (req, _reply, merchantId) => beneficiaryView(ctx, merchantId, String((req.params as any).ref))))
  app.put('/api/v1/affiliates/beneficiaries/:ref/wallet', write(async (req, _reply, merchantId) =>
    registerWallet(ctx, merchantId, String((req.params as any).ref), String((req.body as any)?.address ?? ''))))
  app.post('/api/v1/affiliates/beneficiaries/:ref/withdrawals/simulate', write(async (req, reply, merchantId) => {
    const b = req.body as any
    const units = unitsOf(b?.usd_units)
    if (!units) return err(reply, 422, 'invalid_body', 'esperado usd_units (texto com as unidades, escala 6) e kind pix|wallet')
    return simulateWithdrawal(ctx, merchantId, String((req.params as any).ref), String(b?.kind ?? 'pix') as 'pix' | 'wallet', units)
  }))
  app.post('/api/v1/affiliates/withdrawals', write(async (req, reply, merchantId) => {
    const w = await createWithdrawal(ctx, merchantId, String((req.body as any)?.lock_id ?? ''))
    return reply.code(201).send(w)
  }))
  app.get('/api/v1/affiliates/withdrawals/:id', guarded(async (req, _reply, merchantId) => withdrawalView(ctx, merchantId, String((req.params as any).id))))
  app.post('/api/v1/affiliates/withdrawals/:id/paid', write(async (req, _reply, merchantId) =>
    markWithdrawal(ctx, merchantId, String((req.params as any).id), 'paid', { pixE2eId: String((req.body as any)?.pix_e2e_id ?? '') })))
  app.post('/api/v1/affiliates/withdrawals/:id/failed', write(async (req, _reply, merchantId) =>
    markWithdrawal(ctx, merchantId, String((req.params as any).id), 'failed', { reasonCode: String((req.body as any)?.reason_code ?? 'unspecified') })))
  app.get('/api/v1/affiliates/summary', guarded(async (_req, _reply, merchantId) => aggregateView(ctx, merchantId)))
  app.get('/api/v1/affiliates/receipts/:id', guarded(async (req, reply, merchantId) => {
    const id = String((req.params as any).id)
    const r = RECEIPT_ID.test(id) ? await receiptOf(ctx, id, merchantId) : null
    if (!r) return err(reply, 404, 'receipt_not_found', 'recibo desconhecido')
    return r
  }))

  // Leitura pública do piloto: só com lojista público definido; agregado desse lojista, um beneficiário pseudonimizado (lista permitida) e recibos desse lojista.
  const pub = opts.publicMerchantId
  if (!pub) return
  const pubErr = (reply: FastifyReply, e: unknown) => { if (e instanceof DomainError) return err(reply, e.httpStatus, e.code, e.message); throw e }
  app.get('/pilot/api/affiliates', async (_req, reply) => { try { return await aggregateView(ctx, pub) } catch (e) { return pubErr(reply, e) } })
  app.get('/pilot/api/affiliates/:ref', async (req, reply) => {
    const ref = String((req.params as any).ref)
    if (!REF.test(ref)) return err(reply, 404, 'beneficiary_not_found', 'beneficiário desconhecido')
    try { return await beneficiaryView(ctx, pub, ref, true) } catch (e) { return pubErr(reply, e) }
  })
  app.get('/pilot/api/affiliates/receipts/:id', async (req, reply) => {
    const id = String((req.params as any).id)
    const r = RECEIPT_ID.test(id) ? await receiptOf(ctx, id, pub) : null
    if (!r) return err(reply, 404, 'receipt_not_found', 'recibo desconhecido')
    return r
  })
}
