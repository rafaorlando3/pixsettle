import type { Db } from './db.js'
import type { PixProvider } from './providers/types.js'
import type { ChainGateway } from './chain/gateway.js'
import type { CopilotModel } from './copilot/model.js'

export type Config = {
  /** Public pilot/replay is read-only; simulated demo remains available. */
  publicReplayReadOnly?: boolean
  /** Cotação simulada: unidades do token (6 casas) por centavo = rateNum / rateDen. */
  simRateNum: bigint
  simRateDen: bigint
  quoteTtlMs: number
  orderTtlMs: number
  reconcileMaxTries: number
  maxAttemptsPerSettlement: number
  issuer: { id: string; address: string }
  /** Piloto com eventos atestados: liquidar na testnet cada pedido real pago? (false = só concilia e registra o motivo) */
  pilotSettle: boolean
  /** Cotação SIMULADA do piloto (unidades do token por centavo); escala reduzida para caber na tesouraria de testnet. */
  pilotRateNum: bigint
  pilotRateDen: bigint
  /** Endereço de recebimento dos lojistas do piloto na Tempo (testnet). */
  pilotPayoutAddress: string
}

export type Ctx = {
  db: Db
  provider: PixProvider
  chain: ChainGateway
  now: () => Date
  cfg: Config
  /** Ganchos só para testes de queda (simulam o processo morrendo num ponto exato). */
  crashAt?: (point: string) => void
  /** Copiloto de exceções: modelo para o resíduo que as regras não decidem (ausente = model_off, com motivo). */
  copilot?: { model: CopilotModel | null; offReason?: string; /** teto de chamadas ao modelo por 24 h (modo vivo); esgotado = aguardando humano, com motivo */ budgetCallsPerDay?: number }
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
  pilotSettle: true,
  pilotRateNum: 1n, pilotRateDen: 1n, // 1 centavo = 0,000001 pathUSD (cotação SIMULADA do piloto, escala reduzida)
  pilotPayoutAddress: '0x8ee643c15C603856A76d05020b5ccB0FceA425BF',
  ...over,
})
