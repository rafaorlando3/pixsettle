// Instância de PRODUÇÃO do trilho de comissões em dólar (dinheiro real), separada da demo do concurso.
// Sobe SÓ a API de afiliados (chave do lojista): sem demo, sem Pix simulado, sem piloto, sem copiloto, sem leitura pública e sem
// lotes do produtor (um escritor por lojista: a API do Hub). A tesouraria é só um ENDEREÇO público: a custódia fica fora do
// servidor (carteira do Rafael, C-0825); sem assinante enquanto AFFILIATE_SETTLE=0. Configuração ambígua não sobe: semente de
// demo, rede errada, endereço ausente, cotação simulada com dinheiro real, leitura pública ou lotes ligados são recusados no boot,
// cada um com o motivo. Revisão do Codex (X-1196) aplicada: nada de tesouraria derivada da semente, CHAIN_ID explícito, sem DEMO_MODE.
import Fastify from 'fastify'
import { createPool } from '../db.js'
import { migrate } from '../migrate.js'
import { defaultConfig, type Ctx } from '../context.js'
import { HttpChainGateway, type ChainGateway, type Intent, type Signed, type Broadcast, type Observed } from '../chain/gateway.js'
import type { PixProvider } from '../providers/types.js'
import { quoteSourceFromEnv } from './quotes.js'
import { registerAffiliates } from './routes.js'
import { configureAffiliateJournal } from './journal.js'
import { resumeAffiliateSettlements, settleOn, affiliateCapabilities } from './service.js'
import { startWorker } from '../worker.js'

export const PRODUCTION_PROFILE = 'affiliates_production'
export const TEMPO_MAINNET_CHAIN_ID = 4217
export const TEMPO_TESTNET_CHAIN_ID = 42431
/** USDC na Tempo (Bridged USDC, Stargate; 6 casas): o dólar que a Relay entrega nas portas de depósito. */
export const TEMPO_MAINNET_USDC = '0x20c000000000000000000000b9537d11c60e8b50'
export const TEMPO_MAINNET_RPC = 'https://rpc.mainnet.tempo.xyz'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const TIP20 = /^0x20c0[0-9a-fA-F]{36}$/
const ZERO = '0x0000000000000000000000000000000000000000'

export type ProductionConfig = {
  chainId: number
  token: string
  treasury: string
  databaseUrl: string
  settle: boolean
  launchQuote: boolean
  lockTtlMs: number
  issuer: { id: string; address: string }
  settlement: { url: string; hmacSecret: string } | null
  port: number
  host: string
  trustProxy: boolean
}

