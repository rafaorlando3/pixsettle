// Fase 2: comissões de afiliados em dólar digital (docs/affiliate-payouts.md). Regras de domínio, só banco.
// Toda recusa é DomainError com código estável e mensagem simples; toda mudança de estado grava transição.
import { ulid } from 'ulid'
import { withTx, txLock, recordTransition, enqueue, type Tx } from '../db.js'
import { DomainError } from '../flows/orders.js'
import type { Ctx } from '../context.js'
import { fixUsdUnits, pixNet, fmtUsd, fmtBrl } from './money.js'
import type { UsdQuote } from './quotes.js'

export type BeneficiaryKind = 'affiliate' | 'partner_percent'
export const BENEFICIARY_KINDS: readonly BeneficiaryKind[] = ['affiliate', 'partner_percent']
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const REF = /^[A-Za-z0-9._:-]{8,128}$/
const SOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/

export type CommissionInput = {
  sourceEventId: string; beneficiaryRef: string; kind: BeneficiaryKind; orderRef?: string | null
  amountMinor: bigint; occurredAt: Date
}

const newId = (p: 'ben' | 'com' | 'qlk' | 'wdr' | 'stl' | 'rct') => `${p}_${ulid()}`
const memoOf = (id: string) => '0x' + Buffer.concat([Buffer.from(id, 'ascii'), Buffer.alloc(32 - id.length)]).toString('hex')
const benKey = (beneficiaryId: string) => `affiliate:${beneficiaryId}`

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

async function ensureBeneficiary(tx: Tx, merchantId: string, ref: string, kind: BeneficiaryKind) {
  const existing = (await tx.query(`SELECT * FROM affiliate_beneficiaries WHERE merchant_id=$1 AND beneficiary_ref=$2`, [merchantId, ref])).rows[0]
  if (existing) {
    if (existing.kind !== kind) throw new DomainError('beneficiary_kind_mismatch', `beneficiário já cadastrado como ${existing.kind}`, 409)
    return existing
  }
  const id = newId('ben')
  await tx.query(`INSERT INTO affiliate_beneficiaries (id, merchant_id, beneficiary_ref, kind) VALUES ($1,$2,$3,$4)`, [id, merchantId, ref, kind])
  await recordTransition(tx, 'affiliate_beneficiary', id, null, 'created', 'api', kind)
  return (await tx.query(`SELECT * FROM affiliate_beneficiaries WHERE id=$1`, [id])).rows[0]
}

async function beneficiaryOf(tx: Tx, merchantId: string, ref: string) {
  const b = (await tx.query(`SELECT * FROM affiliate_beneficiaries WHERE merchant_id=$1 AND beneficiary_ref=$2`, [merchantId, ref])).rows[0]
  if (!b) throw new DomainError('beneficiary_not_found', 'beneficiário desconhecido', 404)
  return b
}

/** 3. Comissão nasce em dólar no instante do Pix: cotação fixada, taxa de conversão descontada, arredondado para baixo. */
export async function createCommission(ctx: Ctx, merchantId: string, input: CommissionInput) {
  affiliatesOn(ctx)
  if (!SOURCE_ID.test(input.sourceEventId)) throw new DomainError('invalid_source_event_id', 'source_event_id inválido')
  if (!REF.test(input.beneficiaryRef)) throw new DomainError('invalid_beneficiary_ref', 'beneficiary_ref deve ser um identificador opaco (8 a 128 caracteres), nunca nome, CPF ou chave Pix')
  if (!BENEFICIARY_KINDS.includes(input.kind)) throw new DomainError('invalid_kind', 'kind deve ser affiliate ou partner_percent')
  if (input.amountMinor <= 0n) throw new DomainError('invalid_amount', 'amount deve ser positivo, em centavos')
  if (Number.isNaN(input.occurredAt.getTime())) throw new DomainError('invalid_occurred_at', 'occurred_at inválido')
  // Idempotente pela chave natural: a mesma comissão nunca é cotada duas vezes.
  const prior = (await ctx.db.query(`SELECT id FROM affiliate_commissions WHERE merchant_id=$1 AND source_event_id=$2`, [merchantId, input.sourceEventId])).rows[0]
  if (prior) return { created: false, commission: await commissionView(ctx, merchantId, prior.id) }
  const quote = await freshQuote(ctx)
  const id = await withTx(ctx.db, async tx => {
    const again = (await tx.query(`SELECT id FROM affiliate_commissions WHERE merchant_id=$1 AND source_event_id=$2`, [merchantId, input.sourceEventId])).rows[0]
    if (again) return again.id as string
    const b = await ensureBeneficiary(tx, merchantId, input.beneficiaryRef, input.kind)
    await txLock(tx, benKey(b.id))
    const policy = await policyOf(tx, merchantId)
    const { usdUnits } = fixUsdUnits(input.amountMinor, policy.conversion_fee_bps, quote.buy)
    const id = newId('com')
    await tx.query(
      `INSERT INTO affiliate_commissions (id, merchant_id, beneficiary_id, source_event_id, order_ref, amount_minor, fee_bps, usd_units, rate_num, rate_den, quote_source, quote_at, quote_hash, status, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14)`,
      [id, merchantId, b.id, input.sourceEventId, input.orderRef ?? null, input.amountMinor.toString(), policy.conversion_fee_bps, usdUnits.toString(),
        quote.buy.rateNum.toString(), quote.buy.rateDen.toString(), quote.source, quote.at, quote.hash, input.occurredAt],
    )
    await tx.query(`INSERT INTO affiliate_ledger (beneficiary_id, kind, usd_units, ref_kind, ref_id, op_key) VALUES ($1,'credit_pending',$2,'commission',$3,$4)`,
      [b.id, usdUnits.toString(), id, `credit:${id}`])
    await recordTransition(tx, 'affiliate_commission', id, null, 'pending', 'api',
      JSON.stringify({ amount_minor: input.amountMinor.toString(), usd_units: usdUnits.toString(), quote: quote.source, price4: quote.price4.toString(), age_s: quote.ageS }))
    return id
  })
  return { created: true, commission: await commissionView(ctx, merchantId, id) }
}

