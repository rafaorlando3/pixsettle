// Fase 2: comissões de afiliados em dólar digital (docs/affiliate-payouts.md). Regras de domínio, só banco.
// Toda recusa é DomainError com código estável e mensagem simples; toda mudança de estado grava transição.
// Revisão do Codex (REVISAO-347-BASE.md, 09/10) aplicada: custódia (pool x carteira própria) debita o direito uma vez só;
// anulação segura por estado da liquidação; anulação nunca deixa saldo negativo; pseudônimos opacos obrigatórios;
// idempotência sob trava com conflito de conteúdo; cotação de importação marcada como tal; projeções públicas por lista permitida.
import { ulid } from 'ulid'
import { withTx, txLock, recordTransition, enqueue, type Tx } from '../db.js'
import { DomainError } from '../flows/orders.js'
import type { Ctx } from '../context.js'
import { fixUsdUnits, pixNet, fmtUsd, fmtBrl } from './money.js'
import type { UsdQuote } from './quotes.js'

export type BeneficiaryKind = 'affiliate' | 'partner_percent'
export const BENEFICIARY_KINDS: readonly BeneficiaryKind[] = ['affiliate', 'partner_percent']
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** Pseudônimo opaco por construção: prefixo curto + hexadecimal (o produtor usa aff_/par_ + 32 hex; outros clientes geram no servidor). */
export const REF = /^(aff|par|afl|ben)_[0-9a-f]{12,64}$/
const SOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/
const ORDER_REF = /^[A-Za-z0-9._:-]{1,64}$/
/** Cotação "no instante do Pix" só quando o evento chega até este atraso; depois é importação (backfill) e é dito assim. */
export const AT_PIX_WINDOW_MS = 15 * 60_000
/** Tentativas que podem já ter saído para a rede: a partir daqui ninguém "desfaz" um pagamento, só reconcilia. */
const MAYBE_SENT = ['broadcast_pending', 'broadcast_sent', 'unknown', 'manual_review', 'confirmed']

export type CommissionInput = {
  sourceEventId: string; beneficiaryRef: string; kind: BeneficiaryKind; orderRef?: string | null
  amountMinor: bigint; occurredAt: Date
}

const newId = (p: 'ben' | 'com' | 'qlk' | 'wdr' | 'stl' | 'rct') => `${p}_${ulid()}`
/** Memo de 32 bytes: o id (30 caracteres) + 2 bytes zero; um pagamento refeito usa o sufixo "-N" nos 2 bytes finais (memo é único no diário). */
const memoOf = (id: string, attempt = 1) => '0x' + Buffer.concat([Buffer.from(id, 'ascii'), attempt === 1 ? Buffer.alloc(32 - id.length) : Buffer.from(`-${attempt}`.slice(-(32 - id.length)), 'ascii')]).toString('hex')
const memoPrefix = (id: string) => '0x' + Buffer.from(id, 'ascii').toString('hex')
const benKey = (beneficiaryId: string) => `affiliate:${beneficiaryId}`
const idemKey = (merchantId: string, sourceEventId: string) => `affiliate:idem:${merchantId}:${sourceEventId}`

function affiliatesOn(ctx: Ctx) {
  if (!ctx.affiliates) throw new DomainError('affiliates_off', 'módulo de comissões em dólar desligado nesta instalação', 404)
  return ctx.affiliates
}

async function policyOf(tx: Tx, merchantId: string) {
  const p = (await tx.query(`SELECT * FROM affiliate_policies WHERE merchant_id=$1`, [merchantId])).rows[0]
  return p ?? { merchant_id: merchantId, conversion_fee_bps: 0, withdrawal_fee_bps: 0, withdrawal_fee_minor: 0, pool_address: null }
}

async function freshQuote(ctx: Ctx): Promise<UsdQuote> {
  const r = await affiliatesOn(ctx).quotes.quote(ctx.now())
  if (!r.ok) throw new DomainError('quote_unavailable', `sem cotação agora: ${r.detail}`, 503)
  return r.quote
}

/** Beneficiário sob a trava do pseudônimo: inserção concorrente não duplica nem falha. */
async function ensureBeneficiary(tx: Tx, merchantId: string, ref: string, kind: BeneficiaryKind) {
  await txLock(tx, `affiliate:ref:${merchantId}:${ref}`)
  const existing = (await tx.query(`SELECT * FROM affiliate_beneficiaries WHERE merchant_id=$1 AND beneficiary_ref=$2`, [merchantId, ref])).rows[0]
  if (existing) {
    if (existing.kind !== kind) throw new DomainError('beneficiary_kind_mismatch', `beneficiário já cadastrado como ${existing.kind}`, 409)
    return existing
  }
  const id = newId('ben')
  await tx.query(`INSERT INTO affiliate_beneficiaries (id, merchant_id, beneficiary_ref, kind) VALUES ($1,$2,$3,$4) ON CONFLICT (merchant_id, beneficiary_ref) DO NOTHING`, [id, merchantId, ref, kind])
  const row = (await tx.query(`SELECT * FROM affiliate_beneficiaries WHERE merchant_id=$1 AND beneficiary_ref=$2`, [merchantId, ref])).rows[0]
  if (row.id === id) await recordTransition(tx, 'affiliate_beneficiary', id, null, 'created', 'api', kind)
  return row
}

async function beneficiaryOf(tx: Tx, merchantId: string, ref: string) {
  const b = (await tx.query(`SELECT * FROM affiliate_beneficiaries WHERE merchant_id=$1 AND beneficiary_ref=$2`, [merchantId, ref])).rows[0]
  if (!b) throw new DomainError('beneficiary_not_found', 'beneficiário desconhecido', 404)
  return b
}

const sameContent = (c: any, input: CommissionInput, beneficiaryRef: string, kind: string) =>
  c.beneficiary_ref === beneficiaryRef && c.b_kind === kind && BigInt(c.amount_minor) === input.amountMinor &&
  (c.order_ref ?? null) === (input.orderRef ?? null) && new Date(c.occurred_at).getTime() === input.occurredAt.getTime()

