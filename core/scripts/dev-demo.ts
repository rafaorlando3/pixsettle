// Sobe a demo local: processo de assinatura + core, com chaves de TESTNET de um arquivo local.
// Uso: DATABASE_URL=... E2E_KEYS=<arquivo {treasury, merchant, issuer?}> npx tsx scripts/dev-demo.ts
// Em produção são dois processos separados (settlement/src/server.ts e core/src/server.ts).
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { buildServer } from '../../settlement/src/server.js'
import { startCore } from '../src/server.js'

const keys = JSON.parse(readFileSync(process.env.E2E_KEYS!, 'utf8'))
const issuerKey = keys.issuer ?? generatePrivateKey()
const secret = randomBytes(32).toString('hex')
const TOKEN = '0x20c0000000000000000000000000000000000000'
const srv = buildServer({ port: 7401, hmacSecret: secret, treasuryKey: keys.treasury, issuerKey, token: TOKEN })
await new Promise<void>(r => srv.listen(7401, '127.0.0.1', r))
const core = await startCore({
  SWEEP_INTERVAL_MS: '20000', ...process.env, DEMO_MODE: '1', PORT: process.env.PORT ?? '8080', HOST: process.env.HOST ?? '127.0.0.1',
  SETTLEMENT_HMAC_SECRET: secret, TREASURY_ADDRESS: privateKeyToAccount(keys.treasury).address,
  ISSUER_ADDRESS: privateKeyToAccount(issuerKey).address, DEMO_MERCHANT_ADDRESS: privateKeyToAccount(keys.merchant).address,
  ASAAS_WEBHOOK_TOKEN: process.env.ASAAS_WEBHOOK_TOKEN ?? randomBytes(16).toString('hex'),
  DIAGNOSTICS_TOKEN: process.env.DIAGNOSTICS_TOKEN ?? randomBytes(16).toString('hex'),
})
console.log(`demo em ${core.url}/demo`)
const stop = async () => { await core.stop(); srv.close(); process.exit(0) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
