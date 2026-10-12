// Endereço de depósito por pedido (TIP-1022) e política de recebimento (TIP-403): regras puras sobre logs.
// Parte dos casos usa logs REAIS copiados da Moderato (fixtures/tempo-deposits-moderato.json); o resto, logs
// sintéticos no mesmo formato para o que a rede não mostrou.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, type Hex } from 'viem'
import { ReceivePolicyReceipt } from 'viem/tempo'
import {
  depositAddress, depositTag, issueDepositAddresses, parseDepositAddress, reconcileDeposits, scanMasterInflows,
  type ChainLog, type DepositOrder, type ScanResult,
} from '../src/chain/deposits.js'

type Fixture = {
  master: Hex; payer: Hex; masterId: Hex; merchantId: string
  orders: { orderRef: string; amount: string; tokens: Hex[] }[]
  transactions: Record<string, { tx: Hex; block: string; status: string }>
  logs: ChainLog[]
}
const fx = JSON.parse(readFileSync(new URL('./fixtures/tempo-deposits-moderato.json', import.meta.url), 'utf8')) as Fixture
const orders: DepositOrder[] = fx.orders.map(o => ({ orderRef: o.orderRef, amount: BigInt(o.amount), tokens: o.tokens }))
const PATH_USD = '0x20C0000000000000000000000000000000000000' as Hex
const ALPHA_USD = '0x20C0000000000000000000000000000000000001' as Hex
const BETA_USD = '0x20C0000000000000000000000000000000000002' as Hex
const GUARD = '0xB10C000000000000000000000000000000000000' as Hex
const ZERO = '0x0000000000000000000000000000000000000000' as Hex
const tx = (name: string) => fx.transactions[name]!.tx
const master = getAddress(fx.master), payer = getAddress(fx.payer)
const issuedAll = () => issueDepositAddresses(fx.masterId, fx.merchantId, orders)
const codes = (scan: ScanResult, issued = issuedAll()) => reconcileDeposits(issued, scan).map(o => [o.code, o.orderRef])

describe('endereço de depósito por pedido (TIP-1022)', () => {
  it('userTag: 6 bytes, determinístico, muda com a loja e com o pedido', () => {
    const a = depositTag('mer_1', 'ord-1')
    expect(a).toMatch(/^0x[0-9a-f]{12}$/)
    expect(depositTag('mer_1', 'ord-1')).toBe(a)
    expect(depositTag('mer_1', 'ord-2')).not.toBe(a)
    expect(depositTag('mer_2', 'ord-1')).not.toBe(a)
    expect(() => depositTag('mer:1', 'ord-1')).toThrow('deposit_tag_invalid_input')
    expect(() => depositTag('mer_1', '')).toThrow('deposit_tag_invalid_input')
  })

  it('layout: masterId nos 4 primeiros bytes, 0xfd x10 no meio, userTag nos 6 últimos; ida e volta', () => {
    const addr = depositAddress('0x533041b7', '0x4e6c533fad9d')
    expect(addr.toLowerCase()).toBe('0x533041b7fdfdfdfdfdfdfdfdfdfd4e6c533fad9d')
    expect(addr).toBe(getAddress(addr))
    expect(parseDepositAddress(addr)).toEqual({ masterId: '0x533041b7', tag: '0x4e6c533fad9d' })
    expect(parseDepositAddress(fx.master)).toBeNull()
    expect(() => depositAddress('0x5330', '0x4e6c533fad9d')).toThrow('deposit_master_id_invalid')
    expect(() => depositAddress('0x533041b7', '0x4e6c')).toThrow('deposit_tag_invalid')
  })

  it('emite um endereço por pedido e recusa dois pedidos no mesmo endereço, também entre emissões separadas', () => {
    const issued = issuedAll()
    expect(issued.map(i => i.address.toLowerCase())).toEqual([
      '0x533041b7fdfdfdfdfdfdfdfdfdfd4e6c533fad9d', '0x533041b7fdfdfdfdfdfdfdfdfdfd1ac375df1a98',
      '0x533041b7fdfdfdfdfdfdfdfdfdfd74649d7ca365', '0x533041b7fdfdfdfdfdfdfdfdfdfd2a32fabfab26',
    ])
    expect(() => issueDepositAddresses(fx.masterId, fx.merchantId, orders, () => '0x000000000001')).toThrow('deposit_tag_collision:ord-A:ord-B')
    expect(() => issueDepositAddresses(fx.masterId, fx.merchantId, [{ orderRef: 'x', amount: 0n, tokens: [PATH_USD] }])).toThrow('deposit_order_invalid:x')
    const one = issueDepositAddresses(fx.masterId, fx.merchantId, [orders[0]!], () => '0x000000000007')
    const two = issueDepositAddresses(fx.masterId, fx.merchantId, [orders[1]!], () => '0x000000000007')
    expect(() => reconcileDeposits([...one, ...two], { deposits: [], direct: [], held: [], ignored: [] })).toThrow('deposit_tag_collision:ord-A:ord-B')
  })
})