/** 3. Comissão nasce em dólar: cotação fixada na recepção (marcada at_pix ou backfill), taxa descontada, arredondado para baixo. */
export async function createCommission(ctx: Ctx, merchantId: string, input: CommissionInput) {
  affiliatesOn(ctx)
  if (!SOURCE_ID.test(input.sourceEventId)) throw new DomainError('invalid_source_event_id', 'source_event_id inválido')
  if (!REF.test(input.beneficiaryRef)) throw new DomainError('invalid_beneficiary_ref', 'beneficiary_ref deve ser um pseudônimo opaco (prefixo aff_, par_, afl_ ou ben_ e 12 a 64 hexadecimais), nunca nome, CPF ou chave Pix')
  if (!BENEFICIARY_KINDS.includes(input.kind)) throw new DomainError('invalid_kind', 'kind deve ser affiliate ou partner_percent')
  if (input.orderRef != null && !ORDER_REF.test(input.orderRef)) throw new DomainError('invalid_order_ref', 'order_ref deve ser uma referência curta (1 a 64 caracteres, sem espaços)')
  if (input.amountMinor <= 0n) throw new DomainError('invalid_amount', 'amount deve ser positivo, em centavos')
  if (Number.isNaN(input.occurredAt.getTime())) throw new DomainError('invalid_occurred_at', 'occurred_at inválido')
  // Leitura rápida fora da trava só para não cotar à toa; a decisão idempotente é sempre sob a trava, abaixo.
  const quick = await findBySource(ctx, merchantId, input.sourceEventId)
  if (quick) { assertSame(quick, input); return { created: false, commission: projectCommission(quick) } }
  const quote = await freshQuote(ctx)
  const now = ctx.now()
  const quoteMode = Math.abs(now.getTime() - input.occurredAt.getTime()) <= AT_PIX_WINDOW_MS ? 'at_pix' : 'backfill'
  const created = await withTx(ctx.db, async tx => {
    await txLock(tx, idemKey(merchantId, input.sourceEventId))
    const again = (await tx.query(`SELECT c.*, b.beneficiary_ref, b.kind AS b_kind FROM affiliate_commissions c JOIN affiliate_beneficiaries b ON b.id=c.beneficiary_id WHERE c.merchant_id=$1 AND c.source_event_id=$2`, [merchantId, input.sourceEventId])).rows[0]
    if (again) { assertSame(again, input); return false }
    const b = await ensureBeneficiary(tx, merchantId, input.beneficiaryRef, input.kind)
    await txLock(tx, benKey(b.id))
    const policy = await policyOf(tx, merchantId)
    const { usdUnits } = fixUsdUnits(input.amountMinor, policy.conversion_fee_bps, quote.buy)
    const id = newId('com')
    await tx.query(
      `INSERT INTO affiliate_commissions (id, merchant_id, beneficiary_id, source_event_id, order_ref, amount_minor, fee_bps, usd_units, rate_num, rate_den, quote_source, quote_at, quote_hash, quote_mode, status, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15)`,
      [id, merchantId, b.id, input.sourceEventId, input.orderRef ?? null, input.amountMinor.toString(), policy.conversion_fee_bps, usdUnits.toString(),
        quote.buy.rateNum.toString(), quote.buy.rateDen.toString(), quote.source, quote.at, quote.hash, quoteMode, input.occurredAt],
    )
    await tx.query(`INSERT INTO affiliate_ledger (beneficiary_id, kind, usd_units, ref_kind, ref_id, op_key) VALUES ($1,'credit_pending',$2,'commission',$3,$4)`,
      [b.id, usdUnits.toString(), id, `credit:${id}`])
    await recordTransition(tx, 'affiliate_commission', id, null, 'pending', 'api',
      JSON.stringify({ amount_minor: input.amountMinor.toString(), usd_units: usdUnits.toString(), quote: quote.source, price4: quote.price4.toString(), age_s: quote.ageS, quote_mode: quoteMode }))
    return true
  })
  const row = await findBySource(ctx, merchantId, input.sourceEventId)
  return { created, commission: projectCommission(row) }
}

function assertSame(existing: any, input: CommissionInput) {
  if (!sameContent(existing, input, input.beneficiaryRef, input.kind)) throw new DomainError('idempotency_conflict', 'source_event_id já existe com conteúdo diferente (beneficiário, valor, tipo, pedido ou data); a comissão fixada não muda', 409)
}

async function findBySource(ctx: Ctx, merchantId: string, sourceEventId: string) {
  return (await ctx.db.query(`${COMMISSION_SELECT} WHERE c.merchant_id=$1 AND c.source_event_id=$2`, [merchantId, sourceEventId])).rows[0] ?? null
}

/** 4. Liberação: a regra do lojista diz quando; aqui a comissão vira pagamento no diário de envio. Custódia decidida aqui. */
export async function releaseCommission(ctx: Ctx, merchantId: string, commissionId: string, occurredAt: Date) {
  const aff = affiliatesOn(ctx)
  await withTx(ctx.db, async tx => {
    const c = await lockCommission(tx, merchantId, commissionId)
    if (c.status !== 'pending') {
      if (['released', 'settling', 'settled'].includes(c.status)) return // idempotente
      throw new DomainError('commission_not_pending', `comissão está ${c.status}; só pendente pode ser liberada`, 409)
    }
    const b = (await tx.query(`SELECT * FROM affiliate_beneficiaries WHERE id=$1`, [c.beneficiary_id])).rows[0]
    const policy = await policyOf(tx, merchantId)
    const custody: 'pool' | 'own_wallet' = b.payout_address ? 'own_wallet' : 'pool'
    const recipient: string | null = b.payout_address ?? policy.pool_address ?? null
    await tx.query(`UPDATE affiliate_commissions SET status='released', custody=$2, released_at=$3, updated_at=now() WHERE id=$1`, [c.id, custody, occurredAt])
    await recordTransition(tx, 'affiliate_commission', c.id, 'pending', 'released', 'api', custody)
    await tx.query(`INSERT INTO affiliate_ledger (beneficiary_id, kind, usd_units, ref_kind, ref_id, op_key) VALUES ($1,'release',0,'commission',$2,$3)`, [b.id, c.id, `release:${c.id}`])
    if (!recipient) { await recordTransition(tx, 'affiliate_commission', c.id, 'released', 'released', 'api', 'no_payout_address: sem carteira do beneficiário e sem pool do lojista'); return }
    const stl = newId('stl')
    const hold = aff.settle ? null : 'affiliate_settle_off'
    await tx.query(
      `INSERT INTO settlements (id, order_id, kind, beneficiary_ref, chain_id, token, sender, recipient, amount_units, memo, status, hold_reason)
       VALUES ($1,NULL,'affiliate_payout',$2,$3,$4,$5,$6,$7,$8,'intent_recorded',$9)`,
      [stl, b.beneficiary_ref, ctx.chain.chainId, ctx.chain.token, ctx.chain.treasury, recipient, String(c.usd_units), memoOf(c.id), hold],
    )
    await recordTransition(tx, 'settlement', stl, null, 'intent_recorded', 'affiliate_release', JSON.stringify({ commission: c.id, usd_units: String(c.usd_units), custody, hold }))
    await tx.query(`UPDATE affiliate_commissions SET settlement_id=$2, status=$3, updated_at=now() WHERE id=$1`, [c.id, stl, aff.settle ? 'settling' : 'released'])
    if (aff.settle) { await recordTransition(tx, 'affiliate_commission', c.id, 'released', 'settling', 'api', stl); await enqueue(tx, 'settle', stl) }
  })
  return commissionView(ctx, merchantId, commissionId)
}

