// Endereço de depósito por pedido na Tempo (TIP-1022) e pagamento retido pela política de recebimento (TIP-403,
// guarda e recibos do TIP-1028). Leitura pura de logs: nada aqui assina, envia ou guarda chave.
// Quem atribui o pagamento é o próprio protocolo: o TIP-20 resolve o endereço virtual para a carteira mestre e emite
// dois Transfer na mesma transação (pagador -> virtual, virtual -> mestre). A mestre guarda o saldo; o virtual, nunca.
// Política de recebimento: a mestre só aceita os tokens da lista; o que vier fora dela fica no ReceivePolicyGuard com
// um recibo (TransferBlocked) que guarda o endereço usado, então até o pagamento retido aponta para o pedido.
// Entrada esperada: os logs COMPLETOS das transações (recibos). Com logs parciais, o que não dá para provar vira
// "not_reconciled" com o motivo; nada que tocou a mestre some em silêncio.
import { VirtualAddress, ReceivePolicyReceipt } from 'viem/tempo'
import { decodeEventLog, getAddress, keccak256, parseAbi, toHex, type Hex } from 'viem'

export const ADDRESS_REGISTRY = '0xFDC0000000000000000000000000000000000000' as const
export const RECEIVE_POLICY_GUARD = '0xB10C000000000000000000000000000000000000' as const
export const FEE_MANAGER = '0xfeEC000000000000000000000000000000000000' as const
export const STABLECOIN_DEX = '0xDEc0000000000000000000000000000000000000' as const
const ZERO = '0x0000000000000000000000000000000000000000'
/** Todo token TIP-20 mora sob este prefixo de 12 bytes (fábrica de tokens da Tempo). */
const TIP20_PREFIX = '0x20c000000000000000000000'

const EVENTS = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
  'event TransferBlocked(address indexed token, address indexed receiver, uint64 indexed blockedNonce, uint256 amount, uint8 receiptVersion, bytes receipt)',
  'event ReceiptClaimed(address indexed token, address indexed receiver, uint64 indexed blockedNonce, uint64 blockedAt, uint8 receiptVersion, address originator, address recipient, address recoveryAuthority, address caller, address to, uint256 amount)',
  'event ReceiptBurned(address indexed token, address indexed receiver, uint64 indexed blockedNonce, uint64 blockedAt, uint8 receiptVersion, address originator, address recipient, address recoveryAuthority, address caller, uint256 amount)',
])

/** Remetentes de sistema: entrada na mestre que não é pagamento de cliente (motivo fica no ignored). */
const SYSTEM_SENDERS = new Map<string, string>([
  [FEE_MANAGER.toLowerCase(), 'fee_refund'],
  [RECEIVE_POLICY_GUARD.toLowerCase(), 'guard_release'],
  [STABLECOIN_DEX.toLowerCase(), 'dex_transfer'],
  [ZERO, 'mint'],
])
/** Motivos de ignored que podem ser dinheiro de cliente: viram desfecho not_reconciled. */
const MONEY_REASONS = new Set(['forward_without_first_hop', 'token_not_watched', 'not_tip20', 'receipt_undecodable'])

const TAG_DOMAIN = 'pixsettle:deposit:v1'
const HEX4 = /^0x[0-9a-fA-F]{8}$/
const HEX6 = /^0x[0-9a-fA-F]{12}$/
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const isTip20 = (a: string) => a.toLowerCase().startsWith(TIP20_PREFIX)

/**
 * userTag de 6 bytes do pedido: keccak256("pixsettle:deposit:v1:<loja>:<pedido>")[0..6].
 * Determinístico (reemitir dá o mesmo endereço) e opaco (o endereço não revela a loja nem o pedido).
 */
export function depositTag(merchantId: string, orderRef: string): Hex {
  if (!merchantId || !orderRef || merchantId.includes(':')) throw new Error('deposit_tag_invalid_input')
  return keccak256(toHex(`${TAG_DOMAIN}:${merchantId}:${orderRef}`)).slice(0, 14) as Hex
}

/** Endereço de depósito (virtual, TIP-1022) = masterId (4 bytes) + marca 0xfd x10 + userTag (6 bytes). */
export function depositAddress(masterId: Hex, tag: Hex): Hex {
  if (!HEX4.test(masterId)) throw new Error('deposit_master_id_invalid')
  if (!HEX6.test(tag)) throw new Error('deposit_tag_invalid')
  return getAddress(VirtualAddress.from({ masterId, userTag: tag }))
}

