// Fronteira com o processo de assinatura (settlement/). O core NUNCA tem a chave.
import { createHmac, createHash, randomUUID } from 'node:crypto'

export type Intent = { chainId: number; token: string; from: string; to: string; amount: bigint; memo: string }
export type Signed = { raw: string; hash: string; feeParams: Record<string, string> }
export type Broadcast =
  | { kind: 'accepted'; hash: string }
  | { kind: 'reconcile'; reason: 'already_known' | 'nonce_too_low'; detail: string }
  | { kind: 'unknown'; reason: 'transport'; detail: string }
  | { kind: 'rejected'; detail: string }
export type Observed = { txHash: string; status: 'success' | 'reverted'; blockNumber: string; blockHash: string; logIndex: number | null; identityOk: boolean; mismatches: string[] }

export interface ChainGateway {
  readonly chainId: number
  readonly token: string
  readonly treasury: string
  pendingNonce(): Promise<number>
  sign(intent: Intent, nonce: number): Promise<Signed>
  broadcast(raw: string): Promise<Broadcast>
  observe(hash: string, intent: Intent): Promise<Observed | null>
  signReceipt(payload: Record<string, unknown>): Promise<unknown>
}

/** Cliente HTTP do settlement/, com HMAC (método, rota, timestamp, nonce, sha256 do corpo). */
export class HttpChainGateway implements ChainGateway {
  constructor(private base: string, private secret: string, readonly chainId: number, readonly token: string, readonly treasury: string) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const text = body === undefined ? '' : JSON.stringify(body, (_k, v) => typeof v === 'bigint' ? v.toString() : v)
    const ts = Math.floor(Date.now() / 1000).toString()
    const nonce = randomUUID()
    const bodyHash = createHash('sha256').update(text).digest('hex')
    const sig = createHmac('sha256', this.secret).update(`${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`).digest('hex')
    const res = await fetch(this.base + path, {
      method, body: body === undefined ? undefined : text,
      headers: { 'content-type': 'application/json', 'x-ps-ts': ts, 'x-ps-nonce': nonce, 'x-ps-sig': sig },
      signal: AbortSignal.timeout(20_000),
    })
    const out = await res.text()
    if (!res.ok) throw new Error(`settlement ${method} ${path} -> ${res.status}: ${out.slice(0, 500)}`)
    return JSON.parse(out) as T
  }
  pendingNonce() { return this.call<{ nonce: number }>('GET', '/v1/pending-nonce').then(r => r.nonce) }
  sign(intent: Intent, nonce: number) { return this.call<Signed>('POST', '/v1/sign', { intent, nonce }) }
  broadcast(raw: string) { return this.call<Broadcast>('POST', '/v1/broadcast', { raw }) }
  observe(hash: string, intent: Intent) { return this.call<{ observed: Observed | null }>('POST', '/v1/observe', { hash, intent }).then(r => r.observed) }
  signReceipt(payload: Record<string, unknown>) { return this.call<unknown>('POST', '/v1/sign-receipt', { payload }) }
}