/**
 * 4. Anulação (cancelamento, estorno, MED, fraude), segura por estado:
 *  pending: anula. released: anula se o disponível continuar >= 0 (saque Pix em andamento = recusa com exceção).
 *  settling: se nenhuma tentativa pode ter saído, segura a liquidação e anula (tentativa assinada fica suspensa pelo diário);
 *  se alguma pode ter saído, ou já pagou: recusa com exceção para humano. Nada volta sozinho.
 */
export async function voidCommission(ctx: Ctx, merchantId: string, commissionId: string, reasonCode: string, occurredAt: Date) {
  affiliatesOn(ctx)
  if (!/^[a-z0-9_]{2,64}$/.test(reasonCode)) throw new DomainError('invalid_reason_code', 'reason_code deve ser um código simples (a-z, 0-9, _)')
  const refusal = await withTx(ctx.db, async tx => {
    const c = await lockCommission(tx, merchantId, commissionId)
    if (c.status === 'voided') return null
    if (c.status === 'settled') return { code: 'already_settled', state: c.status, detail: 'comissão já paga na cadeia: a devolução precisa de uma pessoa (exceção registrada)' }
    if (c.status === 'settling') {
      const sent = (await tx.query(`SELECT count(*)::int AS n FROM settlement_attempts WHERE settlement_id=$1 AND status = ANY($2)`, [c.settlement_id, MAYBE_SENT])).rows[0].n
      if (sent > 0) return { code: 'payout_in_flight', state: c.status, detail: 'o pagamento pode já ter saído para a rede: fica para reconciliação e uma pessoa (exceção registrada)' }
      const attempts = (await tx.query(`SELECT count(*)::int AS n FROM settlement_attempts WHERE settlement_id=$1`, [c.settlement_id])).rows[0].n
      // Nada saiu: segura a liquidação ANTES de anular; sem tentativa, a liquidação encerra; com tentativa reservada/assinada, o diário a suspende com motivo.
      await tx.query(`UPDATE settlements SET hold_reason='commission_voided', status=CASE WHEN $2::int = 0 THEN 'failed' ELSE status END, updated_at=now() WHERE id=$1`, [c.settlement_id, attempts])
      await recordTransition(tx, 'settlement', c.settlement_id, null, attempts === 0 ? 'failed' : 'held', 'affiliate_void', `commission_voided:${c.id}`)
    }
    if (c.status === 'released' && c.settlement_id) {
      await tx.query(`UPDATE settlements SET hold_reason='commission_voided', status='failed', updated_at=now() WHERE id=$1 AND status IN ('intent_recorded','in_progress')`, [c.settlement_id])
      await recordTransition(tx, 'settlement', c.settlement_id, null, 'failed', 'affiliate_void', `commission_voided:${c.id}`)
    }
    if (c.status === 'released' || c.status === 'settling') {
      const bal = await balances(tx, c.beneficiary_id)
      const counts = c.custody === 'pool' // só o que entrou no disponível custodiado sai dele
      if (counts && bal.available - BigInt(c.usd_units) < 0n) {
        return { code: 'withdrawal_in_progress', state: c.status, detail: `saque em andamento consome este crédito (disponível US$ ${fmtUsd(bal.available)}); resolva o saque (pago ou falhou) antes de anular (exceção registrada)` }
      }
    }
    await tx.query(`UPDATE affiliate_commissions SET status='voided', reason_code=$2, voided_at=$3, updated_at=now() WHERE id=$1`, [c.id, reasonCode, occurredAt])
    await recordTransition(tx, 'affiliate_commission', c.id, c.status, 'voided', 'api', reasonCode)
    await tx.query(`INSERT INTO affiliate_ledger (beneficiary_id, kind, usd_units, ref_kind, ref_id, op_key) VALUES ($1,'void',$2,'commission',$3,$4)`,
      [c.beneficiary_id, (-BigInt(c.usd_units)).toString(), c.id, `void:${c.id}`])
    return null
  })
  if (refusal) {
    // Exceção durável em transação própria (a recusa não pode apagar o registro); uma por motivo.
    await withTx(ctx.db, async tx => {
      const dup = (await tx.query(`SELECT 1 FROM state_transitions WHERE entity='affiliate_exception' AND entity_id=$1 AND reason=$2`, [commissionId, reasonCode])).rowCount
      if (!dup) await recordTransition(tx, 'affiliate_exception', commissionId, refusal.state, 'affiliate_clawback_needed', 'api', reasonCode)
    })
    throw new DomainError(refusal.code, refusal.detail, 409)
  }
  return commissionView(ctx, merchantId, commissionId)
}

/**
 * Pagamento que falhou no diário (max_attempts etc.): o lojista pede nova intenção para a MESMA comissão. Só quando a
 * liquidação anterior está `failed` sem tentativa que possa ter saído e a comissão não foi anulada; nada é debitado de novo
 * (a razão não muda: o direito já existia), a liquidação antiga fica como histórico e a nova nasce com memo igual.
 */
