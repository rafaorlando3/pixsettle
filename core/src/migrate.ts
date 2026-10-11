import { readdirSync, readFileSync } from 'node:fs'
import { createPool, type Db } from './db.js'

/** Nomes das migrações de negócio, em ordem (só os arquivos .sql do diretório; identity/ e down/ ficam de fora). */
export function migrationFiles(dir = new URL('../migrations/', import.meta.url)): string[] {
  return readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
}

/**
 * Aplica as migrações pendentes, cada uma na sua transação.
 * v7.4 (X-1222): (1) cada TENTATIVA de migração soma 1 na sequência `schema_migration_attempts` antes de rodar (sequência não
 * é transacional: uma tentativa que falhou ou foi desfeita continua contada), então "tentativas = migrações" prova que
 * nenhum boot repetiu uma migração; (2) num banco com a identidade da produção dos afiliados, cada tabela criada por uma
 * migração ganha a guarda de escrita na MESMA transação que a criou (nunca existe sem guarda num banco preso).
 */
export async function migrate(db: Db, dir = new URL('../migrations/', import.meta.url)): Promise<string[]> {
  // registro e contador numa transação; num banco preso, o registro já nasce com a guarda (sem janela sem guarda)
  const pre = await db.connect()
  try {
    await pre.query('BEGIN')
    await pre.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    await pre.query('CREATE SEQUENCE IF NOT EXISTS schema_migration_attempts')
    if ((await pre.query(`SELECT to_regprocedure('public.instance_profile_guard_install()') IS NOT NULL AS g`)).rows[0].g) await pre.query('SELECT instance_profile_guard_install()')
    await pre.query('COMMIT')
  } catch (e) { await pre.query('ROLLBACK'); throw e } finally { pre.release() }
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map(r => r.name as string))
  const applied: string[] = []
  for (const f of migrationFiles(dir)) {
    if (done.has(f)) continue
    const client = await db.connect()
    try {
      await client.query(`SELECT nextval('schema_migration_attempts')`)
      await client.query('BEGIN')
      await client.query(readFileSync(new URL(f, dir), 'utf8'))
      if ((await client.query(`SELECT to_regprocedure('public.instance_profile_guard_install()') IS NOT NULL AS g`)).rows[0].g) {
        await client.query('SELECT instance_profile_guard_install()')
      }
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f])
      await client.query('COMMIT')
      applied.push(f)
    } catch (e) {
      await client.query('ROLLBACK')
      throw new Error(`migração ${f} falhou: ${(e as Error).message}`)
    } finally { client.release() }
  }
  return applied
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createPool()
  // v7.4: banco preso a um perfil (produção dos afiliados) só migra no boot da produção, sob a trava e com o perfil declarado.
  db.query(`SELECT to_regclass('public.instance_profile') IS NOT NULL AS t`)
    .then(async r => {
      if (r.rows[0].t && (await db.query('SELECT 1 FROM instance_profile')).rowCount) throw new Error('database_bound: banco preso a um perfil de instância; as migrações rodam só no boot da produção dos afiliados')
      return migrate(db)
    })
    .then(a => { console.log('aplicadas:', a); return db.end() })
    .catch(async e => { console.error(e.message); await db.end(); process.exit(1) })
}
