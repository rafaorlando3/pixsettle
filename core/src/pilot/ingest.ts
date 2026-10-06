// Piloto com eventos atestados pelo operador (contrato: adendo "piloto e copiloto", 06/10/2026).
//
// Entrada: lotes assinados de linhas pseudonimizadas exportadas da plataforma multiloja (ver docs/pilot.md).
// Cada linha vira um evento durável (attested_events) e é aplicada ao núcleo pelos MESMOS caminhos dos
// provedores reais (applyObservation -> pedido pago -> liquidação -> recibo), com o provedor 'attested'.
// As exceções nascem aqui e vão para o copiloto (copilot/judge.ts).
import { randomBytes, createHash } from 'node:crypto'
import { withTx, recordTransition, type Tx } from '../db.js'
import { newId } from '../ids.js'
import type { Ctx } from '../context.js'
import { applyObservation } from '../flows/events.js'
import type { ProviderPayment } from '../providers/types.js'
import { guardLine, toMinor, type AttestedLine } from './guard.js'
import { openException } from '../copilot/judge.js'
import type { Evidence, ExceptionKind } from '../copilot/verdict.js'
import type { ExceptionFacts } from '../copilot/rules.js'

export const PROVISIONAL_TTL_MS = 60 * 60_000
export const NO_EXPIRY_HORIZON_MS = 30 * 86_400_000
const PAID_STATES = ['paid', 'settling', 'settled', 'refunded', 'late_paid']
const UNPAID_STATES = ['created', 'awaiting_payment', 'expired']
export const DEFER_MAX = 5

export type IngestResult = { accepted: number; duplicates: number; rejected: Array<{ index: number; reason: string }>; ids: number[] }

/** Grava o lote (dedupe por chave canônica). Linha recusada pelo guarda não entra e volta com o motivo. */
export async function ingestBatch(ctx: Ctx, sourceId: string, batchId: string, lines: unknown[]): Promise<IngestResult> {
  const out: IngestResult = { accepted: 0, duplicates: 0, rejected: [], ids: [] }
  const good: Array<{ line: AttestedLine; key: string }> = []
  lines.forEach((raw, i) => { const g = guardLine(raw); if (g.ok) good.push(g); else out.rejected.push({ index: i, reason: g.reason }) })
  if (!good.length) return out
  await withTx(ctx.db, async tx => {
    await tx.query(`INSERT INTO pilot_sources (id, label) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING`, [sourceId])
    for (const g of good) {
      const r = await tx.query(
        `INSERT INTO attested_events (source_id, batch_id, event_key, ev, ts, store_code, ord, payload, processing_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received') ON CONFLICT (event_key) DO NOTHING RETURNING id`,
        [sourceId, batchId, g.key, g.line.ev, g.line.ts ?? null, g.line.store, g.line.ord ?? null, JSON.stringify(g.line)])
      if (r.rows[0]) { out.accepted++; out.ids.push(Number(r.rows[0].id)) } else out.duplicates++
    }
  })
  return out
}

/** Processa eventos pendentes (received/deferred/error) em ordem de chegada; cada um na própria transação. */
export async function processPending(ctx: Ctx, sourceId: string, limit = 1000): Promise<{ processed: number; deferred: number; unmapped: number; ignored: number; errors: number }> {
  const tally = { processed: 0, deferred: 0, unmapped: 0, ignored: 0, errors: 0 }
  for (let pass = 0; pass < 3; pass++) {
    const rows = (await ctx.db.query(
      `SELECT id FROM attested_events WHERE source_id=$1 AND processing_state IN ('received','deferred','error') ORDER BY id LIMIT $2`, [sourceId, limit])).rows
    if (!rows.length) break
    let progressed = false
    for (const r of rows) {
      const st = await processOne(ctx, Number(r.id))
      if (st === 'processed' || st === 'ignored' || st === 'unmapped') progressed = true
      tally[st === 'processed' ? 'processed' : st === 'ignored' ? 'ignored' : st === 'unmapped' ? 'unmapped' : st === 'deferred' ? 'deferred' : 'errors']++
    }
    if (!progressed) break
  }
  return tally
}

type Outcome = 'processed' | 'ignored' | 'deferred' | 'unmapped' | 'error'

export async function processOne(ctx: Ctx, eventId: number): Promise<Outcome> {
  try {
    return await withTx(ctx.db, async tx => {
      const e = (await tx.query(`SELECT * FROM attested_events WHERE id=$1 FOR UPDATE`, [eventId])).rows[0]
      if (!e || !['received', 'deferred', 'error'].includes(e.processing_state)) return 'ignored'
      await tx.query(`UPDATE attested_events SET attempts=attempts+1 WHERE id=$1`, [eventId])
      const res = await applyAttested(tx, ctx, e)
      const state: Outcome = res.state
      if (state === 'deferred' && e.attempts + 1 >= DEFER_MAX) {
        await tx.query(`UPDATE attested_events SET processing_state='unmapped', result=$2, processed_at=now() WHERE id=$1`, [eventId, JSON.stringify({ ...res.result, reason: `adiado ${DEFER_MAX}x: ${res.result.reason ?? 'dependência ausente'}` })])
        return 'unmapped'
      }
      await tx.query(`UPDATE attested_events SET processing_state=$2, result=$3, last_error=NULL, processed_at=CASE WHEN $2 IN ('processed','ignored','unmapped') THEN now() ELSE NULL END WHERE id=$1`,
        [eventId, state, JSON.stringify(res.result)])
      return state
    })
  } catch (err) {
    await ctx.db.query(`UPDATE attested_events SET processing_state='error', last_error=$2 WHERE id=$1`, [eventId, JSON.stringify({ message: (err as Error).message, at: new Date().toISOString() })])
    return 'error'
  }
}

