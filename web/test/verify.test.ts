// Verificador do recibo no navegador (web/src/verify.ts) contra uma RPC falsa.
// Regra: "fail" quando o recibo não bate com a cadeia; "unavailable" SÓ quando a RPC não respondeu.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { toEventSelector, pad, toHex } from 'viem'
import { signReceipt, type ReceiptEnvelope } from '../../settlement/src/receipt.js'
import { verifyReceipt, recipientCommitment, type Step } from '../src/verify.js'

const V = JSON.parse(readFileSync(new URL('../../contract/vectors/receipt-v1.json', import.meta.url), 'utf8'))
const BASE = V.valid.find((c: any) => c.name === 'settlement_basic').envelope.payload
const KEY = V.test_private_key
const TRUSTED: string[] = V.trusted_issuers
const TOPIC = toEventSelector('TransferWithMemo(address,address,uint256,bytes32)')
const FAST = { timeoutMs: 800, retryCount: 0 }

type Mode = { kind: 'receipt'; patch?: (r: any) => void } | { kind: 'null' } | { kind: 'rpc_error' } | { kind: 'http_500' } | { kind: 'hang' }
let mode: Mode = { kind: 'receipt' }
let calls = 0
let server: Server
let rpc = ''

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)) }

function chainReceipt(p: any) {
  const s = p.settlement
  return {
    transactionHash: s.tx_hash, transactionIndex: '0x0', blockHash: s.block_hash, blockNumber: toHex(BigInt(s.block_number)),
    from: p.treasury, to: p.token, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1',
    contractAddress: null, logsBloom: '0x' + '00'.repeat(256), status: '0x1', type: '0x2',
    logs: [
      // log 0: outro evento qualquer, para garantir que o verificador procura o log certo
      { address: p.token, topics: [pad('0x01')], data: '0x', logIndex: '0x0', blockHash: s.block_hash, blockNumber: toHex(BigInt(s.block_number)), transactionHash: s.tx_hash, transactionIndex: '0x0', removed: false },
      { address: p.token, topics: [TOPIC, pad(p.treasury), pad(s.to), s.memo], data: pad(toHex(BigInt(s.amount))), logIndex: toHex(s.log_index),
        blockHash: s.block_hash, blockNumber: toHex(BigInt(s.block_number)), transactionHash: s.tx_hash, transactionIndex: '0x0', removed: false },
    ],
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      calls++
      const m = mode
      if (m.kind === 'hang') return // nunca responde: vira tempo esgotado
      if (m.kind === 'http_500') { res.writeHead(500); res.end('boom'); return }
      const q = JSON.parse(body)
      const reply = (x: object) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, ...x })) }
      if (q.method !== 'eth_getTransactionReceipt') return reply({ error: { code: -32601, message: 'method not found' } })
      if (m.kind === 'rpc_error') return reply({ error: { code: -32000, message: 'node is syncing' } })
      if (m.kind === 'null') return reply({ result: null })
      // Como um nó de verdade: hash malformado é erro de parâmetro; hash desconhecido não tem recibo.
      const h = String(q.params?.[0] ?? '')
      if (!/^0x[0-9a-fA-F]{64}$/.test(h)) return reply({ error: { code: -32602, message: 'invalid params' } })
      if (h.toLowerCase() !== BASE.settlement.tx_hash.toLowerCase()) return reply({ result: null })
      const r = chainReceipt(BASE)
      m.patch?.(r)
      reply({ result: r })
    })
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.closeAllConnections(); server.close() })

async function run(env: ReceiptEnvelope, m: Mode, url = rpc): Promise<{ sig: Step; chain: Step; steps: Step[]; calls: number }> {
  mode = m; calls = 0
  const steps = await verifyReceipt(env, TRUSTED, url, FAST)
  return { sig: steps.find(s => s.key === 'signature')!, chain: steps.find(s => s.key === 'chain')!, steps, calls }
}
const signed = (edit?: (p: any) => void) => { const p = clone(BASE); edit?.(p); return signReceipt(p, KEY) }

describe('verificador do navegador: recibo que bate com a cadeia', () => {
  it('válido: assinatura ok e liquidação ok', async () => {
    const r = await run(await signed(), { kind: 'receipt' })
    expect(r.sig.state).toBe('ok')
    expect(r.chain.state).toBe('ok')
    expect(r.chain.detail).toContain(`block ${BASE.settlement.block_number}`)
    expect(r.calls).toBe(1)
  })
})

