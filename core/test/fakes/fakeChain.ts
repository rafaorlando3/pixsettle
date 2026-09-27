// Cadeia falsa e determinística para os testes P1: mempool, blocos, falhas injetáveis.
import { createHash } from 'node:crypto'
import type { ChainGateway, Intent, Signed, Broadcast, Observed } from '../../src/chain/gateway.js'

type Tx = { hash: string; nonce: number; intent: Intent; signedAt: number }

export class FakeChain implements ChainGateway {
  readonly chainId = 42431
  readonly token = '0x20c0000000000000000000000000000000000000'
  readonly treasury = '0x0f99c00f2712E562B4e762aD11b6b6841557ed14'
  signed = new Map<string, Tx>()     // hash -> tx assinada (não transmitida)
  mempool = new Map<string, Tx>()
  mined: Array<Tx & { block: number; status: 'success' | 'reverted' }> = []
  signCalls = 0
  broadcastCalls = 0
  private feeSalt = 0
  /** Falhas: 'broadcast_timeout_after_accept' = rede recebeu, resposta perdida. */
  failNextBroadcast: null | 'timeout_after_accept' | 'timeout_before_accept' | 'reject' = null
  revertNext = false
  observeDown = false

  get transfersByMemo() {
    const m = new Map<string, number>()
    for (const t of this.mined) if (t.status === 'success') m.set(t.intent.memo, (m.get(t.intent.memo) ?? 0) + 1)
    return m
  }
  nextNonce() { return this.mined.length ? Math.max(...this.mined.map(t => t.nonce)) + 1 : 0 }

  async pendingNonce() {
    const all = [...this.mined.map(t => t.nonce), ...[...this.mempool.values()].map(t => t.nonce)]
    return all.length ? Math.max(...all) + 1 : 0
  }
  async sign(intent: Intent, nonce: number): Promise<Signed> {
    this.signCalls++
    const salt = ++this.feeSalt // assinar de novo muda a taxa: bytes diferentes, como na vida real
    const raw = '0x' + createHash('sha256').update(JSON.stringify({ intent: { ...intent, amount: intent.amount.toString() }, nonce, salt })).digest('hex')
    const hash = '0x' + createHash('sha256').update(raw).digest('hex')
    this.signed.set(raw, { hash, nonce, intent, signedAt: Date.now() })
    return { raw, hash, feeParams: { salt: String(salt) } }
  }
  async broadcast(raw: string): Promise<Broadcast> {
    this.broadcastCalls++
    const tx = this.signed.get(raw)
    if (!tx) return { kind: 'rejected', detail: 'bytes desconhecidos' }
    const f = this.failNextBroadcast; this.failNextBroadcast = null
    if (f === 'timeout_before_accept') return { kind: 'unknown', reason: 'transport', detail: 'timeout simulado' }
    if (f === 'reject') return { kind: 'rejected', detail: 'insufficient funds (simulado)' }
    if (this.mined.some(t => t.hash === tx.hash) || this.mined.some(t => t.nonce === tx.nonce)) return { kind: 'reconcile', reason: 'nonce_too_low', detail: 'nonce too low' }
    if (this.mempool.has(tx.hash)) return { kind: 'reconcile', reason: 'already_known', detail: 'already known' }
    this.mempool.set(tx.hash, tx)
    if (f === 'timeout_after_accept') return { kind: 'unknown', reason: 'transport', detail: 'timeout depois de aceitar (simulado)' }
    return { kind: 'accepted', hash: tx.hash }
  }
  /** Minera o mempool em ordem de nonce (só nonces contíguos). */
  mine() {
    let next = this.nextNonce()
    for (;;) {
      const tx = [...this.mempool.values()].find(t => t.nonce === next)
      if (!tx) break
      this.mempool.delete(tx.hash)
      const status = this.revertNext ? 'reverted' as const : 'success' as const
      this.revertNext = false
      this.mined.push({ ...tx, block: this.mined.length + 1, status })
      next++
    }
  }
  async observe(hash: string, intent: Intent): Promise<Observed | null> {
    if (this.observeDown) throw new Error('RPC fora do ar (simulado)')
    const t = this.mined.find(x => x.hash === hash)
    if (!t) return null
    const same = t.intent.memo === intent.memo && t.intent.to === intent.to && t.intent.amount === intent.amount && t.intent.token === intent.token && t.intent.from === intent.from
    const ok = t.status === 'success' && same
    return { txHash: t.hash, status: t.status, blockNumber: String(t.block), blockHash: '0x' + String(t.block).padStart(64, '0'), logIndex: ok ? 0 : null, identityOk: ok, mismatches: ok ? [] : [t.status === 'reverted' ? 'recibo revertido' : 'identidade divergente'] }
  }
  async signReceipt(payload: Record<string, unknown>) {
    return { payload, digest: { alg: 'sha256', hex: 'fake' }, signature: { scheme: 'eip191-0x45', signer: 'fake', value: '0x' } }
  }
}