// ---------- lojistas do piloto ----------

async function merchantForStore(tx: Tx, ctx: Ctx, sourceId: string, code: string, storeType = ''): Promise<string> {
  const r = (await tx.query(`SELECT merchant_id FROM pilot_stores WHERE source_id=$1 AND code=$2`, [sourceId, code])).rows[0]
  if (r) return r.merchant_id
  const id = newId('mer')
  await tx.query(`INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ($1,$2,$3,$4)`,
    [id, `Pilot: ${code}`, createHash('sha256').update(randomBytes(32)).digest('hex'), ctx.cfg.pilotPayoutAddress])
  await tx.query(`INSERT INTO pilot_stores (source_id, code, store_type, merchant_id) VALUES ($1,$2,$3,$4)`, [sourceId, code, storeType, id])
  return id
}

async function orderOf(tx: Tx, merchantId: string, ord: string | null) {
  if (!ord) return null
  return (await tx.query(`SELECT * FROM orders WHERE merchant_id=$1 AND external_ref=$2 FOR UPDATE`, [merchantId, ord])).rows[0] ?? null
}

type Applied = { state: Outcome; result: Record<string, unknown> & { reason?: string } }
const ignored = (reason: string): Applied => ({ state: 'ignored', result: { reason } })
const deferred = (reason: string): Applied => ({ state: 'deferred', result: { reason } })
const unmapped = (reason: string): Applied => ({ state: 'unmapped', result: { reason } })

/** Aplica UM evento ao núcleo. Dependência ausente adia; evento irrelevante é ignorado com motivo. */
export async function applyAttested(tx: Tx, ctx: Ctx, e: any): Promise<Applied> {
  const l = e.payload as AttestedLine
  const ev = String(l.ev)
  const ts = l.ts ? new Date(String(l.ts)) : null
  const source = `attested:${ev}`
  const merchantId = await merchantForStore(tx, ctx, e.source_id, e.store_code)
  const amt = toMinor(l.amt as string | null)

  if (ev === 'order.created') {
    if (!l.ord) return unmapped('order.created sem ord')
    if (amt === null || amt <= 0n) return ignored(`pedido sem valor positivo (amt=${String(l.amt)})`)
    const ex = await orderOf(tx, merchantId, l.ord as string)
    if (ex) return ignored('pedido já existe')
    const orderId = newId('ord'), quoteId = newId('quo')
    const created = ts ?? ctx.now()
    const expires = new Date(created.getTime() + PROVISIONAL_TTL_MS)
    await tx.query(
      `INSERT INTO orders (id, merchant_id, external_ref, description, amount_minor, status, expires_at, provider_env, chain_env, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'awaiting_payment',$6,'attested','testnet',$7,$7)`,
      [orderId, merchantId, l.ord, `pilot ${String(l.src ?? '')} ${String(l.meth ?? '')}`.trim(), amt.toString(), expires, created])
    await tx.query(`INSERT INTO quotes (id, order_id, rate_num, rate_den, source, valid_until) VALUES ($1,$2,$3,$4,'simulated',$5)`,
      [quoteId, orderId, ctx.cfg.pilotRateNum.toString(), ctx.cfg.pilotRateDen.toString(), expires])
    await recordTransition(tx, 'order', orderId, null, 'awaiting_payment', source, `pedido atestado pela loja ${e.store_code}`)
    return { state: 'processed', result: { order_id: orderId } }
  }

  // Tudo abaixo que depende de pedido:
  const needsOrder = ['pix.charge.created', 'pix.received', 'pix.duplicate', 'pix.charge.expired', 'pix.charge.failed', 'pix.charge.cancelled', 'pix.charge.refunded',
    'order.refund.requested', 'order.refund.pending', 'order.refund.completed', 'order.refund.rejected', 'order.cancelled', 'med.reported', 'med.handled',
    'manual.charge.confirmed', 'manual.charge.divergent']
  if (needsOrder.includes(ev)) {
    if (!l.ord) return unmapped(`${ev} sem ord`)
    const order = await orderOf(tx, merchantId, l.ord as string)
    if (!order) return deferred(`pedido ${l.ord} ainda não visto`)
    return applyOrderEvent(tx, ctx, e, l, ev, ts, order, merchantId, source)
  }
  if (ev === 'wallet.withdrawal.failed') {
    return openWithdrawalException(tx, ctx, e, l, 'withdrawal_failed', merchantId, ts, source)
  }
  if (ev === 'wallet.move.withdrawal_reversal') {
    return openWithdrawalException(tx, ctx, e, l, 'withdrawal_reversal', merchantId, ts, source)
  }
  if (ev.startsWith('wallet.') || ev.startsWith('order.return.') || ev.startsWith('pix.tx.') || ev.startsWith('manual.charge.')) {
    return ignored('evento só estatístico (contado no painel do piloto)')
  }
  return unmapped(`evento desconhecido ${ev}`)
}

