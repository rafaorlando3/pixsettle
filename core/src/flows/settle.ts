// Diário durável de envio (contrato v0.3, seções 3.5, 3.6 e 4).
import { withTx, txLock, recordTransition, enqueue, type Tx } from '../db.js'
import { newId } from '../ids.js'
import type { Ctx } from '../context.js'
import type { Intent, Broadcast } from '../chain/gateway.js'

export const ACTIVE = ['nonce_reserved', 'signed', 'suspended', 'broadcast_pending', 'broadcast_sent', 'unknown', 'manual_review'] as const
const BLOCKING_REFUND = ['requested', 'unknown', 'confirmed', 'partial']

function intentOf(s: any): Intent {
  return { chainId: s.chain_id, token: s.token, from: s.sender, to: s.recipient, amount: BigInt(s.amount_units), memo: s.memo }
}

async function setAttempt(tx: Tx, att: any, to: string, source: string, extra: Record<string, unknown> = {}, reason?: string) {
  const cols = Object.keys(extra)
  const sets = cols.map((c, i) => `${c}=$${i + 3}`).join(', ')
  await tx.query(`UPDATE settlement_attempts SET status=$2${sets ? ', ' + sets : ''}, updated_at=now() WHERE id=$1`,
    [att.id, to, ...cols.map(c => { const v = extra[c]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v })])
  await recordTransition(tx, 'attempt', att.id, att.status, to, source, reason)
}

/** Motivos que proíbem assinar/transmitir (conferidos sob a trava do pedido). */
async function blockers(tx: Tx, orderId: string, settlement: any): Promise<string[]> {
  const out: string[] = []
  const o = (await tx.query(`SELECT hold_reason FROM orders WHERE id=$1`, [orderId])).rows[0]
  if (o.hold_reason) out.push(`order_hold:${o.hold_reason}`)
  if (settlement.hold_reason) out.push(`settlement_hold:${settlement.hold_reason}`)
  const r = await tx.query(`SELECT id, state FROM refund_cases WHERE order_id=$1 AND state = ANY($2)`, [orderId, BLOCKING_REFUND])
  for (const x of r.rows) out.push(`refund_case:${x.id}:${x.state}`)
  return out
}