describe('logs reais da Moderato: o que chegou à carteira mestre', () => {
  const scan = scanMasterInflows(fx.logs, { master: fx.master })

  it('separa depósito por endereço, pagamento direto e retido, sem contar taxa nem devolução', () => {
    expect(scan.deposits.map(d => d.txHash)).toEqual([tx('A_exact'), tx('B_short'), tx('A_second'), tx('U_unknown'), tx('D_memo_alpha')])
    expect(scan.direct.map(d => d.txHash)).toEqual([tx('X_direct')])
    expect(scan.held.map(d => d.txHash)).toEqual([tx('C_wrong_token')])
    expect(scan.ignored).toEqual([])
    for (const d of scan.deposits) expect(d.payer).toBe(payer)
    const memo = scan.deposits.find(d => d.txHash === tx('D_memo_alpha'))!
    expect(memo.token).toBe(ALPHA_USD)
    expect(Buffer.from(memo.memo!.slice(2), 'hex').toString('ascii').replace(/\0+$/, '')).toBe('ord-D')
    expect(scan.deposits.find(d => d.txHash === tx('A_exact'))!.memo).toBeNull()
  })

  it('o retido aponta para o pedido pelo recibo do guarda e mostra que voltou ao pagador', () => {
    const h = scan.held[0]!
    expect(h.sentTo.toLowerCase()).toBe('0x533041b7fdfdfdfdfdfdfdfdfdfd74649d7ca365')
    expect(h.amount).toBe(12_000_000n)
    expect(h.blockedReason).toBe('tokenFilter')
    expect(h.recoveryAuthority).toBe(ZERO)
    expect(h.claimed).toEqual({ txHash: tx('claim_C'), to: payer, caller: payer })
    expect(h.burned).toBeNull()
  })

  it('regras: pago, a menos, segundo pagamento, endereço não emitido, sem referência e retido devolvido', () => {
    const out = reconcileDeposits(issuedAll(), scan)
    expect(out.map(o => [o.code, o.orderRef, o.payment.txHash])).toEqual([
      ['matched', 'ord-A', tx('A_exact')],
      ['amount_short', 'ord-B', tx('B_short')],
      ['second_payment', 'ord-A', tx('A_second')],
      ['unknown_deposit_address', null, tx('U_unknown')],
      ['matched', 'ord-D', tx('D_memo_alpha')],
      ['no_reference', null, tx('X_direct')],
      ['held_by_receive_policy', 'ord-C', tx('C_wrong_token')],
    ])
    const short = out[1]!
    expect(short.code === 'amount_short' && short.missing).toBe(500_000n)
    expect(short.explanation).toBe('Order ord-B expected US$ 40.00 and has received US$ 39.50: US$ 0.50 short.')
    const second = out[2]!
    expect(second.code === 'second_payment' && second.firstTx).toBe(tx('A_exact'))
    const held = out[6]!
    expect(held.code === 'held_by_receive_policy' && held.status).toBe('returned_to_payer')
    expect(held.action).toBe('Reclaimed by the payer; nothing to settle.')
  })

  it('a ordem dos logs não muda o resultado', () => {
    expect(scanMasterInflows([...fx.logs].reverse(), { master: fx.master })).toEqual(scan)
  })

  it('token que o pedido não aceita vira wrong_token; a mais vira amount_over', () => {
    const strict = orders.map(o => o.orderRef === 'ord-D' ? { ...o, tokens: [PATH_USD] } : o.orderRef === 'ord-B' ? { ...o, amount: 39_000_000n } : o)
    const out = reconcileDeposits(issueDepositAddresses(fx.masterId, fx.merchantId, strict), scan)
    expect(out.find(o => o.orderRef === 'ord-D')!.code).toBe('wrong_token')
    const over = out.find(o => o.orderRef === 'ord-B')!
    expect(over.code === 'amount_over' && over.excess).toBe(500_000n)
  })

  it('retido sem resgate: segue retido e diz que o pagador pode resgatar', () => {
    const s = scanMasterInflows(fx.logs.filter(l => l.transactionHash !== tx('claim_C')), { master: fx.master })
    const held = reconcileDeposits(issuedAll(), s).find(o => o.code === 'held_by_receive_policy')!
    expect(held.code === 'held_by_receive_policy' && held.status).toBe('held')
    expect(held.action).toBe('The payer can reclaim it with the receipt.')
  })

  it('resgate num lote posterior: o desfecho aparece mesmo sem o bloqueio no lote, e aponta o pedido', () => {
    const s = scanMasterInflows(fx.logs.filter(l => l.transactionHash === tx('claim_C')), { master: fx.master })
    expect(s.held).toHaveLength(1)
    expect(s.held[0]!.receipt).toBeNull()
    expect(s.held[0]!.sentTo.toLowerCase()).toBe('0x533041b7fdfdfdfdfdfdfdfdfdfd74649d7ca365')
    const out = reconcileDeposits(issuedAll(), s)
    expect(out.map(o => [o.code, o.orderRef, o.code === 'held_by_receive_policy' ? o.status : null])).toEqual([['held_by_receive_policy', 'ord-C', 'returned_to_payer']])
  })

  it('filtro de token: o que fica fora da lista observada vira not_reconciled, não some', () => {
    const s = scanMasterInflows(fx.logs, { master: fx.master, tokens: [PATH_USD] })
    expect(s.deposits.map(d => d.txHash)).not.toContain(tx('D_memo_alpha'))
    expect(s.ignored).toEqual([{ txHash: tx('D_memo_alpha'), blockNumber: expect.any(BigInt), logIndex: 2, reason: 'token_not_watched' }])
    expect(codes(s).at(-1)).toEqual(['not_reconciled', null])
  })

  it('mesmo userTag com outro masterId não casa com o pedido', () => {
    const otherIssued = issueDepositAddresses('0x11111111', fx.merchantId, orders)
    expect(codes(scan, otherIssued).slice(0, 5)).toEqual(Array(5).fill(['unknown_deposit_address', null]))
  })
})