async function applyOrderEvent(tx: Tx, ctx: Ctx, e: any, l: AttestedLine, ev: string, ts: Date | null, order: any, merchantId: string, source: string): Promise<Applied> {
  const amt = toMinor(l.amt as string | null)
  const chg = (l.chg as string | null) ?? null
  const exp = l.exp ? new Date(String(l.exp)) : null

  switch (ev) {
    case 'pix.charge.created': {
      if (!chg) return unmapped('cobrança sem chg')
      await tx.query(
        `INSERT INTO pilot_charges (chg, order_id, provider, amount_minor, state, created_at, expires_at) VALUES ($1,$2,$3,$4,'created',$5,$6)
         ON CONFLICT (chg) DO UPDATE SET expires_at=coalesce(EXCLUDED.expires_at, pilot_charges.expires_at), updated_at=now()`,
        [chg, order.id, String(l.prov ?? ''), (amt ?? BigInt(order.amount_minor)).toString(), ts, exp])
      await ensureCoreCharge(tx, order, chg, amt ?? BigInt(order.amount_minor), exp)
      // Sem vencimento informado (trilhos que não expiram a cobrança), a janela de pagamento é o horizonte longo,
      // nunca a hora provisória do pedido: senão todo pagamento normal pareceria atrasado.
      await extendExpiry(tx, order.id, exp ?? new Date((ts ?? ctx.now()).getTime() + NO_EXPIRY_HORIZON_MS))
      const charges = await chargesOf(tx, order.id)
      if (charges.length >= 2) await openDuplicateCharge(tx, ctx, order, merchantId, charges, ts ?? ctx.now(), source)
      return { state: 'processed', result: { charges: charges.length } }
    }
    case 'pix.received': {
      if (!chg) return unmapped('pagamento sem chg')
      const paid = amt ?? BigInt(order.amount_minor)
      await tx.query(
        `INSERT INTO pilot_charges (chg, order_id, provider, amount_minor, state, created_at, paid_at, paid_minor) VALUES ($1,$2,$3,$4,'paid',$5,$5,$6)
         ON CONFLICT (chg) DO UPDATE SET state='paid', paid_at=EXCLUDED.paid_at, paid_minor=EXCLUDED.paid_minor, updated_at=now()`,
        [chg, order.id, String(l.prov ?? ''), paid.toString(), ts, paid.toString()])
      const core = (await tx.query(`SELECT * FROM pix_charges WHERE order_id=$1 FOR UPDATE`, [order.id])).rows[0]
      if (PAID_STATES.includes(order.status) && core?.provider_payment_id !== chg) {
        // Segundo pagamento num pedido já pago: nunca é "stale" aqui; é a exceção mais cara que existe.
        await openDuplicatePayment(tx, ctx, order, merchantId, chg, paid, ts ?? ctx.now(), source, 'second_payment')
        return { state: 'processed', result: { exception: 'duplicate_payment' } }
      }
      if (!core) await ensureCoreCharge(tx, order, chg, paid, exp)
      else if (core.provider_payment_id !== chg && !['received', 'partially_refunded', 'refunded'].includes(core.observed_state ?? '')) {
        await tx.query(`UPDATE pix_charges SET provider_payment_id=$2, amount_minor=$3, updated_at=now() WHERE id=$1`, [core.id, chg, paid.toString()])
      }
      // O operador atesta se o pagamento foi no prazo (late 0/1): a janela conhecida por ele prevalece sobre a nossa estimativa.
      if (ts && l.late === 0 && new Date(order.expires_at).getTime() < ts.getTime()) {
        await tx.query(`UPDATE orders SET expires_at=$2, updated_at=now() WHERE id=$1`, [order.id, ts])
        await tx.query(`UPDATE quotes SET valid_until=GREATEST(valid_until, $2) WHERE order_id=$1`, [order.id, ts])
        await recordTransition(tx, 'order_window', order.id, null, 'extended', source, 'operador atesta pagamento no prazo (late=0); janela estendida até o pagamento')
      } else if (ts && l.late === 1 && new Date(order.expires_at).getTime() >= ts.getTime()) {
        await tx.query(`UPDATE orders SET expires_at=$2, updated_at=now() WHERE id=$1`, [order.id, new Date(ts.getTime() - 1000)])
        await recordTransition(tx, 'order_window', order.id, null, 'shortened', source, 'operador atesta pagamento atrasado (late=1); janela fechada antes do pagamento')
      }
      const p: ProviderPayment = { id: chg, status: 'RECEIVED', rawStatus: 'attested:received', billingType: 'PIX', valueMinor: paid, externalReference: order.id, paidAt: ts, paidDate: null, refundedMinor: 0n }
      const outcome = await applyObservation(tx, ctx, p, source)
      const after = (await tx.query(`SELECT status, hold_reason, expires_at FROM orders WHERE id=$1`, [order.id])).rows[0]
      const result: Record<string, unknown> = { outcome, status: after.status, hold: after.hold_reason }
      if (after.hold_reason === 'amount_mismatch') {
        await openAmountMismatch(tx, ctx, order, merchantId, chg, paid, ts ?? ctx.now(), source)
        result.exception = 'amount_mismatch'
      } else if (after.status === 'late_paid') {
        await openLatePayment(tx, ctx, order, merchantId, chg, paid, ts ?? ctx.now(), new Date(after.expires_at), source)
        result.exception = 'late_payment'
      } else if (PAID_STATES.includes(after.status)) {
        await resolveOpen(tx, ctx, order.id, ['charge_failed', 'expired_unpaid'], 'close_superseded', 'superseded by a paid charge', source)
      }
      await refreshDuplicateCharge(tx, ctx, order, merchantId, ts ?? ctx.now(), source)
      return { state: 'processed', result }
    }
    case 'pix.duplicate': {
      if (!chg) return unmapped('duplicata sem chg')
      await openDuplicatePayment(tx, ctx, order, merchantId, chg, amt ?? BigInt(order.amount_minor), ts ?? ctx.now(), source, 'store_detected', l.handled ? String(l.handled) : null)
      return { state: 'processed', result: { exception: 'duplicate_payment' } }
    }
    case 'pix.charge.expired':
    case 'pix.charge.failed':
    case 'pix.charge.cancelled': {
      const st = ev.split('.')[2] as 'expired' | 'failed' | 'cancelled'
      if (chg) await tx.query(
        `INSERT INTO pilot_charges (chg, order_id, provider, amount_minor, state, created_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (chg) DO UPDATE SET state=CASE WHEN pilot_charges.state='paid' THEN pilot_charges.state ELSE EXCLUDED.state END, updated_at=now()`,
        [chg, order.id, String(l.prov ?? ''), (amt ?? BigInt(order.amount_minor)).toString(), st, ts])
      await refreshDuplicateCharge(tx, ctx, order, merchantId, ts ?? ctx.now(), source)
      if (st === 'cancelled') return { state: 'processed', result: { charge: st } }
      if (!UNPAID_STATES.includes(order.status)) return { state: 'processed', result: { charge: st, note: 'pedido já pago' } }
      const charges = await chargesOf(tx, order.id)
      if (charges.some(c => c.state === 'created' && c.chg !== chg)) return { state: 'processed', result: { charge: st, note: 'outra cobrança ainda aberta' } }
      await openUnpaidException(tx, ctx, order, merchantId, st === 'expired' ? 'expired_unpaid' : 'charge_failed', charges, ts ?? ctx.now(), source)
      return { state: 'processed', result: { charge: st, exception: st === 'expired' ? 'expired_unpaid' : 'charge_failed' } }
    }
    case 'pix.charge.refunded': {
      if (chg) await tx.query(`UPDATE pilot_charges SET state='refunded', updated_at=now() WHERE chg=$1`, [chg])
      const core = (await tx.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [order.id])).rows[0]
      if (!core || (chg && core.provider_payment_id !== chg)) return { state: 'processed', result: { note: 'cobrança reembolsada não é a cobrança paga do pedido' } }
      if (!PAID_STATES.includes(order.status)) return { state: 'processed', result: { note: 'reembolso de cobrança sem pagamento registrado' } }
      return applyRefundObserved(tx, ctx, order, core.provider_payment_id, amt ?? BigInt(order.amount_minor), ts, source)
    }
    case 'order.refund.requested':
    case 'order.refund.pending': {
      if (!PAID_STATES.includes(order.status)) return ignored(`devolução pedida com pedido em ${order.status}`)
      const open = (await tx.query(`SELECT id FROM refund_cases WHERE order_id=$1 AND state IN ('requested','submitting','unknown')`, [order.id])).rows[0]
      let caseId = open?.id
      if (!caseId) {
        caseId = newId('rfc')
        await tx.query(`INSERT INTO refund_cases (id, order_id, refund_type, state, amount_minor) VALUES ($1,$2,'merchant_refund','requested',$3)`, [caseId, order.id, (amt ?? BigInt(order.amount_minor)).toString()])
        await recordTransition(tx, 'refund_case', caseId, null, 'requested', source, 'devolução pedida na loja (atestado)')
      }
      await openException(tx, ctx, {
        merchantId, orderId: order.id, kind: 'refund_requested', fingerprint: `rfq:${order.id}`, detectedAt: ts ?? ctx.now(), source,
        summary: `Refund requested on a paid order (${fmt(amt ?? BigInt(order.amount_minor))})`,
        facts: { kind: 'refund_requested', store: e.store_code, order: orderFacts(order), refund: { amount_minor: (amt ?? BigInt(order.amount_minor)).toString(), state: ev.split('.')[2]!, how: String(l.how ?? '') }, context: { paid_at: order.paid_at ? new Date(order.paid_at).toISOString() : null, status: order.status } },
        evidence: [
          ev1(`order ${order.external_ref} is ${order.status}, amount ${fmt(BigInt(order.amount_minor))}, paid at ${iso(order.paid_at)}`),
          ev2(`refund ${ev.split('.')[2]} by the store at ${iso(ts)} for ${fmt(amt ?? BigInt(order.amount_minor))}`),
        ],
      })
      return { state: 'processed', result: { refund_case: caseId, exception: 'refund_requested' } }
    }
    case 'order.refund.completed': {
      const core = (await tx.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [order.id])).rows[0]
      if (!core?.provider_payment_id || !PAID_STATES.includes(order.status)) return ignored(`devolução concluída sem pagamento registrado (pedido ${order.status})`)
      const r = await applyRefundObserved(tx, ctx, order, core.provider_payment_id, amt ?? BigInt(order.amount_minor), ts, source)
      await resolveOpen(tx, ctx, order.id, ['refund_requested'], 'approve_refund', 'refund completed by the store', source)
      return r
    }
    case 'order.refund.rejected': {
      const open = (await tx.query(`SELECT id, state FROM refund_cases WHERE order_id=$1 AND state='requested' AND refund_type='merchant_refund'`, [order.id])).rows[0]
      if (open) {
        await tx.query(`UPDATE refund_cases SET state='failed', observed_at=$2, updated_at=now() WHERE id=$1`, [open.id, ts ?? ctx.now()])
        await recordTransition(tx, 'refund_case', open.id, 'requested', 'failed', source, 'devolução rejeitada na loja (atestado)')
      }
      await resolveOpen(tx, ctx, order.id, ['refund_requested'], 'reject_refund', 'refund rejected by the store', source)
      return { state: 'processed', result: { refund_case: open?.id ?? null } }
    }
    case 'order.cancelled': {
      if (UNPAID_STATES.includes(order.status) && order.status !== 'expired') {
        await tx.query(`UPDATE orders SET status='expired', updated_at=now() WHERE id=$1`, [order.id])
        await recordTransition(tx, 'order', order.id, order.status, 'expired', source, `cancelado na loja por ${String(l.by ?? '?')} (atestado)`)
        await tx.query(`UPDATE pilot_charges SET state='cancelled', updated_at=now() WHERE order_id=$1 AND state='created'`, [order.id])
        await resolveOpen(tx, ctx, order.id, ['expired_unpaid', 'charge_failed', 'duplicate_charge'], 'close_expired', 'order cancelled unpaid', source)
        return { state: 'processed', result: { status: 'expired' } }
      }
      return { state: 'processed', result: { note: `cancelamento registrado com pedido em ${order.status}` } }
    }
    case 'med.reported': {
      const amount = amt ?? BigInt(order.amount_minor)
      const open = (await tx.query(`SELECT id FROM refund_cases WHERE order_id=$1 AND refund_type='med_attested' AND state='requested'`, [order.id])).rows[0]
      let caseId = open?.id
      if (!caseId && amount > 0n) {
        caseId = newId('rfc')
        await tx.query(`INSERT INTO refund_cases (id, order_id, refund_type, state, amount_minor, observed_at) VALUES ($1,$2,'med_attested','requested',$3,$4)`, [caseId, order.id, amount.toString(), ts ?? ctx.now()])
        await recordTransition(tx, 'refund_case', caseId, null, 'requested', source, 'MED registrado pela loja (atestado, real)')
      }
      const days = order.paid_at && ts ? Math.round((ts.getTime() - new Date(order.paid_at).getTime()) / 86_400_000) : null
      await openException(tx, ctx, {
        merchantId, orderId: order.id, kind: 'med_reported', fingerprint: `med:${order.id}:${l.ts ?? 'x'}`, detectedAt: ts ?? ctx.now(), source,
        summary: `MED (payer dispute) reported for ${fmt(amount)}${days !== null ? `, ${days} days after payment` : ''}`,
        facts: { kind: 'med_reported', store: e.store_code, order: orderFacts(order), med: { amount_minor: amount.toString(), reported_at: iso(ts), status: String(l.st ?? 'open'), order_status: order.status, days_since_payment: days } },
        evidence: [
          ev1(`order ${order.external_ref} is ${order.status}, amount ${fmt(BigInt(order.amount_minor))}, paid at ${iso(order.paid_at)}`),
          ev2(`MED reported at ${iso(ts)} for ${fmt(amount)}; the payer's bank can claw back a Pix for up to 80 days`),
          ev3(days !== null ? `${days} days elapsed between payment and the dispute` : 'payment date unknown'),
        ],
      })
      return { state: 'processed', result: { refund_case: caseId ?? null, exception: 'med_reported' } }
    }
    case 'med.handled': {
      const n = await resolveOpen(tx, ctx, order.id, ['med_reported'], 'operator_handled', 'MED handled by the store (outcome not attested)', source)
      return { state: 'processed', result: { resolved: n } }
    }
    case 'manual.charge.confirmed':
    case 'manual.charge.divergent': {
      const rcv = toMinor(l.rcv as string | null)
      const expected = amt ?? BigInt(order.amount_minor)
      if (ev.endsWith('divergent') || (rcv !== null && rcv !== expected)) {
        await openException(tx, ctx, {
          merchantId, orderId: order.id, kind: 'manual_divergent', fingerprint: `man:${order.id}:${chg ?? l.ts ?? 'x'}`, detectedAt: ts ?? ctx.now(), source,
          summary: `Manual Pix (payer self-identified) received ${rcv === null ? 'an unknown amount' : fmt(rcv)} against ${fmt(expected)}`,
          facts: { kind: 'manual_divergent', store: e.store_code, order: orderFacts(order), manual: { amount_minor: expected.toString(), received_minor: rcv === null ? null : rcv.toString(), status: ev.split('.')[2]! } },
          evidence: [
            ev1(`order ${order.external_ref} is ${order.status}, amount ${fmt(BigInt(order.amount_minor))}`),
            ev2(`manual charge ${ev.split('.')[2]} at ${iso(ts)}: expected ${fmt(expected)}, received ${rcv === null ? 'unknown' : fmt(rcv)}`),
            ev3('the payer identified themselves in the link; there is no end-to-end id linking the transfer to the order'),
          ],
        })
        return { state: 'processed', result: { exception: 'manual_divergent' } }
      }
      return ignored('cobrança manual confirmada com o valor certo: o pagamento entra pelo evento pix.received, se houver')
    }
    default:
      return unmapped(`evento de pedido desconhecido ${ev}`)
  }
}