/** Lê masterId e userTag de um endereço; null se não for endereço virtual. */
export function parseDepositAddress(address: string): { masterId: Hex; tag: Hex } | null {
  if (!VirtualAddress.validate(address as Hex)) return null
  const { masterId, userTag } = VirtualAddress.parse(address as Hex)
  return { masterId: masterId.toLowerCase() as Hex, tag: userTag.toLowerCase() as Hex }
}

export type DepositOrder = { orderRef: string; amount: bigint; tokens: Hex[] }
export type IssuedDeposit = DepositOrder & { tag: Hex; address: Hex }

/** Emite um endereço por pedido e recusa dois pedidos no mesmo endereço. */
export function issueDepositAddresses(masterId: Hex, merchantId: string, orders: DepositOrder[],
  tagFn: (merchantId: string, orderRef: string) => Hex = depositTag): IssuedDeposit[] {
  const issued = orders.map(o => {
    if (o.amount <= 0n || o.tokens.length === 0) throw new Error(`deposit_order_invalid:${o.orderRef}`)
    const tag = tagFn(merchantId, o.orderRef).toLowerCase() as Hex
    return { ...o, tag, address: depositAddress(masterId, tag) }
  })
  addressIndex(issued)
  return issued
}

/** Índice pelo endereço completo (masterId + tag); recusa colisão entre pedidos diferentes. */
function addressIndex(issued: IssuedDeposit[]): Map<string, IssuedDeposit> {
  const byAddress = new Map<string, IssuedDeposit>()
  for (const i of issued) {
    const prior = byAddress.get(i.address.toLowerCase())
    if (prior && prior.orderRef !== i.orderRef) throw new Error(`deposit_tag_collision:${prior.orderRef}:${i.orderRef}`)
    byAddress.set(i.address.toLowerCase(), i)
  }
  return byAddress
}

/** Log como o recibo da transação devolve (só o necessário). */
export type ChainLog = {
  address: string
  topics: readonly string[]
  data: string
  transactionHash: string
  logIndex: number
  blockNumber: bigint | number | string
}

type Base = { txHash: Hex; blockNumber: bigint; logIndex: number; token: Hex; payer: Hex; amount: bigint; memo: Hex | null }
/** Pagamento feito a um endereço de depósito que resolve para a mestre. */
export type Deposit = Base & { kind: 'deposit'; depositAddress: Hex; masterId: Hex; tag: Hex }
/** Pagamento feito direto à mestre, sem endereço de depósito (o caso clássico de "Pix sem referência"). */
export type DirectPayment = Base & { kind: 'direct' }
/** Pagamento retido pela política de recebimento da mestre. */
export type HeldPayment = Base & {
  kind: 'held'
  sentTo: Hex
  blockedNonce: bigint
  blockedReason: string | null
  recoveryAuthority: Hex
  /** Recibo do guarda; null quando o lote só trouxe o resgate ou a queima (o bloqueio veio num lote anterior). */
  receipt: Hex | null
  claimed: { txHash: Hex; to: Hex; caller: Hex } | null
  burned: { txHash: Hex; caller: Hex } | null
}
export type Ignored = { txHash: Hex; blockNumber: bigint; logIndex: number; reason: string }
export type ScanResult = { deposits: Deposit[]; direct: DirectPayment[]; held: HeldPayment[]; ignored: Ignored[] }

type Decoded = { log: ChainLog; name: (typeof EVENTS)[number]['name']; args: Record<string, unknown> }

function decode(log: ChainLog): Decoded | null {
  try {
    const ev = decodeEventLog({ abi: EVENTS, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true })
    return { log, name: ev.eventName, args: ev.args as Record<string, unknown> }
  } catch {
    return null
  }
}

const blockOf = (l: ChainLog) => BigInt(l.blockNumber)
const order = (a: { blockNumber: bigint; logIndex: number; txHash: string }, b: { blockNumber: bigint; logIndex: number; txHash: string }) =>
  a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1)
    : a.txHash !== b.txHash ? a.txHash.toLowerCase().localeCompare(b.txHash.toLowerCase()) : a.logIndex - b.logIndex
const memoOrNull = (m: string) => (/^0x0{64}$/.test(m) ? null : (m as Hex))
const nonceKey = (token: unknown, nonce: unknown) => `${String(token).toLowerCase()}:${String(nonce)}`

/**
 * Separa, nos logs dados, tudo o que chegou à carteira mestre: depósitos por endereço virtual (os dois saltos na
 * mesma transação), pagamentos diretos e pagamentos retidos pela política (TransferBlocked do guarda, com
 * ReceiptClaimed ou ReceiptBurned quando houver). O resto que tocou a mestre vai para ignored com o motivo.
 */
