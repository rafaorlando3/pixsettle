// Diário durável de envio (contrato v0.3, seções 3.5, 3.6 e 4).
import { withTx, txLock, recordTransition, enqueue, type Tx } from '../db.js'
import { newId } from '../ids.js'
import type { Ctx } from '../context.js'
import type { Intent, Broadcast } from '../chain/gateway.js'

export const ACTIVE = ['nonce_reserved', 'signed', 'suspended', 'broadcast_pending', 'broadcast_sent', 'unknown', 'manual_review'] as const
const BLOCKING_REFUND = ['requested', 'submitting', 'unknown', 'confirmed', 'partial']

/** Estados em que a tentativa ainda aguarda prova on-chain (R1: só eles podem ser reconciliados). */
const RECONCILABLE = ['broadcast_pending', 'broadcast_sent', 'unknown', 'manual_review']
/** Destes, os que ainda permitem reenviar os MESMOS bytes. */
const REBROADCASTABLE = ['broadcast_pending', 'broadcast_sent', 'unknown']
/** Espera enquanto a tesouraria estiver pausada (R2); reconsulta periódica com diagnóstico. */
export const TREASURY_WAIT_MS = 15_000
export type StepResult = void | 'wait'

const treasuryKey = (chainId: number, sender: string) => `treasury:${chainId}:${sender.toLowerCase()}`

/**
 * Pausa da fila da tesouraria (contrato 3.5 e 4.4, revisão R2). Toma a trava consultiva da tesouraria
 * (sempre DEPOIS de pedido -> liquidação -> tentativa) e procura tentativa `suspended` não resolvida.
 * Nonce menor que o suspenso não depende dele e segue; nonce novo ou maior espera.
 */
async function treasuryPause(tx: Tx, chainId: number, sender: string, self: { id: string; nonce: bigint } | null): Promise<string | null> {
  await txLock(tx, treasuryKey(chainId, sender))
  const r = (await tx.query(
    `SELECT id, nonce FROM settlement_attempts WHERE chain_id=$1 AND lower(sender)=lower($2) AND status='suspended' AND ($3::text IS NULL OR id <> $3) ORDER BY nonce LIMIT 1`,
    [chainId, sender, self?.id ?? null])).rows[0]
  if (!r) return null
  if (self && self.nonce < BigInt(r.nonce)) return null
  return `treasury_paused:${r.id}:nonce_${r.nonce}`
}

