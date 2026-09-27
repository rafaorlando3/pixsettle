// Acesso à Tempo para o diário de envio (contrato v0.3, seção 4).
// Regras: o assinante só assina com o nonce recebido; o transmissor só envia bytes já
// persistidos; erro de RPC nunca vira sucesso nem falha definitiva sozinho.
import {
  createPublicClient, createWalletClient, http, encodeFunctionData, keccak256, parseAbi, parseAbiItem,
  getAddress, toEventSelector, type Hex, type PublicClient, type Chain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export const TIP20_ABI = parseAbi([
  'function transferWithMemo(address to, uint256 amount, bytes32 memo)',
  'function balanceOf(address) view returns (uint256)',
])
export const TRANSFER_WITH_MEMO_EVENT = parseAbiItem(
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
)

/** Intenção imutável da liquidação (seção 4.5). */
export type TransferIntent = {
  chainId: number
  token: Hex
  from: Hex
  to: Hex
  amount: bigint
  memo: Hex // bytes32
}

export type SignedTransfer = {
  raw: Hex
  hash: Hex
  nonce: number
  nonceKey: 0
  gas: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
}

export type BroadcastOutcome =
  | { kind: 'accepted'; hash: Hex }
  | { kind: 'reconcile'; reason: 'already_known' | 'nonce_too_low'; detail: string }
  | { kind: 'unknown'; reason: 'transport'; detail: string }
  | { kind: 'rejected'; detail: string }

/** Memo = ASCII do settlement_id, completado com zeros à direita até 32 bytes. */
export function memoFromSettlementId(settlementId: string): Hex {
  if (!/^stl_[0-9A-HJKMNP-TV-Z]{26}$/.test(settlementId)) throw new Error(`settlement_id inválido: ${settlementId}`)
  const bytes = Buffer.from(settlementId, 'ascii')
  if (bytes.length > 32) throw new Error('memo maior que 32 bytes')
  return `0x${Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]).toString('hex')}` as Hex
}

export function settlementIdFromMemo(memo: Hex): string {
  return Buffer.from(memo.slice(2), 'hex').toString('ascii').replace(/\0+$/, '')
}

/**
 * Classifica a resposta de sendRawTransaction. Observado na Moderato em 27/09/2026:
 * reenvio pendente -> -32000 "already known"; reenvio já incluído -> "nonce too low".
 */
export function classifyBroadcastError(err: unknown): BroadcastOutcome {
  const e = err as { details?: string; shortMessage?: string; message?: string; name?: string; cause?: { name?: string } }
  const text = `${e?.details ?? ''} ${e?.shortMessage ?? ''} ${e?.message ?? ''}`.toLowerCase()
  if (text.includes('already known')) return { kind: 'reconcile', reason: 'already_known', detail: e?.details ?? String(e?.message) }
  if (text.includes('nonce too low')) return { kind: 'reconcile', reason: 'nonce_too_low', detail: e?.details ?? String(e?.message) }
  const transport = ['HttpRequestError', 'TimeoutError', 'SocketClosedError'].includes(e?.name ?? '') ||
    ['HttpRequestError', 'TimeoutError'].includes(e?.cause?.name ?? '') ||
    /timeout|timed out|fetch failed|econnreset|socket|network/.test(text)
  if (transport) return { kind: 'unknown', reason: 'transport', detail: String(e?.message ?? e) }
  return { kind: 'rejected', detail: String(e?.details ?? e?.shortMessage ?? e?.message ?? e) }
}

export type ObservedTransfer = {
  txHash: Hex
  status: 'success' | 'reverted'
  blockNumber: bigint
  blockHash: Hex
  logIndex: number | null
  identityOk: boolean
  mismatches: string[]
}

/** Seção 4.8: identidade completa, não só o memo. */
export const TRANSFER_WITH_MEMO_TOPIC = toEventSelector('TransferWithMemo(address,address,uint256,bytes32)')

type ReceiptLike = {
  status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex; transactionHash: Hex
  logs: Array<{ address: Hex; topics: readonly Hex[]; data: Hex; logIndex: number | null }>
}

export function checkIdentity(intent: TransferIntent, receipt: ReceiptLike, chainId: number): ObservedTransfer {
  const mismatches: string[] = []
  if (chainId !== intent.chainId) mismatches.push(`chain_id ${chainId} != ${intent.chainId}`)
  if (receipt.status !== 'success') mismatches.push('recibo revertido')
  const topicAddr = (a: Hex) => ('0x' + a.slice(2).toLowerCase().padStart(64, '0')) as Hex
  const match = receipt.logs.find(l =>
    l.topics[0]?.toLowerCase() === TRANSFER_WITH_MEMO_TOPIC.toLowerCase() &&
    getAddress(l.address) === getAddress(intent.token) &&
    l.topics[1]?.toLowerCase() === topicAddr(intent.from) &&
    l.topics[2]?.toLowerCase() === topicAddr(intent.to) &&
    l.topics[3]?.toLowerCase() === intent.memo.toLowerCase() &&
    BigInt(l.data) === intent.amount)
  if (!match) mismatches.push('nenhum TransferWithMemo com token, from, to, amount e memo da intenção')
  return {
    txHash: receipt.transactionHash, status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    logIndex: match?.logIndex ?? null, identityOk: mismatches.length === 0, mismatches,
  }
}

export class TempoChain {
  readonly pub: PublicClient
  constructor(readonly chain: Chain, rpcUrl?: string) {
    this.pub = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }) }) as PublicClient
  }

  pendingNonce(sender: Hex): Promise<number> {
    return this.pub.getTransactionCount({ address: sender, blockTag: 'pending' })
  }

  /** Só assina. Nonce vem do diário (nonceKey 0, sequência comum). Não transmite. */
  async signTransfer(privateKey: Hex, intent: TransferIntent, nonce: number): Promise<SignedTransfer> {
    const account = privateKeyToAccount(privateKey)
    if (getAddress(account.address) !== getAddress(intent.from)) throw new Error('chave não corresponde à tesouraria da intenção')
    if (this.chain.id !== intent.chainId) throw new Error(`rede ${this.chain.id} diferente da intenção ${intent.chainId}`)
    const wallet = createWalletClient({ account, chain: this.chain, transport: http(undefined, { timeout: 15_000, retryCount: 0 }) })
    const data = encodeFunctionData({ abi: TIP20_ABI, functionName: 'transferWithMemo', args: [intent.to, intent.amount, intent.memo] })
    const req = await wallet.prepareTransactionRequest({ to: intent.token, data, nonce, type: 'eip1559' })
    if (req.nonce !== nonce) throw new Error(`SDK trocou o nonce: pedido ${nonce}, preparado ${req.nonce}`)
    const raw = await wallet.signTransaction(req)
    return {
      raw, hash: keccak256(raw), nonce, nonceKey: 0,
      gas: String(req.gas), maxFeePerGas: String(req.maxFeePerGas), maxPriorityFeePerGas: String(req.maxPriorityFeePerGas),
    }
  }

  /** Transmite exatamente os bytes recebidos e classifica o resultado. */
  async broadcast(raw: Hex): Promise<BroadcastOutcome> {
    try {
      const hash = await this.pub.sendRawTransaction({ serializedTransaction: raw })
      if (hash.toLowerCase() !== keccak256(raw).toLowerCase()) return { kind: 'unknown', reason: 'transport', detail: `hash devolvido ${hash} difere do local` }
      return { kind: 'accepted', hash }
    } catch (err) {
      return classifyBroadcastError(err)
    }
  }

  /** Estado de uma tentativa pelo hash. null = sem recibo ainda (não prova ausência). */
  async observe(hash: Hex, intent: TransferIntent): Promise<ObservedTransfer | null> {
    let receipt
    try {
      receipt = await this.pub.getTransactionReceipt({ hash })
    } catch (err) {
      const name = (err as { name?: string }).name
      if (name === 'TransactionReceiptNotFoundError') return null
      throw err
    }
    return checkIdentity(intent, receipt as never, this.chain.id)
  }

  /** Busca pelo memo (localizar e conciliar; não prova unicidade de negócio). */
  async findByMemo(intent: TransferIntent, fromBlock: bigint) {
    const logs = await this.pub.getLogs({ address: intent.token, event: TRANSFER_WITH_MEMO_EVENT, args: { memo: intent.memo }, fromBlock, toBlock: 'latest' })
    return logs.map(l => ({ txHash: l.transactionHash, blockNumber: l.blockNumber, from: l.args.from, to: l.args.to, amount: l.args.amount, logIndex: l.logIndex }))
  }
}