export async function retryCommissionPayout(ctx: Ctx, merchantId: string, commissionId: string) {
  const aff = affiliatesOn(ctx)
  await withTx(ctx.db, async tx => {
    const c = await lockCommission(tx, merchantId, commissionId)
    if (c.status !== 'settling' && c.status !== 'released') throw new DomainError('commission_not_payable', `comissão está ${c.status}; só liberada ou em liquidação pode ter o pagamento refeito`, 409)
    if (!c.settlement_id) throw new DomainError('no_payout', 'comissão liberada sem intenção de pagamento (sem carteira e sem pool); cadastre o destino e libere de novo', 409)
    const s = (await tx.query(`SELECT * FROM settlements WHERE id=$1 FOR UPDATE`, [c.settlement_id])).rows[0]
    if (s.status !== 'failed') throw new DomainError('payout_not_failed', `a liquidação está ${s.status}; só uma liquidação falhada pode ser refeita`, 409)
    const sent = (await tx.query(`SELECT count(*)::int AS n FROM settlement_attempts WHERE settlement_id=$1 AND status = ANY($2)`, [s.id, MAYBE_SENT])).rows[0].n
    if (sent > 0) throw new DomainError('payout_in_flight', 'uma tentativa da liquidação anterior pode ter saído para a rede; reconcilie antes de refazer', 409)
    const b = (await tx.query(`SELECT * FROM affiliate_beneficiaries WHERE id=$1`, [c.beneficiary_id])).rows[0]
    const policy = await policyOf(tx, merchantId)
    const recipient: string | null = c.custody === 'own_wallet' ? b.payout_address : (policy.pool_address ?? null)
    if (!recipient) throw new DomainError('no_payout_address', 'sem destino para o pagamento (carteira própria ou pool do lojista)', 409)
    const stl = newId('stl')
    const hold = aff.settle ? null : 'affiliate_settle_off'
    const nth = (await tx.query(`SELECT count(*)::int AS n FROM settlements WHERE kind='affiliate_payout' AND memo LIKE $1 || '%'`, [memoPrefix(c.id)])).rows[0].n + 1
    if (nth > 9) throw new DomainError('payout_retries_exhausted', 'nove liquidações para a mesma comissão; fica para uma pessoa', 409)
    await tx.query(
      `INSERT INTO settlements (id, order_id, kind, beneficiary_ref, chain_id, token, sender, recipient, amount_units, memo, status, hold_reason)
       VALUES ($1,NULL,'affiliate_payout',$2,$3,$4,$5,$6,$7,$8,'intent_recorded',$9)`,
      [stl, b.beneficiary_ref, ctx.chain.chainId, ctx.chain.token, ctx.chain.treasury, recipient, String(c.usd_units), memoOf(c.id, nth), hold],
    )
    await recordTransition(tx, 'settlement', stl, null, 'intent_recorded', 'affiliate_retry', JSON.stringify({ commission: c.id, replaces: s.id, attempt: nth, hold }))
    await tx.query(`UPDATE affiliate_commissions SET settlement_id=$2, status=$3, updated_at=now() WHERE id=$1`, [c.id, stl, aff.settle ? 'settling' : 'released'])
    await recordTransition(tx, 'affiliate_commission', c.id, c.status, aff.settle ? 'settling' : 'released', 'api', `retry_payout:${s.id}->${stl}`)
    if (aff.settle) await enqueue(tx, 'settle', stl)
  })
  return commissionView(ctx, merchantId, commissionId)
}

/**
 * Ao ligar a liquidação (AFFILIATE_SETTLE=1 numa instalação que antes gravava só a intenção): liquidações de afiliados paradas
 * por affiliate_settle_off, sem tentativa ativa, voltam para a fila; a comissão liberada passa a settling. Nada mais é tocado.
 */
export async function resumeAffiliateSettlements(ctx: Ctx): Promise<number> {
  if (!ctx.affiliates?.settle) return 0
  return withTx(ctx.db, async tx => {
    const rows = (await tx.query(
      `SELECT s.id FROM settlements s WHERE s.kind='affiliate_payout' AND s.status IN ('intent_recorded','in_progress')
          AND (s.hold_reason IS NULL OR s.hold_reason='affiliate_settle_off')
          AND NOT EXISTS (SELECT 1 FROM settlement_attempts a WHERE a.settlement_id=s.id AND a.status IN ('nonce_reserved','signed','suspended','broadcast_pending','broadcast_sent','unknown','manual_review','confirmed'))
        ORDER BY s.created_at FOR UPDATE`)).rows
    for (const r of rows) {
      await tx.query(`UPDATE settlements SET hold_reason=NULL, updated_at=now() WHERE id=$1 AND hold_reason='affiliate_settle_off'`, [r.id])
      const c = (await tx.query(`UPDATE affiliate_commissions SET status='settling', updated_at=now() WHERE settlement_id=$1 AND status='released' RETURNING id`, [r.id])).rows[0]
      if (c) await recordTransition(tx, 'affiliate_commission', c.id, 'released', 'settling', 'resume', r.id)
      await recordTransition(tx, 'settlement', r.id, null, 'resumed', 'affiliate_resume', 'affiliate_settle_on')
      await enqueue(tx, 'settle', r.id)
    }
    return rows.length
  })
}

async function lockCommission(tx: Tx, merchantId: string, commissionId: string) {
  const row = (await tx.query(`SELECT beneficiary_id FROM affiliate_commissions WHERE id=$1 AND merchant_id=$2`, [commissionId, merchantId])).rows[0]
  if (!row) throw new DomainError('commission_not_found', 'comissão desconhecida', 404)
  await txLock(tx, benKey(row.beneficiary_id))
  return (await tx.query(`SELECT * FROM affiliate_commissions WHERE id=$1 FOR UPDATE`, [commissionId])).rows[0]
}

export async function registerWallet(ctx: Ctx, merchantId: string, ref: string, address: string) {
  affiliatesOn(ctx)
  if (!ADDRESS.test(address)) throw new DomainError('invalid_address', 'endereço deve ser 0x com 40 caracteres hexadecimais')
  return withTx(ctx.db, async tx => {
    const b = await beneficiaryOf(tx, merchantId, ref)
    await txLock(tx, benKey(b.id))
    await tx.query(`UPDATE affiliate_beneficiaries SET payout_address=$2, updated_at=now() WHERE id=$1`, [b.id, address])
    await recordTransition(tx, 'affiliate_beneficiary', b.id, b.payout_address ? 'wallet' : 'pool', 'wallet', 'api', address)
    return { beneficiary_ref: ref, payout: { mode: 'own_wallet', address } }
  })
}