export function scanMasterInflows(logs: ChainLog[], opts: { master: string; tokens?: string[] }): ScanResult {
  const master = getAddress(opts.master)
  const watched = (t: string) => !opts.tokens || opts.tokens.some(x => same(x, t))
  const byTx = new Map<string, Decoded[]>()
  for (const l of logs) {
    const d = decode(l)
    if (!d) continue
    const k = l.transactionHash.toLowerCase()
    byTx.set(k, [...(byTx.get(k) ?? []), d])
  }
  const out: ScanResult = { deposits: [], direct: [], held: [], ignored: [] }
  const fromGuard = (e: Decoded) => same(e.log.address, RECEIVE_POLICY_GUARD) && same(String(e.args.receiver), master)
  const closings = new Map<string, Decoded>() // resgate ou queima de recibo, por (token, blockedNonce)
  const blockedKeys = new Set<string>()
  for (const evs of byTx.values()) {
    evs.sort((a, b) => a.log.logIndex - b.log.logIndex)
    for (const e of evs) {
      if ((e.name === 'ReceiptClaimed' || e.name === 'ReceiptBurned') && fromGuard(e)) closings.set(nonceKey(e.args.token, e.args.blockedNonce), e)
      if (e.name === 'TransferBlocked' && fromGuard(e)) blockedKeys.add(nonceKey(e.args.token, e.args.blockedNonce))
    }
  }
  const closingOf = (key: string) => {
    const c = closings.get(key)
    if (!c) return { claimed: null, burned: null }
    const tx = c.log.transactionHash as Hex, caller = getAddress(String(c.args.caller))
    return c.name === 'ReceiptClaimed'
      ? { claimed: { txHash: tx, to: getAddress(String(c.args.to)), caller }, burned: null }
      : { claimed: null, burned: { txHash: tx, caller } }
  }
  for (const evs of byTx.values()) {
    const usedHop = new Set<number>(), usedMemo = new Set<number>()
    for (const e of evs) {
      const tx = e.log.transactionHash as Hex
      const at = { txHash: tx, blockNumber: blockOf(e.log), logIndex: e.log.logIndex }
      if (e.name === 'TransferBlocked' && fromGuard(e)) {
        let r: ReturnType<typeof ReceivePolicyReceipt.decode>
        try {
          if (Number(e.args.receiptVersion) !== 1) throw new Error('receipt_version')
          r = ReceivePolicyReceipt.decode(e.args.receipt as Hex)
        } catch {
          out.ignored.push({ ...at, reason: 'receipt_undecodable' })
          continue
        }
        const key = nonceKey(e.args.token, e.args.blockedNonce)
        out.held.push({
          kind: 'held', ...at, token: getAddress(String(e.args.token)), payer: getAddress(r.originator),
          amount: BigInt(String(e.args.amount)), memo: memoOrNull(r.memo), sentTo: getAddress(r.recipient),
          blockedNonce: BigInt(String(e.args.blockedNonce)), blockedReason: r.blockedReason,
          recoveryAuthority: getAddress(r.recoveryAuthority), receipt: e.args.receipt as Hex, ...closingOf(key),
        })
        continue
      }
      if (e.name !== 'Transfer' || !same(String(e.args.to), master)) continue
      const from = getAddress(String(e.args.from))
      const token = getAddress(e.log.address)
      const amount = BigInt(String(e.args.amount))
      if (!isTip20(token)) { out.ignored.push({ ...at, reason: 'not_tip20' }); continue }
      if (same(from, master)) { out.ignored.push({ ...at, reason: 'self_transfer' }); continue }
      const system = SYSTEM_SENDERS.get(from.toLowerCase())
      if (system) { out.ignored.push({ ...at, reason: system }); continue }
      if (!watched(token)) { out.ignored.push({ ...at, reason: 'token_not_watched' }); continue }
      const parsed = parseDepositAddress(from)
      if (parsed) {
        // segundo salto (virtual -> mestre): o primeiro (pagador -> virtual) vem antes, na mesma transação, e é usado uma vez
        const hop = evs.find(x => x.name === 'Transfer' && x.log.logIndex < e.log.logIndex && !usedHop.has(x.log.logIndex) &&
          same(x.log.address, token) && same(String(x.args.to), from) && BigInt(String(x.args.amount)) === amount)
        if (!hop) { out.ignored.push({ ...at, reason: 'forward_without_first_hop' }); continue }
        usedHop.add(hop.log.logIndex)
        const payer = getAddress(String(hop.args.from))
        if (same(payer, master)) { out.ignored.push({ ...at, reason: 'self_forward' }); continue }
        const memoEv = evs.find(x => x.name === 'TransferWithMemo' && !usedMemo.has(x.log.logIndex) &&
          x.log.logIndex > hop.log.logIndex && x.log.logIndex < e.log.logIndex && same(x.log.address, token) &&
          same(String(x.args.from), payer) && same(String(x.args.to), from) && BigInt(String(x.args.amount)) === amount)
        if (memoEv) usedMemo.add(memoEv.log.logIndex)
        out.deposits.push({ kind: 'deposit', ...at, token, payer, amount, memo: memoEv ? (memoEv.args.memo as Hex) : null,
          depositAddress: from, masterId: parsed.masterId, tag: parsed.tag })
        continue
      }
      const memoEv = evs.find(x => x.name === 'TransferWithMemo' && !usedMemo.has(x.log.logIndex) && x.log.logIndex > e.log.logIndex &&
        same(x.log.address, token) && same(String(x.args.from), from) && same(String(x.args.to), master) && BigInt(String(x.args.amount)) === amount)
      if (memoEv) usedMemo.add(memoEv.log.logIndex)
      out.direct.push({ kind: 'direct', ...at, token, payer: from, amount, memo: memoEv ? (memoEv.args.memo as Hex) : null })
    }
  }
  // resgate ou queima sem o bloqueio neste lote: o recibo veio antes, mas o desfecho chega agora
  for (const [key, c] of closings) {
    if (blockedKeys.has(key)) continue
    out.held.push({
      kind: 'held', txHash: c.log.transactionHash as Hex, blockNumber: blockOf(c.log), logIndex: c.log.logIndex,
      token: getAddress(String(c.args.token)), payer: getAddress(String(c.args.originator)), amount: BigInt(String(c.args.amount)),
      memo: null, sentTo: getAddress(String(c.args.recipient)), blockedNonce: BigInt(String(c.args.blockedNonce)),
      blockedReason: null, recoveryAuthority: getAddress(String(c.args.recoveryAuthority)), receipt: null, ...closingOf(key),
    })
  }
  out.deposits.sort(order); out.direct.sort(order); out.held.sort(order); out.ignored.sort(order)
  return out
}