// ---------- apoio ----------

async function ensureCoreCharge(tx: Tx, order: any, chg: string, amount: bigint, exp: Date | null) {
  const ex = (await tx.query(`SELECT id, observed_state, provider_payment_id FROM pix_charges WHERE order_id=$1 FOR UPDATE`, [order.id])).rows[0]
  if (!ex) {
    await tx.query(
      `INSERT INTO pix_charges (id, order_id, provider, provider_payment_id, creation_state, observed_state, amount_minor, qr_expires_at, created_at, updated_at)
       VALUES ($1,$2,'attested',$3,'created','created',$4,$5,now(),now())`, [newId('chg'), order.id, chg, amount.toString(), exp])
    return
  }
  if (!['received', 'partially_refunded', 'refunded'].includes(ex.observed_state ?? '') && ex.provider_payment_id !== chg) {
    await tx.query(`UPDATE pix_charges SET provider_payment_id=$2, qr_expires_at=coalesce($3, qr_expires_at), updated_at=now() WHERE id=$1`, [ex.id, chg, exp])
  }
}

/** O prazo do pedido é o maior vencimento entre as cobranças (uma cobrança nova reabre a janela de pagamento). */
async function extendExpiry(tx: Tx, orderId: string, exp: Date) {
  await tx.query(`UPDATE orders SET expires_at=GREATEST(expires_at, $2), updated_at=now() WHERE id=$1 AND status IN ('created','awaiting_payment','expired')`, [orderId, exp])
  await tx.query(`UPDATE quotes SET valid_until=GREATEST(valid_until, $2) WHERE order_id=$1`, [orderId, exp])
}

