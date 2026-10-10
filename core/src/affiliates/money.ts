// Fase 2: aritmética inteira das comissões em dólar digital (docs/affiliate-payouts.md, seções 3 e 5).
// BRL em centavos (escala 2); token em unidades (escala 6). Nunca ponto flutuante; arredondamento sempre para baixo.

export const USD_SCALE = 6
export const BPS = 10_000n

/** Cotação de COMPRA: unidades do token por centavo = rate_num / rate_den. */
export type BuyRate = { rateNum: bigint; rateDen: bigint }
/** Cotação de VENDA: centavos por unidade do token = rate_num / rate_den. */
export type SellRate = { rateNum: bigint; rateDen: bigint }

/** v7.2: o valor convertido ficou abaixo de uma unidade do token; o serviço transforma em erro de domínio (422), nunca 500. */
export class UsdBelowOneUnitError extends Error {}

/** Fixa o valor em dólar de uma comissão: desconta a taxa de conversão (bps) e converte, para baixo. */
export function fixUsdUnits(amountMinor: bigint, feeBps: number, rate: BuyRate): { usdUnits: bigint; feeMinor: bigint } {
  if (amountMinor <= 0n) throw new Error('amount_minor deve ser positivo')
  if (feeBps < 0 || feeBps > 10_000) throw new Error('fee_bps fora de 0..10000')
  if (rate.rateNum <= 0n || rate.rateDen <= 0n) throw new Error('cotação inválida')
  const feeMinor = (amountMinor * BigInt(feeBps)) / BPS // para baixo: a taxa nunca é cobrada a mais
  const net = amountMinor - feeMinor
  const usdUnits = (net * rate.rateNum) / rate.rateDen
  if (usdUnits <= 0n) throw new UsdBelowOneUnitError('valor em dólar ficou zero: comissão menor que uma unidade do token')
  return { usdUnits, feeMinor }
}

/** Saque por Pix: quanto exatamente a pessoa recebe em centavos, dados os dólares, a cotação de venda e as taxas. */
export function pixNet(usdUnits: bigint, rate: SellRate, feeBps: number, feeMinor: bigint): { grossMinor: bigint; feeMinor: bigint; netMinor: bigint } {
  if (usdUnits <= 0n) throw new Error('usd_units deve ser positivo')
  if (rate.rateNum <= 0n || rate.rateDen <= 0n) throw new Error('cotação inválida')
  const grossMinor = (usdUnits * rate.rateNum) / rate.rateDen // para baixo
  const pct = (grossMinor * BigInt(feeBps)) / BPS
  const fee = pct + feeMinor
  const netMinor = grossMinor - fee
  if (netMinor <= 0n) throw new Error('valor líquido não positivo: taxas maiores que o valor')
  return { grossMinor, feeMinor: fee, netMinor }
}

/** Preço em "BRL por dólar" com 4 casas (inteiro, ex.: 5,2000 -> 52000) vira as duas cotações racionais. */
export function ratesFromPrice4(price4: bigint): { buy: BuyRate; sell: SellRate } {
  if (price4 <= 0n) throw new Error('preço inválido')
  // compra: unidades (1e-6 USD) por centavo = (1e4 / preço) = 1e8 / price4
  // venda:  centavos por unidade = preço / 1e4 = price4 / 1e8
  return { buy: { rateNum: 100_000_000n, rateDen: price4 }, sell: { rateNum: price4, rateDen: 100_000_000n } }
}

export const fmtUsd = (units: bigint) => {
  const neg = units < 0n; const u = neg ? -units : units
  const whole = u / 1_000_000n; const frac = (u % 1_000_000n).toString().padStart(6, '0').slice(0, 2)
  return `${neg ? '-' : ''}${whole.toString()}.${frac}`
}
export const fmtBrl = (minor: bigint) => {
  const neg = minor < 0n; const m = neg ? -minor : minor
  return `${neg ? '-' : ''}${(m / 100n).toString()}.${(m % 100n).toString().padStart(2, '0')}`
}
