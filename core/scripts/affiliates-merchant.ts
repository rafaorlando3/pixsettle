// Uso (produção): PIXSETTLE_PROFILE=affiliates_production DATABASE_URL=... \
//   npx tsx scripts/affiliates-merchant.ts --name "Equilibrium" --key-sha256 <64 hex> --pool 0xTESOURARIA [--id mer_...]
// O sha256 sai de: printf %s "$CHAVE" | sha256sum   (a chave nunca é argumento deste script nem aparece na saída).
import { createPool } from '../src/db.js'
import { migrate } from '../src/migrate.js'
import { provisionMerchant } from '../src/affiliates/merchant-provision.js'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
if (process.env.PIXSETTLE_PROFILE !== 'affiliates_production') { console.error('PIXSETTLE_PROFILE=affiliates_production obrigatório'); process.exit(1) }
const db = createPool(process.env.DATABASE_URL)
await migrate(db)
try {
  const r = await provisionMerchant(db, { id: arg('id'), name: arg('name') ?? '', apiKeySha256: (arg('key-sha256') ?? '').toLowerCase(), poolAddress: arg('pool') ?? '' })
  console.log(JSON.stringify({ ok: true, merchant_id: r.id, created: r.created, pool: arg('pool') }))
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: (e as Error).message })); process.exitCode = 1
} finally { await db.end() }
