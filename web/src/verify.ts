// Verificação do recibo NO NAVEGADOR (contrato 7.3). Reusa o mesmo algoritmo do settlement
// e confere a transação direto na RPC pública da Tempo, sem confiar no servidor do PixSettle.
//
// Estados da checagem on-chain:
//   fail        o recibo não bate com a cadeia (rede errada, campo malformado, transação inexistente,
//               revertida, bloco/log/valor/memo diferentes).
//   unavailable só quando a RPC não respondeu (rede, tempo esgotado, erro do próprio nó).
import { createPublicClient, http, getAddress, isAddress, toEventSelector, TransactionReceiptNotFoundError, type Hex } from 'viem'
import { tempoModerato } from 'viem/chains'
import { verifyEnvelope, type ReceiptEnvelope } from '../../settlement/src/receipt.js'

export type Step = { key: string; label: string; state: 'ok' | 'fail' | 'unavailable' | 'info'; detail: string }
export type VerifyOptions = { timeoutMs?: number; retryCount?: number }

const TOPIC = toEventSelector('TransferWithMemo(address,address,uint256,bytes32)')
const pad = (a: string) => ('0x' + a.slice(2).toLowerCase().padStart(64, '0')) as Hex
const HASH32 = /^0x[0-9a-fA-F]{64}$/
const UINT = /^(0|[1-9][0-9]*)$/
const CHAIN = 'On-chain settlement'

// Confere o formato ANTES de ir à RPC: um recibo malformado ou de outra rede é falha do recibo,
// não indisponibilidade da rede.
function malformed(p: any): string | null {
  const s = p?.settlement
  if (!s || typeof s !== 'object') return 'settlement block is missing'
  if (String(p.chain_id) !== String(tempoModerato.id)) return `receipt is for chain ${p.chain_id}, not Tempo Moderato (${tempoModerato.id})`
  const bad: string[] = []
  if (typeof s.tx_hash !== 'string' || !HASH32.test(s.tx_hash)) bad.push('tx_hash')
  if (typeof s.block_hash !== 'string' || !HASH32.test(s.block_hash)) bad.push('block_hash')
  if (typeof s.memo !== 'string' || !HASH32.test(s.memo)) bad.push('memo')
  if (!UINT.test(String(s.block_number))) bad.push('block_number')
  if (!UINT.test(String(s.log_index))) bad.push('log_index')
  if (!UINT.test(String(s.amount))) bad.push('amount')
  for (const [k, v] of [['token', p.token], ['treasury', p.treasury], ['to', s.to]] as const)
    if (typeof v !== 'string' || !isAddress(v, { strict: false })) bad.push(k)
  return bad.length ? `malformed receipt field: ${bad.join(', ')}` : null
}

export async function verifyReceipt(env: ReceiptEnvelope, trustedIssuers: string[], rpcUrl: string = tempoModerato.rpcUrls.default.http[0], opts: VerifyOptions = {}): Promise<Step[]> {
  const steps: Step[] = []
  const sig = await verifyEnvelope(env, trustedIssuers)
  steps.push(sig.ok
    ? { key: 'signature', label: 'Issuer signature', state: 'ok', detail: `Recomputed digest matches; signed by trusted issuer ${sig.recovered}` }
    : { key: 'signature', label: 'Issuer signature', state: 'fail', detail: `${sig.code}: ${sig.detail}` })
  const p: any = env.payload
  if (p?.receipt_type === 'refund_notice') {
    steps.push({ key: 'refund', label: 'Refund', state: 'info', detail: 'Refund confirmed by the Pix provider, as attested by the issuer. Not an on-chain proof.' })
    return steps
  }
  steps.push({ key: 'pix', label: 'Pix payment', state: 'info', detail: `Attested by the issuer from ${p?.pix?.provider} (${p?.provider_env}); not provable on-chain.` })

  const wrong = malformed(p)
  if (wrong) { steps.push({ key: 'chain', label: CHAIN, state: 'fail', detail: wrong }); return steps }
  const s = p.settlement

  let r
  try {
    const client = createPublicClient({ chain: tempoModerato, transport: http(rpcUrl, { timeout: opts.timeoutMs ?? 10_000, retryCount: opts.retryCount ?? 3 }) })
    r = await client.getTransactionReceipt({ hash: s.tx_hash })
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError || (e as Error)?.name === 'TransactionReceiptNotFoundError') {
      steps.push({ key: 'chain', label: CHAIN, state: 'fail', detail: `transaction ${s.tx_hash} not found on Tempo Moderato` })
    } else {
      steps.push({ key: 'chain', label: CHAIN, state: 'unavailable', detail: `Verification unavailable: ${(e as Error).message}` })
    }
    return steps
  }

  const checks: string[] = []
  if (r.status !== 'success') checks.push('transaction reverted')
  if (r.blockHash.toLowerCase() !== s.block_hash.toLowerCase()) checks.push('block hash differs')
  if (r.blockNumber.toString() !== String(s.block_number)) checks.push('block number differs')
  const log = r.logs.find(l =>
    l.topics[0]?.toLowerCase() === TOPIC.toLowerCase() && getAddress(l.address) === getAddress(p.token) &&
    l.topics[1]?.toLowerCase() === pad(p.treasury) && l.topics[2]?.toLowerCase() === pad(s.to) &&
    l.topics[3]?.toLowerCase() === s.memo.toLowerCase() && safeBig(l.data) === BigInt(s.amount))
  if (!log) checks.push('no TransferWithMemo matching token, from, to, amount and memo')
  else if (log.logIndex !== Number(s.log_index)) checks.push('log index differs')
  steps.push(checks.length
    ? { key: 'chain', label: CHAIN, state: 'fail', detail: checks.join('; ') }
    : { key: 'chain', label: CHAIN, state: 'ok', detail: `Verified by your browser on Tempo: ${BigInt(s.amount)} units (6 decimals) to ${s.to}, block ${r.blockNumber}` })
  return steps
}

function safeBig(x: string): bigint | null { try { return BigInt(x) } catch { return null } }

;(globalThis as any).PixSettleVerify = { verifyReceipt }
