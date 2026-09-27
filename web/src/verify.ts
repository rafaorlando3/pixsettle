// Verificação do recibo NO NAVEGADOR (contrato 7.3). Reusa o mesmo algoritmo do settlement
// e confere a transação direto na RPC pública da Tempo, sem confiar no servidor do PixSettle.
import { createPublicClient, http, getAddress, toEventSelector, type Hex } from 'viem'
import { tempoModerato } from 'viem/chains'
import { verifyEnvelope, type ReceiptEnvelope } from '../../settlement/src/receipt.js'

export type Step = { key: string; label: string; state: 'ok' | 'fail' | 'unavailable' | 'info'; detail: string }

const TOPIC = toEventSelector('TransferWithMemo(address,address,uint256,bytes32)')
const pad = (a: string) => ('0x' + a.slice(2).toLowerCase().padStart(64, '0')) as Hex

export async function verifyReceipt(env: ReceiptEnvelope, trustedIssuers: string[], rpcUrl = tempoModerato.rpcUrls.default.http[0]): Promise<Step[]> {
  const steps: Step[] = []
  const sig = await verifyEnvelope(env, trustedIssuers)
  steps.push(sig.ok
    ? { key: 'signature', label: 'Issuer signature', state: 'ok', detail: `Recomputed digest matches; signed by trusted issuer ${sig.recovered}` }
    : { key: 'signature', label: 'Issuer signature', state: 'fail', detail: `${sig.code}: ${sig.detail}` })
  const p: any = env.payload
  if (p.receipt_type === 'refund_notice') {
    steps.push({ key: 'refund', label: 'Refund', state: 'info', detail: 'Refund confirmed by the Pix provider, as attested by the issuer. Not an on-chain proof.' })
    return steps
  }
  steps.push({ key: 'pix', label: 'Pix payment', state: 'info', detail: `Attested by the issuer from ${p.pix.provider} (${p.provider_env}); not provable on-chain.` })
  try {
    if (Number(p.chain_id) !== tempoModerato.id) throw new Error(`receipt chain ${p.chain_id} is not Tempo Moderato ${tempoModerato.id}`)
    const client = createPublicClient({ chain: tempoModerato, transport: http(rpcUrl, { timeout: 10_000 }) })
    const r = await client.getTransactionReceipt({ hash: p.settlement.tx_hash })
    const s = p.settlement
    const checks: string[] = []
    if (r.status !== 'success') checks.push('transaction reverted')
    if (r.blockHash.toLowerCase() !== String(s.block_hash).toLowerCase()) checks.push('block hash differs')
    if (r.blockNumber.toString() !== String(s.block_number)) checks.push('block number differs')
    const log = r.logs.find(l =>
      l.topics[0]?.toLowerCase() === TOPIC.toLowerCase() && getAddress(l.address) === getAddress(p.token) &&
      l.topics[1]?.toLowerCase() === pad(p.treasury) && l.topics[2]?.toLowerCase() === pad(s.to) &&
      l.topics[3]?.toLowerCase() === String(s.memo).toLowerCase() && BigInt(l.data) === BigInt(s.amount))
    if (!log) checks.push('no TransferWithMemo matching token, from, to, amount and memo')
    else if (log.logIndex !== Number(s.log_index)) checks.push('log index differs')
    steps.push(checks.length
      ? { key: 'chain', label: 'On-chain settlement', state: 'fail', detail: checks.join('; ') }
      : { key: 'chain', label: 'On-chain settlement', state: 'ok', detail: `Verified by your browser on Tempo: ${BigInt(s.amount)} units (6 decimals) to ${s.to}, block ${r.blockNumber}` })
  } catch (e) {
    steps.push({ key: 'chain', label: 'On-chain settlement', state: 'unavailable', detail: `Verification unavailable: ${(e as Error).message}` })
  }
  return steps
}

;(globalThis as any).PixSettleVerify = { verifyReceipt }
