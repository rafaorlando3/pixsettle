// Provedor Pix SIMULADO, identificado como tal em todo registro (provider = 'simulated').
// Usado nos testes e na demo sem credenciais. Permite injetar falhas para os testes P1.
//
// Persistência opcional (`store`): com um banco, cada cobrança é gravada em simulated_pix_charges e
// relida quando não está na memória, então a cobrança sobrevive a reinício do processo com o mesmo id.
// Sem banco (testes de unidade), tudo fica só na memória, como antes. As falhas injetáveis nunca persistem.
import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { ProviderError, type PixProvider, type ProviderPayment, type CreatedCharge, type ProviderStatus } from './types.js'

type Charge = { id: string; orderId: string; valueMinor: bigint; status: ProviderStatus; paidAt: Date | null; paidMinor: bigint; refundedMinor: bigint }

const notFound = (id: string) => new ProviderError('http', 404, { errors: [{ code: 'not_found' }] }, `cobrança ${id} não existe`)

export class SimulatedPixProvider implements PixProvider {
  readonly name = 'simulated' as const
  readonly env = 'simulated' as const
  charges = new Map<string, Charge>()
  private readonly store: pg.Pool | null
  /** Falhas injetáveis: 'create_timeout_after_commit' simula resposta perdida depois de criar. */
  failNext: null | 'create_timeout_after_commit' | 'create_timeout_before_commit' | 'get_timeout' | 'refund_timeout_after_commit' | 'refund_rejected' = null

  constructor(opts: { store?: pg.Pool } = {}) { this.store = opts.store ?? null }

  get persistent() { return this.store !== null }

  private static fromRow(r: any): Charge {
    return { id: r.id, orderId: r.order_id, valueMinor: BigInt(r.value_minor), status: r.status, paidAt: r.paid_at ? new Date(r.paid_at) : null, paidMinor: BigInt(r.paid_minor), refundedMinor: BigInt(r.refunded_minor) }
  }

  /** Memória primeiro; se não estiver e houver banco, relê do banco (caso de reinício). */
  private async load(id: string): Promise<Charge | undefined> {
    const hit = this.charges.get(id)
    if (hit || !this.store) return hit
    const row = (await this.store.query(`SELECT * FROM simulated_pix_charges WHERE id=$1`, [id])).rows[0]
    if (!row) return undefined
    const c = SimulatedPixProvider.fromRow(row)
    this.charges.set(id, c)
    return c
  }

  /**
   * Aplica uma mudança numa cobrança. Sem banco: na hora, no próprio objeto (como sempre foi).
   * Com banco: calcula numa cópia, grava, e só então publica na memória. Se a gravação falhar, a memória
   * é descartada para a próxima leitura vir do banco; nunca fica um estado que o banco não tem (ITEM2-02).
   */
  private async mutate(id: string, change: (c: Charge) => void): Promise<void> {
    if (!this.store) {
      const c = this.charges.get(id)
      if (!c) throw notFound(id)
      change(c)
      return
    }
    const cur = await this.load(id)
    if (!cur) throw notFound(id)
    const next: Charge = { ...cur }
    change(next)
    try {
      const r = await this.store.query(
        `UPDATE simulated_pix_charges SET status=$2, paid_at=$3, paid_minor=$4, refunded_minor=$5, updated_at=now() WHERE id=$1`,
        [next.id, next.status, next.paidAt, next.paidMinor.toString(), next.refundedMinor.toString()])
      if (r.rowCount !== 1) throw new Error(`cobrança simulada ${id} não gravada (rowCount=${r.rowCount})`)
    } catch (e) {
      this.charges.delete(id) // resultado incerto: relê do banco na próxima vez
      throw e
    }
    this.charges.set(id, next)
  }

  /** A cobrança existe (na memória ou no banco)? Usado pela demo para distinguir pedido antigo. */
  async has(id: string): Promise<boolean> { return (await this.load(id)) !== undefined }