async function chargesOf(tx: Tx, orderId: string) {
  return (await tx.query(`SELECT chg, provider, amount_minor::text, state, created_at, expires_at, paid_at, paid_minor::text FROM pilot_charges WHERE order_id=$1 ORDER BY created_at NULLS LAST, chg`, [orderId])).rows
}

async function applyRefundObserved(tx: Tx, ctx: Ctx, order: any, paymentId: string, refunded: bigint, ts: Date | null, source: string): Promise<Applied> {
  const total = BigInt(order.amount_minor)
  const p: ProviderPayment = {
    id: paymentId, status: refunded >= total ? 'REFUNDED' : 'PARTIALLY_REFUNDED', rawStatus: 'attested:refunded', billingType: 'PIX',
    valueMinor: total, externalReference: order.id, paidAt: order.paid_at ? new Date(order.paid_at) : null, paidDate: null, refundedMinor: refunded > total ? total : refunded,
  }
  const outcome = await applyObservation(tx, ctx, p, source)
  if (ts) await tx.query(`UPDATE refund_cases SET observed_at=coalesce(observed_at,$2) WHERE order_id=$1 AND state='confirmed'`, [order.id, ts])
  return { state: 'processed', result: { outcome, refunded: refunded.toString() } }
}

/** Encerra pelo sistema (fato posterior) as exceções abertas dos tipos dados. Devolve quantas. */
async function resolveOpen(tx: Tx, ctx: Ctx, orderId: string, kinds: string[], action: string, note: string, source: string): Promise<number> {
  const rows = (await tx.query(`SELECT id, status FROM exceptions WHERE order_id=$1 AND kind = ANY($2) AND status IN ('open','auto_applied','awaiting_human') FOR UPDATE`, [orderId, kinds])).rows
  for (const r of rows) {
    await tx.query(`UPDATE exceptions SET status='resolved', resolution=$2, resolved_at=now(), updated_at=now() WHERE id=$1`,
      [r.id, JSON.stringify({ action, by: 'system', note, at: ctx.now().toISOString() })])
    await recordTransition(tx, 'exception', r.id, r.status, 'resolved', source, `${action}: ${note}`)
  }
  return rows.length
}