// ---------- logs sintéticos no formato da rede ----------
const ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
  'event TransferBlocked(address indexed token, address indexed receiver, uint64 indexed blockedNonce, uint256 amount, uint8 receiptVersion, bytes receipt)',
  'event ReceiptClaimed(address indexed token, address indexed receiver, uint64 indexed blockedNonce, uint64 blockedAt, uint8 receiptVersion, address originator, address recipient, address recoveryAuthority, address caller, address to, uint256 amount)',
  'event ReceiptBurned(address indexed token, address indexed receiver, uint64 indexed blockedNonce, uint64 blockedAt, uint8 receiptVersion, address originator, address recipient, address recoveryAuthority, address caller, uint256 amount)',
])
function mk(address: Hex, eventName: (typeof ABI)[number]['name'], args: Record<string, unknown>, logIndex: number, hash: Hex, block = 1n): ChainLog {
  const item = ABI.find(x => x.name === eventName)!
  const inputs = item.inputs as readonly { name: string; type: string; indexed?: boolean }[]
  const indexed = Object.fromEntries(inputs.filter(i => i.indexed).map(i => [i.name, args[i.name]]))
  const plain = inputs.filter(i => !i.indexed)
  return {
    address, topics: encodeEventTopics({ abi: [item], eventName, args: indexed } as never) as string[],
    data: encodeAbiParameters(plain, plain.map(i => args[i.name]) as never), transactionHash: hash, logIndex, blockNumber: block,
  }
}
const H = (n: number) => ('0x' + n.toString(16).padStart(2, '0').repeat(32)) as Hex
const virt = (ref: string, masterId: Hex = fx.masterId) => depositAddress(masterId, depositTag(fx.merchantId, ref))
const transfer = (from: Hex, to: Hex, amount: bigint, i: number, hash: Hex, token: Hex = PATH_USD) => mk(token, 'Transfer', { from, to, amount }, i, hash)
const memo32 = (s: string) => ('0x' + Buffer.from(s.padEnd(32, '\0'), 'ascii').toString('hex')) as Hex
const deposit = (from: Hex, ref: string, amount: bigint, i: number, hash: Hex, token: Hex = PATH_USD) =>
  [transfer(from, virt(ref), amount, i, hash, token), transfer(virt(ref), master, amount, i + 1, hash, token)]
