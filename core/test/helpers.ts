import { randomUUID, createHash } from 'node:crypto'
import pg from 'pg'
import { createPool, type Db } from '../src/db.js'
import { migrate } from '../src/migrate.js'
import { defaultConfig, CrashError, type Ctx } from '../src/context.js'
import { SimulatedPixProvider } from '../src/providers/simulated.js'
import { FakeChain } from './fakes/fakeChain.js'
import { newId } from '../src/ids.js'
import { drain } from '../src/outbox.js'
import { ingestProviderEvent } from '../src/flows/events.js'

const ADMIN = process.env.TEST_DATABASE_ADMIN ?? 'postgres://pixsettle@localhost:5433/postgres?host=/tmp'

export async function freshDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  const name = 'pst_' + randomUUID().replace(/-/g, '').slice(0, 16)
  const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`); await admin.end()
  const db = createPool(ADMIN.replace('/postgres?', `/${name}?`))
  await migrate(db)
  return { db, drop: async () => { await db.end(); const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`DROP DATABASE ${name} WITH (FORCE)`); await a.end() } }
}

export async function setup() {
  const { db, drop } = await freshDb()
  const provider = new SimulatedPixProvider()
  const chain = new FakeChain()
  const crash = new Set<string>()
  const ctx: Ctx = {
    db, provider, chain, now: () => new Date(), cfg: defaultConfig({ reconcileMaxTries: 5 }),
    crashAt: p => { if (crash.has(p)) { crash.delete(p); throw new CrashError(p) } },
  }
  const merchantId = newId('mer')
  await db.query(`INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ($1,'Loja Teste',$2,'0x8ee643c15C603856A76d05020b5ccB0FceA425BF')`,
    [merchantId, createHash('sha256').update(randomUUID()).digest('hex')])
  return { ctx, db, provider, chain, crash, merchantId, drop }
}

/** Evento no formato do webhook do Asaas (sem dados do pagador). */
export const asaasEvent = (eventId: string, event: string, paymentId: string, status: string) =>
  ({ id: eventId, event, payment: { id: paymentId, status, billingType: 'PIX', customer: 'cus_NAO_GUARDAR', externalReference: 'x' } })

export async function deliver(ctx: Ctx, body: any) { return ingestProviderEvent(ctx, 'asaas', body) }

/** Simula o tempo passando: libera locks de jobs "mortos" e antecipa retries. */
export async function advanceTime(db: Db) {
  await db.query(`UPDATE outbox SET locked_until=NULL, available_at=now() WHERE done_at IS NULL`)
}

/** Roda a fila até estabilizar, minerando a cadeia falsa entre rodadas. Quedas simuladas são engolidas. */
export async function settleAll(ctx: Ctx, chain: FakeChain, rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    try { await drain(ctx) } catch (e) { if (!(e instanceof CrashError)) throw e }
    chain.mine()
    await advanceTime(ctx.db)
    const pending = (await ctx.db.query(`SELECT count(*)::int AS n FROM outbox WHERE done_at IS NULL`)).rows[0].n
    if (pending === 0) break
  }
}

export async function counts(db: Db, orderId: string) {
  const q = (s: string) => db.query(s, [orderId]).then(r => r.rows)
  return {
    order: (await q(`SELECT status, hold_reason FROM orders WHERE id=$1`))[0],
    settlements: await q(`SELECT id, status, hold_reason FROM settlements WHERE order_id=$1`),
    attempts: await q(`SELECT a.status, a.nonce, a.attempt_no FROM settlement_attempts a JOIN settlements s ON s.id=a.settlement_id WHERE s.order_id=$1 ORDER BY attempt_no`),
  }
}