  async createCharge(input: { orderId: string; amountMinor: bigint }): Promise<CreatedCharge> {
    if (this.failNext === 'create_timeout_before_commit') { this.failNext = null; throw new ProviderError('timeout', null, null, 'timeout simulado') }
    const id = `pay_sim_${randomBytes(8).toString('hex')}` // único entre reinícios
    const c: Charge = { id, orderId: input.orderId, valueMinor: input.amountMinor, status: 'PENDING', paidAt: null, paidMinor: 0n, refundedMinor: 0n }
    if (this.store) await this.store.query(`INSERT INTO simulated_pix_charges (id, order_id, value_minor, status) VALUES ($1,$2,$3,'PENDING')`, [id, input.orderId, input.amountMinor.toString()])
    this.charges.set(id, c)
    if (this.failNext === 'create_timeout_after_commit') { this.failNext = null; throw new ProviderError('timeout', null, null, 'timeout simulado depois de criar') }
    return { paymentId: id, qrPayload: `SIMULATED-PIX|${id}|${input.amountMinor}`, qrExpiresAt: new Date(Date.now() + 3600_000) }
  }

  async getPixQr(id: string): Promise<{ qrPayload: string; qrExpiresAt: Date }> {
    const c = await this.load(id)
    if (!c) throw notFound(id)
    return { qrPayload: `SIMULATED-PIX|${id}|${c.valueMinor}`, qrExpiresAt: new Date(Date.now() + 3600_000) }
  }

  private view(c: Charge): ProviderPayment {
    return { id: c.id, status: c.status, rawStatus: c.status, billingType: 'PIX', valueMinor: c.paidMinor || c.valueMinor, externalReference: c.orderId, paidAt: c.paidAt, paidDate: c.paidAt ? c.paidAt.toISOString().slice(0, 10) : null, refundedMinor: c.refundedMinor }
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    if (this.failNext === 'get_timeout') { this.failNext = null; throw new ProviderError('timeout', null, null, 'timeout simulado') }
    const c = await this.load(id)
    if (!c) throw notFound(id)
    return this.view(c)
  }

  async findByExternalReference(orderId: string): Promise<ProviderPayment[]> {
    if (this.store) {
      const rows = (await this.store.query(`SELECT * FROM simulated_pix_charges WHERE order_id=$1 ORDER BY created_at, id`, [orderId])).rows
      return rows.map(r => { const c = this.charges.get(r.id) ?? SimulatedPixProvider.fromRow(r); this.charges.set(c.id, c); return this.view(c) })
    }
    return [...this.charges.values()].filter(c => c.orderId === orderId).map(c => this.view(c))
  }

  async deleteCharge(id: string): Promise<void> {
    const c = await this.load(id)
    if (!c) throw notFound(id)
    // Como o Asaas: só exclui cobrança pendente; paga devolve 400.
    if (c.status !== 'PENDING') throw new ProviderError('http', 400, { errors: [{ code: 'invalid_action', description: 'só cobranças pendentes' }] }, `cobrança ${id} em ${c.status}`)
    await this.mutate(id, x => { x.status = 'DELETED' })
  }

  async refund(id: string, amountMinor: bigint): Promise<{ refundRef: string }> {
    if (this.failNext === 'refund_rejected') { this.failNext = null; throw new ProviderError('http', 400, { errors: [{ code: 'invalid_action', description: 'saldo insuficiente (simulado)' }] }, 'estorno recusado (simulado)') }
    await this.providerRefund(id, amountMinor)
    if (this.failNext === 'refund_timeout_after_commit') { this.failNext = null; throw new ProviderError('timeout', null, null, 'timeout simulado depois de estornar') }
    return { refundRef: `ref_sim_${randomBytes(6).toString('hex')}` } // único entre reinícios
  }

  /** Estorno feito no provedor (pedido nosso, MED ou painel do provedor).
   *  Sem banco, a mudança é aplicada na hora (os testes chamam sem await); com banco, só depois de gravar. */
  async providerRefund(id: string, amountMinor: bigint): Promise<void> {
    await this.mutate(id, c => {
      c.refundedMinor += amountMinor
      c.status = c.refundedMinor >= c.paidMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    })
  }

  // ---- ações da "bancada" (simulam o pagador) ----
  async pay(id: string, opts: { at?: Date; valueMinor?: bigint } = {}): Promise<void> {
    await this.mutate(id, c => { c.status = 'RECEIVED'; c.paidAt = opts.at ?? new Date(); c.paidMinor = opts.valueMinor ?? c.valueMinor })
  }
}
