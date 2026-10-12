// Ensaio REAL na Tempo Moderato (testnet, chain 42431): endereço de depósito por pedido (TIP-1022) e política de
// recebimento (TIP-403) na carteira mestre, conciliados pelos logs com as regras de src/chain/deposits.ts.
// Não usa chave da PixSettle nem da loja: cria contas DESCARTÁVEIS de testnet, pega fundos na torneira da rede
// (tokens de teste, sem valor), minera o salt do TIP-1022, registra a mestre, define a lista de tokens aceitos,
// faz os pagamentos de exemplo, resgata o retido e concilia. Cada passo é idempotente pelo arquivo de estado.
//
// Uso:  npx tsx scripts/tempo-deposits-moderato.ts [pasta-de-estado]      (padrão: .tempo-deposits, fora do git)
// Saída: tabela no terminal e <pasta>/evidence.json com hashes e links do explorador.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { availableParallelism } from 'node:os'
import { randomBytes } from 'node:crypto'
import { decodeEventLog, erc20Abi, formatUnits, http, pad, parseAbi, parseUnits, stringToHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account, Actions, VirtualMaster, createClient } from 'viem/tempo'
import {
  depositTag, depositAddress, issueDepositAddresses, reconcileDeposits, scanMasterInflows,
  RECEIVE_POLICY_GUARD, type ChainLog,
} from '../src/chain/deposits.js'

const RPC = process.env.TEMPO_RPC ?? 'https://rpc.moderato.tempo.xyz'
const EXPLORER = process.env.EXPLORER ?? 'https://explore.testnet.tempo.xyz'
const PATH_USD = '0x20c0000000000000000000000000000000000000' as Hex
const ALPHA_USD = '0x20c0000000000000000000000000000000000001' as Hex
const BETA_USD = '0x20c0000000000000000000000000000000000002' as Hex
const MERCHANT = 'mer_demo_moderato'
const usd = (v: string) => parseUnits(v, 6)

const dir = process.argv[2] ?? '.tempo-deposits'
mkdirSync(dir, { recursive: true, mode: 0o700 })
writeFileSync(join(dir, '.gitignore'), '*\n') // a pasta de estado (com as chaves de testnet) nunca entra no git
const stateFile = join(dir, 'state.json')
type State = Record<string, any>
const st: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}
const save = () => writeFileSync(stateFile, JSON.stringify(st, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 1), { mode: 0o600 })
const step = (s: string) => console.log(`\n== ${s}`)

// 1. Contas descartáveis de testnet (nunca usar fora da Moderato)
const keysFile = join(dir, 'testnet-keys.json')
if (!existsSync(keysFile)) {
  writeFileSync(keysFile, JSON.stringify({ warning: 'TESTNET ONLY, disposable', master: generatePrivateKey(), payer: generatePrivateKey() }), { mode: 0o600 })
}
const keys = JSON.parse(readFileSync(keysFile, 'utf8')) as { master: Hex; payer: Hex }
const client = (key: Hex) => createClient({ account: Account.fromSecp256k1(key), testnet: true, transport: http(RPC), feeToken: PATH_USD })
const master = client(keys.master), payer = client(keys.payer)
const masterAddr = privateKeyToAccount(keys.master).address, payerAddr = privateKeyToAccount(keys.payer).address
if ((await master.getChainId()) !== 42431) throw new Error('this script only runs on Tempo Moderato (42431)')
console.log('master (merchant wallet)', masterAddr, '\npayer (customer)', payerAddr)

const balance = (token: Hex, who: Hex) => master.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] })

step('faucet (test tokens)')
for (const [name, c, addr] of [['master', master, masterAddr], ['payer', payer, payerAddr]] as const) {
  if ((await balance(PATH_USD, addr)) >= usd('100')) { console.log(name, 'already funded'); continue }
  await Actions.faucet.fundSync(c, { account: c.account! })
  console.log(name, 'pathUSD', formatUnits(await balance(PATH_USD, addr), 6))
}