const receipt = (recipient: Hex, opts: { authority?: Hex; nonce?: bigint } = {}) => ReceivePolicyReceipt.encode({
  version: 1, token: BETA_USD, recoveryAuthority: opts.authority ?? ZERO, originator: payer, recipient,
  blockedAt: 1_800_000_000n, blockedNonce: opts.nonce ?? 9n, blockedReason: 'tokenFilter', kind: 'transfer', memo: ('0x' + '00'.repeat(32)) as Hex,
})
const blocked = (recipient: Hex, i: number, hash: Hex, opts: { authority?: Hex; nonce?: bigint; emitter?: Hex; receiver?: Hex; version?: number } = {}) =>
  mk(opts.emitter ?? GUARD, 'TransferBlocked', { token: BETA_USD, receiver: opts.receiver ?? master, blockedNonce: opts.nonce ?? 9n, amount: 3_000_000n,
    receiptVersion: opts.version ?? 1, receipt: receipt(recipient, opts) }, i, hash)
const closing = (name: 'ReceiptClaimed' | 'ReceiptBurned', caller: Hex, i: number, hash: Hex, opts: { to?: Hex; emitter?: Hex; nonce?: bigint; recipient?: Hex } = {}) =>
  mk(opts.emitter ?? GUARD, name, { token: BETA_USD, receiver: master, blockedNonce: opts.nonce ?? 9n, blockedAt: 1_800_000_000n, receiptVersion: 1,
    originator: payer, recipient: opts.recipient ?? virt('ord-C'), recoveryAuthority: ZERO, caller, to: opts.to ?? caller, amount: 3_000_000n }, i, hash, 2n)
const scanOf = (logs: ChainLog[]) => scanMasterInflows(logs, { master })

describe('pagamentos de um pedido somam até o valor', () => {
  it('complemento de um pagamento a menos fecha o pedido (não é segundo pagamento)', () => {
    const s = scanOf([...deposit(payer, 'ord-B', 39_500_000n, 0, H(1)), ...deposit(payer, 'ord-B', 500_000n, 0, H(2))])
    const out = reconcileDeposits(issuedAll(), s)
    expect(out.map(o => o.code)).toEqual(['amount_short', 'completed_by_top_up'])
    expect(out[1]!.code === 'completed_by_top_up' && out[1]!.payments).toEqual([H(1), H(2)])
    expect(out[0]!.action).toBe('Ask the payer for the difference at the same address, or refund; do not settle yet.')
  })

  it('complemento que ainda falta e complemento que passa do valor', () => {
    const short = reconcileDeposits(issuedAll(), scanOf([...deposit(payer, 'ord-B', 30_000_000n, 0, H(1)), ...deposit(payer, 'ord-B', 5_000_000n, 0, H(2))]))
    expect(short.map(o => o.code)).toEqual(['amount_short', 'amount_short'])
    expect(short[1]!.code === 'amount_short' && [short[1]!.received, short[1]!.missing]).toEqual([35_000_000n, 5_000_000n])
    const over = reconcileDeposits(issuedAll(), scanOf([...deposit(payer, 'ord-B', 30_000_000n, 0, H(1)), ...deposit(payer, 'ord-B', 12_000_000n, 0, H(2))]))
    expect(over.map(o => o.code)).toEqual(['amount_short', 'amount_over'])
    expect(over[1]!.code === 'amount_over' && over[1]!.excess).toBe(2_000_000n)
  })

  it('pago a mais e depois outro pagamento: o segundo é segundo pagamento', () => {
    const out = reconcileDeposits(issuedAll(), scanOf([...deposit(payer, 'ord-B', 41_000_000n, 0, H(1)), ...deposit(payer, 'ord-B', 1_000_000n, 0, H(2))]))
    expect(out.map(o => o.code)).toEqual(['amount_over', 'second_payment'])
  })
})

