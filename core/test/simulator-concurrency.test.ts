// ITEM2-03 (revisão do Codex em X-0032): mutações concorrentes da cobrança simulada persistida.
// Uma barreira segura, antes de ir ao banco, a primeira consulta que casar com o padrão escolhido; o teste
// decide quando soltar ou fazê-la falhar. O resultado não depende de tempo: a espera curta (`progress`) só
// deixa a outra operação avançar tudo o que conseguir enquanto a primeira está segura.
import { describe, it, expect, afterEach } from 'vitest'
import type pg from 'pg'
import { freshDb } from './helpers.js'
import { SimulatedPixProvider } from '../src/providers/simulated.js'
import { ProviderError } from '../src/providers/types.js'

let env: Awaited<ReturnType<typeof freshDb>> | undefined
afterEach(async () => { await env?.drop(); env = undefined })

type Held = { arrived: Promise<void>; release: () => void; fail: (e: Error) => void }
/** Pool com barreira: vale para pool.query e para consultas de um cliente obtido por pool.connect(). */
function gated(pool: pg.Pool) {
  type Armed = { match: (sql: string) => boolean; when: 'before' | 'after'; arrive: () => void; wait: Promise<void> }
  let armed: Armed | null = null
  const take = (sql: string, when: Armed['when']) => {
    if (!armed || armed.when !== when || !armed.match(sql)) return null
    const a = armed; armed = null; a.arrive(); return a.wait
  }
  // 'before': segura antes de a consulta ir ao banco. 'after': a consulta roda, e o resultado fica segurado.
  const wrap = (target: any) => async (text: any, params?: any) => {
    const sql = typeof text === 'string' ? text : text.text
    await take(sql, 'before')
    const res = await target.query(text, params)
    await take(sql, 'after')
    return res
  }
  const proxy = {
    query: wrap(pool),
    connect: async () => {
      const c = await pool.connect()
      return new Proxy(c, { get(t: any, k) { if (k === 'query') return wrap(t); const v = t[k]; return typeof v === 'function' ? v.bind(t) : v } })
    },
  }
  function hold(match: (sql: string) => boolean, when: 'before' | 'after' = 'before'): Held {
    let arrive!: () => void, release!: () => void, fail!: (e: Error) => void
    const arrived = new Promise<void>(r => { arrive = r })
    const wait = new Promise<void>((r, j) => { release = r; fail = j })
    armed = { match, when, arrive, wait }
    return { arrived, release, fail }
  }
  return { pool: proxy as unknown as pg.Pool, hold }
}
const isUpdate = (sql: string) => /^\s*UPDATE simulated_pix_charges/i.test(sql)
const isPlainRead = (sql: string) => /^\s*SELECT \* FROM simulated_pix_charges WHERE id=\$1\s*$/i.test(sql)
/** Estado de uma promessa depois de dar chance a ela de andar. */
const progress = (p: Promise<unknown>) => Promise.race([p.then(() => 'done', () => 'failed'), new Promise(r => setTimeout(() => r('pending'), 150))])
const row = (pid: string) => env!.db.query(`SELECT status, paid_minor::text, refunded_minor::text FROM simulated_pix_charges WHERE id=$1`, [pid]).then(r => r.rows[0])

async function paidCharge(p: SimulatedPixProvider, value = 5000n) {
  const { paymentId } = await p.createCharge({ orderId: 'ord_concorrencia', amountMinor: value })
  await p.pay(paymentId)
  return paymentId
}

