// Worker com estado ocioso (src/worker.ts), pelos seis critérios da revisão do Codex (X-0023):
// não perder wake; acordar depois do commit e antecipar job futuro; lease e reinício; limite de um
// processo (documentado no worker); erro de banco não é fila vazia; medir TODAS as consultas.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setup, deliver, asaasEvent } from './helpers.js'
import { createOrder } from '../src/flows/orders.js'
import { startWorker, wakeOnWrites, type Worker, type WorkerState } from '../src/worker.js'
import { buildApp } from '../src/app.js'
import { registerWeb } from '../src/web.js'
import { registerDemo } from '../src/demo.js'
import { defaultSweep } from '../src/flows/sweep.js'
import { SimulatedPixProvider } from '../src/providers/simulated.js'
import { signReceipt } from '../../settlement/src/receipt.js'
import { privateKeyToAccount } from 'viem/accounts'

const ISSUER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const // chave pública de TESTE
const ISSUER = privateKeyToAccount(ISSUER_KEY).address
const SWEEP_CFG = { ...defaultSweep, recentReceivedMs: 0 } // como o servidor configura com o Pix simulado

let env: Awaited<ReturnType<typeof setup>>
let worker: Worker | null = null
let miner: ReturnType<typeof setInterval> | null = null
afterEach(async () => {
  if (miner) clearInterval(miner); miner = null
  await worker?.stop(); worker = null
  await env?.drop()
})

/** Conta TODA consulta ao banco: pool.query e as feitas dentro de transação (pool.connect). */
function countQueries(db: any) {
  let n = 0
  const q = db.query.bind(db)
  db.query = (...a: any[]) => { n++; return q(...a) }
  const c = db.connect.bind(db)
  db.connect = (...a: any[]) => {
    if (typeof a[0] === 'function') return c(...a) // uso interno do pool.query (já contado acima)
    return wrap(c(...a))
  }
  async function wrap(p: Promise<any>) {
    const client = await p
    if (!client.__counted) { const cq = client.query.bind(client); client.query = (...b: any[]) => { n++; return cq(...b) }; client.__counted = true }
    return client
  }
  return { get n() { return n }, reset() { n = 0 } }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(pred: () => boolean | Promise<boolean>, ms = 15_000, step = 20) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(step) }
  throw new Error('condição não atingida a tempo')
}

async function start(extra: Partial<Parameters<typeof startWorker>[1]> = {}) {
  const states: WorkerState[] = []
  worker = startWorker(env.ctx, { sweepEveryMs: 300_000, sweep: SWEEP_CFG, log: () => {}, errorBackoffMs: { min: 50, max: 400 }, onState: s => states.push(s), ...extra })
  return states
}
async function start0() {
  env = await setup()
  env.ctx.cfg.issuer = { id: 'pixsettle-test', address: ISSUER }
  env.chain.signReceipt = (payload: any) => signReceipt(payload, ISSUER_KEY)
}

describe('worker: ocioso de verdade', () => {
  it('sem nada a fazer: fica idle e faz ZERO consultas enquanto ninguém chama wake', async () => {
    await start0()
    const qc = countQueries(env.db)
    await start()
    await until(() => worker!.state === 'idle')
    expect(qc.n).toBeGreaterThan(0) // o contador enxerga as consultas da primeira volta
    qc.reset()
    await sleep(1500)
    expect(worker!.state).toBe('idle')
    expect(qc.n).toBe(0)
  })

  it('pedido aguardando pagamento: não fica idle (varredura pendente), espera o intervalo da varredura sem consultar no meio', async () => {
    await start0()
    await createOrder(env.ctx, env.merchantId, { externalRef: 'r-' + randomUUID(), amountMinor: 10090n, description: 't' })
    const qc = countQueries(env.db)
    await start({ sweepEveryMs: 60_000 })
    await until(() => worker!.state === 'waiting')
    qc.reset()
    await sleep(1000)
    expect(worker!.state).toBe('waiting')
    expect(qc.n).toBe(0)
  })
})