describe('verificador do navegador: assinatura', () => {
  it('adulterado depois de assinado (valor trocado): assinatura falha', async () => {
    const env = await signed()
    ;(env.payload as any).settlement.amount = '99999999'
    const r = await run(env, { kind: 'receipt' })
    expect(r.sig.state).toBe('fail')
    expect(r.sig.detail).toMatch(/^digest_mismatch/)
    expect(r.chain.state).toBe('fail') // o valor também não bate com o log
  })
  it('emissor fora da lista confiável: assinatura falha', async () => {
    const env = await signed()
    const steps = await verifyReceipt(env, ['0x0000000000000000000000000000000000000001'], rpc, FAST)
    expect(steps.find(s => s.key === 'signature')!.detail).toMatch(/^untrusted_issuer/)
    expect(steps.find(s => s.key === 'signature')!.state).toBe('fail')
  })
})

describe('verificador do navegador: recibo que não bate com a cadeia falha', () => {
  it('rede errada (chain_id 1): fail, sem consultar a RPC', async () => {
    const r = await run(await signed(p => { p.chain_id = 1 }), { kind: 'receipt' })
    expect(r.sig.state).toBe('ok')
    expect(r.chain.state).toBe('fail')
    expect(r.chain.detail).toContain('not Tempo Moderato')
    expect(r.calls).toBe(0)
  })
  it('tx_hash malformado: fail, sem consultar a RPC', async () => {
    const r = await run(await signed(p => { p.settlement.tx_hash = '0x1234' }), { kind: 'receipt' })
    expect(r.chain.state).toBe('fail')
    expect(r.chain.detail).toContain('tx_hash')
    expect(r.calls).toBe(0)
  })
  it('valor e destino malformados: fail listando os campos', async () => {
    const r = await run(await signed(p => { p.settlement.amount = '1.5'; p.settlement.to = 'nobody' }), { kind: 'receipt' })
    expect(r.chain.state).toBe('fail')
    expect(r.chain.detail).toMatch(/amount/)
    expect(r.chain.detail).toMatch(/\bto\b/)
    expect(r.calls).toBe(0)
  })
  it('transação revertida: fail', async () => {
    const r = await run(await signed(), { kind: 'receipt', patch: x => { x.status = '0x0' } })
    expect(r.chain.state).toBe('fail')
    expect(r.chain.detail).toContain('transaction reverted')
  })
  it('bloco diferente: fail', async () => {
    const r = await run(await signed(), { kind: 'receipt', patch: x => { x.blockHash = '0x' + '22'.repeat(32) } })
    expect(r.chain.state).toBe('fail')
    expect(r.chain.detail).toContain('block hash differs')
  })
  it('valor do log diferente do recibo: fail', async () => {
    const r = await run(await signed(), { kind: 'receipt', patch: x => { x.logs[1].data = pad(toHex(1n)) } })
    expect(r.chain.state).toBe('fail')
    expect(r.chain.detail).toContain('no TransferWithMemo matching')
  })
  it('memo diferente: fail', async () => {
    const r = await run(await signed(), { kind: 'receipt', patch: x => { x.logs[1].topics[3] = '0x' + '00'.repeat(32) } })
    expect(r.chain.state).toBe('fail')
    expect(r.chain.detail).toContain('no TransferWithMemo matching')
  })
  it('token diferente (outro contrato emitiu o evento): fail', async () => {
    const r = await run(await signed(), { kind: 'receipt', patch: x => { x.logs[1].address = '0x20c0000000000000000000000000000000000001' } })
    expect(r.chain.state).toBe('fail')
  })
  it('log index diferente: fail', async () => {
    const r = await run(await signed(), { kind: 'receipt', patch: x => { x.logs[1].logIndex = '0x7' } })
    expect(r.chain.state).toBe('fail')
    expect(r.chain.detail).toContain('log index differs')
  })
})

