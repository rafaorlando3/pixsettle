// Verificação do recibo NO NAVEGADOR (contrato 7.3). Reusa o mesmo algoritmo do settlement
// e confere a transação direto na RPC pública da Tempo, sem confiar no servidor do PixSettle.
//
// Tipos de recibo:
//   settlement                  liquidação de um Pix ao lojista: o recibo carrega o destino (settlement.to).
//   refund_notice               devolução atestada pelo emissor; sem prova on-chain.
//   affiliate_commission_payout pagamento de comissão (fase 2, docs/affiliate-payouts.md): o recibo é público e NUNCA carrega o
//   affiliate_wallet_withdrawal destino; carrega o compromisso settlement.recipient_sha256 = sha256(endereço em minúsculas). O
//                               navegador confere que o destinatário do TransferWithMemo na cadeia bate com o compromisso, sem
//                               exibir a carteira. Um recibo desses com `to` é malformado (o contrato proíbe o destino no envelope).
//
// Estados da checagem on-chain:
//   fail        o recibo não bate com a cadeia (rede errada, campo malformado, revertida,
//               bloco/log/valor/memo/destinatário diferentes). Só com evidência observada.
//   unavailable inconclusivo, com motivo em `reason`:
//               rpc_unreachable   a RPC não respondeu (rede, HTTP, erro do nó, tempo esgotado);
//               receipt_not_found a RPC respondeu sem recibo (transação pendente ou nó atrasado;
//                                 "não encontrado" não prova que o recibo é falso, revisão REV-01);
//               rpc_incomplete    a RPC devolveu um recibo sem os campos necessários.
import { createPublicClient, http, getAddress, isAddress, toEventSelector, sha256, stringToBytes, TransactionReceiptNotFoundError, type Hex } from 'viem'
import { tempoModerato } from 'viem/chains'
import { verifyEnvelope, type ReceiptEnvelope } from '../../settlement/src/receipt.js'

export type Reason = 'rpc_unreachable' | 'receipt_not_found' | 'rpc_incomplete'
export type Step = { key: string; label: string; state: 'ok' | 'fail' | 'unavailable' | 'info'; detail: string; reason?: Reason }
export type VerifyOptions = { timeoutMs?: number; retryCount?: number }

const TOPIC = toEventSelector('TransferWithMemo(address,address,uint256,bytes32)')
const pad = (a: string) => ('0x' + a.slice(2).toLowerCase().padStart(64, '0')) as Hex
const HASH32 = /^0x[0-9a-fA-F]{64}$/
const SHA256_HEX = /^[0-9a-fA-F]{64}$/
const UINT = /^(0|[1-9][0-9]*)$/
const CHAIN = 'On-chain settlement'
const AFFILIATE_TYPES = new Set(['affiliate_commission_payout', 'affiliate_wallet_withdrawal'])
export const isAffiliateReceipt = (p: any): boolean => AFFILIATE_TYPES.has(String(p?.receipt_type))

/** Endereço (minúsculas, 0x + 40 hex) codificado num tópico indexado; null se o tópico não é um endereço. */
function addressInTopic(topic: unknown): string | null {
  if (typeof topic !== 'string' || !HASH32.test(topic) || !/^0{24}/.test(topic.slice(2))) return null
  return '0x' + topic.slice(26).toLowerCase()
}
/** Compromisso do contrato: sha256 do endereço em minúsculas (o mesmo cálculo do emissor, core/src/affiliates/receipts.ts). */
export const recipientCommitment = (address: string): string => sha256(stringToBytes(address.toLowerCase())).slice(2)

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
  const addresses: Array<readonly [string, unknown]> = [['token', p.token], ['treasury', p.treasury]]
  if (isAffiliateReceipt(p)) {
    if (typeof s.recipient_sha256 !== 'string' || !SHA256_HEX.test(s.recipient_sha256)) bad.push('recipient_sha256')
    if ('to' in s) bad.push('to (an affiliate receipt must not carry the destination)')
  } else addresses.push(['to', s.to])
  for (const [k, v] of addresses) if (typeof v !== 'string' || !isAddress(v, { strict: false })) bad.push(k)
  return bad.length ? `malformed receipt field: ${bad.join(', ')}` : null
}

