// Processo de assinatura: ÚNICO lugar com as chaves (tesouraria e emissor de recibos).
// Só escuta em 127.0.0.1 e só aceita chamadas com HMAC (método, rota, timestamp, nonce, sha256 do corpo).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import { tempoModerato } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { TempoChain, TIP20_ABI, type TransferIntent } from './chain.js'
import { signReceipt, type ReceiptPayload } from './receipt.js'

export type ServerConfig = { port: number; hmacSecret: string; treasuryKey: Hex; issuerKey: Hex; token: Hex; rpcUrl?: string }

export function buildServer(cfg: ServerConfig, chain = new TempoChain(tempoModerato, cfg.rpcUrl)) {
  const treasury = privateKeyToAccount(cfg.treasuryKey).address
  const seen = new Map<string, number>() // nonces de requisição (anti-replay)

  const auth = (req: IncomingMessage, body: string): string | null => {
    const ts = String(req.headers['x-ps-ts'] ?? ''), nonce = String(req.headers['x-ps-nonce'] ?? ''), sig = String(req.headers['x-ps-sig'] ?? '')
    const now = Math.floor(Date.now() / 1000)
    if (!ts || Math.abs(now - Number(ts)) > 60) return 'timestamp fora da janela de 60s'
    if (!nonce || seen.has(nonce)) return 'nonce ausente ou repetido'
    const expected = createHmac('sha256', cfg.hmacSecret).update(`${req.method}\n${req.url}\n${ts}\n${nonce}\n${createHash('sha256').update(body).digest('hex')}`).digest()
    const got = Buffer.from(sig, 'hex')
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return 'assinatura HMAC inválida'
    seen.set(nonce, now)
    for (const [k, t] of seen) if (now - t > 120) seen.delete(k)
    return null
  }

  const toIntent = (i: any): TransferIntent => {
    if (i.from?.toLowerCase() !== treasury.toLowerCase()) throw new Error('intenção com remetente diferente da tesouraria deste processo')
    if (i.token?.toLowerCase() !== cfg.token.toLowerCase()) throw new Error('token diferente do configurado')
    return { chainId: Number(i.chainId), token: i.token, from: i.from, to: i.to, amount: BigInt(i.amount), memo: i.memo }
  }

  const send = (res: ServerResponse, code: number, obj: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? v.toString() : v))
  }

  return createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const denied = auth(req, body)
    if (denied) return send(res, 401, { error: { code: 'unauthorized', message: denied } })
    try {
      const j = body ? JSON.parse(body) : {}
      if (req.method === 'GET' && req.url === '/v1/pending-nonce') return send(res, 200, { nonce: await chain.pendingNonce(treasury) })
      if (req.method === 'POST' && req.url === '/v1/sign') {
        const s = await chain.signTransfer(cfg.treasuryKey, toIntent(j.intent), Number(j.nonce))
        return send(res, 200, { raw: s.raw, hash: s.hash, feeParams: { nonceKey: '0', gas: s.gas, maxFeePerGas: s.maxFeePerGas, maxPriorityFeePerGas: s.maxPriorityFeePerGas } })
      }
      if (req.method === 'POST' && req.url === '/v1/broadcast') return send(res, 200, await chain.broadcast(j.raw))
      if (req.method === 'POST' && req.url === '/v1/observe') {
        const o = await chain.observe(j.hash, toIntent(j.intent))
        return send(res, 200, { observed: o && { ...o, blockNumber: o.blockNumber.toString() } })
      }
      if (req.method === 'POST' && req.url === '/v1/sign-receipt') return send(res, 200, await signReceipt(j.payload as ReceiptPayload, cfg.issuerKey))
      return send(res, 404, { error: { code: 'not_found', message: `${req.method} ${req.url}` } })
    } catch (e) {
      // Motivo sempre visível para quem chamou; nada de chave ou bytes assinados no log.
      return send(res, 500, { error: { code: 'settlement_error', message: (e as Error).message } })
    }
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`variável ${k} ausente`); process.exit(1) } return v }
  const cfg: ServerConfig = {
    port: Number(process.env.PORT ?? 7401), hmacSecret: need('SETTLEMENT_HMAC_SECRET'),
    treasuryKey: need('TREASURY_KEY') as Hex, issuerKey: need('ISSUER_KEY') as Hex,
    token: (process.env.TOKEN ?? '0x20c0000000000000000000000000000000000000') as Hex, rpcUrl: process.env.TEMPO_RPC,
  }
  buildServer(cfg).listen(cfg.port, '127.0.0.1', () => console.log(`settlement ouvindo em 127.0.0.1:${cfg.port}`))
  // Testnet: mantém a tesouraria com pathUSD do faucet (tempo_fundAddress). Nunca em outra rede.
  const min = BigInt(process.env.TREASURY_MIN_UNITS ?? '50000000') // 50 pathUSD
  const topUp = async () => {
    try { console.log(await ensureFunded(new TempoChain(tempoModerato, cfg.rpcUrl), privateKeyToAccount(cfg.treasuryKey).address, cfg.token, min)) }
    catch (e) { console.error('faucet:', (e as Error).message) }
  }
  if (process.env.FAUCET_TOPUP !== '0') { void topUp(); setInterval(topUp, 3_600_000).unref() }
}

/** Abastece pelo faucet da testnet se o saldo estiver abaixo do mínimo. Recusa qualquer rede que não seja a Moderato. */
export async function ensureFunded(chain: TempoChain, address: Hex, token: Hex, min: bigint): Promise<string> {
  if (chain.chain.id !== tempoModerato.id) throw new Error(`faucet só na testnet Moderato (rede ${chain.chain.id})`)
  const bal = await chain.pub.readContract({ address: token, abi: TIP20_ABI, functionName: 'balanceOf', args: [address] }) as bigint
  if (bal >= min) return `tesouraria com ${bal} unidades; sem faucet`
  const txs = await chain.pub.request({ method: 'tempo_fundAddress' as any, params: [address] as any }) as unknown as string[]
  return `tesouraria com ${bal} unidades; faucet pedido: ${Array.isArray(txs) ? txs.join(',') : String(txs)}`
}