type Out<C extends string, P, X = {}> = { code: C; payment: P; explanation: string; action: string } & X
export type DepositOutcome =
  | Out<'matched', Deposit, { orderRef: string }>
  | Out<'completed_by_top_up', Deposit, { orderRef: string; payments: Hex[] }>
  | Out<'amount_short', Deposit, { orderRef: string; expected: bigint; received: bigint; missing: bigint }>
  | Out<'amount_over', Deposit, { orderRef: string; expected: bigint; received: bigint; excess: bigint }>
  | Out<'second_payment', Deposit, { orderRef: string; firstTx: Hex }>
  | Out<'wrong_token', Deposit, { orderRef: string }>
  | Out<'unknown_deposit_address', Deposit, { orderRef: null }>
  | Out<'no_reference', DirectPayment, { orderRef: null }>
  | Out<'held_by_receive_policy', HeldPayment, { orderRef: string | null; status: 'held' | 'returned_to_payer' | 'released' | 'burned' }>
  | Out<'not_reconciled', Ignored, { orderRef: null }>

const usd = (n: bigint) => {
  const neg = n < 0n, v = neg ? -n : n
  return `${neg ? '-' : ''}US$ ${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0').replace(/0{1,4}$/, '')}`
}
const NOT_RECONCILED: Record<string, string> = {
  forward_without_first_hop: 'A payment reached the merchant wallet through a deposit address, but these logs miss the payer hop.',
  token_not_watched: 'A token outside the watch list reached the merchant wallet.',
  not_tip20: 'A Transfer to the merchant wallet came from a contract that is not a TIP-20 token.',
  receipt_undecodable: 'A payment was held by the receive policy, but its receipt could not be decoded.',
}

/**
 * Regras determinísticas (o copiloto só veria o resíduo): cada entrada na mestre vira um desfecho com a razão e o
 * próximo passo. Pagamentos de um pedido somam até o valor: o complemento de um pagamento a menos fecha o pedido;
 * só o que chega DEPOIS do pedido pago é segundo pagamento. Valores em 6 casas (dólares digitais da Tempo).
 */