describe('ITEM2-03: cobrança simulada com mutações concorrentes', () => {
  it('caso A: dois estornos simultâneos de 1000 somam 2000 (respostas, memória, banco e depois de reiniciar)', async () => {
    env = await freshDb()
    const g = gated(env.db)
    const p = new SimulatedPixProvider({ store: g.pool })
    const pid = await paidCharge(p)
    const held = g.hold(isUpdate)
    const r1 = p.providerRefund(pid, 1000n)
    await held.arrived
    const r2 = p.providerRefund(pid, 1000n)
    expect.soft(await progress(r2)).toBe('pending') // o segundo espera o primeiro terminar
    held.release()
    await expect(Promise.all([r1, r2])).resolves.toBeDefined()
    expect((await p.getPayment(pid)).refundedMinor).toBe(2000n)
    expect(await row(pid)).toMatchObject({ refunded_minor: '2000', status: 'PARTIALLY_REFUNDED' })
    expect((await new SimulatedPixProvider({ store: env.db }).getPayment(pid)).refundedMinor).toBe(2000n)
  })

  it('caso A entre dois processos no mesmo banco: o lock da linha soma 2000 (a memória do outro processo fica velha, limite declarado)', async () => {
    env = await freshDb()
    const g = gated(env.db)
    const a = new SimulatedPixProvider({ store: g.pool })
    const b = new SimulatedPixProvider({ store: env.db })
    const pid = await paidCharge(a)
    await b.getPayment(pid) // b também tem a cobrança na memória
    const held = g.hold(isUpdate)
    const ra = a.providerRefund(pid, 1000n)
    await held.arrived
    const rb = b.providerRefund(pid, 1000n)
    expect.soft(await progress(rb)).toBe('pending') // b espera a transação de a no banco
    held.release()
    await Promise.all([ra, rb])
    expect(await row(pid)).toMatchObject({ refunded_minor: '2000' })
    expect((await b.getPayment(pid)).refundedMinor).toBe(2000n)
    expect((await new SimulatedPixProvider({ store: env.db }).getPayment(pid)).refundedMinor).toBe(2000n)
    expect((await a.getPayment(pid)).refundedMinor).toBe(1000n) // limite: a memória de a não vê o que b gravou
  })

  it('caso B1: pagamento entra na seção primeiro; a exclusão responde 400 (paga) e nunca apaga RECEIVED', async () => {
    env = await freshDb()
    const g = gated(env.db)
    const p = new SimulatedPixProvider({ store: g.pool })
    const { paymentId: pid } = await p.createCharge({ orderId: 'ord_b1', amountMinor: 5000n })
    const held = g.hold(isUpdate)
    const pay = p.pay(pid)
    await held.arrived
    const del = p.deleteCharge(pid)
    held.release()
    await pay
    const err = await del.then(() => null, e => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.status).toBe(400)
    expect(await row(pid)).toMatchObject({ status: 'RECEIVED', paid_minor: '5000' })
    expect((await p.getPayment(pid)).status).toBe('RECEIVED')
    expect((await new SimulatedPixProvider({ store: env.db }).getPayment(pid)).status).toBe('RECEIVED')
  })

  it('caso B2: exclusão confere PENDING e é segurada antes de gravar; o pagamento espera; o fim é RECEIVED, nunca DELETED por cima', async () => {
    env = await freshDb()
    const g = gated(env.db)
    const p = new SimulatedPixProvider({ store: g.pool })
    const { paymentId: pid } = await p.createCharge({ orderId: 'ord_b2', amountMinor: 5000n })
    const held = g.hold(isUpdate)
    const del = p.deleteCharge(pid)
    await held.arrived
    const pay = p.pay(pid)
    expect.soft(await progress(pay)).toBe('pending')
    held.release()
    await Promise.all([del, pay]) // histórico coerente: excluída quando estava pendente, paga depois (pagamento tardio)
    expect(await row(pid)).toMatchObject({ status: 'RECEIVED', paid_minor: '5000' })
    expect((await new SimulatedPixProvider({ store: env.db }).getPayment(pid)).status).toBe('RECEIVED')
  })

  it('exclusão de cobrança já paga, sem concorrência: 400 e nada gravado', async () => {
    env = await freshDb()
    const p = new SimulatedPixProvider({ store: env.db })
    const pid = await paidCharge(p)
    const before = (await env.db.query(`SELECT updated_at FROM simulated_pix_charges WHERE id=$1`, [pid])).rows[0].updated_at
    await expect(p.deleteCharge(pid)).rejects.toMatchObject({ status: 400 })
    expect((await env.db.query(`SELECT status, updated_at FROM simulated_pix_charges WHERE id=$1`, [pid])).rows[0]).toEqual({ status: 'RECEIVED', updated_at: before })
  })

  it('erro na primeira mutação não trava a fila: a segunda grava e a primeira não deixa rastro', async () => {
    env = await freshDb()
    const g = gated(env.db)
    const p = new SimulatedPixProvider({ store: g.pool })
    const pid = await paidCharge(p)
    const held = g.hold(isUpdate)
    const r1 = p.providerRefund(pid, 1000n)
    await held.arrived
    const r2 = p.providerRefund(pid, 700n)
    held.fail(new Error('conexão caiu (simulado)'))
    await expect(r1).rejects.toThrow('conexão caiu')
    await expect(r2).resolves.toBeUndefined()
    expect(await row(pid)).toMatchObject({ refunded_minor: '700' })
    expect((await p.getPayment(pid)).refundedMinor).toBe(700n)
    expect((await new SimulatedPixProvider({ store: env.db }).getPayment(pid)).refundedMinor).toBe(700n)
    await expect(p.providerRefund(pid, 300n)).resolves.toBeUndefined() // a fila continua andando
    expect(await row(pid)).toMatchObject({ refunded_minor: '1000' })
  })

  it('leitura com memória vazia durante uma mutação nunca deixa estado velho na memória', async () => {
    env = await freshDb()
    const pid = await paidCharge(new SimulatedPixProvider({ store: env.db }))
    const g = gated(env.db)
    const p = new SimulatedPixProvider({ store: g.pool }) // "reinício": memória vazia
    const held = g.hold(isPlainRead, 'after') // a leitura já foi ao banco (refunded 0); o resultado chega depois
    const read = p.getPayment(pid)
    await held.arrived
    const refund = p.providerRefund(pid, 1000n)
    await progress(refund)
    held.release()
    await Promise.all([read, refund])
    expect(await row(pid)).toMatchObject({ refunded_minor: '1000' })
    expect((await p.getPayment(pid)).refundedMinor).toBe(1000n)
  })
})