describe('verificador do navegador: recibo não encontrado ou incompleto é inconclusivo (REV-01)', () => {
  it('RPC responde sem recibo: indisponível com motivo próprio, nunca falha', async () => {
    const r = await run(await signed(), { kind: 'null' })
    expect(r.sig.state).toBe('ok')
    expect(r.chain.state).toBe('unavailable')
    expect(r.chain.reason).toBe('receipt_not_found')
    expect(r.chain.detail).toContain('does not prove the receipt is false')
  })
  it('mesmo envelope: sem recibo na primeira consulta, recibo correto na seguinte fica ok (sem poll infinito: uma consulta por verificação)', async () => {
    const env = await signed()
    const first = await run(env, { kind: 'null' })
    expect(first.chain.reason).toBe('receipt_not_found')
    expect(first.calls).toBe(1)
    const second = await run(env, { kind: 'receipt' })
    expect(second.chain.state).toBe('ok')
    expect(second.calls).toBe(1)
  })
  it('hash bem formado que o nó não conhece: indisponível (receipt_not_found)', async () => {
    const r = await run(await signed(p => { p.settlement.tx_hash = '0x' + 'ab'.repeat(32) }), { kind: 'receipt' })
    expect(r.chain.state).toBe('unavailable')
    expect(r.chain.reason).toBe('receipt_not_found')
    expect(r.calls).toBe(1)
  })
  it('recibo sem blockHash: indisponível (rpc_incomplete), sem exceção', async () => {
    const r = await run(await signed(), { kind: 'receipt', patch: x => { delete x.blockHash } })
    expect(r.chain.state).toBe('unavailable')
    expect(r.chain.reason).toBe('rpc_incomplete')
  })
  it('recibo sem logs: indisponível (rpc_incomplete), sem exceção', async () => {
    const r = await run(await signed(), { kind: 'receipt', patch: x => { delete x.logs } })
    expect(r.chain.state).toBe('unavailable')
    expect(r.chain.reason).toBe('rpc_incomplete')
  })
  it('log estranho sem topics nem address no meio da lista: ignorado, o log certo ainda confere', async () => {
    const r = await run(await signed(), { kind: 'receipt', patch: x => { x.logs.unshift({ data: '0x', logIndex: '0x5', blockHash: x.blockHash, blockNumber: x.blockNumber, transactionHash: x.transactionHash, transactionIndex: '0x0', removed: false, topics: [], address: '0x0000000000000000000000000000000000000000' }) } })
    expect(r.chain.state).toBe('ok')
  })
})