/**
 * Saldos derivados dos estados (a razão é a trilha de auditoria). O direito disponível é só o custodiado no pool:
 * comissão paga direto na carteira própria já saiu e nunca entra em "disponível".
 */
export async function balances(tx: Tx | Ctx['db'], beneficiaryId: string) {
  const q = async (sql: string) => BigInt((await tx.query(sql, [beneficiaryId])).rows[0].s ?? '0')
  const pending = await q(`SELECT coalesce(sum(usd_units),0)::text AS s FROM affiliate_commissions WHERE beneficiary_id=$1 AND status='pending'`)
  const custodied = await q(`SELECT coalesce(sum(usd_units),0)::text AS s FROM affiliate_commissions WHERE beneficiary_id=$1 AND status IN ('released','settling','settled') AND custody='pool'`)
  const paidToWallet = await q(`SELECT coalesce(sum(usd_units),0)::text AS s FROM affiliate_commissions WHERE beneficiary_id=$1 AND status='settled' AND custody='own_wallet'`)
  const inFlightToWallet = await q(`SELECT coalesce(sum(usd_units),0)::text AS s FROM affiliate_commissions WHERE beneficiary_id=$1 AND status IN ('released','settling') AND custody='own_wallet'`)
  const withdrawn = await q(`SELECT coalesce(sum(usd_units),0)::text AS s FROM affiliate_withdrawals WHERE beneficiary_id=$1 AND status IN ('requested','paid','settling','settled')`)
  return { pending, available: custodied - withdrawn, withdrawn, paidToWallet, inFlightToWallet }
}