/** Despachante: decide o próximo passo da liquidação. Idempotente e seguro em concorrência. */
export async function advanceSettlement(ctx: Ctx, settlementId: string) {
  await withTx(ctx.db, async tx => {
    const s = (await tx.query(`SELECT * FROM settlements WHERE id=$1 FOR UPDATE`, [settlementId])).rows[0]
    if (!s || ['confirmed', 'failed', 'manual_review'].includes(s.status)) return
    const active = (await tx.query(`SELECT * FROM settlement_attempts WHERE settlement_id=$1 AND status = ANY($2) FOR UPDATE`, [settlementId, ACTIVE])).rows[0]
    if (active) {
      if (active.status === 'nonce_reserved') await enqueue(tx, 'sign_attempt', active.id)
      else if (active.status === 'signed') await enqueue(tx, 'broadcast_attempt', active.id)
      else if (['broadcast_pending', 'broadcast_sent', 'unknown'].includes(active.status)) await enqueue(tx, 'reconcile_attempt', active.id, { try: 0 })
      return // suspended e manual_review ficam parados com diagnóstico
    }
    const prev = (await tx.query(`SELECT status FROM settlement_attempts WHERE settlement_id=$1 ORDER BY attempt_no DESC`, [settlementId])).rows
    if (prev.some(p => p.status === 'confirmed')) return
    const blocked = await blockers(tx, s.order_id, s)
    if (blocked.length) { await recordTransition(tx, 'settlement_blocked', s.id, null, 'blocked', 'advance', blocked.join(',')); return }
    if (prev.length >= ctx.cfg.maxAttemptsPerSettlement) {
      await tx.query(`UPDATE settlements SET status='failed', hold_reason='max_attempts', updated_at=now() WHERE id=$1`, [s.id])
      await recordTransition(tx, 'settlement', s.id, s.status, 'failed', 'advance', `${prev.length} tentativas revertidas`)
      return
    }
    // Reserva de nonce sob a trava da tesouraria, ligada a uma tentativa durável (contrato 4.4).
    await txLock(tx, `treasury:${s.chain_id}:${s.sender.toLowerCase()}`)
    const pending = await ctx.chain.pendingNonce()
    const maxRes = (await tx.query(`SELECT max(nonce) AS m FROM settlement_attempts WHERE chain_id=$1 AND lower(sender)=lower($2) AND nonce_key=0`, [s.chain_id, s.sender])).rows[0].m
    const nonce = Math.max(pending, maxRes === null ? 0 : Number(maxRes) + 1)
    const att = { id: newId('att'), status: null }
    await tx.query(
      `INSERT INTO settlement_attempts (id, settlement_id, attempt_no, chain_id, sender, nonce_key, nonce, status) VALUES ($1,$2,$3,$4,$5,0,$6,'nonce_reserved')`,
      [att.id, s.id, prev.length + 1, s.chain_id, s.sender, nonce],
    )
    await recordTransition(tx, 'attempt', att.id, null, 'nonce_reserved', 'advance', `nonce ${nonce} (pendente na cadeia ${pending}, maior reservado ${maxRes ?? '-'})`)
    if (s.status !== 'in_progress') {
      await tx.query(`UPDATE settlements SET status='in_progress', updated_at=now() WHERE id=$1`, [s.id])
      await recordTransition(tx, 'settlement', s.id, s.status, 'in_progress', 'advance')
    }
    await enqueue(tx, 'sign_attempt', att.id)
  })
}

async function loadForUpdate(tx: Tx, attemptId: string) {
  // Ordem fixa de travas: pedido -> liquidação -> tentativa (evita impasse).
  const ids = (await tx.query(`SELECT s.order_id, a.settlement_id FROM settlement_attempts a JOIN settlements s ON s.id=a.settlement_id WHERE a.id=$1`, [attemptId])).rows[0]
  if (!ids) return null
  await tx.query(`SELECT id FROM orders WHERE id=$1 FOR UPDATE`, [ids.order_id])
  const s = (await tx.query(`SELECT * FROM settlements WHERE id=$1 FOR UPDATE`, [ids.settlement_id])).rows[0]
  const a = (await tx.query(`SELECT * FROM settlement_attempts WHERE id=$1 FOR UPDATE`, [attemptId])).rows[0]
  return { s, a, orderId: ids.order_id as string }
}

export async function signAttempt(ctx: Ctx, attemptId: string) {
  const pre = await withTx(ctx.db, async tx => {
    const x = await loadForUpdate(tx, attemptId)
    if (!x || x.a.status !== 'nonce_reserved') return null
    const b = await blockers(tx, x.orderId, x.s)
    if (b.length) {
      await setAttempt(tx, x.a, 'suspended', 'pre_sign', { pre_sign_check: { ok: false, blockers: b, at: ctx.now().toISOString() } }, b.join(','))
      return null
    }
    await tx.query(`UPDATE settlement_attempts SET pre_sign_check=$2 WHERE id=$1`, [attemptId, JSON.stringify({ ok: true, at: ctx.now().toISOString() })])
    return { s: x.s, a: x.a }
  })
  if (!pre) return
  ctx.crashAt?.('after_pre_sign_check')
  const signed = await ctx.chain.sign(intentOf(pre.s), Number(pre.a.nonce))
  ctx.crashAt?.('after_sign_before_persist')
  await withTx(ctx.db, async tx => {
    const x = await loadForUpdate(tx, attemptId)
    if (!x || x.a.status !== 'nonce_reserved') return // outro worker avançou; estes bytes são descartados sem envio
    await setAttempt(tx, x.a, 'signed', 'sign', { raw_tx: signed.raw, tx_hash: signed.hash, fee_params: signed.feeParams })
    await enqueue(tx, 'broadcast_attempt', attemptId)
  })
}

