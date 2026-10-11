// Uso (produção): com o MESMO ambiente da produção (PIXSETTLE_PROFILE, CHAIN_ID, TREASURY_ADDRESS, TOKEN, AFFILIATE_QUOTE_SOURCE,
// PRODUCTION_REHEARSAL, DATABASE_URL), DEPOIS do primeiro boot da produção:
//   npx tsx scripts/affiliates-merchant.ts --name "Equilibrium" --key-sha256 <64 hex> --pool 0xTESOURARIA [--id mer_...]
// O sha256 sai de: printf %s "$CHAVE" | sha256sum   (a chave nunca é argumento deste script nem aparece na saída).
// v7.4 (X-1222): a ferramenta não migra e não prende banco. Exige o banco já preso ao perfil deste ambiente, com a identidade
// atual e sem migração pendente (senão recusa com o motivo), e escreve declarando o perfil (guarda de escrita do banco).
// Não lê chave privada: o perfil sai só das variáveis públicas (mesma fase 1 do launcher).
import { createPool } from '../src/db.js'
import { migrationFiles } from '../src/migrate.js'
import { provisionMerchant } from '../src/affiliates/merchant-provision.js'
import { assertDatabaseBoundTo, profileFingerprint } from '../src/affiliates/instance-profile.js'
import { publicLaunchPlan } from './start-production.js'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
let profile
try { profile = publicLaunchPlan(process.env).profile } catch (e) { console.error(JSON.stringify({ ok: false, error: (e as Error).message })); process.exit(1) }
const db = createPool(process.env.DATABASE_URL, { profileFingerprint: profileFingerprint(profile), applicationName: 'pixsettle-affiliates-merchant', max: 2 })
try {
  await assertDatabaseBoundTo(db, profile, migrationFiles())
  const r = await provisionMerchant(db, { id: arg('id'), name: arg('name') ?? '', apiKeySha256: (arg('key-sha256') ?? '').toLowerCase(), poolAddress: arg('pool') ?? '' })
  console.log(JSON.stringify({ ok: true, merchant_id: r.id, created: r.created, pool: arg('pool') }))
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: (e as Error).message })); process.exitCode = 1
} finally { await db.end() }