/** 5. Simulação de saque: números exatos, cotação de venda travada por lockTtlMs, uso único. */
export async function simulateWithdrawal(ctx: Ctx, merchantId: string, ref: string, kind: 'pix' | 'wallet', usdUnits: bigint) {
  const aff = affiliatesOn(ctx)
  if (kind !== 'pix' && kind !== 'wallet') throw new DomainError('invalid_kind', 'kind deve ser pix ou wallet')
  if (usdUnits <= 0n) throw new DomainError('invalid_amount', 'usd_units deve ser positivo')
  const quote = kind === 'pix' ? await freshQuote(ctx) : null
  return withTx(ctx.db, async tx => {
    const b = await beneficiaryOf(tx, merchantId, ref)
    await txLock(tx, benKey(b.id))
    const bal = await balances(tx, b.id)
    if (usdUnits > bal.available) throw new DomainError('insufficient_available', `disponível US$ ${fmtUsd(bal.available)}, pedido US$ ${fmtUsd(usdUnits)}`, 422)
    if (kind === 'wallet' && !b.payout_address) throw new DomainError('no_wallet', 'cadastre a carteira própria antes de enviar para ela', 422)
    const policy = await policyOf(tx, merchantId)
    const id = newId('qlk')
    const expiresAt = new Date(ctx.now().getTime() + aff.lockTtlMs)
    let gross = 0n, fee = 0n, net = 0n, rateNum = 0n, rateDen = 1n, source = 'none'
    if (kind === 'pix' && quote) {
      const n = pixNet(usdUnits, quote.sell, policy.withdrawal_fee_bps, BigInt(policy.withdrawal_fee_minor))
      gross = n.grossMinor; fee = n.feeMinor; net = n.netMinor; rateNum = quote.sell.rateNum; rateDen = quote.sell.rateDen; source = quote.source
    }
    await tx.query(
      `INSERT INTO affiliate_quote_locks (id, beneficiary_id, kind, usd_units, rate_num, rate_den, quote_source, gross_minor, fee_minor, net_minor, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, b.id, kind, usdUnits.toString(), rateNum.toString(), rateDen.toString(), source, gross.toString(), fee.toString(), net.toString(), expiresAt],
    )
    return {
      lock_id: id, kind, usd_units: usdUnits.toString(), usd: fmtUsd(usdUnits),
      rate: kind === 'pix' && quote ? { price4: quote.price4.toString(), source: quote.source, at: quote.at.toISOString(), age_s: quote.ageS, side: 'sell' } : null,
      gross_minor: gross.toString(), fee_minor: fee.toString(), net_minor: net.toString(),
      gross_brl: fmtBrl(gross), fee_brl: fmtBrl(fee), net_brl: fmtBrl(net),
      expires_at: expiresAt.toISOString(),
      message: kind === 'pix' ? `Você recebe exatamente R$ ${fmtBrl(net)} por Pix (US$ ${fmtUsd(usdUnits)}, custo R$ ${fmtBrl(fee)}).` : `Enviar US$ ${fmtUsd(usdUnits)} para a sua carteira na Tempo, sem custo.`,
    }
  })
}

/** 5. Saque: Pix = promessa gravada e paga pelo lojista do fluxo de reais (netting); carteira = liquidação on-chain. */
export async function createWithdrawal(ctx: Ctx, merchantId: string, lockId: string) {
  const aff = affiliatesOn(ctx)
  const id = await withTx(ctx.db, async tx => {
    const l = (await tx.query(`SELECT l.*, b.merchant_id, b.payout_address, b.beneficiary_ref FROM affiliate_quote_locks l JOIN affiliate_beneficiaries b ON b.id=l.beneficiary_id WHERE l.id=$1`, [lockId])).rows[0]
    if (!l || l.merchant_id !== merchantId) throw new DomainError('lock_not_found', 'simulação desconhecida', 404)
    await txLock(tx, benKey(l.beneficiary_id))
    const existing = (await tx.query(`SELECT id FROM affiliate_withdrawals WHERE lock_id=$1`, [lockId])).rows[0]
    if (existing) return existing.id as string // idempotente
    if (l.used_at) throw new DomainError('lock_used', 'esta simulação já foi usada', 409)
    if (new Date(l.expires_at).getTime() <= ctx.now().getTime()) throw new DomainError('lock_expired', 'a cotação travada venceu; simule de novo para ver o valor atual', 409)
    const bal = await balances(tx, l.beneficiary_id)
    const usd = BigInt(l.usd_units)
    if (usd > bal.available) throw new DomainError('insufficient_available', `disponível US$ ${fmtUsd(bal.available)}, pedido US$ ${fmtUsd(usd)}`, 422)
    const id = newId('wdr')
    await tx.query(`UPDATE affiliate_quote_locks SET used_at=now() WHERE id=$1`, [lockId])
    if (l.kind === 'pix') {
      await tx.query(`INSERT INTO affiliate_withdrawals (id, beneficiary_id, kind, lock_id, usd_units, net_minor, fee_minor, status) VALUES ($1,$2,'pix',$3,$4,$5,$6,'requested')`,
        [id, l.beneficiary_id, lockId, l.usd_units, l.net_minor, l.fee_minor])
      await tx.query(`INSERT INTO affiliate_ledger (beneficiary_id, kind, usd_units, ref_kind, ref_id, op_key) VALUES ($1,'withdraw_pix',$2,'withdrawal',$3,$4)`,
        [l.beneficiary_id, (-usd).toString(), id, `withdraw:${id}`])
      await recordTransition(tx, 'affiliate_withdrawal', id, null, 'requested', 'api', JSON.stringify({ net_minor: String(l.net_minor), fee_minor: String(l.fee_minor) }))
      return id
    }
    if (!l.payout_address) throw new DomainError('no_wallet', 'cadastre a carteira própria antes de enviar para ela', 422)
    const stl = newId('stl')
    const hold = aff.settle ? null : 'affiliate_settle_off'
    await tx.query(
      `INSERT INTO settlements (id, order_id, kind, beneficiary_ref, chain_id, token, sender, recipient, amount_units, memo, status, hold_reason)
       VALUES ($1,NULL,'affiliate_payout',$2,$3,$4,$5,$6,$7,$8,'intent_recorded',$9)`,
      [stl, l.beneficiary_ref, ctx.chain.chainId, ctx.chain.token, ctx.chain.treasury, l.payout_address, l.usd_units, memoOf(id), hold],
    )
    await tx.query(`INSERT INTO affiliate_withdrawals (id, beneficiary_id, kind, lock_id, usd_units, net_minor, fee_minor, status, settlement_id) VALUES ($1,$2,'wallet',$3,$4,0,0,'settling',$5)`,
      [id, l.beneficiary_id, lockId, l.usd_units, stl])
    await tx.query(`INSERT INTO affiliate_ledger (beneficiary_id, kind, usd_units, ref_kind, ref_id, op_key) VALUES ($1,'withdraw_wallet',$2,'withdrawal',$3,$4)`,
      [l.beneficiary_id, (-usd).toString(), id, `withdraw:${id}`])
    await recordTransition(tx, 'settlement', stl, null, 'intent_recorded', 'affiliate_withdrawal', JSON.stringify({ withdrawal: id, hold }))
    await recordTransition(tx, 'affiliate_withdrawal', id, null, 'settling', 'api', stl)
    if (aff.settle) await enqueue(tx, 'settle', stl)
    return id
  })
  return withdrawalView(ctx, merchantId, id)
}

/** Pix pago/falhou é DECLARAÇÃO do lojista (id fim a fim guardado); o produto não verifica no provedor e diz isso em todas as vistas. */
export async function markWithdrawal(ctx: Ctx, merchantId: string, withdrawalId: string, outcome: 'paid' | 'failed', detail: { pixE2eId?: string; reasonCode?: string }) {
  affiliatesOn(ctx)
  await withTx(ctx.db, async tx => {
    const w = (await tx.query(`SELECT w.*, b.merchant_id FROM affiliate_withdrawals w JOIN affiliate_beneficiaries b ON b.id=w.beneficiary_id WHERE w.id=$1`, [withdrawalId])).rows[0]
    if (!w || w.merchant_id !== merchantId) throw new DomainError('withdrawal_not_found', 'saque desconhecido', 404)
    await txLock(tx, benKey(w.beneficiary_id))
    const cur = (await tx.query(`SELECT * FROM affiliate_withdrawals WHERE id=$1 FOR UPDATE`, [withdrawalId])).rows[0]
    if (cur.kind !== 'pix') throw new DomainError('not_pix', 'saque para carteira é confirmado pela cadeia, não pelo lojista', 409)
    if (cur.status === outcome) return
    if (cur.status !== 'requested') throw new DomainError('withdrawal_not_requested', `saque está ${cur.status}`, 409)
    if (outcome === 'paid') {
      if (!detail.pixE2eId || !/^[A-Za-z0-9]{8,64}$/.test(detail.pixE2eId)) throw new DomainError('invalid_pix_e2e_id', 'informe o id fim a fim do Pix pago')
      await tx.query(`UPDATE affiliate_withdrawals SET status='paid', pix_e2e_id=$2, updated_at=now() WHERE id=$1`, [withdrawalId, detail.pixE2eId])
      await recordTransition(tx, 'affiliate_withdrawal', withdrawalId, 'requested', 'paid', 'api', 'declared_by_merchant')
    } else {
      const rc = detail.reasonCode ?? 'unspecified'
      if (!/^[a-z0-9_]{2,64}$/.test(rc)) throw new DomainError('invalid_reason_code', 'reason_code deve ser um código simples (a-z, 0-9, _)')
      await tx.query(`UPDATE affiliate_withdrawals SET status='failed', reason_code=$2, updated_at=now() WHERE id=$1`, [withdrawalId, rc])
      await tx.query(`INSERT INTO affiliate_ledger (beneficiary_id, kind, usd_units, ref_kind, ref_id, op_key) VALUES ($1,'withdraw_pix_reversal',$2,'withdrawal',$3,$4) ON CONFLICT (op_key) DO NOTHING`,
        [cur.beneficiary_id, String(cur.usd_units), withdrawalId, `reversal:${withdrawalId}`])
      await recordTransition(tx, 'affiliate_withdrawal', withdrawalId, 'requested', 'failed', 'api', rc)
    }
  })
  return withdrawalView(ctx, merchantId, withdrawalId)
}

// ------------------------------------------------------------------ leituras

const iso = (x: any) => (x ? new Date(x).toISOString() : null)
const COMMISSION_SELECT = `SELECT c.*, b.beneficiary_ref, b.kind AS b_kind, s.status AS s_status, s.recipient, s.memo, s.hold_reason,
            (SELECT tx_hash FROM settlement_attempts a WHERE a.settlement_id=s.id AND a.status='confirmed' LIMIT 1) AS tx_hash,
            (SELECT id FROM affiliate_receipts r WHERE r.settlement_id=s.id) AS receipt_id
       FROM affiliate_commissions c JOIN affiliate_beneficiaries b ON b.id=c.beneficiary_id LEFT JOIN settlements s ON s.id=c.settlement_id`
const WITHDRAWAL_SELECT = `SELECT w.*, b.beneficiary_ref, b.merchant_id, s.status AS s_status, s.hold_reason, s.recipient, s.memo,
            (SELECT tx_hash FROM settlement_attempts a WHERE a.settlement_id=s.id AND a.status='confirmed' LIMIT 1) AS tx_hash,
            (SELECT id FROM affiliate_receipts r WHERE r.settlement_id=s.id) AS receipt_id
       FROM affiliate_withdrawals w JOIN affiliate_beneficiaries b ON b.id=w.beneficiary_id LEFT JOIN settlements s ON s.id=w.settlement_id`

export async function commissionView(ctx: Ctx, merchantId: string, id: string) {
  const c = (await ctx.db.query(`${COMMISSION_SELECT} WHERE c.id=$1 AND c.merchant_id=$2`, [id, merchantId])).rows[0]
  if (!c) throw new DomainError('commission_not_found', 'comissão desconhecida', 404)
  return projectCommission(c)
}

/** Visão do lojista (chave): tudo que o lojista precisa, inclusive destino e ids de origem. */
export function projectCommission(c: any) {
  const usd = BigInt(c.usd_units)
  return {
    id: c.id, source_event_id: c.source_event_id, order_ref: c.order_ref, beneficiary_ref: c.beneficiary_ref, kind: c.b_kind,
    status: c.status, reason_code: c.reason_code, custody: c.custody,
    amount: { amount: String(c.amount_minor), currency: 'BRL', scale: 2, brl: fmtBrl(BigInt(c.amount_minor)) },
    usd: { units: usd.toString(), scale: 6, usd: fmtUsd(usd) },
    quote: { rate_num: String(c.rate_num), rate_den: String(c.rate_den), source: c.quote_source, at: iso(c.quote_at), hash: c.quote_hash, fee_bps: c.fee_bps, mode: c.quote_mode },
    occurred_at: iso(c.occurred_at), released_at: iso(c.released_at), voided_at: iso(c.voided_at),
    payout: c.settlement_id ? { settlement_id: c.settlement_id, status: c.s_status, hold_reason: c.hold_reason, to: c.recipient, memo: c.memo, tx_hash: c.tx_hash ?? null, receipt_id: c.receipt_id ?? null } : null,
    trace: { source_event_id: c.source_event_id, commission_id: c.id, settlement_id: c.settlement_id ?? null, tx_hash: c.tx_hash ?? null, receipt_id: c.receipt_id ?? null },
  }
}

/** Projeção PÚBLICA por lista permitida: sem destino, sem ids de origem, sem referência do pedido. */
export function publicCommission(c: any) {
  const p = projectCommission(c)
  return {
    id: p.id, status: p.status, reason_code: p.reason_code, custody: p.custody, amount: p.amount, usd: p.usd, quote: p.quote,
    occurred_at: p.occurred_at, released_at: p.released_at, voided_at: p.voided_at,
    payout: p.payout ? { status: p.payout.status, hold_reason: p.payout.hold_reason, memo: p.payout.memo, tx_hash: p.payout.tx_hash, receipt_id: p.payout.receipt_id } : null,
  }
}

export async function withdrawalView(ctx: Ctx, merchantId: string, id: string) {
  const w = (await ctx.db.query(`${WITHDRAWAL_SELECT} WHERE w.id=$1`, [id])).rows[0]
  if (!w || w.merchant_id !== merchantId) throw new DomainError('withdrawal_not_found', 'saque desconhecido', 404)
  return projectWithdrawal(w)
}

export function projectWithdrawal(w: any) {
  return {
    id: w.id, beneficiary_ref: w.beneficiary_ref, kind: w.kind, status: w.status, reason_code: w.reason_code,
    /** Pix: "paid" é declaração do lojista com o id fim a fim; carteira: "settled" é confirmação observada na cadeia. */
    evidence: w.kind === 'pix' ? (w.status === 'paid' ? 'declared_by_merchant' : 'promise') : (w.status === 'settled' ? 'chain_confirmed' : 'pending_chain'),
    usd: { units: String(w.usd_units), usd: fmtUsd(BigInt(w.usd_units)) },
    net: { amount: String(w.net_minor), currency: 'BRL', scale: 2, brl: fmtBrl(BigInt(w.net_minor)) },
    fee: { amount: String(w.fee_minor), currency: 'BRL', scale: 2, brl: fmtBrl(BigInt(w.fee_minor)) },
    pix_e2e_id: w.pix_e2e_id ?? null,
    payout: w.settlement_id ? { settlement_id: w.settlement_id, status: w.s_status, hold_reason: w.hold_reason, to: w.recipient, memo: w.memo, tx_hash: w.tx_hash ?? null, receipt_id: w.receipt_id ?? null } : null,
    created_at: iso(w.created_at), updated_at: iso(w.updated_at),
  }
}

/** Projeção PÚBLICA do saque: sem destino e sem id fim a fim do Pix. */
export function publicWithdrawal(w: any) {
  const p = projectWithdrawal(w)
  return {
    id: p.id, kind: p.kind, status: p.status, reason_code: p.reason_code, evidence: p.evidence, usd: p.usd, net: p.net, fee: p.fee,
    payout: p.payout ? { status: p.payout.status, hold_reason: p.payout.hold_reason, memo: p.payout.memo, tx_hash: p.payout.tx_hash, receipt_id: p.payout.receipt_id } : null,
    created_at: p.created_at, updated_at: p.updated_at,
  }
}

const chainEnv = (ctx: Ctx) => (ctx.chain.chainId === 42431 ? 'testnet' : ctx.chain.chainId === 4217 ? 'mainnet' : `chain_${ctx.chain.chainId}`)

/** Visão do beneficiário: saldos em dólar e em reais de agora, comissões e saques. `pub` = lista permitida pública. */
export async function beneficiaryView(ctx: Ctx, merchantId: string, ref: string, pub = false) {
  const b = (await ctx.db.query(`SELECT * FROM affiliate_beneficiaries WHERE merchant_id=$1 AND beneficiary_ref=$2`, [merchantId, ref])).rows[0]
  if (!b) throw new DomainError('beneficiary_not_found', 'beneficiário desconhecido', 404)
  const bal = await balances(ctx.db, b.id)
  const q = await affiliatesOn(ctx).quotes.quote(ctx.now())
  const brlNow = (u: bigint) => (q.ok ? fmtBrl((u * q.quote.sell.rateNum) / q.quote.sell.rateDen) : null)
  const commissions = (await ctx.db.query(`${COMMISSION_SELECT} WHERE c.beneficiary_id=$1 ORDER BY c.occurred_at DESC, c.id DESC LIMIT 200`, [b.id])).rows.map(pub ? publicCommission : projectCommission)
  const withdrawals = (await ctx.db.query(`${WITHDRAWAL_SELECT} WHERE w.beneficiary_id=$1 ORDER BY w.created_at DESC LIMIT 100`, [b.id])).rows.map(pub ? publicWithdrawal : projectWithdrawal)
  const usdOf = (u: bigint) => ({ units: u.toString(), usd: fmtUsd(u) })
  return {
    beneficiary_ref: ref, kind: b.kind,
    payout: pub ? { mode: b.payout_address ? 'own_wallet' : 'pool' } : (b.payout_address ? { mode: 'own_wallet', address: b.payout_address } : { mode: 'pool' }),
    currency: { symbol: 'USD', token: ctx.chain.token, chain_id: ctx.chain.chainId, chain_env: chainEnv(ctx), note: 'digital dollar on the Tempo network' },
    balances: {
      pending: { ...usdOf(bal.pending), brl_now: brlNow(bal.pending) },
      available: { ...usdOf(bal.available), brl_now: brlNow(bal.available) },
      withdrawn: usdOf(bal.withdrawn),
      paid_to_own_wallet: usdOf(bal.paidToWallet),
      in_flight_to_own_wallet: usdOf(bal.inFlightToWallet),
    },
    rate_now: q.ok ? { price4: q.quote.price4.toString(), brl_per_usd: (Number(q.quote.price4) / 10_000).toFixed(4), source: q.quote.source, at: q.quote.at.toISOString(), age_s: q.quote.ageS } : { unavailable: q.detail },
    commissions, withdrawals,
  }
}

/** Agregado do lojista (público quando o lojista público está configurado): contagens e somas; exceções no mesmo escopo. */
export async function aggregateView(ctx: Ctx, merchantId: string) {
  const r = (await ctx.db.query(
    `SELECT count(DISTINCT c.beneficiary_id)::int AS beneficiaries, count(*)::int AS commissions,
            coalesce(sum(c.amount_minor),0)::text AS brl_minor, coalesce(sum(c.usd_units),0)::text AS usd_units,
            count(*) FILTER (WHERE c.status='pending')::int AS pending, count(*) FILTER (WHERE c.status='released')::int AS released,
            count(*) FILTER (WHERE c.status='settling')::int AS settling, count(*) FILTER (WHERE c.status='settled')::int AS settled,
            count(*) FILTER (WHERE c.status='voided')::int AS voided, count(*) FILTER (WHERE c.status='failed')::int AS failed,
            count(*) FILTER (WHERE c.quote_mode='backfill')::int AS backfill,
            coalesce(sum(c.usd_units) FILTER (WHERE c.status='settled'),0)::text AS usd_settled
       FROM affiliate_commissions c WHERE c.merchant_id=$1`, [merchantId])).rows[0]
  const w = (await ctx.db.query(
    `SELECT count(*)::int AS withdrawals, count(*) FILTER (WHERE w.kind='pix' AND w.status='paid')::int AS pix_paid_declared,
            count(*) FILTER (WHERE w.kind='pix' AND w.status='requested')::int AS pix_requested,
            count(*) FILTER (WHERE w.kind='wallet' AND w.status='settled')::int AS wallet_settled,
            coalesce(sum(w.net_minor) FILTER (WHERE w.kind='pix' AND w.status='paid'),0)::text AS brl_paid_minor
       FROM affiliate_withdrawals w JOIN affiliate_beneficiaries b ON b.id=w.beneficiary_id WHERE b.merchant_id=$1`, [merchantId])).rows[0]
  const exceptions = (await ctx.db.query(
    `SELECT count(*)::int AS n FROM state_transitions t JOIN affiliate_commissions c ON c.id=t.entity_id WHERE t.entity='affiliate_exception' AND c.merchant_id=$1`, [merchantId])).rows[0].n
  const sample = (await ctx.db.query(`SELECT b.beneficiary_ref FROM affiliate_beneficiaries b WHERE b.merchant_id=$1 ORDER BY (SELECT count(*) FROM affiliate_commissions c WHERE c.beneficiary_id=b.id) DESC, b.id LIMIT 3`, [merchantId])).rows.map(r => r.beneficiary_ref as string)
  const q = await affiliatesOn(ctx).quotes.quote(ctx.now())
  return {
    beneficiaries: r.beneficiaries, commissions: r.commissions,
    brl: { amount: r.brl_minor, brl: fmtBrl(BigInt(r.brl_minor)) }, usd: { units: r.usd_units, usd: fmtUsd(BigInt(r.usd_units)) },
    by_status: { pending: r.pending, released: r.released, settling: r.settling, settled: r.settled, voided: r.voided, failed: r.failed },
    quote_modes: { backfill: r.backfill, at_pix: r.commissions - r.backfill },
    usd_settled_on_chain: { units: r.usd_settled, usd: fmtUsd(BigInt(r.usd_settled)) },
    withdrawals: { total: w.withdrawals, pix_requested: w.pix_requested, pix_paid_declared: w.pix_paid_declared, wallet_settled: w.wallet_settled, brl_paid_declared: fmtBrl(BigInt(w.brl_paid_minor)) },
    exceptions_for_human: exceptions, sample_refs: sample, // pseudônimos do lojista público: páginas públicas de exemplo
    rate_now: q.ok ? { brl_per_usd: (Number(q.quote.price4) / 10_000).toFixed(4), source: q.quote.source, at: q.quote.at.toISOString(), age_s: q.quote.ageS } : { unavailable: q.detail },
    currency: { symbol: 'USD', token: ctx.chain.token, chain_id: ctx.chain.chainId, chain_env: chainEnv(ctx) },
    evidence: { pix: 'declared_by_merchant', wallet: 'chain_confirmed', settlement: ctx.affiliates?.settle ? 'enabled' : 'disabled' },
  }
}
