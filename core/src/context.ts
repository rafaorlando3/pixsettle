import type { Db } from './db.js'
import type { PixProvider } from './providers/types.js'
import type { ChainGateway } from './chain/gateway.js'

export type Config = {
  /** Cotação simulada: unidades do token (6 casas) por centavo = rateNum / rateDen. */
  simRateNum: bigint
  simRateDen: bigint
  quoteTtlMs: number
  orderTtlMs: number
  reconcileMaxTries: number
  maxAttemptsPerSettlement: number
  issuer: { id: string; address: string }
}

export type Ctx = {
  db: Db
  provider: PixProvider
  chain: ChainGateway
  now: () => Date
  cfg: Config
  /** Ganchos só para testes de queda (simulam o processo morrendo num ponto exato). */
  crashAt?: (point: string) => void
}

export class CrashError extends Error {
  constructor(point: string) { super(`queda simulada em ${point}`) }
}

export const defaultConfig = (over: Partial<Config> = {}): Config => ({
  simRateNum: 1810n, simRateDen: 1n, // 1 centavo = 0,001810 pathUSD (cotação SIMULADA)
  quoteTtlMs: 15 * 60_000,
  orderTtlMs: 15 * 60_000,
  reconcileMaxTries: 20,
  maxAttemptsPerSettlement: 3,
  issuer: { id: 'pixsettle-demo', address: '0x0000000000000000000000000000000000000000' },
  ...over,
})