const fmt = (minor: bigint) => `R$ ${(Number(minor) / 100).toFixed(2)}`
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : 'unknown')
const ev1 = (fact: string): Evidence => ({ id: 'e1', fact })
const ev2 = (fact: string): Evidence => ({ id: 'e2', fact })
const ev3 = (fact: string): Evidence => ({ id: 'e3', fact })
async function storeCodeOf(tx: Tx, merchantId: string): Promise<string> {
  return (await tx.query(`SELECT code FROM pilot_stores WHERE merchant_id=$1`, [merchantId])).rows[0]?.code ?? 'demo'
}
const orderFacts = (o: any): ExceptionFacts['order'] => ({ amount_minor: String(o.amount_minor), status: o.status, created_at: iso(o.created_at), expires_at: iso(o.expires_at), paid_at: o.paid_at ? iso(o.paid_at) : null })
const chargeFacts = (rows: any[]): NonNullable<ExceptionFacts['charges']> => rows.map(c => ({ chg: c.chg, state: c.state, amount_minor: c.amount_minor, created_at: c.created_at ? iso(c.created_at) : null, expires_at: c.expires_at ? iso(c.expires_at) : null, paid_at: c.paid_at ? iso(c.paid_at) : null, paid_minor: c.paid_minor ?? null, provider: c.provider }))

