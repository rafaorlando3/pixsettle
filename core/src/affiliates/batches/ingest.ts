// Ingestão de lotes assinados de comissões (contrato pixsettle-commission-batch/1) em duas fases:
//  1. transação: trava da corrente (origin, store), repetição exata, cadeia, revisões (só inserção), lote e recibo HMAC;
//  2. aplicação ao domínio (service.ts), revisão a revisão, idempotente, com resultado gravado por revisão e retry pela outbox.
// A fase 2 nunca derruba a fase 1: cotação fora do ar ou corrente sem lojista mapeado ficam gravadas com motivo e voltam depois.
import { createHash, createHmac } from 'node:crypto'
import { withTx, enqueue, recordTransition, type Db, type Tx } from '../../db.js'
import { canonicalJson } from '../../pilot-shadow/guard.js'
import { DomainError } from '../../flows/orders.js'
import type { Ctx } from '../../context.js'
import { checkChain, CommissionError, type CommissionEvent, type ValidatedBatch } from './batch.js'
import { createCommission, releaseCommission, voidCommission, type BeneficiaryKind } from '../service.js'

export type CommissionReceipt = {
  schema: 'pixsettle-commission-receipt/1'; mode: 'shadow'; bank_settlement: false; result: 'accepted'
  origin: string; store: string; key_id: string; batch_sha256: string; previous_batch_sha256: string | null
  count: number; accepted: number; unchanged: number; committed_at: string; sig: string
}
export type IngestResult = { replayed: boolean; receipt: CommissionReceipt }

export const APPLY_TOPIC = 'apply_commission_revisions'
export const streamEntity = (origin: string, store: string) => `${origin}|${store}`

export function lockKey(origin: string, store: string): string {
  return createHash('sha256').update('affiliate-commission-stream\0' + origin + '\0' + store).digest().readBigInt64BE(0).toString()
}
export function signCommissionReceipt(r: Omit<CommissionReceipt, 'sig'>, key: Buffer): string {
  return createHmac('sha256', key).update(canonicalJson(r)).digest('hex')
}

async function storeRevision(tx: Tx, origin: string, store: string, e: CommissionEvent, batchSha: string): Promise<boolean> {
  const inserted = await tx.query(
    `INSERT INTO affiliate_commission_revisions(origin,store,commission_id,revision,event_id,order_id,affiliate_id,amount_minor,status,reason_code,created_at,source_updated_at,release_at,released_at,voided_at,event,batch_sha256)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17) ON CONFLICT DO NOTHING RETURNING revision`,
    [origin, store, e.id, e.revision, e.event_id, e.order_id, e.affiliate_id, e.amount_minor, e.status, e.reason_code, e.created_at, e.source_updated_at, e.release_at, e.released_at, e.voided_at, JSON.stringify(e), batchSha])
  if (inserted.rowCount) return true
  const same = (await tx.query('SELECT 1 FROM affiliate_commission_revisions WHERE origin=$1 AND store=$2 AND commission_id=$3 AND revision=$4 AND event_id=$5', [origin, store, e.id, e.revision, e.event_id])).rowCount
  if (!same) throw new CommissionError('commission_batch_conflict', `event_id reused: ${e.event_id}`, 409)
  return false
}

