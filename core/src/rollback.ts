// Retorno de migração: aplica migrations/down/<nome>.down.sql numa transação e remove a linha de schema_migrations.
// Só desfaz a ÚLTIMA migração aplicada (ordem inversa, uma por vez), para o esquema nunca ficar com buraco.
// Falha inteira (ROLLBACK) com o motivo se o SQL de retorno não puder rodar (ex.: dados do piloto presentes).
import { readFileSync, existsSync } from 'node:fs'
import { createPool, type Db } from './db.js'

export async function lastApplied(db: Db): Promise<string | null> {
  const r = await db.query('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')
  return r.rows[0]?.name ?? null
}

export async function rollback(db: Db, name: string, dir = new URL('../migrations/down/', import.meta.url)): Promise<{ undone: string }> {
  const last = await lastApplied(db)
  if (last !== name) throw new Error(`só a última migração pode ser desfeita: última aplicada é ${last ?? 'nenhuma'}, pedida ${name}`)
  const file = new URL(name.replace(/\.sql$/, '.down.sql'), dir)
  if (!existsSync(file)) throw new Error(`sem SQL de retorno para ${name} (esperado ${file.pathname})`)
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(readFileSync(file, 'utf8'))
    await client.query('DELETE FROM schema_migrations WHERE name=$1', [name])
    await client.query('COMMIT')
    return { undone: name }
  } catch (e) {
    await client.query('ROLLBACK')
    throw new Error(`retorno de ${name} falhou e nada mudou: ${(e as Error).message}`)
  } finally { client.release() }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createPool()
  const name = process.argv[2]
  if (!name) { console.error('uso: rollback.ts <nome-da-migração.sql> (só a última aplicada)'); process.exit(2) }
  rollback(db, name).then(r => { console.log('desfeita:', r.undone); return db.end() }).catch(e => { console.error(e.message); process.exit(1) })
}