describe('o que tocou a mestre e não é pagamento de cliente, ou não dá para provar', () => {
  it('autoenvio, autoenvio pela virtual, taxa, guarda, troca na DEX e cunhagem: ignorados sem desfecho', () => {
    const s = scanOf([
      transfer(master, master, 1n, 0, H(1)),
      transfer(master, virt('ord-A'), 2n, 0, H(2)), transfer(virt('ord-A'), master, 2n, 1, H(2)),
      transfer('0xfeEC000000000000000000000000000000000000', master, 3n, 0, H(3)),
      transfer(GUARD, master, 4n, 0, H(4)),
      transfer('0xDEc0000000000000000000000000000000000000', master, 5n, 0, H(5)),
      transfer(ZERO, master, 6n, 0, H(6)),
    ])
    expect(s.ignored.map(i => [i.txHash, i.reason])).toEqual([
      [H(1), 'self_transfer'], [H(2), 'self_forward'], [H(3), 'fee_refund'], [H(4), 'guard_release'], [H(5), 'dex_transfer'], [H(6), 'mint'],
    ])
    expect(s.deposits).toEqual([]); expect(s.direct).toEqual([])
    expect(reconcileDeposits(issuedAll(), s)).toEqual([])
  })

  it('Transfer de contrato que não é TIP-20 e segundo salto sem o primeiro viram not_reconciled com o motivo', () => {
    const fake = '0x1234567890123456789012345678901234567890' as Hex
    const s = scanOf([transfer(payer, master, 9n, 0, H(1), fake), transfer(virt('ord-A'), master, 5n, 0, H(2))])
    expect(s.ignored.map(i => i.reason)).toEqual(['not_tip20', 'forward_without_first_hop'])
    const out = reconcileDeposits(issuedAll(), s)
    expect(out.map(o => [o.code, o.action])).toEqual([
      ['not_reconciled', 'Review by hand before crediting any order.'],
      ['not_reconciled', 'Fetch the full transaction receipt and reconcile again.'],
    ])
  })

  it('o primeiro salto tem de ser do mesmo token, do mesmo valor e vir antes', () => {
    const wrongToken = scanOf([transfer(payer, virt('ord-A'), 5n, 0, H(1), ALPHA_USD), transfer(virt('ord-A'), master, 5n, 1, H(1))])
    const wrongAmount = scanOf([transfer(payer, virt('ord-A'), 6n, 0, H(2)), transfer(virt('ord-A'), master, 5n, 1, H(2))])
    const after = scanOf([transfer(virt('ord-A'), master, 5n, 0, H(3)), transfer(payer, virt('ord-A'), 5n, 1, H(3))])
    for (const s of [wrongToken, wrongAmount, after]) {
      expect(s.deposits).toEqual([])
      expect(s.ignored.map(i => i.reason)).toEqual(['forward_without_first_hop'])
    }
  })

  it('dois depósitos na mesma transação: cada salto casa com o seu primeiro salto e o seu pagador', () => {
    const other = getAddress('0x00000000000000000000000000000000000000aa')
    const s = scanOf([...deposit(payer, 'ord-A', 7n, 0, H(3)), ...deposit(other, 'ord-A', 7n, 2, H(3))])
    expect(s.deposits.map(d => [d.logIndex, d.payer])).toEqual([[1, payer], [3, other]])
  })

  it('ignored sai em ordem estável, qualquer que seja a ordem dos logs', () => {
    const logs = [transfer(master, master, 1n, 0, H(9)), transfer(ZERO, master, 6n, 0, H(1)), transfer(GUARD, master, 4n, 3, H(1))]
    expect(scanOf(logs).ignored).toEqual(scanOf([...logs].reverse()).ignored)
    expect(scanOf(logs).ignored.map(i => [i.txHash, i.logIndex])).toEqual([[H(1), 0], [H(1), 3], [H(9), 0]])
  })
})

describe('memo: só o do próprio pagamento, usado uma vez', () => {
  it('memo de outro pagador ou fora da janela entre os saltos não entra', () => {
    const other = getAddress('0x00000000000000000000000000000000000000aa')
    const fromOther = scanOf([transfer(payer, virt('ord-A'), 5n, 0, H(1)), mk(PATH_USD, 'TransferWithMemo', { from: other, to: virt('ord-A'), amount: 5n, memo: memo32('x') }, 1, H(1)), transfer(virt('ord-A'), master, 5n, 2, H(1))])
    expect(fromOther.deposits[0]!.memo).toBeNull()
    const late = scanOf([transfer(payer, virt('ord-A'), 5n, 0, H(2)), transfer(virt('ord-A'), master, 5n, 1, H(2)), mk(PATH_USD, 'TransferWithMemo', { from: payer, to: virt('ord-A'), amount: 5n, memo: memo32('x') }, 2, H(2))])
    expect(late.deposits[0]!.memo).toBeNull()
  })

  it('dois pagamentos diretos do mesmo valor com memos diferentes: cada um com o seu', () => {
    const s = scanOf([
      transfer(payer, master, 5n, 0, H(1)), mk(PATH_USD, 'TransferWithMemo', { from: payer, to: master, amount: 5n, memo: memo32('ord-1') }, 1, H(1)),
      transfer(payer, master, 5n, 2, H(1)), mk(PATH_USD, 'TransferWithMemo', { from: payer, to: master, amount: 5n, memo: memo32('ord-2') }, 3, H(1)),
    ])
    expect(s.direct.map(d => d.memo)).toEqual([memo32('ord-1'), memo32('ord-2')])
    const grouped = scanOf([
      transfer(payer, master, 5n, 0, H(2)), transfer(payer, master, 5n, 1, H(2)),
      mk(PATH_USD, 'TransferWithMemo', { from: payer, to: master, amount: 5n, memo: memo32('ord-1') }, 2, H(2)),
      mk(PATH_USD, 'TransferWithMemo', { from: payer, to: master, amount: 5n, memo: memo32('ord-2') }, 3, H(2)),
    ])
    expect(grouped.direct.map(d => d.memo)).toEqual([memo32('ord-1'), memo32('ord-2')])
  })
})