describe('worker: acorda e processa', () => {
  it('evento chega (commit) + wake: liquida até o fim e volta a idle; depois, zero consultas', async () => {
    await start0()
    miner = setInterval(() => env.chain.mine(), 30)
    await start()
    await until(() => worker!.state === 'idle')
    const orderId = await createOrder(env.ctx, env.merchantId, { externalRef: 'r-' + randomUUID(), amountMinor: 10090n, description: 't' })
    const pid = (await env.db.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [orderId])).rows[0].provider_payment_id
    await env.provider.pay(pid)
    await deliver(env.ctx, asaasEvent('evt_' + orderId, 'PAYMENT_RECEIVED', pid, 'RECEIVED'))
    worker!.wake()
    await until(async () => (await env.db.query(`SELECT 1 FROM receipts WHERE order_id=$1`, [orderId])).rowCount === 1, 25_000)
    expect((await env.db.query(`SELECT status FROM orders WHERE id=$1`, [orderId])).rows[0].status).toBe('settled')
    expect(env.chain.mined).toHaveLength(1)
    await until(() => worker!.state === 'idle', 15_000)
    const qc = countQueries(env.db)
    await sleep(1000)
    expect(qc.n).toBe(0)
  }, 40_000)

  it('wake durante o trabalho não se perde: o job gravado nesse meio-tempo roda sem esperar timer', async () => {
    await start0()
    const states = await start({ sweepEveryMs: 3_600_000 })
    // grava um job no instante em que o worker está trabalhando na primeira volta
    await until(() => states.includes('busy'))
    await env.db.query(`INSERT INTO outbox (topic, entity_id, payload) VALUES ('observe_charge','chg_inexistente','{}')`)
    worker!.wake()
    await until(async () => (await env.db.query(`SELECT count(*)::int AS n FROM outbox WHERE done_at IS NULL`)).rows[0].n === 0, 3_000)
    await until(() => worker!.state === 'idle', 3_000)
  })

  it('job com horário futuro: fica waiting e roda sozinho na hora, sem wake', async () => {
    await start0()
    await env.db.query(`INSERT INTO outbox (topic, entity_id, payload, available_at) VALUES ('observe_charge','chg_futuro','{}', now() + interval '700 milliseconds')`)
    await start()
    await until(() => worker!.state === 'waiting')
    await until(async () => (await env.db.query(`SELECT count(*)::int AS n FROM outbox WHERE done_at IS NULL`)).rows[0].n === 0, 5_000)
    await until(() => worker!.state === 'idle', 3_000)
  })

  it('lease de um worker que morreu: espera o lease vencer e retoma o job', async () => {
    await start0()
    await env.db.query(`INSERT INTO outbox (topic, entity_id, payload, locked_until, attempts) VALUES ('observe_charge','chg_lease','{}', now() + interval '800 milliseconds', 1)`)
    await start()
    await until(() => worker!.state === 'waiting')
    await until(async () => (await env.db.query(`SELECT count(*)::int AS n FROM outbox WHERE done_at IS NULL`)).rows[0].n === 0, 5_000)
    expect((await env.db.query(`SELECT attempts FROM outbox WHERE entity_id='chg_lease'`)).rows[0].attempts).toBe(2)
  })
})

