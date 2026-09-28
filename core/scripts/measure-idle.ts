// Mede quantas consultas o worker faz com a fila vazia e nada a conciliar (critério 6 da revisão X-0023).
// Compara o laço antigo (runOnce + sono de 200 ms + varredura periódica) com o worker novo (src/worker.ts).
// Uso: TEST_DATABASE_ADMIN=postgres://... npx tsx scripts/measure-idle.ts [segundos]
// Cria e apaga um banco próprio; não toca em nenhum outro banco.
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { createPool } from '../src/db.js'
import { migrate } from '../src/migrate.js'
import { defaultConfig, type Ctx } from '../src/context.js'
import { SimulatedPixProvider } from '../src/providers/simulated.js'
import { runOnce } from '../src/outbox.js'
import { sweep, defaultSweep } from '../src/flows/sweep.js'
import { startWorker } from '../src/worker.js'

const ADMIN = process.env.TEST_DATABASE_ADMIN ?? 'postgres://pixsettle@localhost:5433/postgres?host=/tmp'
const SECONDS = Number(process.argv[2] ?? 10)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function counter(db: any) {
  let n = 0
  const q = db.query.bind(db); db.query = (...a: any[]) => { n++; return q(...a) }
  const c = db.connect.bind(db)
  db.connect = (...a: any[]) => typeof a[0] === 'function' ? c(...a) : c(...a).then((cl: any) => {
    if (!cl.__counted) { const cq = cl.query.bind(cl); cl.query = (...b: any[]) => { n++; return cq(...b) }; cl.__counted = true }
    return cl
  })
  return { get n() { return n }, reset() { n = 0 } }
}

async function main() {
  const name = 'pst_measure_' + randomUUID().replace(/-/g, '').slice(0, 12)
  const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end()
  const u = new URL(ADMIN); u.pathname = `/${name}`
  const db = createPool(u.toString())
  try {
    await migrate(db)
    const ctx: Ctx = { db, provider: new SimulatedPixProvider({ store: db }), chain: null as any, now: () => new Date(), cfg: defaultConfig() }
    const qc = counter(db)

    // 1) laço antigo, igual ao de src/server.ts até 463ad51
    let stop = false
    const sweepEvery = 60_000; let lastSweep = 0
    const old = (async () => { while (!stop) { if (Date.now() - lastSweep >= sweepEvery) { lastSweep = Date.now(); await sweep(ctx) } if (!(await runOnce(ctx))) await sleep(200) } })()
    await sleep(500); qc.reset(); await sleep(SECONDS * 1000)
    const oldCount = qc.n
    stop = true; await old

    // 2) worker novo
    const w = startWorker(ctx, { sweepEveryMs: sweepEvery, sweep: { ...defaultSweep, recentReceivedMs: 0 }, log: () => {} })
    while (w.state !== 'idle') await sleep(20)
    qc.reset(); await sleep(SECONDS * 1000)
    const newCount = qc.n
    await w.stop()

    console.log(JSON.stringify({ seconds: SECONDS, old_loop_queries: oldCount, old_per_minute: Math.round(oldCount / SECONDS * 60), new_worker_queries: newCount, new_state: 'idle' }))
  } finally {
    await db.end()
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`DROP DATABASE ${name} WITH (FORCE)`); await a.end()
  }
}
main().catch(e => { console.error('FALHOU', e); process.exit(1) })
