// v7.3 (X-1212): adoção EXPLÍCITA de um banco legado (dado financeiro, sem perfil) pela produção dos afiliados.
// Nunca roda sozinho no boot. Valida o dado legado contra o perfil pedido e deixa auditoria (quem, por quê, contagens).
// Uso (DATABASE_URL no ambiente):
//   npx tsx core/scripts/affiliates-adopt-profile.ts --mode production|rehearsal --chain 4217 --token 0x20c0... \
//     --treasury 0x... --quote binance_usdtbrl|simulated --operator nome --note "motivo da adoção" --confirm-legacy
import { createPool } from '../src/db.js'
import { adoptLegacyDatabase, withBootLock, type InstanceProfile } from '../src/affiliates/instance-profile.js'

export function parseAdoptArgs(argv: string[]): { profile: InstanceProfile; operator: string; note: string } {
  const get = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  if (!argv.includes('--confirm-legacy')) throw new Error('confirm_missing: a adoção de banco legado exige --confirm-legacy')
  const mode = get('mode'), quote = get('quote')
  if (mode !== 'production' && mode !== 'rehearsal') throw new Error('invalid_mode: --mode production ou rehearsal')
  if (quote !== 'binance_usdtbrl' && quote !== 'simulated') throw new Error('invalid_quote: --quote binance_usdtbrl ou simulated')
  if (mode === 'production' && quote !== 'binance_usdtbrl') throw new Error('invalid_quote: produção só com binance_usdtbrl')
  const chainId = Number(get('chain'))
  const token = String(get('token') ?? ''), treasury = String(get('treasury') ?? '')
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('invalid_chain: --chain inteiro positivo')
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(treasury)) throw new Error('invalid_address: --token e --treasury com 0x + 40 hexadecimais')
  return { profile: { mode, chainId, token, treasury, quoteSource: quote }, operator: String(get('operator') ?? ''), note: String(get('note') ?? '') }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let args: ReturnType<typeof parseAdoptArgs>
  try { args = parseAdoptArgs(process.argv.slice(2)) } catch (e) { console.error((e as Error).message); process.exit(2) }
  const db = createPool()
  withBootLock(db, () => adoptLegacyDatabase(db, args.profile, { operator: args.operator, note: args.note }))
    .then(r => { console.log(`adotado: ${r.mode} na rede ${r.chainId}, cotação ${r.quoteSource}; contagens ${JSON.stringify(r.counts)}`); return db.end() })
    .catch(async e => { console.error((e as Error).message); await db.end(); process.exit(1) })
}