export async function broadcastAttempt(ctx: Ctx, attemptId: string) {
  const pre = await withTx(ctx.db, async tx => {
    const x = await loadForUpdate(tx, attemptId)
    if (!x || !['signed', 'broadcast_pending'].includes(x.a.status)) return null
    const b = await blockers(tx, x.orderId, x.s)
    if (b.length) {
      if (x.a.status === 'signed') {
        // Nunca transmitir pagamento proibido; bytes e nonce preservados, fila da tesouraria parada.
        await setAttempt(tx, x.a, 'suspended', 'pre_broadcast', { pre_broadcast_check: { ok: false, blockers: b, at: ctx.now().toISOString() } }, b.join(','))
      } else {
        // broadcast_pending: pode já ter saído; não dá para "des-enviar". Só reconciliar.
        await setAttempt(tx, x.a, 'unknown', 'pre_broadcast', { pre_broadcast_check: { ok: false, blockers: b, at: ctx.now().toISOString() } }, 'bloqueado depois de possível envio')
        await enqueue(tx, 'reconcile_attempt', attemptId, { try: 0 })
      }
      return null
    }
    if (x.a.status === 'signed') await setAttempt(tx, x.a, 'broadcast_pending', 'pre_broadcast', { pre_broadcast_check: { ok: true, at: ctx.now().toISOString() } })
    return { raw: x.a.raw_tx as string }
  })
  if (!pre) return
  ctx.crashAt?.('after_broadcast_pending_before_rpc')
  let out: Broadcast
  try { out = await ctx.chain.broadcast(pre.raw) } catch (e) { out = { kind: 'unknown', reason: 'transport', detail: (e as Error).message } }
  ctx.crashAt?.('after_rpc_before_record')
  await withTx(ctx.db, async tx => {
    const x = await loadForUpdate(tx, attemptId)
    if (!x || x.a.status !== 'broadcast_pending') return
    await setAttempt(tx, x.a, out.kind === 'accepted' ? 'broadcast_sent' : 'unknown', 'broadcast', { broadcast_outcome: out }, out.kind)
    await enqueue(tx, 'reconcile_attempt', attemptId, { try: 0 })
  })
}

