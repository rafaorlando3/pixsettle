// Devoluções (contrato 3.3, 3.6 e 6): pedido, execução no provedor, confirmação observada,
// contabilidade da reserva SIMULADA e recibo refund_notice ligado ao anterior.
import { withTx, txLock, recordTransition, enqueue, type Tx } from '../db.js'
import { newId } from '../ids.js'
import { ProviderError, type ProviderPayment } from '../providers/types.js'
import type { Ctx } from '../context.js'
import { DomainError } from './orders.js'
import { applyObservation } from './events.js'
import { verifyEnvelope, type ReceiptEnvelope } from '../../../settlement/src/receipt.js'

const ACTIVE_ATTEMPT = ['nonce_reserved', 'signed', 'suspended', 'broadcast_pending', 'broadcast_sent', 'unknown', 'manual_review']
const OPEN = ['requested', 'submitting', 'unknown']
const COUNTED = ['requested', 'submitting', 'unknown', 'confirmed', 'partial']

export type RefundRequest = { type: 'merchant_refund' | 'med_simulated'; amountMinor: bigint; simulationReason?: string; source: string }
export type RefundResult = { ok: true; refundCaseId: string } | { ok: false; code: string; message: string; httpStatus: number }

/**
 * Abre um caso de devolução. Exclusão nos dois sentidos (3.6): com tentativa de liquidação ativa
 * (inclusive manual_review) o pedido é recusado com motivo registrado; com caso aberto, a liquidação não assina.
 */
export async function requestRefund(ctx: Ctx, merchantId: string, orderId: string, r: RefundRequest): Promise<RefundResult> {
  if (r.type === 'med_simulated' && !r.simulationReason) throw new DomainError('simulation_reason_required', 'med_simulated exige simulation_reason')
  if (r.amountMinor <= 0n) return { ok: false, code: 'invalid_amount', message: 'valor deve ser positivo', httpStatus: 422 }
  return withTx(ctx.db, async tx => {
    const o = (await tx.query(`SELECT * FROM orders WHERE id=$1 AND merchant_id=$2 FOR UPDATE`, [orderId, merchantId])).rows[0]
    if (!o) return { ok: false, code: 'not_found', message: 'pedido não encontrado', httpStatus: 404 }
    const refuse = async (code: string, message: string, httpStatus = 409): Promise<RefundResult> => {
      await recordTransition(tx, 'refund_blocked', o.id, null, code, r.source, message)
      return { ok: false, code, message, httpStatus }
    }
    if (!['paid', 'settling', 'settled'].includes(o.status)) return refuse('not_refundable', `pedido em ${o.status}`)
    const s = (await tx.query(`SELECT * FROM settlements WHERE order_id=$1 FOR UPDATE`, [o.id])).rows[0]
    if (s) {
      const act = (await tx.query(`SELECT id, status FROM settlement_attempts WHERE settlement_id=$1 AND status = ANY($2)`, [s.id, ACTIVE_ATTEMPT])).rows[0]
      if (act) return refuse('settlement_in_flight', `liquidação ${s.id} com tentativa ${act.id} em ${act.status}; estorno só depois de resultado conclusivo`)
      if (s.status === 'manual_review') return refuse('settlement_in_flight', `liquidação ${s.id} em manual_review`)
    }
    const open = (await tx.query(`SELECT id FROM refund_cases WHERE order_id=$1 AND state = ANY($2)`, [o.id, OPEN])).rows[0]
    if (open) return refuse('refund_in_progress', `caso ${open.id} ainda sem resultado`)
    const used = BigInt((await tx.query(`SELECT coalesce(sum(amount_minor),0)::text AS v FROM refund_cases WHERE order_id=$1 AND state = ANY($2)`, [o.id, COUNTED])).rows[0].v)
    const left = BigInt(o.amount_minor) - used
    if (r.amountMinor > left) return refuse('amount_exceeds_refundable', `pedido ${r.amountMinor}, disponível ${left}`, 422)
    const settledOnChain = s?.status === 'confirmed'
    if (!settledOnChain && r.amountMinor !== BigInt(o.amount_minor)) return refuse('partial_before_settlement', 'antes da liquidação só devolução total (a intenção on-chain é imutável)')
    const id = newId('rfc')
    await tx.query(`INSERT INTO refund_cases (id, order_id, refund_type, state, amount_minor, simulation_reason) VALUES ($1,$2,$3,'requested',$4,$5)`,
      [id, o.id, r.type, r.amountMinor.toString(), r.simulationReason ?? null])
    await recordTransition(tx, 'refund_case', id, null, 'requested', r.source, r.type === 'med_simulated' ? `SIMULADO: ${r.simulationReason}` : r.type)
    await enqueue(tx, 'request_refund', id)
    return { ok: true, refundCaseId: id }
  })
}