/** 4. Liberação: a regra do lojista diz quando; aqui a comissão vira pagamento no diário de envio. */
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
    const recipient: string | null = b.payout_address ?? policy.pool_address ?? null
    await tx.query(`UPDATE affiliate_commissions SET status='released', released_at=$2, updated_at=now() WHERE id=$1`, [c.id, occurredAt])
    await recordTransition(tx, 'affiliate_commission', c.id, 'pending', 'released', 'api')
    await tx.query(`INSERT INTO affiliate_ledger (beneficiary_id, kind, usd_units, ref_kind, ref_id, op_key) VALUES ($1,'release',0,'commission',$2,$3)`, [b.id, c.id, `release:${c.id}`])
    if (!recipient) { await recordTransition(tx, 'affiliate_commission', c.id, 'released', 'released', 'api', 'no_payout_address: sem carteira do beneficiário e sem pool do lojista'); return }
    const stl = newId('stl')
    const hold = aff.settle ? null : 'affiliate_settle_off'
    await tx.query(
      `INSERT INTO settlements (id, order_id, kind, beneficiary_ref, chain_id, token, sender, recipient, amount_units, memo, status, hold_reason)
       VALUES ($1,NULL,'affiliate_payout',$2,$3,$4,$5,$6,$7,$8,'intent_recorded',$9)`,
      [stl, b.beneficiary_ref, ctx.chain.chainId, ctx.chain.token, ctx.chain.treasury, recipient, String(c.usd_units), memoOf(c.id), hold],
    )
    await recordTransition(tx, 'settlement', stl, null, 'intent_recorded', 'affiliate_release', JSON.stringify({ commission: c.id, usd_units: String(c.usd_units), hold }))
    await tx.query(`UPDATE affiliate_commissions SET settlement_id=$2, status=$3, updated_at=now() WHERE id=$1`, [c.id, stl, aff.settle ? 'settling' : 'released'])
    if (aff.settle) { await recordTransition(tx, 'affiliate_commission', c.id, 'released', 'settling', 'api', stl); await enqueue(tx, 'settle', stl) }
  })
  return commissionView(ctx, merchantId, commissionId)
}