describe('worker: acordado pelas requisições do servidor', () => {
  it('botão "pagar" da demo (POST) acorda o worker ocioso, que liquida sem nenhum wake manual', async () => {
    await start0()
    miner = setInterval(() => env.chain.mine(), 30)
    const app = buildApp(env.ctx, { asaasWebhookToken: 'tok-webhook-teste', diagnosticsToken: 'diag' })
    registerWeb(app, env.ctx, { tempoRpc: 'https://rpc.moderato.tempo.xyz', explorer: 'https://explore.testnet.tempo.xyz', demo: true })
    await registerDemo(app, env.ctx, { webhookToken: 'tok-webhook-teste', merchantAddress: '0x8ee643c15C603856A76d05020b5ccB0FceA425BF', explorer: 'https://explore.testnet.tempo.xyz' })
    await start()
    wakeOnWrites(app, worker!)
    await until(() => worker!.state === 'idle')
    const c = await app.inject({ method: 'POST', url: '/demo/api/orders', payload: { amount_minor: 10090, description: 't' } })
    const { order_id } = c.json()
    await app.inject({ method: 'POST', url: `/demo/api/orders/${order_id}/simulate`, payload: { scenario: 'pay', deliveries: 3 } })
    await until(async () => (await app.inject({ method: 'GET', url: `/demo/api/orders/${order_id}` })).json().status === 'settled', 25_000)
    await until(() => worker!.state === 'idle', 15_000)
    await app.close()
  }, 40_000)
})

describe('worker: necessidade de varredura recalculada depois de drenar (ITEM2-01, revisão X-0027)', () => {
  async function orderWithLostCreation() {
    const A = new SimulatedPixProvider({ store: env.db }); env.ctx.provider = A
    A.failNext = 'create_timeout_after_commit' // o provedor criou, a resposta se perdeu
    const orderId = await createOrder(env.ctx, env.merchantId, { externalRef: 'r-' + randomUUID(), amountMinor: 10090n, description: 't' })
    expect((await env.db.query(`SELECT creation_state FROM pix_charges WHERE order_id=$1`, [orderId])).rows[0].creation_state).toBe('creation_unknown')
    const pid = (await env.db.query(`SELECT id FROM simulated_pix_charges WHERE order_id=$1`, [orderId])).rows[0].id as string
    return { A, orderId, pid }
  }

  it('criação com resposta perdida + pagamento sem webhook + reinício: só o worker, sem wake, liquida uma vez', async () => {
    await start0()
    const { A, orderId, pid } = await orderWithLostCreation()
    await A.pay(pid) // pago no provedor; nenhum webhook vai chegar
    env.ctx.provider = new SimulatedPixProvider({ store: env.db }) // reinício
    miner = setInterval(() => env.chain.mine(), 30)
    await start({ sweepEveryMs: 400 })
    await until(async () => (await env.db.query(`SELECT 1 FROM receipts WHERE order_id=$1`, [orderId])).rowCount === 1, 25_000)
    expect(env.chain.mined).toHaveLength(1)
  }, 40_000)

  it('mesma situação sem pagamento: depois de recuperar a cobrança o worker fica esperando a varredura, não ocioso', async () => {
    await start0()
    await orderWithLostCreation()
    env.ctx.provider = new SimulatedPixProvider({ store: env.db })
    await start({ sweepEveryMs: 60_000 })
    await until(async () => (await env.db.query(`SELECT count(*)::int AS n FROM orders WHERE status='awaiting_payment'`)).rows[0].n === 1, 5_000)
    await until(() => worker!.state === 'waiting' || worker!.state === 'idle', 5_000)
    await sleep(300)
    expect(worker!.state).toBe('waiting')
  })
})

describe('worker: erro de banco não é fila vazia', () => {
  it('consulta falhando: estado error com o motivo, nunca idle; quando o banco volta, conclui e fica idle', async () => {
    await start0()
    let failures = 3
    const q = env.db.query.bind(env.db) as any
    ;(env.db as any).query = (...a: any[]) => {
      if (failures > 0) { failures--; return Promise.reject(new Error('connection terminated unexpectedly (simulado)')) }
      return q(...a)
    }
    const states = await start()
    await until(() => worker!.state === 'idle', 5_000)
    const firstIdle = states.indexOf('idle')
    expect(states.slice(0, firstIdle)).toContain('error')
    expect(states.filter(s => s === 'error').length).toBe(3)
    expect(worker!.lastError).toBeNull()
  })
})
