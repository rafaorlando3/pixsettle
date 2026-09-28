// Rotas da DEMO (console do operador). Só existem com DEMO_MODE=1 e provedor Pix SIMULADO.
// Tudo passa pelos caminhos reais: pedido via POST /api/v1/orders e aviso via POST /webhooks/asaas.
import type { FastifyInstance } from 'fastify'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import type { Ctx } from './context.js'
import { SimulatedPixProvider } from './providers/simulated.js'
import { AsaasPixProvider, type AsaasSandboxPayer } from './providers/asaas.js'
import { computeAmounts } from './flows/events.js'
import { requestRefund } from './flows/refunds.js'

export type DemoOptions = { webhookToken: string; merchantAddress: string; explorer: string; merchantName?: string; merchantId?: string; bench?: AsaasSandboxPayer }

const err = (reply: any, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } })

/** Limite simples por IP e global: a demo pública gasta pathUSD de testnet da tesouraria. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>()
  return (key: string) => {
    const now = Date.now()
    const arr = (hits.get(key) ?? []).filter(t => now - t < windowMs)
    if (arr.length >= max) { hits.set(key, arr); return false }
    arr.push(now); hits.set(key, arr)
    return true
  }
}

export async function registerDemo(app: FastifyInstance, ctx: Ctx, opts: DemoOptions) {
  // Só sem dinheiro real: provedor simulado, ou Asaas SANDBOX com um pagador de sandbox explícito.
  const sim = ctx.provider instanceof SimulatedPixProvider ? ctx.provider : null
  const sandbox = ctx.provider instanceof AsaasPixProvider && ctx.provider.env === 'sandbox' && opts.bench ? opts.bench : null
  if (!sim && !sandbox) throw new Error('demo exige o provedor Pix simulado ou o Asaas sandbox com pagador de sandbox')
  const apiKey = 'sk_demo_' + randomBytes(24).toString('base64url') // só na memória deste processo
  // Lojista da demo com id FIXO: depois de um reinício, os pedidos antigos continuam do mesmo lojista e o
  // console da demo ainda os enxerga. A chave troca a cada partida (só o hash fica no banco).
  const merchantId = opts.merchantId ?? 'mer_demo'
  await ctx.db.query(
    `INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET api_key_hash=EXCLUDED.api_key_hash, payout_address=EXCLUDED.payout_address, name=EXCLUDED.name`,
    [merchantId, opts.merchantName ?? 'Demo Store (simulated)', createHash('sha256').update(apiKey).digest('hex'), opts.merchantAddress])
  const auth = { authorization: `Bearer ${apiKey}` }
  const perIp = limiter(20, 10 * 60_000), global = limiter(300, 60 * 60_000)

  const own = async (id: string) => (await ctx.db.query(
    `SELECT o.id, o.status, o.hold_reason, o.amount_minor, c.provider_payment_id, c.qr_payload FROM orders o JOIN pix_charges c ON c.order_id=o.id WHERE o.id=$1 AND o.merchant_id=$2`,
    [id, merchantId])).rows[0]

  app.post('/demo/api/orders', async (req, reply) => {
    if (!perIp(req.ip) || !global('all')) return err(reply, 429, 'rate_limited', 'Demo limit reached. Try again in a few minutes.')
    const b = (req.body ?? {}) as any
    const amount = String(b.amount_minor ?? '')
    if (!/^\d{1,6}$/.test(amount) || Number(amount) < 100 || Number(amount) > 50_000) return err(reply, 422, 'invalid_amount', 'Amount must be between R$ 1,00 and R$ 500,00.')
    const r = await app.inject({
      method: 'POST', url: '/api/v1/orders', headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: { external_ref: 'demo-' + randomUUID(), amount: { amount, currency: 'BRL' }, description: String(b.description ?? '').slice(0, 80) },
    })
    return reply.code(r.statusCode).send(r.json())
  })

  // Simula o pagador (banco) e o aviso do provedor, entregue N vezes como o Asaas pode fazer.
  app.post('/demo/api/orders/:id/simulate', async (req, reply) => {
    const o = await own((req.params as any).id)
    if (!o) return err(reply, 404, 'not_found', 'Order not found.')
    if (o.status !== 'awaiting_payment' || o.hold_reason) return err(reply, 409, 'not_payable', `Order is ${o.hold_reason ? 'on hold' : o.status}.`)
    const b = (req.body ?? {}) as any
    const scenario = b.scenario === 'underpay' ? 'underpay' : 'pay'
    if (sandbox) {
      // Asaas sandbox: paga de verdade no sandbox; o aviso chega pelo webhook real (ou pela conciliação periódica).
      if (scenario === 'underpay') return err(reply, 409, 'not_supported', 'The Asaas sandbox QR has a fixed amount; underpayment is only simulated with the simulated provider.')
      try {
        const r = await sandbox.pay(o.provider_payment_id, o.qr_payload, BigInt(o.amount_minor))
        return { scenario, via: r.via, deliveries: [] }
      } catch (e) { return err(reply, 502, 'sandbox_payment_failed', (e as Error).message) }
    }
    const provider = sim!
    if (!(await provider.has(o.provider_payment_id))) return err(reply, 409, 'stale_demo_order', 'The simulated charge for this order no longer exists (it was created before the simulator kept its state). Create a new one.')
    const deliveries = Math.min(5, Math.max(1, Number(b.deliveries ?? 3) | 0))
    await provider.pay(o.provider_payment_id, scenario === 'underpay' ? { valueMinor: BigInt(o.amount_minor) - 1n } : {})
    const event = { id: `evt_sim_${o.id}`, event: 'PAYMENT_RECEIVED', payment: { id: o.provider_payment_id, status: 'RECEIVED', billingType: 'PIX' } }
    const results = []
    for (let i = 1; i <= deliveries; i++) {
      const r = await app.inject({ method: 'POST', url: '/webhooks/asaas', headers: { 'asaas-access-token': opts.webhookToken }, payload: event })
      results.push({ delivery: i, status: r.statusCode, duplicate: r.json().duplicate ?? null })
    }
    return { scenario, deliveries: results }
  })

  // Devolução parcial pelo endpoint REAL do lojista (com Idempotency-Key).
  app.post('/demo/api/orders/:id/refund', async (req, reply) => {
    if (!perIp(req.ip)) return err(reply, 429, 'rate_limited', 'Demo limit reached. Try again in a few minutes.')
    const o = await own((req.params as any).id)
    if (!o) return err(reply, 404, 'not_found', 'Order not found.')
    const amount = String((req.body as any)?.amount_minor ?? '')
    if (!/^\d{1,6}$/.test(amount)) return err(reply, 422, 'invalid_amount', 'Invalid amount.')
    const r = await app.inject({ method: 'POST', url: `/api/v1/orders/${o.id}/refund`, headers: { ...auth, 'idempotency-key': randomUUID() }, payload: { amount: { amount, currency: 'BRL' } } })
    return reply.code(r.statusCode).send(r.json())
  })

  // MED SIMULADO: não existe evento real de MED aqui; o caso nasce rotulado como simulação (contrato 6).
  app.post('/demo/api/orders/:id/med', async (req, reply) => {
    if (!perIp(req.ip)) return err(reply, 429, 'rate_limited', 'Demo limit reached. Try again in a few minutes.')
    const o = await own((req.params as any).id)
    if (!o) return err(reply, 404, 'not_found', 'Order not found.')
    const used = BigInt((await ctx.db.query(`SELECT coalesce(sum(amount_minor),0)::text AS v FROM refund_cases WHERE order_id=$1 AND state IN ('requested','submitting','unknown','confirmed','partial')`, [o.id])).rows[0].v)
    const left = BigInt(o.amount_minor) - used
    if (left <= 0n) return err(reply, 409, 'nothing_left', 'Order already fully refunded.')
    const r = await requestRefund(ctx, merchantId, o.id, { type: 'med_simulated', amountMinor: left, simulationReason: 'demo: payer opened a MED claim at their bank (simulated, no real MED event)', source: 'demo' })
    if (!r.ok) return err(reply, r.httpStatus, r.code, r.message)
    return reply.code(202).send({ refund_case_id: r.refundCaseId, state: 'requested', amount_minor: left.toString() })
  })

  app.get('/demo/api/orders/:id', async (req, reply) => {
    const id = (req.params as any).id
    const r = await app.inject({ method: 'GET', url: `/api/v1/orders/${encodeURIComponent(id)}`, headers: auth })
    if (r.statusCode !== 200) return reply.code(r.statusCode).send(r.json())
    const order = r.json()
    const q = (await ctx.db.query(`SELECT q.rate_num, q.rate_den, m.reserve_bps FROM quotes q JOIN orders o ON o.id=q.order_id JOIN merchants m ON m.id=o.merchant_id WHERE q.order_id=$1`, [id])).rows[0]
    const a = computeAmounts(BigInt(order.amount_minor), BigInt(q.rate_num), BigInt(q.rate_den), q.reserve_bps)
    const ev = (await ctx.db.query(`SELECT count(*)::int AS events, coalesce(sum(duplicate_count),0)::int AS duplicates FROM provider_events e JOIN pix_charges c ON c.provider_payment_id=e.provider_payment_id WHERE c.order_id=$1`, [id])).rows[0]
    const att = (await ctx.db.query(`SELECT a.nonce, a.observed FROM settlement_attempts a JOIN settlements s ON s.id=a.settlement_id WHERE s.order_id=$1 ORDER BY a.attempt_no DESC LIMIT 1`, [id])).rows[0]
    const stl = (await ctx.db.query(`SELECT recipient FROM settlements WHERE order_id=$1`, [id])).rows[0]
    const tx = order.settlement?.tx_hash as string | undefined
    const pool = Object.fromEntries((await ctx.db.query(`SELECT kind, sum(amount_units)::text AS v FROM ledger_entries WHERE merchant_id=$1 GROUP BY kind`, [merchantId])).rows.map(r => [r.kind, r.v]))
    const held = BigInt(pool.reserve_simulated ?? 0), consumed = BigInt(pool.reserve_consumed_simulated ?? 0), released = BigInt(pool.reserve_release_simulated ?? 0)
    return {
      reserve_pool: { held: held.toString(), consumed: consumed.toString(), balance: (held - consumed - released).toString(), debt: String(pool.debt_simulated ?? '0'), scale: 6, simulated: true },
      ...order,
      amounts: { gross: a.gross.toString(), reserve_simulated: a.reserve.toString(), net: a.net.toString(), scale: 6, token: 'pathUSD', rate_num: String(q.rate_num), rate_den: String(q.rate_den), reserve_bps: q.reserve_bps },
      webhooks: { events: ev.events, deliveries: ev.events + ev.duplicates, duplicates_ignored: ev.duplicates },
      chain: att ? { nonce: String(att.nonce), block_number: att.observed?.blockNumber ?? null, recipient: stl?.recipient ?? null, explorer_url: tx ? `${opts.explorer}/tx/${tx}` : null } : null,
    }
  })

  app.get('/demo/api/orders', async () => {
    const rows = (await ctx.db.query(`SELECT id, status, hold_reason, amount_minor::text, created_at FROM orders WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 8`, [merchantId])).rows
    return { orders: rows }
  })

  return { merchantId }
}
