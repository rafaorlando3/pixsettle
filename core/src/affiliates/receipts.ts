// Recibo verificável de um pagamento de comissão ou de um saque para carteira (fase 2, contrato 7 do núcleo).
import { ulid } from 'ulid'
import { withTx } from '../db.js'
import type { Ctx } from '../context.js'
import { verifyEnvelope, type ReceiptEnvelope } from '../../../settlement/src/receipt.js'
import { fmtUsd, fmtBrl } from './money.js'

export async function issueAffiliateReceipt(ctx: Ctx, settlementId: string) {
  const d = (await ctx.db.query(
    `SELECT s.*, a.tx_hash, a.observed, a.updated_at AS a_upd,
            c.id AS c_id, c.source_event_id, c.order_ref, c.amount_minor, c.usd_units AS c_usd, c.fee_bps, c.rate_num, c.rate_den, c.quote_source, c.quote_at, c.quote_hash, c.quote_mode, c.custody, c.occurred_at, c.released_at,
            w.id AS w_id, w.usd_units AS w_usd, b.beneficiary_ref AS b_ref, b.kind AS b_kind
       FROM settlements s JOIN settlement_attempts a ON a.settlement_id=s.id AND a.status='confirmed'
       LEFT JOIN affiliate_commissions c ON c.settlement_id=s.id
       LEFT JOIN affiliate_withdrawals w ON w.settlement_id=s.id
       LEFT JOIN affiliate_beneficiaries b ON b.id = coalesce(c.beneficiary_id, w.beneficiary_id)
      WHERE s.id=$1 AND s.kind='affiliate_payout' AND s.status='confirmed'`, [settlementId])).rows[0]
  if (!d) return
  if ((await ctx.db.query(`SELECT 1 FROM affiliate_receipts WHERE settlement_id=$1`, [settlementId])).rowCount) return
  const obs = d.observed
  const iso = (x: any) => (x ? new Date(x).toISOString() : null)
  const receiptId = `rct_${ulid()}`
  const payload: Record<string, unknown> = {
    schema_version: 1, receipt_id: receiptId, receipt_type: d.c_id ? 'affiliate_commission_payout' : 'affiliate_wallet_withdrawal',
    issuer: ctx.cfg.issuer, provider_env: 'merchant_api', chain_env: ctx.chain.chainId === 42431 ? 'testnet' : 'mainnet', chain_id: d.chain_id, token: d.token, treasury: d.sender,
    order: { ref: null, commission_id: d.c_id ?? null, withdrawal_id: d.w_id ?? null }, // sem pedido do núcleo e sem referência do lojista: o recibo é público; com_/wdr_ é o vínculo
    beneficiary: { ref: d.b_ref, kind: d.b_kind },
    issued_at: ctx.now().toISOString(),
    settlement: { id: d.id, to: d.recipient, amount: String(d.amount_units), memo: d.memo, tx_hash: d.tx_hash, block_number: String(obs.blockNumber), block_hash: obs.blockHash, log_index: obs.logIndex, confirmation_observed_at: iso(d.a_upd) },
    amounts: { usd_units: String(d.amount_units), usd: fmtUsd(BigInt(d.amount_units)), currency: 'USD', scale: 6 },
  }
  if (d.c_id) {
    payload.commission = {
      id: d.c_id, custody: d.custody, // ids de origem do programa e referência do pedido ficam fora do recibo público; a comissão (com_) já é o vínculo
      amount: { amount: String(d.amount_minor), currency: 'BRL', scale: 2, brl: fmtBrl(BigInt(d.amount_minor)) },
      // mode: at_pix = cotada no instante do Pix; backfill = importação histórica cotada depois (o recibo diz, nunca finge)
      quote: { rate_num: String(d.rate_num), rate_den: String(d.rate_den), source: d.quote_source, at: iso(d.quote_at), hash: d.quote_hash, fee_bps: d.fee_bps, mode: d.quote_mode },
      occurred_at: iso(d.occurred_at), released_at: iso(d.released_at),
    }
  } else if (d.w_id) {
    payload.withdrawal = { id: d.w_id, kind: 'wallet' }
  }
  const env = await ctx.chain.signReceipt(payload) as ReceiptEnvelope
  const v = await verifyEnvelope(env, [ctx.cfg.issuer.address])
  if (!v.ok) throw new Error(`recibo de comissão assinado não confere: ${v.code} ${v.detail}`)
  await withTx(ctx.db, tx => tx.query(
    `INSERT INTO affiliate_receipts (id, settlement_id, commission_id, withdrawal_id, digest_hex, envelope) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (settlement_id) DO NOTHING`,
    [receiptId, settlementId, d.c_id ?? null, d.w_id ?? null, env.digest.hex, JSON.stringify(env)]))
}
