// Emissão do recibo de liquidação (contrato 7). Assinado no processo de assinatura, conferido aqui.
import { withTx } from '../db.js'
import { newId } from '../ids.js'
import { reserveOfIntent } from './amounts.js'
import type { Ctx } from '../context.js'
import { verifyEnvelope, type ReceiptEnvelope } from '../../../settlement/src/receipt.js'

export async function issueSettlementReceipt(ctx: Ctx, settlementId: string) {
  const d = (await ctx.db.query(
    `SELECT s.*, o.id AS o_id, o.amount_minor, o.provider_env, o.chain_env, o.merchant_id, c.provider, c.observed_state, c.last_observed_at, c.updated_at AS c_upd,
            q.id AS q_id, q.rate_num, q.rate_den, q.valid_until, q.rounding, m.reserve_bps,
            a.tx_hash, a.observed, a.updated_at AS a_upd
       FROM settlements s JOIN orders o ON o.id=s.order_id JOIN pix_charges c ON c.order_id=o.id
       JOIN quotes q ON q.order_id=o.id JOIN merchants m ON m.id=o.merchant_id
       JOIN settlement_attempts a ON a.settlement_id=s.id AND a.status='confirmed'
      WHERE s.id=$1 AND s.status='confirmed'`, [settlementId])).rows[0]
  if (!d) return
  const exists = (await ctx.db.query(`SELECT 1 FROM receipts WHERE order_id=$1 AND receipt_type='settlement'`, [d.o_id])).rowCount
  if (exists) return
  const gross = (BigInt(d.amount_minor) * BigInt(d.rate_num)) / BigInt(d.rate_den)
  const reserve = reserveOfIntent(BigInt(d.amount_minor), BigInt(d.rate_num), BigInt(d.rate_den), BigInt(d.amount_units)) // da intenção, não do reserve_bps atual
  const obs = d.observed
  const iso = (x: any) => new Date(x).toISOString()
  const payload = {
    schema_version: 1, receipt_id: newId('rct'), receipt_type: 'settlement',
    issuer: ctx.cfg.issuer, provider_env: d.provider_env, chain_env: d.chain_env, chain_id: d.chain_id,
    order: { id: d.o_id, amount: { amount: String(d.amount_minor), currency: 'BRL', scale: 2 } },
    issued_at: ctx.now().toISOString(),
    token: d.token, treasury: d.sender,
    pix: { provider: d.provider, state: d.observed_state, observed_at: iso(d.last_observed_at ?? d.c_upd) },
    quote: { id: d.q_id, rate_num: String(d.rate_num), rate_den: String(d.rate_den), valid_until: iso(d.valid_until), rounding: d.rounding },
    amounts: { gross: gross.toString(), fees_simulated: '0', reserve_simulated: reserve.toString(), net: String(d.amount_units), currency: 'pathUSD', scale: 6 },
    settlement: { to: d.recipient, amount: String(d.amount_units), memo: d.memo, tx_hash: d.tx_hash, block_number: String(obs.blockNumber), block_hash: obs.blockHash, log_index: obs.logIndex, confirmation_observed_at: iso(d.a_upd) },
  }
  const env = await ctx.chain.signReceipt(payload) as ReceiptEnvelope
  const v = await verifyEnvelope(env, [ctx.cfg.issuer.address])
  if (!v.ok) throw new Error(`recibo assinado não confere: ${v.code} ${v.detail}`)
  await withTx(ctx.db, tx => tx.query(`INSERT INTO receipts (id, order_id, receipt_type, digest_hex, envelope) VALUES ($1,$2,'settlement',$3,$4)`,
    [payload.receipt_id, d.o_id, env.digest.hex, JSON.stringify(env)]))
}

/** Projeção pública mínima (contrato 7.4): sem external_ref, pagador ou IDs privados do provedor. */
export function publicProjection(env: ReceiptEnvelope) {
  return env // o payload já nasce sem external_ref, pagador e IDs do provedor; o envelope inteiro é verificável
}