/** O que o emissor atesta e a cadeia não prova: o Pix (liquidação) ou a natureza da comissão/saque (fase 2). */
function attestedStep(p: any): Step {
  if (p?.receipt_type === 'affiliate_commission_payout') {
    const c = p.commission ?? {}, q = c.quote ?? {}
    const brl = c.amount?.brl ? `R$ ${c.amount.brl}` : c.amount?.amount !== undefined ? `${c.amount.amount} BRL cents` : 'unknown BRL amount'
    const when = q.mode === 'at_pix' ? 'at the moment the Pix landed' : q.mode === 'backfill' ? 'later than its Pix (imported commission, quoted at import)' : `quote mode ${q.mode ?? 'unknown'}`
    return { key: 'origin', label: 'Affiliate commission', state: 'info',
      detail: `Commission ${c.id ?? 'unknown'} (${c.custody ?? 'unknown'} custody): ${brl} converted to ${p.amounts?.usd ?? p.amounts?.usd_units ?? 'unknown'} USD ${when}, quote ${q.source ?? 'unknown'}. Attested by the issuer; not provable on-chain.` }
  }
  if (p?.receipt_type === 'affiliate_wallet_withdrawal') {
    const w = p.withdrawal ?? {}
    return { key: 'origin', label: 'Wallet withdrawal', state: 'info',
      detail: `Withdrawal ${w.id ?? 'unknown'} of ${p.amounts?.usd ?? p.amounts?.usd_units ?? 'unknown'} USD requested by beneficiary ${p.beneficiary?.ref ?? 'unknown'} to their own wallet. Attested by the issuer; not provable on-chain.` }
  }
  return { key: 'pix', label: 'Pix payment', state: 'info', detail: `Attested by the issuer from ${p?.pix?.provider} (${p?.provider_env}); not provable on-chain.` }
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
  steps.push(attestedStep(p))

  const wrong = malformed(p)
  if (wrong) { steps.push({ key: 'chain', label: CHAIN, state: 'fail', detail: wrong }); return steps }
  const s = p.settlement
  const affiliate = isAffiliateReceipt(p)

  let r
  try {
    const client = createPublicClient({ chain: tempoModerato, transport: http(rpcUrl, { timeout: opts.timeoutMs ?? 10_000, retryCount: opts.retryCount ?? 3 }) })
    r = await client.getTransactionReceipt({ hash: s.tx_hash })
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError || (e as Error)?.name === 'TransactionReceiptNotFoundError') {
      steps.push({ key: 'chain', label: CHAIN, state: 'unavailable', reason: 'receipt_not_found',
        detail: `Not found yet: the Tempo RPC has no receipt for ${s.tx_hash}. The transaction may still be pending or the node may be behind; this alone does not prove the receipt is false. Verify again in a moment.` })
    } else {
      steps.push({ key: 'chain', label: CHAIN, state: 'unavailable', reason: 'rpc_unreachable', detail: `Verification unavailable: ${(e as Error).message}` })
    }
    return steps
  }

  // Recibo estruturalmente incompleto não pode travar a tela nem virar falha: é inconclusivo.
  const missing = ['status', 'blockHash', 'blockNumber', 'logs'].filter(k => (r as any)?.[k] === undefined || (r as any)?.[k] === null)
  if (missing.length || !Array.isArray(r.logs)) {
    steps.push({ key: 'chain', label: CHAIN, state: 'unavailable', reason: 'rpc_incomplete', detail: `Verification unavailable: the Tempo RPC returned an incomplete receipt (missing ${missing.join(', ') || 'logs'}).` })
    return steps
  }

  const checks: string[] = []
  if (r.status !== 'success') checks.push('transaction reverted')
  if (r.blockHash.toLowerCase() !== s.block_hash.toLowerCase()) checks.push('block hash differs')
  if (r.blockNumber.toString() !== String(s.block_number)) checks.push('block number differs')
  // Destinatário: no recibo de liquidação é o endereço do recibo; no recibo de afiliado é quem bate com o compromisso sha256.
  const recipientMatches = (topic: unknown): boolean => {
    if (!affiliate) return typeof topic === 'string' && topic.toLowerCase() === pad(s.to)
    const a = addressInTopic(topic)
    return a !== null && recipientCommitment(a) === String(s.recipient_sha256).toLowerCase()
  }
  const log = r.logs.find(l => Array.isArray(l?.topics) && typeof l?.address === 'string' && isAddress(l.address, { strict: false }) &&
    l.topics[0]?.toLowerCase() === TOPIC.toLowerCase() && getAddress(l.address) === getAddress(p.token) &&
    l.topics[1]?.toLowerCase() === pad(p.treasury) && recipientMatches(l.topics[2]) &&
    l.topics[3]?.toLowerCase() === s.memo.toLowerCase() && safeBig(l.data) === BigInt(s.amount))
  if (!log) checks.push(affiliate ? 'no TransferWithMemo matching token, from, recipient commitment (recipient_sha256), amount and memo' : 'no TransferWithMemo matching token, from, to, amount and memo')
  else if (Number(log.logIndex) !== Number(s.log_index)) checks.push('log index differs')
  steps.push(checks.length
    ? { key: 'chain', label: CHAIN, state: 'fail', detail: checks.join('; ') }
    : { key: 'chain', label: CHAIN, state: 'ok', detail: affiliate
        ? `Verified by your browser on Tempo: ${BigInt(s.amount)} units (6 decimals) to the recipient committed in this receipt (sha256 of the address; the address itself is not published), block ${r.blockNumber}`
        : `Verified by your browser on Tempo: ${BigInt(s.amount)} units (6 decimals) to ${s.to}, block ${r.blockNumber}` })
  return steps
}

function safeBig(x: string): bigint | null { try { return BigInt(x) } catch { return null } }

;(globalThis as any).PixSettleVerify = { verifyReceipt, isAffiliateReceipt, recipientCommitment }