export async function reconcileAttempt(ctx: Ctx, attemptId: string, tryNo: number): Promise<'done' | 'retry'> {
  const snap = (await ctx.db.query(`SELECT a.*, s.chain_id AS s_chain, s.token, s.sender AS s_sender, s.recipient, s.amount_units, s.memo, s.order_id FROM settlement_attempts a JOIN settlements s ON s.id=a.settlement_id WHERE a.id=$1`, [attemptId])).rows[0]
  if (!snap || !['broadcast_pending', 'broadcast_sent', 'unknown', 'manual_review'].includes(snap.status)) return 'done'
  const intent: Intent = { chainId: snap.s_chain, token: snap.token, from: snap.s_sender, to: snap.recipient, amount: BigInt(snap.amount_units), memo: snap.memo }
  let obs
  try { obs = await ctx.chain.observe(snap.tx_hash, intent) } catch (e) {
    await ctx.db.query(`UPDATE settlement_attempts SET observed=$2, updated_at=now() WHERE id=$1`, [attemptId, JSON.stringify({ rpc_error: (e as Error).message, at: ctx.now().toISOString() })])
    return 'retry' // RPC fora do ar: continua desconhecido, nunca sucesso
  }
  if (!obs) {
    // Sem recibo ainda: reenviar os MESMOS bytes é seguro, se nada proíbe.
    const blocked = await withTx(ctx.db, async tx => { const x = await loadForUpdate(tx, attemptId); return x ? (await blockers(tx, x.orderId, x.s)).length > 0 : true })
    if (!blocked && snap.status !== 'manual_review') {
      const out = await ctx.chain.broadcast(snap.raw_tx).catch(e => ({ kind: 'unknown', detail: (e as Error).message }))
      await ctx.db.query(`UPDATE settlement_attempts SET broadcast_outcome=$2, updated_at=now() WHERE id=$1`, [attemptId, JSON.stringify({ rebroadcast: out, try: tryNo })])
    }
    if (tryNo + 1 >= ctx.cfg.reconcileMaxTries && snap.status !== 'manual_review') {
      await withTx(ctx.db, async tx => {
        const x = await loadForUpdate(tx, attemptId); if (!x || x.a.status === 'manual_review') return
        await setAttempt(tx, x.a, 'manual_review', 'reconcile', {}, `${tryNo + 1} consultas sem recibo`)
        await tx.query(`UPDATE settlements SET status='manual_review', updated_at=now() WHERE id=$1`, [x.s.id])
        await recordTransition(tx, 'settlement', x.s.id, x.s.status, 'manual_review', 'reconcile')
      })
      return 'done'
    }
    return 'retry'
  }
  await withTx(ctx.db, async tx => {
    const x = await loadForUpdate(tx, attemptId)
    if (!x || !['broadcast_pending', 'broadcast_sent', 'unknown', 'manual_review'].includes(x.a.status)) return
    if (obs.status === 'success' && obs.identityOk) {
      await setAttempt(tx, x.a, 'confirmed', 'reconcile', { observed: obs })
      await tx.query(`UPDATE settlements SET status='confirmed', updated_at=now() WHERE id=$1`, [x.s.id])
      await recordTransition(tx, 'settlement', x.s.id, x.s.status, 'confirmed', 'reconcile', obs.txHash)
      const o = (await tx.query(`SELECT * FROM orders WHERE id=$1`, [x.orderId])).rows[0]
      if (o.status === 'settling') {
        await tx.query(`UPDATE orders SET status='settled', updated_at=now() WHERE id=$1`, [o.id])
        await recordTransition(tx, 'order', o.id, 'settling', 'settled', 'reconcile')
      }
      const m = (await tx.query(`SELECT reserve_bps FROM merchants WHERE id=$1`, [o.merchant_id])).rows[0]
      const q = (await tx.query(`SELECT * FROM quotes WHERE order_id=$1`, [o.id])).rows[0]
      const gross = (BigInt(o.amount_minor) * BigInt(q.rate_num)) / BigInt(q.rate_den)
      const reserve = (gross * BigInt(m.reserve_bps)) / 10000n
      await tx.query(`INSERT INTO ledger_entries (merchant_id, order_id, kind, amount_units, currency, simulated) VALUES ($1,$2,'settlement_net',$3,'pathUSD',false),($1,$2,'reserve_simulated',$4,'pathUSD',true)`,
        [o.merchant_id, o.id, x.s.amount_units, reserve.toString()])
      await enqueue(tx, 'issue_receipt', x.s.id)
    } else if (obs.status === 'reverted') {
      await setAttempt(tx, x.a, 'attempt_reverted', 'reconcile', { observed: obs }, 'recibo revertido (prova final desta tentativa)')
      await tx.query(`UPDATE settlements SET status='intent_recorded', updated_at=now() WHERE id=$1`, [x.s.id])
      await recordTransition(tx, 'settlement', x.s.id, x.s.status, 'intent_recorded', 'reconcile', 'nova tentativa só após revert comprovado')
      await enqueue(tx, 'settle', x.s.id)
    } else {
      await setAttempt(tx, x.a, 'manual_review', 'reconcile', { observed: obs }, obs.mismatches.join('; '))
      await tx.query(`UPDATE settlements SET status='manual_review', hold_reason='identity_mismatch', updated_at=now() WHERE id=$1`, [x.s.id])
      await recordTransition(tx, 'settlement', x.s.id, x.s.status, 'manual_review', 'reconcile', obs.mismatches.join('; '))
    }
  })
  return 'done'
}
