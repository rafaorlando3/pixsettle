// Verificador do recibo no navegador (web/src/verify.ts) contra uma RPC falsa.
// Regra: "fail" quando o recibo não bate com a cadeia; "unavailable" SÓ quando a RPC não respondeu.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { toEventSelector, pad, toHex } from 'viem'
import { signReceipt, type ReceiptEnvelope } from '../../settlement/src/receipt.js'
import { verifyReceipt, type Step } from '../src/verify.js'

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

describe('verificador do navegador: falha do recibo nunca vira "indisponível"', () => {
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
  it('transação inexistente na Tempo: fail "not found"', async () => {
    const r = await run(await signed(), { kind: 'null' })
    expect(r.chain.state).toBe('fail')
    expect(r.chain.detail).toContain('not found on Tempo Moderato')
    const other = await run(await signed(p => { p.settlement.tx_hash = '0x' + 'ab'.repeat(32) }), { kind: 'receipt' })
    expect(other.chain.state).toBe('fail')
    expect(other.chain.detail).toContain('not found on Tempo Moderato')
    expect(other.calls).toBe(1)
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

describe('verificador do navegador: RPC fora do ar vira "indisponível", nunca válido nem inválido', () => {
  it('porta fechada', async () => {
    const closed = createServer(); await new Promise<void>(ok => closed.listen(0, '127.0.0.1', ok))
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`; closed.close()
    const r = await run(await signed(), { kind: 'receipt' }, url)
    expect(r.sig.state).toBe('ok')
    expect(r.chain.state).toBe('unavailable')
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