/** Fase 1. Uma transação: trava da corrente, repetição exata, cadeia, revisões, lote, recibo assinado e job de aplicação. */
export async function ingestCommissionBatch(db: Db, v: ValidatedBatch, receiptKey: Buffer): Promise<IngestResult> {
  const { origin, store } = v.batch
  return withTx(db, async tx => {
    await tx.query('SET LOCAL synchronous_commit = on')
    const lock = await tx.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS ok', [lockKey(origin, store)])
    if (!lock.rows[0].ok) throw new CommissionError('commission_busy', '', 423)
    const prior = (await tx.query('SELECT receipt FROM affiliate_commission_batches WHERE origin=$1 AND store=$2 AND batch_sha256=$3', [origin, store, v.batch_sha256])).rows[0]
    if (prior) return { replayed: true, receipt: prior.receipt as CommissionReceipt } // recibo gravado intacto; assinatura continua válida
    await tx.query('INSERT INTO affiliate_commission_streams(origin,store) VALUES($1,$2) ON CONFLICT DO NOTHING', [origin, store])
    const last = (await tx.query('SELECT last_batch_sha256 FROM affiliate_commission_streams WHERE origin=$1 AND store=$2 FOR UPDATE', [origin, store])).rows[0].last_batch_sha256 as string | null
    checkChain(v, last)
    let accepted = 0
    for (const e of v.batch.events) if (await storeRevision(tx, origin, store, e, v.batch_sha256)) accepted++
    const now = (await tx.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS at")).rows[0].at as string
    const body: Omit<CommissionReceipt, 'sig'> = {
      schema: 'pixsettle-commission-receipt/1', mode: 'shadow', bank_settlement: false, result: 'accepted',
      origin, store, key_id: v.batch.key_id, batch_sha256: v.batch_sha256, previous_batch_sha256: v.batch.previous_batch_sha256,
      count: v.batch.count, accepted, unchanged: v.batch.count - accepted, committed_at: now,
    }
    const receipt: CommissionReceipt = { ...body, sig: signCommissionReceipt(body, receiptKey) }
    await tx.query(
      `INSERT INTO affiliate_commission_batches(origin,store,batch_sha256,previous_batch_sha256,key_id,event_count,accepted,unchanged,receipt,committed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [origin, store, v.batch_sha256, v.batch.previous_batch_sha256, v.batch.key_id, v.batch.count, accepted, body.unchanged, JSON.stringify(receipt), now])
    await tx.query('UPDATE affiliate_commission_streams SET last_batch_sha256=$3, updated_at=now() WHERE origin=$1 AND store=$2', [origin, store, v.batch_sha256])
    if (accepted > 0) await enqueue(tx, APPLY_TOPIC, streamEntity(origin, store), { try: 0 })
    return { replayed: false, receipt }
  })
}

// ------------------------------------------------------------------ fase 2: aplicação ao domínio

const VOID_REASONS: Record<string, string> = { voided: 'order_voided', lost: 'program_loss' }
const kindOf = (affiliateId: string): BeneficiaryKind => (affiliateId.startsWith('par_') ? 'partner_percent' : 'affiliate')
/** Campos que a comissão fixa ao nascer; uma revisão que os troque não é "a mesma comissão". */
function immutableDiff(prior: any, r: any): string[] {
  const out: string[] = []
  if (BigInt(prior.amount_minor) !== BigInt(r.amount_minor)) out.push('amount_minor')
  if (prior.beneficiary_ref !== r.affiliate_id) out.push('affiliate_id')
  if (prior.kind !== kindOf(r.affiliate_id)) out.push('kind')
  if ((prior.order_ref ?? null) !== (r.order_id ?? null)) out.push('order_id')
  if (new Date(prior.occurred_at).getTime() !== new Date(r.created_at).getTime()) out.push('created_at')
  return out
}

export type ApplyOutcome = { applied: number; failed: number; retry: boolean; /** sobraram revisões além do bloco: reagendar já, sem esperar */ more?: boolean }
export const APPLY_BLOCK = 500

/**
 * Aplica, em ordem, as revisões ainda não aplicadas da corrente ao domínio. Cada revisão recebe exatamente uma linha
 * em affiliate_commission_applications com o resultado (created, released, voided, unchanged, skipped_*, failed:<código>).
 * Erro de cotação ou corrente sem lojista mapeado = retry (nada gravado para essa revisão); erro de domínio = falha gravada.
 */
export async function applyCommissionRevisions(ctx: Ctx, origin: string, store: string): Promise<ApplyOutcome> {
  const aff = ctx.affiliates
  // Módulo desligado ou instalação sem escritas: o job existente espera com motivo; nada é aplicado "por inércia".
  if (!aff || aff.writes === false) {
    await withTx(ctx.db, tx => recordTransition(tx, 'affiliate_stream', streamEntity(origin, store), null, aff ? 'writes_off' : 'affiliates_off', 'apply', 'revisões esperando a instalação aceitar escritas de afiliados'))
    return { applied: 0, failed: 0, retry: true }
  }
  const merchantId = aff.streams?.[streamEntity(origin, store)]
  const block = aff.applyBlock ?? APPLY_BLOCK
  // Um bloco por job; se sobrar, `more` manda o handler reagendar na hora (um lote de 5.000 revisões é drenado em blocos, na ordem).
  const pending = (await ctx.db.query(
    `SELECT r.* FROM affiliate_commission_revisions r
      WHERE r.origin=$1 AND r.store=$2 AND NOT EXISTS (SELECT 1 FROM affiliate_commission_applications a WHERE a.origin=r.origin AND a.store=r.store AND a.revision=r.revision AND a.commission_id=r.commission_id)
      ORDER BY r.source_updated_at, r.received_at, r.event_id LIMIT $3`, [origin, store, block + 1])).rows
  const out: ApplyOutcome = { applied: 0, failed: 0, retry: false }
  if (!pending.length) return out
  if (pending.length > block) { out.more = true; pending.length = block }
  if (!merchantId) {
    await withTx(ctx.db, tx => recordTransition(tx, 'affiliate_stream', streamEntity(origin, store), null, 'unmapped', 'apply', `${pending.length} revisões esperando AFFILIATE_STREAMS_JSON`))
    return { ...out, retry: true }
  }
  for (const r of pending) {
    let result: string
    let commissionId: string | null = null
    try {
      const prior = (await ctx.db.query(
        `SELECT c.id, c.status, c.amount_minor, c.order_ref, c.occurred_at, b.beneficiary_ref, b.kind FROM affiliate_commissions c JOIN affiliate_beneficiaries b ON b.id=c.beneficiary_id WHERE c.merchant_id=$1 AND c.source_event_id=$2`, [merchantId, r.commission_id])).rows[0]
      const changed = prior ? immutableDiff(prior, r) : []
      if (prior && changed.length) {
        // Campos imutáveis mudaram depois de a comissão nascer (valor, afiliado, pedido, tipo ou data): nada é liberado nem anulado
        // sobre o domínio antigo; a divergência fica registrada para uma pessoa, campo a campo.
        const code = changed.length === 1 && changed[0] === 'amount_minor' ? 'affiliate_amount_changed' : 'affiliate_identity_changed'
        await withTx(ctx.db, tx => recordTransition(tx, 'affiliate_exception', prior.id, prior.status, code, 'apply', `${changed.join(',')} (${r.revision.slice(0, 12)})`))
        result = code === 'affiliate_amount_changed' ? 'skipped_amount_changed' : 'skipped_identity_changed'; commissionId = prior.id
      } else if (r.status === 'voided' || r.status === 'lost') {
        if (!prior) { result = 'skipped_void_on_first_sight' } // nunca existiu no domínio: nada a anular, nada a pagar
        else { await voidCommission(ctx, merchantId, prior.id, r.reason_code ?? VOID_REASONS[r.status]!, new Date(r.voided_at ?? r.source_updated_at)); result = 'voided'; commissionId = prior.id }
      } else {
        let id: string
        if (!prior) {
          const c = await createCommission(ctx, merchantId, {
            sourceEventId: r.commission_id, beneficiaryRef: r.affiliate_id, kind: kindOf(r.affiliate_id), orderRef: r.order_id,
            amountMinor: BigInt(r.amount_minor), occurredAt: new Date(r.created_at),
          })
          id = c.commission.id; result = 'created'
        } else { id = prior.id as string; result = 'unchanged' }
        commissionId = id
        if (r.status === 'active') { await releaseCommission(ctx, merchantId, id, new Date(r.released_at ?? r.source_updated_at)); result = prior ? 'released' : 'created_released' }
      }
    } catch (e) {
      if (e instanceof DomainError && e.code === 'quote_unavailable') { out.retry = true; break } // volta depois, com a cotação viva; ordem preservada
      // Anulação recusada pelo domínio com exceção já registrada para uma pessoa: a revisão fica aplicada como "pulada", com o motivo.
      if (e instanceof DomainError && e.code === 'already_settled') { result = 'skipped_already_settled' }
      else if (e instanceof DomainError && e.code === 'payout_in_flight') { result = 'skipped_payout_in_flight' }
      else if (e instanceof DomainError && e.code === 'withdrawal_in_progress') { result = 'skipped_withdrawal_in_progress' }
      else if (e instanceof DomainError) { result = `failed:${e.code}`; out.failed++ }
      else throw e
    }
    await ctx.db.query(
      `INSERT INTO affiliate_commission_applications(origin,store,commission_id,revision,event_id,result,domain_commission_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [origin, store, r.commission_id, r.revision, r.event_id, result, commissionId])
    if (!result.startsWith('failed')) out.applied++
  }
  return out
}
