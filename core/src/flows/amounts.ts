// Aritmética de valores em unidades mínimas (inteiros), compartilhada por liquidação e recibo.

/** Reserva de uma liquidação já registrada: bruto - líquido - tarifas (tarifas simuladas = 0 nesta versão).
 *  Recusa valores que quebram a identidade, em vez de gravar contabilidade inconsistente. */
export function reserveOfIntent(amountMinor: bigint, rateNum: bigint, rateDen: bigint, netUnits: bigint): bigint {
  const gross = (amountMinor * rateNum) / rateDen
  const reserve = gross - netUnits
  if (netUnits <= 0n || reserve < 0n) throw new Error('identidade contábil violada: líquido da intenção maior que o bruto')
  return reserve
}
