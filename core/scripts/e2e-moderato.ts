// Ensaio ponta a ponta REAL: core + processo de assinatura + Tempo Moderato (testnet) + Pix SIMULADO.
// Uso: DATABASE_URL=... E2E_KEYS=<arquivo local com {treasury, merchant}> npx tsx scripts/e2e-moderato.ts
import { readFileSync } from 'node:fs'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { createPool } from '../src/db.js'
import { migrate } from '../src/migrate.js'
import { defaultConfig, type Ctx } from '../src/context.js'
import { SimulatedPixProvider } from '../src/providers/simulated.js'
import { HttpChainGateway } from '../src/chain/gateway.js'
import { buildApp } from '../src/app.js'
import { runOnce } from '../src/outbox.js'
import { buildServer } from '../../settlement/src/server.js'
import { verifyEnvelope } from '../../settlement/src/receipt.js'
import { newId } from '../src/ids.js'

const keys = JSON.parse(readFileSync(process.env.E2E_KEYS!, 'utf8'))
const issuerKey = generatePrivateKey() // emissor de recibos só desta rodada
const issuer = privateKeyToAccount(issuerKey).address
const treasury = privateKeyToAccount(keys.treasury).address
const merchantAddr = privateKeyToAccount(keys.merchant).address
const secret = randomBytes(32).toString('hex')
const TOKEN = '0x20c0000000000000000000000000000000000000'

const srv = buildServer({ port: 7401, hmacSecret: secret, treasuryKey: keys.treasury, issuerKey, token: TOKEN })
await new Promise<void>(r => srv.listen(7401, '127.0.0.1', r))
const db = createPool(); await migrate(db)
const ctx: Ctx = { db, provider: new SimulatedPixProvider(), chain: new HttpChainGateway('http://127.0.0.1:7401', secret, 42431, TOKEN, treasury), now: () => new Date(), cfg: defaultConfig({ issuer: { id: 'pixsettle-e2e', address: issuer } }) }
const app = buildApp(ctx, { asaasWebhookToken: 'tok', diagnosticsToken: 'diag' })
const apiKey = 'sk_' + randomUUID(), merchantId = newId('mer')
await db.query(`INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ($1,'Loja E2E',$2,$3)`, [merchantId, createHash('sha256').update(apiKey).digest('hex'), merchantAddr])

const t0 = Date.now()
const created = (await app.inject({ method: 'POST', url: '/api/v1/orders', headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': randomUUID() }, payload: { external_ref: 'e2e-' + Date.now(), amount: { amount: '10090', currency: 'BRL' }, description: 'ensaio' } })).json()
console.log('pedido', created.order_id, 'status', created.status)
const ch = (await db.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [created.order_id])).rows[0]
;(ctx.provider as SimulatedPixProvider).pay(ch.provider_payment_id)
for (let i = 0; i < 3; i++) // o mesmo aviso 3 vezes, como o Asaas pode mandar
  await app.inject({ method: 'POST', url: '/webhooks/asaas', headers: { 'asaas-access-token': 'tok' }, payload: { id: 'evt_e2e_' + created.order_id, event: 'PAYMENT_RECEIVED', payment: { id: ch.provider_payment_id, status: 'RECEIVED' } } })

let order: any
for (let i = 0; i < 120; i++) {
  await db.query(`UPDATE outbox SET available_at=now() WHERE done_at IS NULL AND available_at > now() + interval '3 seconds'`)
  while (await runOnce(ctx)) { /* esvazia */ }
  order = (await app.inject({ method: 'GET', url: `/api/v1/orders/${created.order_id}`, headers: { authorization: `Bearer ${apiKey}` } })).json()
  if (order.status === 'settled' && order.receipt_id) break
  await new Promise(r => setTimeout(r, 1000))
}
console.log('status final', order.status, 'em', ((Date.now() - t0) / 1000).toFixed(1), 's')
console.log('tx', order.settlement?.tx_hash, 'tentativa', order.settlement?.attempt_status)
const env = (await app.inject({ method: 'GET', url: `/r/${order.receipt_id}` })).json()
console.log('recibo', order.receipt_id, 'verificação:', JSON.stringify(await verifyEnvelope(env, [issuer])))
console.log('valores (pathUSD, 6 casas):', env.payload.amounts)
console.log('transições:', order.timeline.map((t: any) => `${t.entity}:${t.from_state ?? '-'}->${t.to_state}`).join(' | '))
srv.close(); await db.end()