/**
 * Job request_refund (revisão R4): execução e observação separadas de forma durável.
 * 1. Sob a trava do caso, `requested -> submitting` é gravado ANTES de chamar o provedor.
 * 2. Só quem fez essa transição chama `refund`, uma única vez.
 * 3. Qualquer retomada que encontre `submitting` (queda, erro na consulta, job repetido) NÃO chama o provedor de novo:
 *    vira `unknown` e a conciliação observa. Sem prova, o caso fica aberto e bloqueando, nunca é reenviado.
 */
export async function executeRefund(ctx: Ctx, refundCaseId: string): Promise<void> {
  const claim = await withTx(ctx.db, async tx => {
    const c = (await tx.query(`SELECT rc.*, pc.provider_payment_id FROM refund_cases rc JOIN pix_charges pc ON pc.order_id=rc.order_id WHERE rc.id=$1 FOR UPDATE OF rc`, [refundCaseId])).rows[0]
    if (!c) return null
    if (c.state === 'submitting') {
      await tx.query(`UPDATE refund_cases SET state='unknown', updated_at=now() WHERE id=$1`, [refundCaseId])
      await recordTransition(tx, 'refund_case', refundCaseId, 'submitting', 'unknown', 'provider_refund', 'retomada depois de possível envio: só observar, nunca repetir o estorno')
      await enqueue(tx, 'reconcile_refund', refundCaseId, { try: 0 })
      return null
    }
    if (c.state !== 'requested') return null
    await tx.query(`UPDATE refund_cases SET state='submitting', updated_at=now() WHERE id=$1`, [refundCaseId])
    await recordTransition(tx, 'refund_case', refundCaseId, 'requested', 'submitting', 'provider_refund')
    return c
  })
  if (!claim) return
  ctx.crashAt?.('refund_after_submitting')
  const settle = (to: 'unknown' | 'failed', reason: string, err?: unknown) => withTx(ctx.db, async tx => {
    const cur = (await tx.query(`SELECT state FROM refund_cases WHERE id=$1 FOR UPDATE`, [refundCaseId])).rows[0]
    if (cur.state !== 'submitting') return // a observação já decidiu
    await tx.query(`UPDATE refund_cases SET state=$2, last_error=$3, updated_at=now() WHERE id=$1`, [refundCaseId, to, err ? JSON.stringify(err) : null])
    await recordTransition(tx, 'refund_case', refundCaseId, 'submitting', to, 'provider_refund', reason)
    if (to === 'unknown') await enqueue(tx, 'reconcile_refund', refundCaseId, { try: 0 })
  })
  try {
    const out = await ctx.provider.refund(claim.provider_payment_id, BigInt(claim.amount_minor), `PixSettle ${claim.refund_type} ${refundCaseId}`)
    await ctx.db.query(`UPDATE refund_cases SET provider_ref=$2, updated_at=now() WHERE id=$1`, [refundCaseId, out.refundRef])
  } catch (e) {
    // Revisão R8: `failed` só com recusa comprovada (4xx com corpo de erro). Qualquer outra coisa pode ter executado.
    if (e instanceof ProviderError && e.provenRejection) return settle('failed', `provedor recusou: ${e.message}`, { message: e.message, status: e.status, body: e.body ?? null })
    return settle('unknown', `resultado ambíguo: ${(e as Error).message}`, { message: (e as Error).message, status: (e as any).status ?? null })
  }
  ctx.crashAt?.('refund_after_provider_accept')
  try { await observeRefund(ctx, claim.provider_payment_id, `refund:${refundCaseId}`) } catch (e) {
    return settle('unknown', `provedor aceitou; consulta falhou: ${(e as Error).message}`, { message: (e as Error).message })
  }
  await settle('unknown', 'provedor aceitou; confirmação ainda não observada')
}