describe('política de recebimento: retido, devolvido, liberado e queimado', () => {
  it('só o guarda, e só para esta mestre, gera retido; o resgate também só vale do guarda', () => {
    const fakeGuard = '0x00000000000000000000000000000000000000bb' as Hex
    const s = scanOf([
      blocked(virt('ord-C'), 0, H(1), { emitter: fakeGuard }),
      blocked(virt('ord-C'), 0, H(2), { receiver: getAddress('0x00000000000000000000000000000000000000cc'), nonce: 8n }),
      blocked(virt('ord-C'), 0, H(3), { nonce: 7n }), closing('ReceiptClaimed', payer, 0, H(4), { emitter: fakeGuard, nonce: 7n }),
    ])
    expect(s.held.map(h => [h.txHash, h.claimed])).toEqual([[H(3), null]])
  })

  it('pagador resgatando para outra carteira dele ainda é devolvido ao pagador; autoridade de recuperação é liberado', () => {
    const otherWallet = getAddress('0x00000000000000000000000000000000000000dd'), authority = getAddress('0x00000000000000000000000000000000000000ee')
    const returned = reconcileDeposits(issuedAll(), scanOf([blocked(virt('ord-C'), 0, H(1)), closing('ReceiptClaimed', payer, 0, H(2), { to: otherWallet })]))
    expect(returned.map(o => o.code === 'held_by_receive_policy' && o.status)).toEqual(['returned_to_payer'])
    const released = reconcileDeposits(issuedAll(), scanOf([blocked(virt('ord-C'), 0, H(1), { authority }), closing('ReceiptClaimed', authority, 0, H(2), { to: authority })]))
    expect(released.map(o => o.code === 'held_by_receive_policy' && [o.status, o.action])).toEqual([['released', 'Released by the recovery authority; reconcile where it was sent.']])
    const pending = reconcileDeposits(issuedAll(), scanOf([blocked(virt('ord-C'), 0, H(1), { authority })]))
    expect(pending[0]!.action).toBe('The recovery authority can release it with the receipt.')
  })

  it('recibo queimado pelo emissor vira burned', () => {
    const out = reconcileDeposits(issuedAll(), scanOf([blocked(virt('ord-C'), 0, H(1)), closing('ReceiptBurned', getAddress('0x00000000000000000000000000000000000000ff'), 0, H(2))]))
    expect(out.map(o => o.code === 'held_by_receive_policy' && [o.status, o.action])).toEqual([['burned', 'Burned by the token issuer; nothing to settle or return.']])
  })

  it('retido enviado direto à mestre ou a endereço de outro masterId não aponta pedido', () => {
    const out = reconcileDeposits(issuedAll(), scanOf([blocked(master, 0, H(1), { nonce: 1n }), blocked(virt('ord-C', '0x22222222'), 0, H(2), { nonce: 2n })]))
    expect(out.map(o => [o.code, o.orderRef])).toEqual([['held_by_receive_policy', null], ['held_by_receive_policy', null]])
  })

  it('recibo de versão desconhecida não derruba a varredura: vira not_reconciled', () => {
    const s = scanOf([blocked(virt('ord-C'), 0, H(1), { version: 2 })])
    expect(s.held).toEqual([])
    expect(s.ignored.map(i => i.reason)).toEqual(['receipt_undecodable'])
    expect(reconcileDeposits(issuedAll(), s).map(o => o.code)).toEqual(['not_reconciled'])
  })
})
