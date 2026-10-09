// Fase 2: o que o diário de envio (flows/settle.ts) pergunta ao módulo de afiliados para uma liquidação
// kind='affiliate_payout'. Só funções puras de banco, sem importar o diário (evita ciclo).
import { recordTransition, enqueue, type Tx } from '../db.js'

// Autorização de liquidação de afiliados. Fica desligada até server.ts ligar explicitamente: exige AFFILIATE_SETTLE=1 E a instalação
// aceitar escritas (réplica pública sem opt-in nunca assina nem transmite). Desligada, nenhum job existente assina ou transmite um
// pagamento de comissão, mesmo que já esteja na fila: advance não cria tentativa, sign/broadcast suspendem a existente (R2).
let settleEnabled = false
export function configureAffiliateJournal(opts: { settle: boolean; writes?: boolean }): void { settleEnabled = opts.settle === true && opts.writes !== false }
export const affiliateSettleEnabled = () => settleEnabled

/** Bloqueios de um pagamento de comissão ou de um saque para carteira. Vazio = pode assinar/transmitir. */
export async function affiliatePayoutBlockers(tx: Tx, settlement: any): Promise<string[]> {
  const out: string[] = []
  if (!settleEnabled) out.push('affiliate_settle_off')
  if (settlement.hold_reason) out.push(`settlement_hold:${settlement.hold_reason}`)
  const c = (await tx.query(`SELECT id, status FROM affiliate_commissions WHERE settlement_id=$1`, [settlement.id])).rows[0]
  if (c && c.status === 'voided') out.push(`commission_voided:${c.id}`)
  if (c && c.status === 'failed') out.push(`commission_failed:${c.id}`)
  const w = (await tx.query(`SELECT id, status FROM affiliate_withdrawals WHERE settlement_id=$1`, [settlement.id])).rows[0]
  if (w && w.status === 'failed') out.push(`withdrawal_failed:${w.id}`)
  if (!c && !w) out.push('orphan_affiliate_settlement') // nunca paga uma liquidação sem dono conhecido
  return out
}

/** Confirmação on-chain: comissão vira settled (ou saque vira settled), razão ganha a entrada, recibo entra na fila. */
export async function onAffiliatePayoutConfirmed(tx: Tx, settlement: any, txHash: string): Promise<void> {
  const c = (await tx.query(`SELECT * FROM affiliate_commissions WHERE settlement_id=$1 FOR UPDATE`, [settlement.id])).rows[0]
  if (c) {
    if (c.status === 'settling' || c.status === 'released') {
      await tx.query(`UPDATE affiliate_commissions SET status='settled', updated_at=now() WHERE id=$1`, [c.id])
      await recordTransition(tx, 'affiliate_commission', c.id, c.status, 'settled', 'reconcile', txHash)
      await tx.query(
        `INSERT INTO affiliate_ledger (beneficiary_id, kind, usd_units, ref_kind, ref_id, op_key) VALUES ($1,'settle',0,'settlement',$2,$3) ON CONFLICT (op_key) DO NOTHING`,
        [c.beneficiary_id, settlement.id, `settle:${settlement.id}`],
      )
    } else if (c.status === 'voided') {
      // Anulada depois de transmitida (janela entre broadcast e confirmação): o dinheiro está na cadeia; fica para uma pessoa.
      await recordTransition(tx, 'affiliate_exception', c.id, 'voided', 'affiliate_clawback_needed', 'reconcile', txHash)
    }
  }
  const w = (await tx.query(`SELECT * FROM affiliate_withdrawals WHERE settlement_id=$1 FOR UPDATE`, [settlement.id])).rows[0]
  if (w && w.status === 'settling') {
    await tx.query(`UPDATE affiliate_withdrawals SET status='settled', updated_at=now() WHERE id=$1`, [w.id])
    await recordTransition(tx, 'affiliate_withdrawal', w.id, 'settling', 'settled', 'reconcile', txHash)
  }
  await enqueue(tx, 'issue_affiliate_receipt', settlement.id)
}