/** Job reconcile_refund: consulta o provedor até ver o estorno (ou desistir para revisão). */
export async function reconcileRefund(ctx: Ctx, refundCaseId: string, tryNo: number): Promise<'done' | 'retry'> {
  const c = (await ctx.db.query(`SELECT rc.state, pc.provider_payment_id FROM refund_cases rc JOIN pix_charges pc ON pc.order_id=rc.order_id WHERE rc.id=$1`, [refundCaseId])).rows[0]
  if (!c || !['submitting', 'unknown'].includes(c.state)) return 'done' // `requested` ainda não foi ao provedor: é do request_refund
  await observeRefund(ctx, c.provider_payment_id, `reconcile_refund:${refundCaseId}`)
  const st = (await ctx.db.query(`SELECT state FROM refund_cases WHERE id=$1`, [refundCaseId])).rows[0].state
  if (!OPEN.includes(st)) return 'done'
  if (tryNo + 1 >= ctx.cfg.reconcileMaxTries) {
    await withTx(ctx.db, tx => recordTransition(tx, 'refund_case', refundCaseId, st, st, 'reconcile_refund', `${tryNo + 1} consultas sem confirmação; revisão manual`))
    return 'done' // continua aberto e bloqueando: nunca vira confirmado nem falho sem prova
  }
  return 'retry'
}

async function observeRefund(ctx: Ctx, paymentId: string, source: string) {
  const p = await ctx.provider.getPayment(paymentId)
  await withTx(ctx.db, tx => applyObservation(tx, ctx, p, source))
}

/**
 * Chamado por applyObservation quando o provedor mostra estorno (total ou parcial).
 * Com a liquidação ainda sem resultado conclusivo (tentativa ativa ou manual_review), NADA é confirmado,
 * contabilizado ou encerrado (revisão R6): o fato fica registrado, os casos abertos cobrem o valor observado
 * e o pedido fica retido. Sem exposição pendente, confirma nossos casos na ordem; o excedente vira provider_refund.
 */
