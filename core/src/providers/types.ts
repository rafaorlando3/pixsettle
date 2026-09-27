// Interface do provedor Pix (Asaas no sandbox, ou simulado identificado).
export type ProviderStatus =
  | 'PENDING' | 'CONFIRMED' | 'RECEIVED' | 'OVERDUE' | 'REFUNDED' | 'REFUND_IN_PROGRESS'
  | 'PARTIALLY_REFUNDED' | 'DELETED' | 'OTHER'

export type ProviderPayment = {
  id: string
  status: ProviderStatus
  rawStatus: string
  billingType: string
  valueMinor: bigint
  externalReference: string | null
  /** Instante do pagamento com fuso, quando o provedor informar com precisão. */
  paidAt: Date | null
  /** Só a data (AAAA-MM-DD), quando é tudo que o provedor dá. */
  paidDate: string | null
  refundedMinor: bigint
}

export type CreatedCharge = { paymentId: string; qrPayload: string; qrExpiresAt: Date }

export class ProviderError extends Error {
  constructor(
    readonly code: 'timeout' | 'http' | 'invalid_response', readonly status: number | null, readonly body: unknown, message: string,
    /** Resultado desconhecido: o provedor pode ter executado. Padrão: só timeout/rede. */
    readonly ambiguous: boolean = code === 'timeout',
  ) {
    super(message)
  }
  get outcomeUnknown() { return this.ambiguous }
  /** Recusa COMPROVADA (revisão R8): 4xx com corpo de erro do provedor. Só isso autoriza declarar falha. */
  get provenRejection() { return this.code === 'http' && !this.ambiguous && this.status !== null && this.status >= 400 && this.status < 500 }
}

export interface PixProvider {
  readonly name: 'asaas' | 'simulated'
  readonly env: 'sandbox' | 'simulated'
  createCharge(input: { orderId: string; amountMinor: bigint; description: string; dueDate: string }): Promise<CreatedCharge>
  /** QR (copia e cola) de uma cobrança já criada; usado quando a criação teve resposta perdida. */
  getPixQr(paymentId: string): Promise<{ qrPayload: string; qrExpiresAt: Date }>
  getPayment(paymentId: string): Promise<ProviderPayment>
  findByExternalReference(orderId: string): Promise<ProviderPayment[]>
  deleteCharge(paymentId: string): Promise<void>
  refund(paymentId: string, amountMinor: bigint, description: string): Promise<{ refundRef: string }>
}

/** Ordem de avanço do estado observado; nunca regredir (contrato 3.2). */
export const OBSERVED_RANK: Record<string, number> = {
  created: 0, overdue: 1, confirmed: 1, received: 2, partially_refunded: 3, refunded: 4, deleted: 1,
}

export function mapObserved(s: ProviderStatus): string | null {
  switch (s) {
    case 'PENDING': return 'created'
    case 'CONFIRMED': return 'confirmed'
    case 'RECEIVED': return 'received'
    case 'OVERDUE': return 'overdue'
    case 'PARTIALLY_REFUNDED': return 'partially_refunded'
    case 'REFUNDED': return 'refunded'
    case 'REFUND_IN_PROGRESS': return 'received' // ainda recebido; o caso de devolução acompanha à parte
    case 'DELETED': return 'deleted'
    default: return null
  }
}
