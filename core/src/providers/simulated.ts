// Provedor Pix SIMULADO, identificado como tal em todo registro (provider = 'simulated').
// Usado nos testes e na demo sem credenciais. Permite injetar falhas para os testes P1.
import { randomBytes } from 'node:crypto'
import { ProviderError, type PixProvider, type ProviderPayment, type CreatedCharge, type ProviderStatus } from './types.js'

type Charge = { id: string; orderId: string; valueMinor: bigint; status: ProviderStatus; paidAt: Date | null; paidMinor: bigint; refundedMinor: bigint }

export class SimulatedPixProvider implements PixProvider {
  readonly name = 'simulated' as const
  readonly env = 'simulated' as const
  charges = new Map<string, Charge>()
  private seq = 0
  /** Falhas injetáveis: 'create_timeout_after_commit' simula resposta perdida depois de criar. */
  failNext: null | 'create_timeout_after_commit' | 'create_timeout_before_commit' | 'get_timeout' | 'refund_timeout_after_commit' | 'refund_rejected' = null

  async createCharge(input: { orderId: string; amountMinor: bigint }): Promise<CreatedCharge> {
    if (this.failNext === 'create_timeout_before_commit') { this.failNext = null; throw new ProviderError('timeout', null, null, 'timeout simulado') }
    const id = `pay_sim_${randomBytes(8).toString('hex')}` // único entre reinícios: o banco sobrevive, a memória não
    this.charges.set(id, { id, orderId: input.orderId, valueMinor: input.amountMinor, status: 'PENDING', paidAt: null, paidMinor: 0n, refundedMinor: 0n })
    if (this.failNext === 'create_timeout_after_commit') { this.failNext = null; throw new ProviderError('timeout', null, null, 'timeout simulado depois de criar') }
    return { paymentId: id, qrPayload: `SIMULATED-PIX|${id}|${input.amountMinor}`, qrExpiresAt: new Date(Date.now() + 3600_000) }
  }

  async getPixQr(id: string): Promise<{ qrPayload: string; qrExpiresAt: Date }> {
    const c = this.charges.get(id)
    if (!c) throw new ProviderError('http', 404, { errors: [{ code: 'not_found' }] }, `cobrança ${id} não existe`)
    return { qrPayload: `SIMULATED-PIX|${id}|${c.valueMinor}`, qrExpiresAt: new Date(Date.now() + 3600_000) }
  }

  private view(c: Charge): ProviderPayment {
    return { id: c.id, status: c.status, rawStatus: c.status, billingType: 'PIX', valueMinor: c.paidMinor || c.valueMinor, externalReference: c.orderId, paidAt: c.paidAt, paidDate: c.paidAt ? c.paidAt.toISOString().slice(0, 10) : null, refundedMinor: c.refundedMinor }
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    if (this.failNext === 'get_timeout') { this.failNext = null; throw new ProviderError('timeout', null, null, 'timeout simulado') }
    const c = this.charges.get(id)
    if (!c) throw new ProviderError('http', 404, { errors: [{ code: 'not_found' }] }, `cobrança ${id} não existe`)
    return this.view(c)
  }

  async findByExternalReference(orderId: string): Promise<ProviderPayment[]> {
    return [...this.charges.values()].filter(c => c.orderId === orderId).map(c => this.view(c))
  }

  async deleteCharge(id: string): Promise<void> {
    const c = this.charges.get(id)
    if (!c) throw new ProviderError('http', 404, { errors: [{ code: 'not_found' }] }, `cobrança ${id} não existe`)
    // Como o Asaas: só exclui cobrança pendente; paga devolve 400.
    if (c.status !== 'PENDING') throw new ProviderError('http', 400, { errors: [{ code: 'invalid_action', description: 'só cobranças pendentes' }] }, `cobrança ${id} em ${c.status}`)
    c.status = 'DELETED'
  }

  async refund(id: string, amountMinor: bigint): Promise<{ refundRef: string }> {
    if (this.failNext === 'refund_rejected') { this.failNext = null; throw new ProviderError('http', 400, { errors: [{ code: 'invalid_action', description: 'saldo insuficiente (simulado)' }] }, 'estorno recusado (simulado)') }
    this.providerRefund(id, amountMinor)
    if (this.failNext === 'refund_timeout_after_commit') { this.failNext = null; throw new ProviderError('timeout', null, null, 'timeout simulado depois de estornar') }
    return { refundRef: `ref_sim_${++this.seq}` }
  }

  /** Estorno feito no provedor (pedido nosso, MED ou painel do provedor). */
  providerRefund(id: string, amountMinor: bigint) {
    const c = this.charges.get(id)!
    c.refundedMinor += amountMinor
    c.status = c.refundedMinor >= c.paidMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
  }

  // ---- ações da "bancada" (simulam o pagador) ----
  pay(id: string, opts: { at?: Date; valueMinor?: bigint } = {}) {
    const c = this.charges.get(id)!
    c.status = 'RECEIVED'; c.paidAt = opts.at ?? new Date(); c.paidMinor = opts.valueMinor ?? c.valueMinor
  }
}