export class ProductionConfigError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`) }
}

const failWith = (code: string, message: string): never => { throw new ProductionConfigError(code, message) }

/**
 * v7.2 (revisão X-1205, F2/F3): combinações proibidas com dinheiro real, decididas sobre o ambiente ORIGINAL. O launcher chama
 * isto ANTES de filtrar as variáveis que repassa ao core (filtrar não pode esconder uma flag proibida) e antes de subir
 * qualquer processo; o core chama de novo no boot, antes do banco. Chave privada fica de fora daqui: o launcher recebe a
 * chave de propósito (AFFILIATE_SETTLE=1) e o core recusa chave à parte (key_in_core_forbidden).
 */
export function assertNoForbiddenProductionFlags(env: Record<string, string | undefined>): void {
  if (env.DEMO_MODE === '1') failWith('demo_mode_forbidden', 'DEMO_MODE=1 não convive com dinheiro real: produção e demo são instâncias separadas')
  if (env.PIXSETTLE_SEED) failWith('seed_forbidden', 'PIXSETTLE_SEED é da demo; em produção nenhuma chave ou tesouraria é derivada de semente')
  if (env.AFFILIATE_PUBLIC_MERCHANT_ID) failWith('public_read_forbidden', 'leitura pública (AFFILIATE_PUBLIC_MERCHANT_ID) é do piloto da demo; dados reais não ficam públicos')
  if (env.AFFILIATE_STREAMS_JSON || Object.keys(env).some(k => /^AFFILIATE_(KEY|TOKEN)_/.test(k)) || env.AFFILIATE_KEYS_JSON || env.AFFILIATE_TOKENS_JSON)
    failWith('producer_batches_forbidden', 'lotes do produtor ficam fora da produção: um escritor por lojista (a API do Hub)')
  // Ensaio nunca liquida, em rede nenhuma: PRODUCTION_REHEARSAL=1 só com AFFILIATE_SETTLE desligado.
  if (env.PRODUCTION_REHEARSAL === '1' && env.AFFILIATE_SETTLE === '1')
    failWith('rehearsal_settle_forbidden', 'ensaio (PRODUCTION_REHEARSAL=1) nunca liquida: suba o ensaio com AFFILIATE_SETTLE=0')
  // Cotação simulada nunca convive com liquidação (dinheiro saindo com preço inventado), mesmo fora do ensaio.
  if ((env.AFFILIATE_QUOTE_SOURCE ?? '').toLowerCase() === 'simulated' && env.AFFILIATE_SETTLE === '1')
    failWith('simulated_quote_settle_forbidden', 'cotação simulada não convive com AFFILIATE_SETTLE=1: liquidação só com binance_usdtbrl')
}

/** Lê e valida o ambiente de produção. Qualquer ambiguidade vira erro com código e motivo (nunca um padrão silencioso). */
export function productionConfigFromEnv(env: Record<string, string | undefined>): ProductionConfig {
  const fail = failWith
  if (env.PIXSETTLE_PROFILE !== PRODUCTION_PROFILE) fail('profile_missing', `PIXSETTLE_PROFILE precisa ser ${PRODUCTION_PROFILE}`)
  assertNoForbiddenProductionFlags(env)
  if (env.TREASURY_KEY || env.ISSUER_KEY) fail('key_in_core_forbidden', 'chave privada não entra no core: só o assinante (settlement/) recebe chave, pelo launcher de produção')
  const chainId = Number(env.CHAIN_ID ?? '')
  if (chainId !== TEMPO_MAINNET_CHAIN_ID && !(chainId === TEMPO_TESTNET_CHAIN_ID && env.PRODUCTION_REHEARSAL === '1'))
    fail('chain_id_invalid', `CHAIN_ID precisa ser ${TEMPO_MAINNET_CHAIN_ID} (Tempo mainnet); ${TEMPO_TESTNET_CHAIN_ID} só em ensaio com PRODUCTION_REHEARSAL=1`)
  const treasury = String(env.TREASURY_ADDRESS ?? '')
  if (!ADDRESS.test(treasury) || treasury.toLowerCase() === ZERO) fail('treasury_address_invalid', 'TREASURY_ADDRESS precisa ser o endereço público da tesouraria (0x + 40 hexadecimais)')
  const token = String(env.TOKEN ?? (chainId === TEMPO_MAINNET_CHAIN_ID ? TEMPO_MAINNET_USDC : ''))
  if (!TIP20.test(token)) fail('token_invalid', 'TOKEN precisa ser um token TIP-20 da Tempo (0x20c0...)')
  const databaseUrl = String(env.DATABASE_URL ?? '')
  if (!databaseUrl) fail('database_url_missing', 'DATABASE_URL ausente (banco próprio da produção)')
  const quoteSource = (env.AFFILIATE_QUOTE_SOURCE ?? '').toLowerCase()
  if (quoteSource !== 'binance_usdtbrl' && !(quoteSource === 'simulated' && env.PRODUCTION_REHEARSAL === '1'))
    fail('quote_source_invalid', 'AFFILIATE_QUOTE_SOURCE precisa ser binance_usdtbrl com dinheiro real (simulated só em ensaio)')
  const settle = env.AFFILIATE_SETTLE === '1'
  let settlement: ProductionConfig['settlement'] = null
  if (settle) {
    const url = String(env.SETTLEMENT_URL ?? ''); const hmacSecret = String(env.SETTLEMENT_HMAC_SECRET ?? '')
    if (!/^https?:\/\/127\.0\.0\.1:\d+$/.test(url) || hmacSecret.length < 32) fail('signer_missing', 'AFFILIATE_SETTLE=1 exige o assinante local (SETTLEMENT_URL em 127.0.0.1 e SETTLEMENT_HMAC_SECRET com 32+ caracteres), subido pelo launcher de produção')
    if (!ADDRESS.test(String(env.ISSUER_ADDRESS ?? ''))) fail('issuer_address_missing', 'AFFILIATE_SETTLE=1 emite recibos: ISSUER_ADDRESS precisa ser o endereço do emissor')
    settlement = { url, hmacSecret }
  }
  return {
    chainId, token, treasury, databaseUrl, settle, settlement,
    launchQuote: env.AFFILIATE_LAUNCH_QUOTE === '1',
    lockTtlMs: Number(env.AFFILIATE_LOCK_TTL_MS ?? 120_000),
    issuer: { id: env.ISSUER_ID ?? 'pixsettle-production', address: String(env.ISSUER_ADDRESS ?? ZERO) },
    port: Number(env.PORT ?? 8080), host: env.HOST ?? '0.0.0.0', trustProxy: env.TRUST_PROXY === '1',
  }
}

/** Tesouraria só com endereço: lê nada, assina nada. Qualquer chamada de assinatura é erro explícito (não deve acontecer com AFFILIATE_SETTLE=0). */
export class AddressOnlyChainGateway implements ChainGateway {
  constructor(readonly chainId: number, readonly token: string, readonly treasury: string) {}
  private refuse<T>(op: string): Promise<T> { return Promise.reject(new Error(`signer_absent: ${op} recusado; esta instância não assina (AFFILIATE_SETTLE=0, tesouraria só com endereço)`)) }
  pendingNonce(): Promise<number> { return this.refuse('pendingNonce') }
  sign(_i: Intent, _n: number): Promise<Signed> { return this.refuse('sign') }
  broadcast(_raw: string): Promise<Broadcast> { return this.refuse('broadcast') }
  observe(_h: string, _i: Intent): Promise<Observed | null> { return this.refuse('observe') }
  signReceipt(_p: Record<string, unknown>): Promise<unknown> { return this.refuse('signReceipt') }
}

/** Sem Pix nesta instância: o Pix dos afiliados sai do caixa em reais do lojista (netting), nunca daqui. */
const NO_PIX: PixProvider = new Proxy({ name: 'simulated', env: 'simulated' } as unknown as PixProvider, {
  get(target, prop) {
    if (prop === 'name' || prop === 'env') return (target as any)[prop]
    return () => { throw new Error('pix_absent: a instância de produção dos afiliados não cria nem consulta Pix') }
  },
})

export async function startAffiliatesProduction(env: Record<string, string | undefined> = process.env) {
  const cfg = productionConfigFromEnv(env)
  const db = createPool(cfg.databaseUrl)
  await migrate(db)
  const chain: ChainGateway = cfg.settlement
    ? new HttpChainGateway(cfg.settlement.url, cfg.settlement.hmacSecret, cfg.chainId, cfg.token, cfg.treasury)
    : new AddressOnlyChainGateway(cfg.chainId, cfg.token, cfg.treasury)
  const ctx: Ctx = {
    db, provider: NO_PIX, chain, now: () => new Date(),
    cfg: defaultConfig({ issuer: cfg.issuer, pilotSettle: false, publicReplayReadOnly: false }),
    affiliates: { quotes: quoteSourceFromEnv(env), settle: cfg.settle, writes: true, lockTtlMs: cfg.lockTtlMs, launchQuote: cfg.launchQuote },
  }
  configureAffiliateJournal({ settle: cfg.settle, writes: true })
  if (settleOn(ctx.affiliates)) {
    const n = await resumeAffiliateSettlements(ctx)
    if (n) console.log(`produção: ${n} liquidação(ões) retomada(s) com AFFILIATE_SETTLE=1`)
  }
  const app = Fastify({ logger: false, trustProxy: cfg.trustProxy, bodyLimit: 64 * 1024 })
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('cache-control', 'no-store')
    return payload
  })
  // Saúde sem segredo: o que roda, em que rede, para qual tesouraria (endereço público), e o que está ligado.
  app.get('/healthz', async () => ({
    ok: true, profile: PRODUCTION_PROFILE, chain_id: cfg.chainId, token: cfg.token, treasury: cfg.treasury,
    settle: settleOn(ctx.affiliates), launch_quote: cfg.launchQuote, capabilities: affiliateCapabilities(ctx), quote_source: ctx.affiliates!.quotes.name,
    commit: env.RENDER_GIT_COMMIT ?? env.GIT_COMMIT ?? null,
  }))
  registerAffiliates(app, ctx, { publicMerchantId: null })
  const worker = cfg.settle ? startWorker(ctx, { sweepEveryMs: 3_600_000, maxIdleMs: null }) : null
  await app.listen({ port: cfg.port, host: cfg.host })
  console.log(`produção dos afiliados ouvindo em ${cfg.host}:${cfg.port} (rede ${cfg.chainId}, tesouraria ${cfg.treasury}, liquidar ${cfg.settle ? 'sim' : 'não'}, cotação do lançamento ${cfg.launchQuote ? 'aceita' : 'recusada'})`)
  return {
    app, ctx, cfg, url: `http://${cfg.host}:${cfg.port}`,
    stop: async () => { await worker?.stop(); await app.close(); await db.end() },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startAffiliatesProduction().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
}