export async function onRefundObserved(tx: Tx, ctx: Ctx, order: any, p: ProviderPayment, source: string, hold: (reason: string, detail: string) => Promise<void>): Promise<'applied' | 'stale'> {
  const total = p.status === 'REFUNDED' && p.refundedMinor === 0n ? BigInt(order.amount_minor) : p.refundedMinor
  const done = BigInt((await tx.query(`SELECT coalesce(sum(amount_minor),0)::text AS v FROM refund_cases WHERE order_id=$1 AND state IN ('confirmed','partial')`, [order.id])).rows[0].v)
  let remaining = total - done
  if (remaining <= 0n) return 'stale'
  const s = (await tx.query(`SELECT s.*, EXISTS (SELECT 1 FROM settlement_attempts a WHERE a.settlement_id=s.id AND a.status = ANY($2)) AS active FROM settlements s WHERE s.order_id=$1 FOR UPDATE`, [order.id, ACTIVE_ATTEMPT])).rows[0]
  const pending = (await tx.query(`SELECT * FROM refund_cases WHERE order_id=$1 AND state = ANY($2) ORDER BY created_at, id FOR UPDATE`, [order.id, OPEN])).rows

  if (s && (s.active || s.status === 'manual_review')) {
    // Exposição desconhecida: registra o fato, garante casos abertos cobrindo o valor e retém. Sem contabilizar.
    const covered = pending.reduce((a: bigint, c: any) => a + BigInt(c.amount_minor), 0n)
    if (remaining > covered) {
      const id = newId('rfc')
      await tx.query(`INSERT INTO refund_cases (id, order_id, refund_type, state, amount_minor, observed_at) VALUES ($1,$2,'provider_refund','unknown',$3,$4)`, [id, order.id, (remaining - covered).toString(), ctx.now()])
      await recordTransition(tx, 'refund_case', id, null, 'unknown', source, 'estorno observado no provedor sem pedido nosso, com liquidação em andamento')
    }
    const fact = `provedor mostra ${total} devolvido; liquidação ${s.id} sem resultado conclusivo`
    const last = (await tx.query(`SELECT reason FROM state_transitions WHERE entity='refund_observed' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [order.id])).rows[0]
    if (last?.reason !== fact) await recordTransition(tx, 'refund_observed', order.id, null, 'pending_exposure', source, fact)
    if (s.hold_reason !== 'exposure_reconciliation') await tx.query(`UPDATE settlements SET hold_reason='exposure_reconciliation', updated_at=now() WHERE id=$1`, [s.id])
    const o = (await tx.query(`SELECT hold_reason FROM orders WHERE id=$1`, [order.id])).rows[0]
    if (o.hold_reason !== 'exposure_reconciliation') await hold('exposure_reconciliation', `liquidação ${s.id} em andamento com estorno externo`)
    return 'applied'
  }

  for (const c of pending) {
    if (BigInt(c.amount_minor) > remaining) break
    remaining -= BigInt(c.amount_minor)
    await confirmCase(tx, ctx, order, s, c.id, c.state, source)
  }
  if (remaining > 0n) {
    // Estorno que não pedimos (ex.: iniciado no provedor): nunca descartado.
    const id = newId('rfc')
    await tx.query(`INSERT INTO refund_cases (id, order_id, refund_type, state, amount_minor) VALUES ($1,$2,'provider_refund','requested',$3)`, [id, order.id, remaining.toString()])
    await confirmCase(tx, ctx, order, s, id, null, source, 'estorno observado no provedor sem pedido nosso')
  }
  return 'applied'
}

async function confirmCase(tx: Tx, ctx: Ctx, order: any, s: any, caseId: string, from: string | null, source: string, reason?: string) {
  await tx.query(`UPDATE refund_cases SET state='confirmed', observed_at=$2, updated_at=now() WHERE id=$1`, [caseId, ctx.now()])
  await recordTransition(tx, 'refund_case', caseId, from, 'confirmed', source, reason)
  const c = (await tx.query(`SELECT * FROM refund_cases WHERE id=$1`, [caseId])).rows[0]
  if (s?.status === 'confirmed') {
    // Reserva contábil SIMULADA do lojista cobre o que puder; o resto vira dívida simulada (contrato 6).
    // Trava do lojista (revisão R5): leitura e consumo do saldo comum serializados entre pedidos.
    // Ordem: pedido -> liquidação -> caso -> reserva do lojista, igual em todos os caminhos que debitam.
    await txLock(tx, `merchant_reserve:${order.merchant_id}`)
    const q = (await tx.query(`SELECT rate_num, rate_den FROM quotes WHERE order_id=$1`, [order.id])).rows[0]
    const exposure = (BigInt(c.amount_minor) * BigInt(q.rate_num)) / BigInt(q.rate_den)
    const bal = BigInt((await tx.query(
      `SELECT coalesce(sum(CASE kind WHEN 'reserve_simulated' THEN amount_units WHEN 'reserve_consumed_simulated' THEN -amount_units WHEN 'reserve_release_simulated' THEN -amount_units ELSE 0 END),0)::text AS v
         FROM ledger_entries WHERE merchant_id=$1`, [order.merchant_id])).rows[0].v)
    const consumed = exposure < bal ? exposure : (bal > 0n ? bal : 0n)
    const debt = exposure - consumed
    if (consumed > 0n) await tx.query(`INSERT INTO ledger_entries (merchant_id, order_id, kind, amount_units, currency, simulated, op_key) VALUES ($1,$2,'reserve_consumed_simulated',$3,'pathUSD',true,$4)`, [order.merchant_id, order.id, consumed.toString(), `refund:${caseId}:reserve`])
    if (debt > 0n) await tx.query(`INSERT INTO ledger_entries (merchant_id, order_id, kind, amount_units, currency, simulated, op_key) VALUES ($1,$2,'debt_simulated',$3,'pathUSD',true,$4)`, [order.merchant_id, order.id, debt.toString(), `refund:${caseId}:debt`])
    await recordTransition(tx, 'refund_accounting', caseId, null, 'recorded', source, JSON.stringify({ exposure: exposure.toString(), reserve_consumed_simulated: consumed.toString(), debt_simulated: debt.toString(), reserve_before: bal.toString() }))
  } else if (s && order.status !== 'late_paid') {
    // Antes de liquidar (sem tentativa ativa, conferido pelo chamador): só a devolução TOTAL encerra a liquidação.
    const refunded = BigInt((await tx.query(`SELECT coalesce(sum(amount_minor),0)::text AS v FROM refund_cases WHERE order_id=$1 AND state IN ('confirmed','partial')`, [order.id])).rows[0].v)
    if (refunded < BigInt(order.amount_minor)) {
      // Parcial antes de liquidar: a intenção on-chain é imutável; o caso confirmado bloqueia a assinatura e o pedido vai para revisão.
      const o = (await tx.query(`SELECT hold_reason FROM orders WHERE id=$1`, [order.id])).rows[0]
      if (!o.hold_reason) {
        await tx.query(`UPDATE orders SET hold_reason='partial_refund_before_settlement', updated_at=now() WHERE id=$1`, [order.id])
        await recordTransition(tx, 'order_hold', order.id, null, 'partial_refund_before_settlement', source, `${refunded} de ${order.amount_minor} devolvidos antes da liquidação`)
      }
      await tx.query(`UPDATE refund_cases SET observed_at=coalesce(observed_at, now()) WHERE id=$1`, [caseId])
      await enqueue(tx, 'issue_refund_receipt', caseId)
      return
    }
    if (!['failed', 'confirmed'].includes(s.status)) {
      await tx.query(`UPDATE settlements SET status='failed', hold_reason='refunded_before_settlement', updated_at=now() WHERE id=$1`, [s.id])
      await recordTransition(tx, 'settlement', s.id, s.status, 'failed', source, 'devolvido antes de liquidar')
    }
    if (order.status !== 'refunded') {
      await tx.query(`UPDATE orders SET status='refunded', updated_at=now() WHERE id=$1`, [order.id])
      await recordTransition(tx, 'order', order.id, order.status, 'refunded', source)
    }
  }
  await enqueue(tx, 'issue_refund_receipt', caseId)
}

/** Recibo refund_notice: declaração assinada do emissor sobre o provedor, nunca prova on-chain. */
export async function issueRefundReceipt(ctx: Ctx, caseId: string) {
  const d = (await ctx.db.query(
    `SELECT rc.*, o.amount_minor AS o_amount, o.provider_env, o.chain_env, c.provider FROM refund_cases rc JOIN orders o ON o.id=rc.order_id JOIN pix_charges c ON c.order_id=o.id WHERE rc.id=$1 AND rc.state='confirmed'`, [caseId])).rows[0]
  if (!d) return
  if ((await ctx.db.query(`SELECT 1 FROM receipts WHERE refund_case_id=$1`, [caseId])).rowCount) return
  const prev = (await ctx.db.query(`SELECT id FROM receipts WHERE order_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`, [d.order_id])).rows[0]
  const stl = (await ctx.db.query(`SELECT r.id AS receipt_id, r.envelope->'payload'->'settlement'->>'tx_hash' AS tx_hash FROM receipts r WHERE r.order_id=$1 AND r.receipt_type='settlement'`, [d.order_id])).rows[0]
  const acc = (await ctx.db.query(`SELECT reason FROM state_transitions WHERE entity='refund_accounting' AND entity_id=$1`, [caseId])).rows[0]
  const refund: Record<string, unknown> = {
    amount: { amount: String(d.amount_minor), currency: 'BRL', scale: 2 }, refund_type: d.refund_type, state: 'confirmed',
    observed_at: new Date(d.observed_at ?? d.updated_at).toISOString(), origin: 'provider_attested', provider: d.provider,
    simulated: d.refund_type === 'med_simulated',
  }
  if (d.simulation_reason) refund.simulation_reason = d.simulation_reason
  const payload: Record<string, unknown> = {
    schema_version: 1, receipt_id: newId('rct'), receipt_type: 'refund_notice',
    issuer: ctx.cfg.issuer, provider_env: d.provider_env, chain_env: d.chain_env, chain_id: ctx.chain.chainId,
    order: { id: d.order_id, amount: { amount: String(d.o_amount), currency: 'BRL', scale: 2 } },
    issued_at: ctx.now().toISOString(), refund,
  }
  if (prev) payload.previous_receipt_id = prev.id
  if (stl) payload.settlement_ref = { receipt_id: stl.receipt_id, tx_hash: stl.tx_hash }
  if (acc) { const a = JSON.parse(acc.reason); payload.accounting = { exposure: a.exposure, reserve_consumed_simulated: a.reserve_consumed_simulated, debt_simulated: a.debt_simulated, currency: 'pathUSD', scale: 6, simulated: true } }
  const env = await ctx.chain.signReceipt(payload) as ReceiptEnvelope
  const v = await verifyEnvelope(env, [ctx.cfg.issuer.address])
  if (!v.ok) throw new Error(`recibo de devolução assinado não confere: ${v.code} ${v.detail}`)
  await withTx(ctx.db, tx => tx.query(
    `INSERT INTO receipts (id, order_id, receipt_type, previous_receipt_id, refund_case_id, digest_hex, envelope) VALUES ($1,$2,'refund_notice',$3,$4,$5,$6)`,
    [payload.receipt_id, d.order_id, prev?.id ?? null, caseId, env.digest.hex, JSON.stringify(env)]))
}
