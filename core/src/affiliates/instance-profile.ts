// v7.3 (10/10/2026): vínculo do banco com o perfil da instância de produção dos afiliados. No primeiro boot a instância
// grava (modo, rede, token, tesouraria); nos seguintes confere e recusa se mudou. Fecha o risco aberto na v7.2: um ensaio
// com cotação simulada apontado para o banco da produção (ou o contrário) deixaria comissões com preço inventado no banco
// real. Banco com pedidos (dados da demo: a produção nunca grava `orders`) não é reivindicado.
import { withTx, type Db } from '../db.js'

export type InstanceMode = 'production' | 'rehearsal'
export type InstanceProfile = { mode: InstanceMode; chainId: number; token: string; treasury: string }
export type ClaimedProfile = InstanceProfile & { claimedAt: string; claimedNow: boolean }

export class InstanceProfileError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`) }
}

const describe = (p: { mode: string; chainId: number; treasury: string }) => `${p.mode} na rede ${p.chainId} com a tesouraria ${p.treasury}`

/** Grava o perfil no primeiro boot ou confere o gravado. Serializado por trava da tabela: dois boots ao mesmo tempo não se cruzam. */
export async function claimDatabaseProfile(db: Db, p: InstanceProfile): Promise<ClaimedProfile> {
  const want = { mode: p.mode, chainId: p.chainId, token: p.token.toLowerCase(), treasury: p.treasury.toLowerCase() }
  return withTx(db, async tx => {
    await tx.query('LOCK TABLE instance_profile IN SHARE ROW EXCLUSIVE MODE')
    const row = (await tx.query('SELECT mode, chain_id, token, treasury, claimed_at FROM instance_profile WHERE id = 1')).rows[0]
    if (!row) {
      const demo = (await tx.query('SELECT EXISTS (SELECT 1 FROM orders) AS has')).rows[0].has
      if (demo) throw new InstanceProfileError('database_has_demo_data', 'o banco tem pedidos (dados da demo); a produção dos afiliados não usa esse banco')
      const ins = (await tx.query('INSERT INTO instance_profile (id, mode, chain_id, token, treasury) VALUES (1, $1, $2, $3, $4) RETURNING claimed_at',
        [want.mode, want.chainId, want.token, want.treasury])).rows[0]
      return { ...want, claimedAt: new Date(ins.claimed_at).toISOString(), claimedNow: true }
    }
    const have = { mode: row.mode as InstanceMode, chainId: Number(row.chain_id), token: String(row.token), treasury: String(row.treasury) }
    if (have.mode !== want.mode || have.chainId !== want.chainId || have.token !== want.token || have.treasury !== want.treasury) {
      throw new InstanceProfileError('database_profile_mismatch', `banco preso a ${describe(have)} (token ${have.token}); esta instância é ${describe(want)} (token ${want.token}). Use o banco certo; trocar o vínculo é gesto manual registrado`)
    }
    return { ...have, claimedAt: new Date(row.claimed_at).toISOString(), claimedNow: false }
  })
}