step('TIP-1022: mine salt and register the master')
if (!st.salt) {
  // 32 bits de prova de trabalho: em média 2^32 tentativas (alguns minutos com todos os núcleos)
  const t0 = Date.now(); let last = 0
  let found: Awaited<ReturnType<typeof VirtualMaster.mineSaltAsync>> = undefined
  for (let round = 0; round < 4 && !found; round++) {
    const start = BigInt('0x' + randomBytes(8).toString('hex')) << 64n // cada rodada começa num ponto aleatório
    found = await VirtualMaster.mineSaltAsync({
      address: masterAddr, start,
      // o padrão da biblioteca é núcleos - 1, que numa máquina de 2 núcleos cai no modo de 1 linha (lento)
      workers: Math.max(2, availableParallelism()), chunkSize: 1_000_000,
      onProgress: p => { if (Date.now() - last > 15_000) { last = Date.now(); console.log(`  ${(p.attempts / 1e6).toFixed(0)}M attempts, ${(p.rate / 1e6).toFixed(1)}M/s`) } },
    })
  }
  if (!found) throw new Error('no TIP-1022 salt found after 4 rounds of 2^32 attempts')
  st.salt = { salt: found.salt, masterId: found.masterId, seconds: Math.round((Date.now() - t0) / 1000) }; save()
}
const masterId = st.salt.masterId as Hex
const current = await Actions.virtualAddress.getMasterAddress(master, { masterId }) // não registrado = null; erro de RPC sobe
if (current && current.toLowerCase() === masterAddr.toLowerCase()) console.log('masterId', masterId, 'already registered')
else {
  const r = await Actions.virtualAddress.registerMasterSync(master, { salt: st.salt.salt })
  st.register = r.receipt.transactionHash; save()
  console.log('masterId', masterId, 'registered in', st.register)
}

step('TIP-403: the master accepts only pathUSD and AlphaUSD')
const policy = await Actions.receivePolicy.get(master, { account: masterAddr })
if (!st.tokenPolicyId) { // grava a política antes de aplicar: uma falha no passo seguinte não cria outra lista na próxima rodada
  const p = await Actions.policy.createSync(master, { admin: masterAddr, type: 'whitelist', addresses: [PATH_USD, ALPHA_USD] })
  Object.assign(st, { tokenPolicyId: p.policyId.toString(), tokenPolicyTx: p.receipt.transactionHash }); save()
}
if (!policy.hasReceivePolicy || String(policy.tokenPolicyId) !== String(st.tokenPolicyId)) {
  const r = await Actions.receivePolicy.setSync(master, { senderPolicyId: 'allow-all', tokenPolicyId: BigInt(st.tokenPolicyId), claimer: 'sender' })
  st.receivePolicyTx = r.receipt.transactionHash; save()
}
console.log('token whitelist policy', st.tokenPolicyId, '(anything else is held by the guard; the payer can reclaim it)')

step('orders and their deposit addresses')
st.runId = st.runId ?? randomBytes(3).toString('hex'); save()
const ref = (s: string) => `ord-${st.runId}-${s}`
const issued = issueDepositAddresses(masterId, MERCHANT, [
  { orderRef: ref('A'), amount: usd('25'), tokens: [PATH_USD] },
  { orderRef: ref('B'), amount: usd('40'), tokens: [PATH_USD] },
  { orderRef: ref('C'), amount: usd('12'), tokens: [PATH_USD] },
  { orderRef: ref('D'), amount: usd('18.90'), tokens: [PATH_USD, ALPHA_USD] },
])
for (const i of issued) console.log(i.orderRef.padEnd(16), i.address, formatUnits(i.amount, 6))
const addr = (s: string) => issued.find(i => i.orderRef === ref(s))!.address
const neverIssued = depositAddress(masterId, depositTag(MERCHANT, ref('never-issued')))

