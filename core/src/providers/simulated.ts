// Provedor Pix SIMULADO, identificado como tal em todo registro (provider = 'simulated').
// Usado nos testes e na demo sem credenciais. Permite injetar falhas para os testes P1.
//
// Persistência opcional (`store`): com um banco, cada cobrança é gravada em simulated_pix_charges e
// relida quando não está na memória, então a cobrança sobrevive a reinício do processo com o mesmo id.
// Sem banco (testes de unidade), tudo fica só na memória, como antes. As falhas injetáveis nunca persistem.
//
// Concorrência (ITEM2-03): com banco, toda mudança é uma transação que relê a linha com FOR UPDATE, confere a
// pré-condição, grava e só depois publica na memória; e, neste processo, as operações de uma mesma cobrança
// passam por uma fila (mudanças e leituras que vão ao banco), para a memória nunca receber um estado mais
// velho que o já publicado. Entre processos, o lock da linha mantém as GRAVAÇÕES corretas, mas a memória de
// cada processo só vê o que ele mesmo gravou: a demo roda um processo só; não prometa mais que isso.
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
  private readonly queues = new Map<string, Promise<void>>()
  /** Falhas injetáveis: 'create_timeout_after_commit' simula resposta perdida depois de criar. */
  failNext: null | 'create_timeout_after_commit' | 'create_timeout_before_commit' | 'get_timeout' | 'refund_timeout_after_commit' | 'refund_rejected' = null

  constructor(opts: { store?: pg.Pool } = {}) { this.store = opts.store ?? null }

  get persistent() { return this.store !== null }

  private static fromRow(r: any): Charge {
    return { id: r.id, orderId: r.order_id, valueMinor: BigInt(r.value_minor), status: r.status, paidAt: r.paid_at ? new Date(r.paid_at) : null, paidMinor: BigInt(r.paid_minor), refundedMinor: BigInt(r.refunded_minor) }
  }

  /** Fila por cobrança, neste processo. Um erro não trava a fila: a próxima operação roda mesmo assim. */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(id) ?? Promise.resolve()).then(fn)
    const tail = run.then(() => {}, () => {})
    this.queues.set(id, tail)
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id) })
    return run
  }

  /** Memória primeiro; se não estiver e houver banco, relê do banco (caso de reinício), na fila da cobrança. */
  private async load(id: string): Promise<Charge | undefined> {
    const hit = this.charges.get(id)
    if (hit || !this.store) return hit
    const store = this.store
    return this.serial(id, async () => {
      const again = this.charges.get(id) // alguém da fila já publicou enquanto esperávamos
      if (again) return again
      const row = (await store.query(`SELECT * FROM simulated_pix_charges WHERE id=$1`, [id])).rows[0]
      if (!row) return undefined
      const c = SimulatedPixProvider.fromRow(row)
      this.charges.set(id, c)
      return c
    })
  }

  /**
   * Aplica uma mudança numa cobrança. `change` pode recusar (lançar) olhando o estado atual; aí nada muda.
   * Sem banco: na hora, no próprio objeto (como sempre foi; os testes de unidade chamam sem await).
   * Com banco, na fila da cobrança: BEGIN, relê a linha com FOR UPDATE (o banco é a fonte, não a memória),
   * `change` numa cópia, UPDATE, COMMIT, e só então publica na memória. Recusa: ROLLBACK, e a memória fica com
   * o estado lido do banco. Erro de banco (resultado incerto): descarta a memória para a próxima leitura vir do
   * banco (ITEM2-02) e repassa o erro, sem repetir a operação.
   */
  private async mutate(id: string, change: (c: Charge) => void): Promise<void> {
    if (!this.store) {
      const c = this.charges.get(id)
      if (!c) throw notFound(id)
      change(c)
      return
    }
    const store = this.store
    await this.serial(id, async () => {
      const client = await store.connect()
      let refused = false, broken = false
      try {
        await client.query('BEGIN')
        const row = (await client.query(`SELECT * FROM simulated_pix_charges WHERE id=$1 FOR UPDATE`, [id])).rows[0]
        if (!row) { refused = true; throw notFound(id) }
        const current = SimulatedPixProvider.fromRow(row)
        const next: Charge = { ...current }
        try { change(next) } catch (e) { refused = true; this.charges.set(id, current); throw e }
        const r = await client.query(
          `UPDATE simulated_pix_charges SET status=$2, paid_at=$3, paid_minor=$4, refunded_minor=$5, updated_at=now() WHERE id=$1`,
          [next.id, next.status, next.paidAt, next.paidMinor.toString(), next.refundedMinor.toString()])
        if (r.rowCount !== 1) throw new Error(`cobrança simulada ${id} não gravada (rowCount=${r.rowCount})`)
        await client.query('COMMIT')
        this.charges.set(id, next)
      } catch (e) {
        try { await client.query('ROLLBACK') } catch { broken = true }
        if (!refused) { this.charges.delete(id); broken = true } // resultado incerto: relê do banco na próxima vez
        throw e
      } finally {
        client.release(broken) // conexão com erro não volta para o pool
      }
    })
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
      // Não publica na memória o que leu aqui fora da fila (evita estado velho por cima de um mais novo).
      return rows.map(r => this.view(this.charges.get(r.id) ?? SimulatedPixProvider.fromRow(r)))
    }
    return [...this.charges.values()].filter(c => c.orderId === orderId).map(c => this.view(c))
  }

  async deleteCharge(id: string): Promise<void> {
    // Como o Asaas: só exclui cobrança pendente; paga devolve 400. A conferência fica dentro da mesma seção
    // da gravação, então um pagamento que entrou antes nunca é apagado (ITEM2-03).
    await this.mutate(id, x => {
      if (x.status !== 'PENDING') throw new ProviderError('http', 400, { errors: [{ code: 'invalid_action', description: 'só cobranças pendentes' }] }, `cobrança ${id} em ${x.status}`)
      x.status = 'DELETED'
    })
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
