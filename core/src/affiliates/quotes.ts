// Fonte de cotação BRL/USD da fase 2. Toda cotação sai com fonte, hora e hash; erro de rede vira motivo gravado,
// nunca cotação inventada. `simulated` é a única fonte dos testes e do replay público.
import { createHash } from 'node:crypto'
import { ratesFromPrice4, type BuyRate, type SellRate } from './money.js'

export type UsdQuote = {
  source: string
  /** BRL por dólar com 4 casas, inteiro (ex.: 52000 = 5,2000). */
  price4: bigint
  buy: BuyRate
  sell: SellRate
  at: Date
  /** Idade da cotação em segundos quando veio do cache (0 = fresca). */
  ageS: number
  hash: string
}
export type QuoteFailure = { ok: false; code: 'quote_unavailable'; detail: string; /** status HTTP da última resposta do provedor, quando houve resposta */ httpStatus?: number }
export type QuoteResult = { ok: true; quote: UsdQuote } | QuoteFailure

export interface UsdQuoteSource {
  readonly name: string
  quote(now: Date): Promise<QuoteResult>
}

const hashOf = (source: string, price4: bigint, at: Date) =>
  createHash('sha256').update(`${source}|${price4.toString()}|${at.toISOString()}`).digest('hex')

export function makeQuote(source: string, price4: bigint, at: Date, ageS = 0): UsdQuote {
  const { buy, sell } = ratesFromPrice4(price4)
  return { source, price4, buy, sell, at, ageS, hash: hashOf(source, price4, at) }
}

/** Cotação fixa e declarada: testes, demo pública e replay. */
export class SimulatedQuoteSource implements UsdQuoteSource {
  readonly name = 'simulated'
  constructor(private price4: bigint = 52000n) {}
  set(price4: bigint) { this.price4 = price4 }
  async quote(now: Date): Promise<QuoteResult> { return { ok: true, quote: makeQuote(this.name, this.price4, now) } }
}

/** Serviço público de dados de mercado da Binance (sem chave, sem conta, sem negociação), documentado em
 *  developers.binance.com/en/docs/products/spot/faqs/market_data_only. O host de negociação (api.binance.com) responde
 *  HTTP 451 em algumas regiões de nuvem (observado na Render em 09/10/2026); o serviço de dados é o default (E1, v8). */
export const BINANCE_PUBLIC_DATA_URL = 'https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=USDTBRL'
const BINANCE_URL_OK = /^https:\/\/[a-z0-9-]+\.binance\.(vision|com)\/api\/v3\/ticker\/bookTicker\?symbol=USDTBRL$/

/**
 * Binance USDTBRL (tela pública, sem chave). Compra pelo melhor ask, venda pelo melhor bid: usamos o PIOR
 * lado para a pessoa em cada sentido (compra mais cara, venda mais barata), e a diferença fica declarada.
 * Cache de `maxAgeMs`; fora do ar: devolve a última boa com a idade, ou falha com o status HTTP e o corpo da resposta.
 */
export class BinanceUsdtBrlQuoteSource implements UsdQuoteSource {
  readonly name = 'binance_usdtbrl'
  readonly url: string
  private last: { price4Buy: bigint; price4Sell: bigint; at: Date } | null = null
  private lastError: string | null = null
  private lastStatus: number | null = null
  constructor(private opts: { url?: string; maxAgeMs?: number; staleOkMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.url = opts.url ?? BINANCE_PUBLIC_DATA_URL
  }

  async quote(now: Date): Promise<QuoteResult> {
    const maxAge = this.opts.maxAgeMs ?? 30_000
    if (this.last && now.getTime() - this.last.at.getTime() <= maxAge) return { ok: true, quote: this.pick(now) }
    try {
      const f = this.opts.fetchImpl ?? fetch
      this.lastStatus = null
      const res = await f(this.url, { signal: AbortSignal.timeout(5_000) })
      this.lastStatus = res.status
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      const j = JSON.parse(text) as { bidPrice?: string; askPrice?: string }
      const ask = parsePrice4(j.askPrice); const bid = parsePrice4(j.bidPrice)
      if (ask === null || bid === null || ask <= 0n || bid <= 0n || bid > ask) throw new Error(`resposta sem bid/ask válidos: ${text.slice(0, 200)}`)
      this.last = { price4Buy: ask, price4Sell: bid, at: now }; this.lastError = null
      return { ok: true, quote: this.pick(now) }
    } catch (e) {
      this.lastError = (e as Error).message
      const staleOk = this.opts.staleOkMs ?? 10 * 60_000
      if (this.last && now.getTime() - this.last.at.getTime() <= staleOk) return { ok: true, quote: this.pick(now) }
      return { ok: false, code: 'quote_unavailable', detail: `${this.name}: ${this.lastError}`, ...(this.lastStatus !== null ? { httpStatus: this.lastStatus } : {}) }
    }
  }
  private pick(now: Date): UsdQuote {
    const l = this.last!
    const ageS = Math.max(0, Math.floor((now.getTime() - l.at.getTime()) / 1000))
    // Uma cotação só com dois lados: compra pelo ask e venda pelo bid. O hash cobre os dois.
    const { buy } = ratesFromPrice4(l.price4Buy); const { sell } = ratesFromPrice4(l.price4Sell)
    const hash = createHash('sha256').update(`${this.name}|${l.price4Buy}|${l.price4Sell}|${l.at.toISOString()}`).digest('hex')
    return { source: this.name, price4: l.price4Buy, buy, sell, at: l.at, ageS, hash }
  }
}

export function parsePrice4(s: string | undefined): bigint | null {
  if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s)) return null
  const [w, f] = s.split('.') as [string, string | undefined]
  return BigInt(w) * 10_000n + BigInt(((f ?? '') + '0000').slice(0, 4))
}

/** AFFILIATE_QUOTE_SOURCE simulated|binance_usdtbrl. AFFILIATE_QUOTE_URL (opcional) troca o endpoint da Binance por outro host
 *  oficial da Binance com o MESMO caminho e símbolo (ex.: api-gcp.binance.com); qualquer outra coisa é erro de configuração
 *  declarado no boot, nunca ignorado em silêncio. Nunca proxy, nunca credencial. */
export function quoteSourceFromEnv(env: Record<string, string | undefined>): UsdQuoteSource {
  const kind = (env.AFFILIATE_QUOTE_SOURCE ?? 'simulated').toLowerCase()
  if (kind === 'binance_usdtbrl') {
    const url = env.AFFILIATE_QUOTE_URL?.trim()
    if (url !== undefined && url !== '' && !BINANCE_URL_OK.test(url)) throw new Error(`AFFILIATE_QUOTE_URL inválida: precisa ser https://<host>.binance.vision|binance.com/api/v3/ticker/bookTicker?symbol=USDTBRL (recebido: ${url.slice(0, 120)})`)
    return new BinanceUsdtBrlQuoteSource(url ? { url } : {})
  }
  return new SimulatedQuoteSource(BigInt(env.AFFILIATE_SIM_PRICE4 ?? '52000'))
}