/** Grava o diagnóstico de espera só quando o motivo muda (sem inundar o histórico a cada reconsulta). */
async function noteWaiting(tx: Tx, entity: string, id: string, reason: string, source: string) {
  const last = (await tx.query(`SELECT reason FROM state_transitions WHERE entity=$1 AND entity_id=$2 ORDER BY id DESC LIMIT 1`, [entity, id])).rows[0]
  if (last?.reason !== reason) await recordTransition(tx, entity, id, null, 'waiting', source, reason)
}

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
export async function advanceSettlement(ctx: Ctx, settlementId: string): Promise<StepResult> {
  return withTx(ctx.db, async (tx): Promise<StepResult> => {
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
    const paused = await treasuryPause(tx, s.chain_id, s.sender, null)
    if (paused) { await noteWaiting(tx, 'settlement_waiting', s.id, paused, 'advance'); return 'wait' }
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

export async function signAttempt(ctx: Ctx, attemptId: string): Promise<StepResult> {
  const pre = await withTx(ctx.db, async tx => {
    const x = await loadForUpdate(tx, attemptId)
    if (!x || x.a.status !== 'nonce_reserved') return null
    const b = await blockers(tx, x.orderId, x.s)
    const paused = await treasuryPause(tx, x.a.chain_id, x.a.sender, { id: x.a.id, nonce: BigInt(x.a.nonce) })
    if (b.length) {
      await setAttempt(tx, x.a, 'suspended', 'pre_sign', { pre_sign_check: { ok: false, blockers: b, at: ctx.now().toISOString() } }, b.join(','))
      return null
    }
    if (paused) {
      // Nonce reservado, nada assinado: espera a tesouraria voltar (R2).
      await tx.query(`UPDATE settlement_attempts SET pre_sign_check=$2, updated_at=now() WHERE id=$1`, [attemptId, JSON.stringify({ ok: false, waiting: paused, at: ctx.now().toISOString() })])
      await noteWaiting(tx, 'attempt_waiting', attemptId, paused, 'pre_sign')
      return 'wait' as const
    }
    await tx.query(`UPDATE settlement_attempts SET pre_sign_check=$2 WHERE id=$1`, [attemptId, JSON.stringify({ ok: true, at: ctx.now().toISOString() })])
    return { s: x.s, a: x.a }
  })
  if (pre === 'wait') return 'wait'
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

export async function broadcastAttempt(ctx: Ctx, attemptId: string): Promise<StepResult> {
  const pre = await withTx(ctx.db, async tx => {
    const x = await loadForUpdate(tx, attemptId)
    if (!x || !['signed', 'broadcast_pending'].includes(x.a.status)) return null
    const b = await blockers(tx, x.orderId, x.s)
    const paused = await treasuryPause(tx, x.a.chain_id, x.a.sender, { id: x.a.id, nonce: BigInt(x.a.nonce) })
    if (!b.length && paused) {
      if (x.a.status === 'signed') {
        // Assinado e nunca enviado: não transmite enquanto a tesouraria estiver pausada (R2).
        await tx.query(`UPDATE settlement_attempts SET pre_broadcast_check=$2, updated_at=now() WHERE id=$1`, [attemptId, JSON.stringify({ ok: false, waiting: paused, at: ctx.now().toISOString() })])
        await noteWaiting(tx, 'attempt_waiting', attemptId, paused, 'pre_broadcast')
        return 'wait' as const
      }
      // broadcast_pending: pode já ter saído. Só observar; sem reenviar enquanto pausada.
      await setAttempt(tx, x.a, 'unknown', 'pre_broadcast', { pre_broadcast_check: { ok: false, waiting: paused, at: ctx.now().toISOString() } }, 'tesouraria pausada depois de possível envio')
      await enqueue(tx, 'reconcile_attempt', attemptId, { try: 0 })
      return null
    }
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
  if (pre === 'wait') return 'wait'
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
  if (!snap || !RECONCILABLE.includes(snap.status)) return 'done'
  const intent: Intent = { chainId: snap.s_chain, token: snap.token, from: snap.s_sender, to: snap.recipient, amount: BigInt(snap.amount_units), memo: snap.memo }
  let obs
  try { obs = await ctx.chain.observe(snap.tx_hash, intent) } catch (e) {
    // Coluna própria: um erro atrasado nunca apaga a evidência conclusiva em `observed` (R1).
    await ctx.db.query(`UPDATE settlement_attempts SET last_rpc_error=$2, updated_at=now() WHERE id=$1`, [attemptId, JSON.stringify({ rpc_error: (e as Error).message, at: ctx.now().toISOString() })])
    return 'retry' // RPC fora do ar: continua desconhecido, nunca sucesso
  }
  if (!obs) {
    // Sem recibo ainda. Decide com o estado ATUAL sob a trava, nunca com o snapshot anterior à RPC (R1):
    // outro reconciliador pode ter confirmado enquanto esta consulta esperava.
    const now = await withTx(ctx.db, async tx => {
      const x = await loadForUpdate(tx, attemptId)
      if (!x || !REBROADCASTABLE.includes(x.a.status)) return { status: x?.a.status as string | undefined, resend: false }
      const blocked = (await blockers(tx, x.orderId, x.s)).length > 0
      const paused = await treasuryPause(tx, x.a.chain_id, x.a.sender, { id: x.a.id, nonce: BigInt(x.a.nonce) })
      return { status: x.a.status as string, resend: !blocked && !paused }
    })
    if (!now.status || !RECONCILABLE.includes(now.status)) return 'done' // já concluída por outro caminho
    if (now.resend) {
      // Reenviar os MESMOS bytes é seguro: mesmo hash e mesmo nonce (nunca assinatura nova).
      const out = await ctx.chain.broadcast(snap.raw_tx).catch(e => ({ kind: 'unknown', detail: (e as Error).message }))
      await ctx.db.query(`UPDATE settlement_attempts SET last_reconcile=$2, updated_at=now() WHERE id=$1`, [attemptId, JSON.stringify({ rebroadcast: out, try: tryNo, at: ctx.now().toISOString() })])
    }
    if (tryNo + 1 >= ctx.cfg.reconcileMaxTries && now.status !== 'manual_review') {
      await withTx(ctx.db, async tx => {
        const x = await loadForUpdate(tx, attemptId); if (!x || !REBROADCASTABLE.includes(x.a.status)) return // terminal não regride
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
    if (!x || !RECONCILABLE.includes(x.a.status)) return // confirmed/attempt_reverted são terminais (R1)
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
      // op_key único: mesmo com defeito futuro de transição, o banco recusa o lançamento em dobro (R1).
      await tx.query(`INSERT INTO ledger_entries (merchant_id, order_id, kind, amount_units, currency, simulated, op_key) VALUES ($1,$2,'settlement_net',$3,'pathUSD',false,$5),($1,$2,'reserve_simulated',$4,'pathUSD',true,$6)`,
        [o.merchant_id, o.id, x.s.amount_units, reserve.toString(), `settlement:${x.s.id}:net`, `settlement:${x.s.id}:reserve`])
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