describe('verificador do navegador: RPC fora do ar vira "indisponível", nunca válido nem inválido', () => {
  it('porta fechada', async () => {
    const closed = createServer(); await new Promise<void>(ok => closed.listen(0, '127.0.0.1', ok))
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`; closed.close()
    const r = await run(await signed(), { kind: 'receipt' }, url)
    expect(r.sig.state).toBe('ok')
    expect(r.chain.state).toBe('unavailable')
    expect(r.chain.reason).toBe('rpc_unreachable')
  })
  it('HTTP 500', async () => {
    const r = await run(await signed(), { kind: 'http_500' })
    expect(r.chain.state).toBe('unavailable')
  })
  it('erro JSON-RPC do nó', async () => {
    const r = await run(await signed(), { kind: 'rpc_error' })
    expect(r.chain.state).toBe('unavailable')
    expect(r.chain.detail).toContain('Verification unavailable')
  })
  it('tempo esgotado', async () => {
    const r = await run(await signed(), { kind: 'hang' })
    expect(r.chain.state).toBe('unavailable')
  })
})

describe('verificador do navegador: aviso de estorno', () => {
  it('refund_notice: só informativo, sem consultar a RPC', async () => {
    const p: any = clone(BASE)
    for (const k of ['token', 'treasury', 'pix', 'quote', 'amounts', 'settlement']) delete p[k]
    p.receipt_type = 'refund_notice'
    p.refund = { amount: { amount: '10090', currency: 'BRL', scale: 2 }, settlement_ref: 'rct_01K6VECTOR00000000000000A' }
    const r = await run(await signReceipt(p, KEY), { kind: 'receipt' })
    expect(r.sig.state).toBe('ok')
    expect(r.steps.find(s => s.key === 'refund')!.state).toBe('info')
    expect(r.chain).toBeUndefined()
    expect(r.calls).toBe(0)
  })
})

// Fase 2 (revisão 349 dedicada, D2): recibos de afiliado nunca carregam o destino; o navegador confere o destinatário do
// TransferWithMemo contra o compromisso settlement.recipient_sha256 e nunca mostra a carteira.
describe('verificador do navegador: recibos de afiliado (comissão e saque) com compromisso do destinatário', () => {
  const RECIPIENT = '0x5eE9C0ffee1234567890AbCdEf1234567890AfF1' // carteira do afiliado: só existe no teste, nunca no recibo
  const OTHER = '0x000000000000000000000000000000000000d00d'
  const commit = (a: string) => createHash('sha256').update(a.toLowerCase()).digest('hex') // mesmo cálculo do emissor (core/src/affiliates/receipts.ts)
  function affiliate(type: 'affiliate_commission_payout' | 'affiliate_wallet_withdrawal', edit?: (p: any) => void) {
    const b = BASE, s = b.settlement
    const p: any = {
      schema_version: 1, receipt_id: 'rct_01K7AFFILIATE000000000000A', receipt_type: type, issuer: clone(b.issuer), provider_env: 'merchant_api',
      chain_env: b.chain_env, chain_id: b.chain_id, token: b.token, treasury: b.treasury,
      order: { ref: null, commission_id: type === 'affiliate_commission_payout' ? 'com_01K7TESTCOMMISSION0000001' : null, withdrawal_id: type === 'affiliate_wallet_withdrawal' ? 'wdr_01K7TESTWITHDRAWAL0000001' : null },
      beneficiary: { ref: 'afl_7f3a9c1e2b4d', kind: 'affiliate' }, issued_at: '2026-10-09T20:00:00.000Z',
      settlement: { id: 'stl_01K7TESTSETTLEMENT0000001', amount: s.amount, memo: s.memo, tx_hash: s.tx_hash, block_number: s.block_number, block_hash: s.block_hash, log_index: s.log_index,
        confirmation_observed_at: '2026-10-09T20:00:05.000Z', recipient_sha256: commit(RECIPIENT) },
      amounts: { usd_units: String(s.amount), usd: (Number(s.amount) / 1e6).toFixed(6), currency: 'USD', scale: 6 },
    }
    if (type === 'affiliate_commission_payout') p.commission = { id: p.order.commission_id, custody: 'own_wallet', amount: { amount: '12345', currency: 'BRL', scale: 2, brl: '123.45' },
      quote: { rate_num: '1', rate_den: '5', source: 'binance_usdtbrl', at: '2026-10-09T19:59:00.000Z', hash: 'a'.repeat(64), fee_bps: 0, mode: 'at_pix' }, occurred_at: '2026-10-09T19:58:00.000Z', released_at: '2026-10-09T19:59:30.000Z' }
    else p.withdrawal = { id: p.order.withdrawal_id, kind: 'wallet' }
    edit?.(p)
    return signReceipt(p, KEY)
  }
  const toRecipient = (addr: string) => (x: any) => { x.logs[1].topics[2] = pad(addr as `0x${string}`) }
  const noAddress = (r: { steps: Step[] }) => { const j = JSON.stringify(r.steps).toLowerCase(); expect(j).not.toContain(RECIPIENT.slice(2, 12).toLowerCase()); expect(j).not.toContain(RECIPIENT.toLowerCase()) }

  it('comissão own_wallet: assinatura ok, origem informativa (sem "Pix undefined"), cadeia ok pelo compromisso, carteira nunca exibida', async () => {
    const r = await run(await affiliate('affiliate_commission_payout'), { kind: 'receipt', patch: toRecipient(RECIPIENT) })
    expect(r.sig.state).toBe('ok')
    expect(r.steps.find(s => s.key === 'pix')).toBeUndefined()
    const origin = r.steps.find(s => s.key === 'origin')!
    expect(origin.state).toBe('info'); expect(origin.label).toBe('Affiliate commission')
    expect(origin.detail).toContain('R$ 123.45'); expect(origin.detail).toContain('own_wallet'); expect(origin.detail).toContain('Pix landed'); expect(origin.detail).not.toContain('undefined')
    expect(r.chain.state).toBe('ok'); expect(r.chain.detail).toContain('committed'); expect(r.calls).toBe(1)
    noAddress(r)
  })
  it('saque para carteira: assinatura ok, origem "Wallet withdrawal", cadeia ok pelo compromisso', async () => {
    const r = await run(await affiliate('affiliate_wallet_withdrawal'), { kind: 'receipt', patch: toRecipient(RECIPIENT) })
    expect(r.sig.state).toBe('ok')
    const origin = r.steps.find(s => s.key === 'origin')!
    expect(origin.label).toBe('Wallet withdrawal'); expect(origin.detail).toContain('afl_7f3a9c1e2b4d'); expect(origin.detail).not.toContain('undefined')
    expect(r.chain.state).toBe('ok'); expect(r.calls).toBe(1)
    noAddress(r)
  })
  it('compromisso que não bate com o destinatário na cadeia (recibo reassinado): fail, sem revelar endereço', async () => {
    const r = await run(await affiliate('affiliate_commission_payout', p => { p.settlement.recipient_sha256 = commit(OTHER) }), { kind: 'receipt', patch: toRecipient(RECIPIENT) })
    expect(r.sig.state).toBe('ok')
    expect(r.chain.state).toBe('fail'); expect(r.chain.detail).toContain('recipient commitment')
    noAddress(r)
  })
  it('log adulterado (transferência foi para outra carteira): fail', async () => {
    const r = await run(await affiliate('affiliate_wallet_withdrawal'), { kind: 'receipt', patch: toRecipient(OTHER) })
    expect(r.sig.state).toBe('ok'); expect(r.chain.state).toBe('fail'); expect(r.chain.detail).toContain('recipient commitment')
  })
  it('valor, memo ou índice do log diferentes: fail (as outras conferências continuam valendo)', async () => {
    const a = await run(await affiliate('affiliate_commission_payout', p => { p.settlement.amount = '1' }), { kind: 'receipt', patch: toRecipient(RECIPIENT) })
    expect(a.chain.state).toBe('fail')
    const m = await run(await affiliate('affiliate_commission_payout', p => { p.settlement.memo = '0x' + 'ab'.repeat(32) }), { kind: 'receipt', patch: toRecipient(RECIPIENT) })
    expect(m.chain.state).toBe('fail')
    const i = await run(await affiliate('affiliate_commission_payout', p => { p.settlement.log_index = '7' }), { kind: 'receipt', patch: toRecipient(RECIPIENT) })
    expect(i.chain.state).toBe('fail'); expect(i.chain.detail).toContain('log index')
  })
  it('recibo de afiliado com destino embutido ou sem compromisso válido: malformado, fail sem consultar a RPC', async () => {
    const withTo = await run(await affiliate('affiliate_commission_payout', p => { p.settlement.to = RECIPIENT }), { kind: 'receipt', patch: toRecipient(RECIPIENT) })
    expect(withTo.chain.state).toBe('fail'); expect(withTo.chain.detail).toMatch(/malformed.*\bto\b/); expect(withTo.calls).toBe(0)
    const noCommit = await run(await affiliate('affiliate_wallet_withdrawal', p => { p.settlement.recipient_sha256 = 'xyz' }), { kind: 'receipt', patch: toRecipient(RECIPIENT) })
    expect(noCommit.chain.state).toBe('fail'); expect(noCommit.chain.detail).toContain('recipient_sha256'); expect(noCommit.calls).toBe(0)
  })
  it('adulterado depois de assinado (compromisso trocado sem reassinar): assinatura falha', async () => {
    const env = await affiliate('affiliate_commission_payout')
    ;(env.payload as any).settlement.recipient_sha256 = commit(OTHER)
    const r = await run(env, { kind: 'receipt', patch: toRecipient(OTHER) })
    expect(r.sig.state).toBe('fail'); expect(r.sig.detail).toMatch(/^digest_mismatch/)
  })
  it('RPC indisponível, sem recibo ainda ou recibo incompleto: unavailable com motivo, nunca fail', async () => {
    const env = await affiliate('affiliate_wallet_withdrawal')
    const down = await run(env, { kind: 'http_500' }); expect(down.chain.state).toBe('unavailable'); expect(down.chain.reason).toBe('rpc_unreachable')
    const hang = await run(env, { kind: 'hang' }); expect(hang.chain.state).toBe('unavailable'); expect(hang.chain.reason).toBe('rpc_unreachable')
    const none = await run(env, { kind: 'null' }); expect(none.chain.state).toBe('unavailable'); expect(none.chain.reason).toBe('receipt_not_found')
    const partial = await run(env, { kind: 'receipt', patch: x => { delete x.logs } }); expect(partial.chain.state).toBe('unavailable'); expect(partial.chain.reason).toBe('rpc_incomplete')
  })
  it('recipientCommitment: mesmo cálculo do emissor (sha256 do endereço em minúsculas), independente da caixa do endereço', () => {
    expect(recipientCommitment(RECIPIENT)).toBe(commit(RECIPIENT))
    expect(recipientCommitment(RECIPIENT.toUpperCase().replace('0X', '0x'))).toBe(commit(RECIPIENT))
  })
})