/** 4. Anulação (cancelamento, estorno, MED, fraude). Depois de liquidada na cadeia vira exceção para um humano. */
export async function voidCommission(ctx: Ctx, merchantId: string, commissionId: string, reasonCode: string, occurredAt: Date) {
  affiliatesOn(ctx)
  if (!/^[a-z0-9_]{2,64}$/.test(reasonCode)) throw new DomainError('invalid_reason_code', 'reason_code deve ser um código simples (a-z, 0-9, _)')
  const settledStatus = await withTx(ctx.db, async tx => {
    const c = await lockCommission(tx, merchantId, commissionId)
    if (c.status === 'voided') return null
    if (c.status === 'settled' || c.status === 'settling') return c.status as string
    await tx.query(`UPDATE affiliate_commissions SET status='voided', reason_code=$2, voided_at=$3, updated_at=now() WHERE id=$1`, [c.id, reasonCode, occurredAt])
    await recordTransition(tx, 'affiliate_commission', c.id, c.status, 'voided', 'api', reasonCode)
    await tx.query(`INSERT INTO affiliate_ledger (beneficiary_id, kind, usd_units, ref_kind, ref_id, op_key) VALUES ($1,'void',$2,'commission',$3,$4)`,
      [c.beneficiary_id, (-BigInt(c.usd_units)).toString(), c.id, `void:${c.id}`])
    if (c.settlement_id) {
      await tx.query(`UPDATE settlements SET hold_reason='commission_voided', updated_at=now() WHERE id=$1 AND status IN ('intent_recorded','in_progress')`, [c.settlement_id])
      await recordTransition(tx, 'settlement', c.settlement_id, null, 'held', 'affiliate_void', `commission_voided:${c.id}`)
    }
    return null
  })
  if (settledStatus) {
    // Exceção durável em transação própria (a recusa abaixo não pode apagar o registro); uma por motivo.
    await withTx(ctx.db, async tx => {
      const dup = (await tx.query(`SELECT 1 FROM state_transitions WHERE entity='affiliate_exception' AND entity_id=$1 AND reason=$2`, [commissionId, reasonCode])).rowCount
      if (!dup) await recordTransition(tx, 'affiliate_exception', commissionId, settledStatus, 'affiliate_clawback_needed', 'api', reasonCode)
    })
    throw new DomainError('already_settled', 'comissão já paga na cadeia: a devolução precisa de uma pessoa (exceção registrada)', 409)
  }
  return commissionView(ctx, merchantId, commissionId)
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
    return { beneficiary_ref: ref, payout_address: address }
  })
}

