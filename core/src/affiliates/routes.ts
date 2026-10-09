// Fase 2: API das comissões em dólar (chave do lojista, mesma dos pedidos) e leitura pública pseudonimizada do piloto.
// Registrada só com o módulo ligado (ctx.affiliates); desligado, nenhuma rota existe.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import type { Ctx } from '../context.js'
import { DomainError } from '../flows/orders.js'
import {
  createCommission, releaseCommission, voidCommission, registerWallet, simulateWithdrawal, createWithdrawal, markWithdrawal,
  beneficiaryView, commissionView, withdrawalView, aggregateView, projectCommission, type BeneficiaryKind,
} from './service.js'

export type AffiliateRouteOptions = { /** piloto público: merchant dono dos dados exibidos em /pilot/affiliates (null = agregado de todos) */ publicMerchantId?: string | null }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const err = (reply: FastifyReply, status: number, code: string, message: string, details: Record<string, unknown> = {}) =>
  reply.code(status).send({ error: { code, message, details } })
const amountOf = (a: any): bigint | null => (typeof a?.amount === 'string' && /^\d{1,18}$/.test(a.amount) && a.currency === 'BRL' && (a.scale ?? 2) === 2 ? BigInt(a.amount) : null)
const unitsOf = (u: any): bigint | null => (typeof u === 'string' && /^\d{1,30}$/.test(u) ? BigInt(u) : null)
const dateOf = (s: any, fallback: Date): Date => (typeof s === 'string' && s ? new Date(s) : fallback)

export function registerAffiliates(app: FastifyInstance, ctx: Ctx, opts: AffiliateRouteOptions = {}) {
  if (!ctx.affiliates) return
  const merchantOf = async (req: FastifyRequest): Promise<string | null> => {
    const h = String(req.headers.authorization ?? '')
    if (!h.startsWith('Bearer ')) return null
    const r = await ctx.db.query(`SELECT id FROM merchants WHERE api_key_hash=$1`, [sha256(h.slice(7))])
    return r.rows[0]?.id ?? null
  }
  const guarded = (fn: (req: FastifyRequest, reply: FastifyReply, merchantId: string) => Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
    const merchantId = await merchantOf(req)
    if (!merchantId) return err(reply, 401, 'unauthorized', 'chave do lojista ausente ou inválida')
    try { return await fn(req, reply, merchantId) } catch (e) {
      if (e instanceof DomainError) return err(reply, e.httpStatus, e.code, e.message)
      throw e
    }
  }

  app.post('/api/v1/affiliates/commissions', guarded(async (req, reply, merchantId) => {
    const b = req.body as any
    const amount = amountOf(b?.amount)
    if (!amount) return err(reply, 422, 'invalid_body', 'esperado amount {amount: "centavos", currency: "BRL", scale: 2}')
    const r = await createCommission(ctx, merchantId, {
      sourceEventId: String(b?.source_event_id ?? ''), beneficiaryRef: String(b?.beneficiary_ref ?? ''), kind: String(b?.kind ?? 'affiliate') as BeneficiaryKind,
      orderRef: b?.order_ref == null ? null : String(b.order_ref).slice(0, 128), amountMinor: amount, occurredAt: dateOf(b?.occurred_at, ctx.now()),
    })
    return reply.code(r.created ? 201 : 200).send(r.commission)
  }))
  app.get('/api/v1/affiliates/commissions/:id', guarded(async (req, _reply, merchantId) => commissionView(ctx, merchantId, String((req.params as any).id))))
  app.post('/api/v1/affiliates/commissions/:id/release', guarded(async (req, _reply, merchantId) =>
    releaseCommission(ctx, merchantId, String((req.params as any).id), dateOf((req.body as any)?.occurred_at, ctx.now()))))
  app.post('/api/v1/affiliates/commissions/:id/void', guarded(async (req, _reply, merchantId) =>
    voidCommission(ctx, merchantId, String((req.params as any).id), String((req.body as any)?.reason_code ?? ''), dateOf((req.body as any)?.occurred_at, ctx.now()))))

  app.get('/api/v1/affiliates/beneficiaries/:ref', guarded(async (req, _reply, merchantId) => beneficiaryView(ctx, merchantId, String((req.params as any).ref))))
  app.put('/api/v1/affiliates/beneficiaries/:ref/wallet', guarded(async (req, _reply, merchantId) =>
    registerWallet(ctx, merchantId, String((req.params as any).ref), String((req.body as any)?.address ?? ''))))
  app.post('/api/v1/affiliates/beneficiaries/:ref/withdrawals/simulate', guarded(async (req, reply, merchantId) => {
    const b = req.body as any
    const units = unitsOf(b?.usd_units)
    if (!units) return err(reply, 422, 'invalid_body', 'esperado usd_units (texto com as unidades, escala 6) e kind pix|wallet')
    return simulateWithdrawal(ctx, merchantId, String((req.params as any).ref), String(b?.kind ?? 'pix') as 'pix' | 'wallet', units)
  }))
  app.post('/api/v1/affiliates/withdrawals', guarded(async (req, reply, merchantId) => {
    const w = await createWithdrawal(ctx, merchantId, String((req.body as any)?.lock_id ?? ''))
    return reply.code(201).send(w)
  }))
  app.get('/api/v1/affiliates/withdrawals/:id', guarded(async (req, _reply, merchantId) => withdrawalView(ctx, merchantId, String((req.params as any).id))))
  app.post('/api/v1/affiliates/withdrawals/:id/paid', guarded(async (req, _reply, merchantId) =>
    markWithdrawal(ctx, merchantId, String((req.params as any).id), 'paid', { pixE2eId: String((req.body as any)?.pix_e2e_id ?? '') })))
  app.post('/api/v1/affiliates/withdrawals/:id/failed', guarded(async (req, _reply, merchantId) =>
    markWithdrawal(ctx, merchantId, String((req.params as any).id), 'failed', { reasonCode: String((req.body as any)?.reason_code ?? 'unspecified') })))
  app.get('/api/v1/affiliates/summary', guarded(async (_req, _reply, merchantId) => aggregateView(ctx, merchantId)))

  // Leitura pública do piloto: agregado e um beneficiário pseudonimizado. Sem chave; nada de escrita.
  app.get('/pilot/api/affiliates', async () => aggregateView(ctx, opts.publicMerchantId ?? undefined))
  app.get('/pilot/api/affiliates/:ref', async (req, reply) => {
    const ref = String((req.params as any).ref)
    const row = (await ctx.db.query(`SELECT merchant_id FROM affiliate_beneficiaries WHERE beneficiary_ref=$1 ${opts.publicMerchantId ? 'AND merchant_id=$2' : ''}`, opts.publicMerchantId ? [ref, opts.publicMerchantId] : [ref])).rows[0]
    if (!row) return err(reply, 404, 'beneficiary_not_found', 'beneficiário desconhecido')
    const v = await beneficiaryView(ctx, row.merchant_id, ref)
    // Projeção pública: sem o endereço da carteira própria (só o modo) e sem os ids de origem do lojista.
    return { ...v, payout: { mode: v.payout.mode }, commissions: v.commissions.map(c => ({ ...c, source_event_id: undefined, order_ref: undefined, trace: { ...c.trace, source_event_id: undefined } })) }
  })
  app.get('/pilot/api/affiliates/receipts/:id', async (req, reply) => {
    const r = (await ctx.db.query(`SELECT envelope FROM affiliate_receipts WHERE id=$1`, [String((req.params as any).id)])).rows[0]
    if (!r) return err(reply, 404, 'receipt_not_found', 'recibo desconhecido')
    return r.envelope
  })
  void projectCommission
}