/** Estado de cobrança mudou: se há exceção duplicate_charge aberta, os fatos e o julgamento são refeitos. */
async function refreshDuplicateCharge(tx: Tx, ctx: Ctx, order: any, merchantId: string, at: Date, source: string) {
  const open = (await tx.query(`SELECT 1 FROM exceptions WHERE fingerprint=$1 AND status NOT IN ('resolved','dismissed')`, [`dupchg:${order.id}`])).rowCount
  if (!open) return
  const charges = await chargesOf(tx, order.id)
  const fresh = (await tx.query(`SELECT * FROM orders WHERE id=$1`, [order.id])).rows[0]
  await openDuplicateCharge(tx, ctx, fresh, merchantId, charges, at, source)
}

async function openDuplicateCharge(tx: Tx, ctx: Ctx, order: any, merchantId: string, charges: any[], at: Date, source: string) {
  const store = await storeCodeOf(tx, merchantId)
  const evidence: Evidence[] = charges.map((c, i) => ({ id: `e${i + 1}`, fact: `charge ${c.chg} (${c.provider || 'pix'}) ${c.state}, ${fmt(BigInt(c.amount_minor))}, created ${iso(c.created_at)}${c.paid_at ? `, paid ${iso(c.paid_at)}` : ''}` }))
  await openException(tx, ctx, {
    merchantId, orderId: order.id, kind: 'duplicate_charge', fingerprint: `dupchg:${order.id}`, detectedAt: at, source,
    summary: `${charges.length} Pix charges created for one order (${charges.filter(c => c.state === 'paid').length} paid)`,
    facts: { kind: 'duplicate_charge', store, order: orderFacts(order), charges: chargeFacts(charges) }, evidence,
  })
}

async function openDuplicatePayment(tx: Tx, ctx: Ctx, order: any, merchantId: string, chg: string, paid: bigint, at: Date, source: string, how: string, handled: string | null = null) {
  const store = await storeCodeOf(tx, merchantId)
  const charges = await chargesOf(tx, order.id)
  const core = (await tx.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [order.id])).rows[0]
  const evidence: Evidence[] = [
    ev1(`order ${order.external_ref} was already ${order.status} (${fmt(BigInt(order.amount_minor))}) through charge ${core?.provider_payment_id ?? '?'}, paid at ${iso(order.paid_at)}`),
    ev2(`a second payment of ${fmt(paid)} arrived at ${iso(at)} on charge ${chg} (${how === 'store_detected' ? 'flagged by the store system' : 'seen in the attested stream'})`),
    ev3(handled ? `the store marked it handled at ${handled}` : 'the store has not marked it handled'),
  ]
  await openException(tx, ctx, {
    merchantId, orderId: order.id, kind: 'duplicate_payment', fingerprint: `duppay:${order.id}:${chg}`, detectedAt: at, source,
    summary: `Order paid twice: second payment of ${fmt(paid)} on charge ${chg}`,
    facts: { kind: 'duplicate_payment', store, order: orderFacts(order), charges: chargeFacts(charges), payment: { chg, amount_minor: paid.toString(), paid_at: iso(at), expected_minor: String(order.amount_minor) }, context: { detection: how, handled_at: handled } },
    evidence,
  })
}