/** Saldos derivados dos estados (a razão é a trilha de auditoria): pendente, disponível, sacado. */
export async function balances(tx: Tx | Ctx['db'], beneficiaryId: string) {
  const q = async (sql: string) => BigInt((await tx.query(sql, [beneficiaryId])).rows[0].s ?? '0')
  const pending = await q(`SELECT coalesce(sum(usd_units),0)::text AS s FROM affiliate_commissions WHERE beneficiary_id=$1 AND status='pending'`)
  const released = await q(`SELECT coalesce(sum(usd_units),0)::text AS s FROM affiliate_commissions WHERE beneficiary_id=$1 AND status IN ('released','settling','settled')`)
  const withdrawn = await q(`SELECT coalesce(sum(usd_units),0)::text AS s FROM affiliate_withdrawals WHERE beneficiary_id=$1 AND status IN ('requested','paid','settling','settled')`)
  return { pending, available: released - withdrawn, withdrawn }
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
      await recordTransition(tx, 'affiliate_withdrawal', withdrawalId, 'requested', 'paid', 'api', detail.pixE2eId)
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

export async function commissionView(ctx: Ctx, merchantId: string, id: string) {
  const c = (await ctx.db.query(
    `SELECT c.*, b.beneficiary_ref, b.kind AS b_kind, s.status AS s_status, s.recipient, s.memo, s.hold_reason,
            (SELECT tx_hash FROM settlement_attempts a WHERE a.settlement_id=s.id AND a.status='confirmed' LIMIT 1) AS tx_hash,
            (SELECT id FROM affiliate_receipts r WHERE r.settlement_id=s.id) AS receipt_id
       FROM affiliate_commissions c JOIN affiliate_beneficiaries b ON b.id=c.beneficiary_id LEFT JOIN settlements s ON s.id=c.settlement_id
      WHERE c.id=$1 AND c.merchant_id=$2`, [id, merchantId])).rows[0]
  if (!c) throw new DomainError('commission_not_found', 'comissão desconhecida', 404)
  return projectCommission(c)
}

export function projectCommission(c: any) {
  const usd = BigInt(c.usd_units)
  return {
    id: c.id, source_event_id: c.source_event_id, order_ref: c.order_ref, beneficiary_ref: c.beneficiary_ref, kind: c.b_kind,
    status: c.status, reason_code: c.reason_code,
    amount: { amount: String(c.amount_minor), currency: 'BRL', scale: 2, brl: fmtBrl(BigInt(c.amount_minor)) },
    usd: { units: usd.toString(), scale: 6, usd: fmtUsd(usd) },
    quote: { rate_num: String(c.rate_num), rate_den: String(c.rate_den), source: c.quote_source, at: iso(c.quote_at), hash: c.quote_hash, fee_bps: c.fee_bps },
    occurred_at: iso(c.occurred_at), released_at: iso(c.released_at), voided_at: iso(c.voided_at),
    payout: c.settlement_id ? { settlement_id: c.settlement_id, status: c.s_status, hold_reason: c.hold_reason, to: c.recipient, memo: c.memo, tx_hash: c.tx_hash ?? null, receipt_id: c.receipt_id ?? null } : null,
    trace: { source_event_id: c.source_event_id, commission_id: c.id, settlement_id: c.settlement_id ?? null, tx_hash: c.tx_hash ?? null, receipt_id: c.receipt_id ?? null },
  }
}

export async function withdrawalView(ctx: Ctx, merchantId: string, id: string) {
  const w = (await ctx.db.query(
    `SELECT w.*, b.beneficiary_ref, b.merchant_id, s.status AS s_status, s.hold_reason, s.recipient, s.memo,
            (SELECT tx_hash FROM settlement_attempts a WHERE a.settlement_id=s.id AND a.status='confirmed' LIMIT 1) AS tx_hash,
            (SELECT id FROM affiliate_receipts r WHERE r.settlement_id=s.id) AS receipt_id
       FROM affiliate_withdrawals w JOIN affiliate_beneficiaries b ON b.id=w.beneficiary_id LEFT JOIN settlements s ON s.id=w.settlement_id WHERE w.id=$1`, [id])).rows[0]
  if (!w || w.merchant_id !== merchantId) throw new DomainError('withdrawal_not_found', 'saque desconhecido', 404)
  return projectWithdrawal(w)
}

export function projectWithdrawal(w: any) {
  return {
    id: w.id, beneficiary_ref: w.beneficiary_ref, kind: w.kind, status: w.status, reason_code: w.reason_code,
    usd: { units: String(w.usd_units), usd: fmtUsd(BigInt(w.usd_units)) },
    net: { amount: String(w.net_minor), currency: 'BRL', scale: 2, brl: fmtBrl(BigInt(w.net_minor)) },
    fee: { amount: String(w.fee_minor), currency: 'BRL', scale: 2, brl: fmtBrl(BigInt(w.fee_minor)) },
    pix_e2e_id: w.pix_e2e_id ?? null,
    payout: w.settlement_id ? { settlement_id: w.settlement_id, status: w.s_status, hold_reason: w.hold_reason, to: w.recipient, memo: w.memo, tx_hash: w.tx_hash ?? null, receipt_id: w.receipt_id ?? null } : null,
    created_at: iso(w.created_at), updated_at: iso(w.updated_at),
  }
}

/** Visão do beneficiário: saldos em dólar e em reais de agora, comissões e saques. Sem dado pessoal (o ref já é um hash). */
export async function beneficiaryView(ctx: Ctx, merchantId: string, ref: string) {
  const b = (await ctx.db.query(`SELECT * FROM affiliate_beneficiaries WHERE merchant_id=$1 AND beneficiary_ref=$2`, [merchantId, ref])).rows[0]
  if (!b) throw new DomainError('beneficiary_not_found', 'beneficiário desconhecido', 404)
  const bal = await balances(ctx.db, b.id)
  const q = await affiliatesOn(ctx).quotes.quote(ctx.now())
  const brlNow = (u: bigint) => (q.ok ? fmtBrl((u * q.quote.sell.rateNum) / q.quote.sell.rateDen) : null)
  const commissions = (await ctx.db.query(
    `SELECT c.*, b.beneficiary_ref, b.kind AS b_kind, s.status AS s_status, s.recipient, s.memo, s.hold_reason,
            (SELECT tx_hash FROM settlement_attempts a WHERE a.settlement_id=s.id AND a.status='confirmed' LIMIT 1) AS tx_hash,
            (SELECT id FROM affiliate_receipts r WHERE r.settlement_id=s.id) AS receipt_id
       FROM affiliate_commissions c JOIN affiliate_beneficiaries b ON b.id=c.beneficiary_id LEFT JOIN settlements s ON s.id=c.settlement_id
      WHERE c.beneficiary_id=$1 ORDER BY c.occurred_at DESC, c.id DESC LIMIT 200`, [b.id])).rows.map(projectCommission)
  const withdrawals = (await ctx.db.query(
    `SELECT w.*, b.beneficiary_ref, s.status AS s_status, s.hold_reason, s.recipient, s.memo,
            (SELECT tx_hash FROM settlement_attempts a WHERE a.settlement_id=s.id AND a.status='confirmed' LIMIT 1) AS tx_hash,
            (SELECT id FROM affiliate_receipts r WHERE r.settlement_id=s.id) AS receipt_id
       FROM affiliate_withdrawals w JOIN affiliate_beneficiaries b ON b.id=w.beneficiary_id LEFT JOIN settlements s ON s.id=w.settlement_id
      WHERE w.beneficiary_id=$1 ORDER BY w.created_at DESC LIMIT 100`, [b.id])).rows.map(projectWithdrawal)
  return {
    beneficiary_ref: ref, kind: b.kind, payout: b.payout_address ? { mode: 'own_wallet', address: b.payout_address } : { mode: 'pool' },
    currency: { symbol: 'USD', token: ctx.chain.token, chain_id: ctx.chain.chainId, note: 'dólar digital na rede Tempo' },
    balances: {
      pending: { units: bal.pending.toString(), usd: fmtUsd(bal.pending), brl_now: brlNow(bal.pending) },
      available: { units: bal.available.toString(), usd: fmtUsd(bal.available), brl_now: brlNow(bal.available) },
      withdrawn: { units: bal.withdrawn.toString(), usd: fmtUsd(bal.withdrawn) },
    },
    rate_now: q.ok ? { price4: q.quote.price4.toString(), brl_per_usd: (Number(q.quote.price4) / 10_000).toFixed(4), source: q.quote.source, at: q.quote.at.toISOString(), age_s: q.quote.ageS } : { unavailable: q.detail },
    commissions, withdrawals,
  }
}

/** Agregado público do piloto: contagens e somas, nenhum ref individual. */
export async function aggregateView(ctx: Ctx, merchantId?: string) {
  const where = merchantId ? `WHERE c.merchant_id=$1` : ''
  const args = merchantId ? [merchantId] : []
  const r = (await ctx.db.query(
    `SELECT count(DISTINCT c.beneficiary_id)::int AS beneficiaries, count(*)::int AS commissions,
            coalesce(sum(c.amount_minor),0)::text AS brl_minor, coalesce(sum(c.usd_units),0)::text AS usd_units,
            count(*) FILTER (WHERE c.status='pending')::int AS pending, count(*) FILTER (WHERE c.status='released')::int AS released,
            count(*) FILTER (WHERE c.status='settling')::int AS settling, count(*) FILTER (WHERE c.status='settled')::int AS settled,
            count(*) FILTER (WHERE c.status='voided')::int AS voided,
            coalesce(sum(c.usd_units) FILTER (WHERE c.status='settled'),0)::text AS usd_settled
       FROM affiliate_commissions c ${where}`, args)).rows[0]
  const w = (await ctx.db.query(
    `SELECT count(*)::int AS withdrawals, count(*) FILTER (WHERE w.kind='pix' AND w.status='paid')::int AS pix_paid,
            count(*) FILTER (WHERE w.kind='wallet' AND w.status='settled')::int AS wallet_settled,
            coalesce(sum(w.net_minor) FILTER (WHERE w.kind='pix' AND w.status='paid'),0)::text AS brl_paid_minor
       FROM affiliate_withdrawals w JOIN affiliate_beneficiaries b ON b.id=w.beneficiary_id ${merchantId ? 'WHERE b.merchant_id=$1' : ''}`, args)).rows[0]
  const exceptions = (await ctx.db.query(`SELECT count(*)::int AS n FROM state_transitions WHERE entity='affiliate_exception'`)).rows[0].n
  const q = await affiliatesOn(ctx).quotes.quote(ctx.now())
  return {
    beneficiaries: r.beneficiaries, commissions: r.commissions,
    brl: { amount: r.brl_minor, brl: fmtBrl(BigInt(r.brl_minor)) }, usd: { units: r.usd_units, usd: fmtUsd(BigInt(r.usd_units)) },
    by_status: { pending: r.pending, released: r.released, settling: r.settling, settled: r.settled, voided: r.voided },
    usd_settled_on_chain: { units: r.usd_settled, usd: fmtUsd(BigInt(r.usd_settled)) },
    withdrawals: { total: w.withdrawals, pix_paid: w.pix_paid, wallet_settled: w.wallet_settled, brl_paid: fmtBrl(BigInt(w.brl_paid_minor)) },
    exceptions_for_human: exceptions,
    rate_now: q.ok ? { brl_per_usd: (Number(q.quote.price4) / 10_000).toFixed(4), source: q.quote.source, at: q.quote.at.toISOString(), age_s: q.quote.ageS } : { unavailable: q.detail },
    currency: { symbol: 'USD', token: ctx.chain.token, chain_id: ctx.chain.chainId },
  }
}