step('payments from the customer wallet')
st.pay = st.pay ?? {}
const plan: [string, { to: Hex; amount: bigint; token: Hex; memo?: Hex }][] = [
  ['A exact, no memo', { to: addr('A'), amount: usd('25'), token: PATH_USD }],
  ['B short by 0.50', { to: addr('B'), amount: usd('39.50'), token: PATH_USD }],
  ['A paid twice', { to: addr('A'), amount: usd('25'), token: PATH_USD }],
  ['address never issued', { to: neverIssued, amount: usd('5'), token: PATH_USD }],
  ['C in BetaUSD (not accepted)', { to: addr('C'), amount: usd('12'), token: BETA_USD }],
  ['straight to the merchant wallet', { to: masterAddr, amount: usd('7'), token: PATH_USD }],
  ['D in AlphaUSD with memo', { to: addr('D'), amount: usd('18.90'), token: ALPHA_USD, memo: pad(stringToHex(ref('D').slice(0, 31)), { dir: 'right', size: 32 }) }],
]
for (const [name, p] of plan) {
  if (st.pay[name] === 'sending') // a rodada anterior parou no meio do envio: não reenviar às cegas
    throw new Error(`payment "${name}" may already be on chain; check the payer on ${EXPLORER}/address/${payerAddr} or start a new run in a new state folder`)
  if (st.pay[name]) continue
  st.pay[name] = 'sending'; save()
  const r = await Actions.token.transferSync(payer, p)
  st.pay[name] = r.receipt.transactionHash; save()
  console.log(name.padEnd(32), r.receipt.transactionHash)
}

step('the customer reclaims the held BetaUSD with the guard receipt')
const GUARD = parseAbi(['event TransferBlocked(address indexed token, address indexed receiver, uint64 indexed blockedNonce, uint256 amount, uint8 receiptVersion, bytes receipt)'])
if (st.claim === 'sending') throw new Error(`the claim may already be on chain; check ${EXPLORER}/address/${payerAddr}`)
if (!st.claim) {
  const heldTx = await payer.getTransactionReceipt({ hash: st.pay['C in BetaUSD (not accepted)'] })
  const blocked = heldTx.logs.find(l => l.address.toLowerCase() === RECEIVE_POLICY_GUARD.toLowerCase())
  if (!blocked) throw new Error('expected a TransferBlocked receipt for the BetaUSD payment')
  const ev = decodeEventLog({ abi: GUARD, data: blocked.data, topics: blocked.topics })
  st.claim = 'sending'; save()
  const r = await Actions.receivePolicy.claimSync(payer, { to: payerAddr, receipt: ev.args.receipt })
  st.claim = r.receipt.transactionHash; save()
}
console.log('claim', st.claim)

step('reconcile from chain logs')
const txs = [...Object.values(st.pay as Record<string, Hex>), st.claim as Hex]
const logs: ChainLog[] = []
for (const h of txs) {
  const r = await master.getTransactionReceipt({ hash: h })
  for (const l of r.logs) logs.push({ address: l.address, topics: l.topics, data: l.data, transactionHash: l.transactionHash, logIndex: l.logIndex, blockNumber: l.blockNumber })
}
const scan = scanMasterInflows(logs, { master: masterAddr })
const outcomes = reconcileDeposits(issued, scan)
for (const o of outcomes) console.log(`${o.code.padEnd(24)} ${String(o.orderRef ?? '-').padEnd(16)} ${o.explanation}\n${' '.repeat(42)}next: ${o.action}  ${EXPLORER}/tx/${o.payment.txHash}`)

const evidence = {
  chainId: 42431, explorer: EXPLORER, master: masterAddr, masterId, runId: st.runId,
  setup: { registerMaster: st.register ?? null, tokenPolicyId: st.tokenPolicyId, tokenPolicyTx: st.tokenPolicyTx, receivePolicyTx: st.receivePolicyTx },
  payments: st.pay, claim: st.claim,
  outcomes: outcomes.map(o => ({ code: o.code, orderRef: o.orderRef, tx: o.payment.txHash, explanation: o.explanation, action: o.action })),
}
writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 1) + '\n')
console.log(`\nevidence: ${join(dir, 'evidence.json')}`)

// o resultado tem de ser exatamente o do plano; qualquer diferença sai com erro
const expected = [['matched', ref('A')], ['amount_short', ref('B')], ['second_payment', ref('A')], ['unknown_deposit_address', null],
  ['matched', ref('D')], ['no_reference', null], ['held_by_receive_policy', ref('C')]]
const got = outcomes.map(o => [o.code, o.orderRef])
const heldStatus = outcomes.find(o => o.code === 'held_by_receive_policy')
if (JSON.stringify(got) !== JSON.stringify(expected) || !heldStatus || heldStatus.code !== 'held_by_receive_policy' || heldStatus.status !== 'returned_to_payer') {
  console.error('UNEXPECTED OUTCOMES\nexpected', JSON.stringify(expected), '\ngot     ', JSON.stringify(got))
  process.exit(1)
}
console.log('all 7 outcomes as planned')