async function openAmountMismatch(tx: Tx, ctx: Ctx, order: any, merchantId: string, chg: string, paid: bigint, at: Date, source: string) {
  const store = await storeCodeOf(tx, merchantId)
  const expected = BigInt(order.amount_minor)
  const diff = paid - expected
  const evidence: Evidence[] = [
    ev1(`order ${order.external_ref} expects ${fmt(expected)}, created ${iso(order.created_at)}, charge window until ${iso(order.expires_at)}`),
    ev2(`payment of ${fmt(paid)} received at ${iso(at)} on charge ${chg}: ${diff < 0n ? `${fmt(-diff)} short` : `${fmt(diff)} over`}`),
    ev3('the order is on hold (amount_mismatch); no settlement was started'),
  ]
  await openException(tx, ctx, {
    merchantId, orderId: order.id, kind: 'amount_mismatch', fingerprint: `amt:${order.id}:${chg}`, detectedAt: at, source,
    summary: `Payment ${diff < 0n ? 'under' : 'over'} the order amount: ${fmt(paid)} vs ${fmt(expected)}`,
    facts: { kind: 'amount_mismatch', store, order: orderFacts(order), payment: { chg, amount_minor: paid.toString(), paid_at: iso(at), expected_minor: expected.toString() }, charges: chargeFacts(await chargesOf(tx, order.id)) },
    evidence,
  })
}

async function openLatePayment(tx: Tx, ctx: Ctx, order: any, merchantId: string, chg: string, paid: bigint, at: Date, expiresAt: Date, source: string) {
  const store = await storeCodeOf(tx, merchantId)
  const lateMs = at.getTime() - expiresAt.getTime()
  const evidence: Evidence[] = [
    ev1(`order ${order.external_ref} (${fmt(BigInt(order.amount_minor))}) could be paid until ${expiresAt.toISOString()}`),
    ev2(`payment of ${fmt(paid)} arrived at ${iso(at)}, ${Math.round(lateMs / 60_000)} minutes after the window closed, on charge ${chg}`),
    ev3('a late_payment_refund case was opened by the core; the merchant may instead accept the late payment'),
  ]
  await openException(tx, ctx, {
    merchantId, orderId: order.id, kind: 'late_payment', fingerprint: `late:${order.id}:${chg}`, detectedAt: at, source,
    summary: `Paid ${Math.round(lateMs / 60_000)} min after the charge expired`,
    facts: { kind: 'late_payment', store, order: orderFacts(order), payment: { chg, amount_minor: paid.toString(), paid_at: iso(at), expected_minor: String(order.amount_minor) }, context: { late_minutes: Math.round(lateMs / 60_000) } },
    evidence,
  })
}

async function openUnpaidException(tx: Tx, ctx: Ctx, order: any, merchantId: string, kind: 'expired_unpaid' | 'charge_failed', charges: any[], at: Date, source: string) {
  const store = await storeCodeOf(tx, merchantId)
  const evidence: Evidence[] = [
    ev1(`order ${order.external_ref} (${fmt(BigInt(order.amount_minor))}) is ${order.status}; no payment received`),
    ev2(`charges: ${charges.map(c => `${c.chg} ${c.state}`).join('; ') || 'none'}`),
  ]
  await openException(tx, ctx, {
    merchantId, orderId: order.id, kind, fingerprint: `${kind}:${order.id}`, detectedAt: at, source,
    summary: kind === 'expired_unpaid' ? 'Charge expired without payment' : 'Charge failed at the provider without payment',
    facts: { kind, store, order: orderFacts(order), charges: chargeFacts(charges) }, evidence,
  })
}

async function openWithdrawalException(tx: Tx, ctx: Ctx, e: any, l: AttestedLine, kind: 'withdrawal_failed' | 'withdrawal_reversal', merchantId: string, ts: Date | null, source: string): Promise<Applied> {
  const amount = toMinor(l.amt as string | null), fee = toMinor(l.fee as string | null)
  const key = (l.wd as string | null) ?? e.event_key.slice(0, 16)
  const evidence: Evidence[] = [
    ev1(`${kind === 'withdrawal_failed' ? 'withdrawal failed' : 'withdrawal reversed'} at ${iso(ts)} for ${amount === null ? 'unknown amount' : fmt(amount)}${fee !== null ? ` (fee ${fmt(fee)})` : ''}`),
    ev2(`source ${String(l.src ?? l.dir ?? '')}, rail ${String(l.prov ?? '')}, requested ${l.req ? String(l.req) : 'unknown'}`),
  ]
  await openException(tx, ctx, {
    merchantId, orderId: null, kind, fingerprint: `${kind}:${key}`, detectedAt: ts ?? ctx.now(), source,
    summary: kind === 'withdrawal_failed' ? `Withdrawal failed (${amount === null ? '?' : fmt(amount)})` : `Withdrawal reversed back to balance (${amount === null ? '?' : fmt(amount)})`,
    facts: { kind, store: e.store_code, withdrawal: { amount_minor: amount?.toString() ?? null, fee_minor: fee?.toString() ?? null, state: kind === 'withdrawal_failed' ? 'failed' : 'reversed', source: String(l.src ?? ''), provider: String(l.prov ?? '') } },
    evidence,
  })
  return { state: 'processed', result: { exception: kind } }
}

export type { ExceptionKind }