export function reconcileDeposits(issued: IssuedDeposit[], scan: ScanResult): DepositOutcome[] {
  const byAddress = addressIndex(issued)
  const state = new Map<string, { received: bigint; payments: Hex[] }>()
  const out: DepositOutcome[] = []
  for (const p of scan.deposits) {
    const o = byAddress.get(p.depositAddress.toLowerCase())
    if (!o) {
      out.push({ code: 'unknown_deposit_address', orderRef: null, payment: p,
        explanation: `${usd(p.amount)} arrived at deposit address ${p.depositAddress}, which this merchant never issued for an order.`,
        action: 'Hold for review; return to the payer if no order claims it.' })
      continue
    }
    if (!o.tokens.some(t => same(t, p.token))) {
      out.push({ code: 'wrong_token', orderRef: o.orderRef, payment: p,
        explanation: `Order ${o.orderRef} was paid in a token the order does not accept.`,
        action: 'Convert or return; do not settle the order on this payment.' })
      continue
    }
    const s = state.get(o.orderRef) ?? { received: 0n, payments: [] }
    state.set(o.orderRef, s)
    if (s.received >= o.amount) {
      out.push({ code: 'second_payment', orderRef: o.orderRef, payment: p, firstTx: s.payments[0]!,
        explanation: `Order ${o.orderRef} was already paid in full; this is another payment of ${usd(p.amount)}.`,
        action: 'Refund this payment to the payer.' })
      continue
    }
    s.received += p.amount
    s.payments.push(p.txHash)
    const n = s.payments.length, over = n > 1 ? ` after ${n} payments` : ''
    if (s.received === o.amount) {
      out.push(n === 1
        ? { code: 'matched', orderRef: o.orderRef, payment: p,
          explanation: `Order ${o.orderRef} paid in full (${usd(p.amount)}), identified by its own deposit address${p.memo ? '' : ', no memo needed'}.`,
          action: 'Settle the order.' }
        : { code: 'completed_by_top_up', orderRef: o.orderRef, payment: p, payments: [...s.payments],
          explanation: `Order ${o.orderRef} is now paid in full (${usd(o.amount)}) over ${n} payments.`,
          action: 'Settle the order.' })
    } else if (s.received < o.amount) {
      out.push({ code: 'amount_short', orderRef: o.orderRef, payment: p, expected: o.amount, received: s.received, missing: o.amount - s.received,
        explanation: `Order ${o.orderRef} expected ${usd(o.amount)} and has received ${usd(s.received)}${over}: ${usd(o.amount - s.received)} short.`,
        action: 'Ask the payer for the difference at the same address, or refund; do not settle yet.' })
    } else {
      out.push({ code: 'amount_over', orderRef: o.orderRef, payment: p, expected: o.amount, received: s.received, excess: s.received - o.amount,
        explanation: `Order ${o.orderRef} expected ${usd(o.amount)} and has received ${usd(s.received)}${over}: ${usd(s.received - o.amount)} over.`,
        action: 'Settle the order and refund the excess.' })
    }
  }
  for (const p of scan.direct) {
    out.push({ code: 'no_reference', orderRef: null, payment: p,
      explanation: `${usd(p.amount)} was sent straight to the merchant wallet, not to a deposit address, so no order can be inferred.`,
      action: 'Ask the payer which order it pays, or return it.' })
  }
  for (const p of scan.held) {
    const o = byAddress.get(p.sentTo.toLowerCase())
    const status = p.burned ? 'burned' : p.claimed ? (same(p.claimed.caller, p.payer) ? 'returned_to_payer' : 'released') : 'held'
    const action = {
      held: same(p.recoveryAuthority, ZERO) ? 'The payer can reclaim it with the receipt.' : 'The recovery authority can release it with the receipt.',
      returned_to_payer: 'Reclaimed by the payer; nothing to settle.',
      released: 'Released by the recovery authority; reconcile where it was sent.',
      burned: 'Burned by the token issuer; nothing to settle or return.',
    }[status]
    out.push({ code: 'held_by_receive_policy', orderRef: o?.orderRef ?? null, payment: p, status, action,
      explanation: `${usd(p.amount)} in a token the merchant does not accept was held on-chain by the receive policy${o ? ` (meant for order ${o.orderRef})` : ''}; it never reached the merchant.` })
  }
  for (const i of scan.ignored) {
    const explanation = NOT_RECONCILED[i.reason]
    if (!explanation) continue // taxa, autoenvio, troca na DEX, cunhagem e liberação do guarda não são pagamento de cliente
    out.push({ code: 'not_reconciled', orderRef: null, payment: i, explanation,
      action: i.reason === 'forward_without_first_hop' ? 'Fetch the full transaction receipt and reconcile again.' : 'Review by hand before crediting any order.' })
  }
  return out
}
