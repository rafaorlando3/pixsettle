// Cadastro do lojista na instância de PRODUÇÃO dos afiliados, sem a chave em texto: recebe só o sha256 da chave do lojista
// (a chave nasce fora daqui, vai para o ambiente privado do Hub e nunca passa por este processo, log ou terminal compartilhado).
// Idempotente pelo id: rodar de novo atualiza nome, hash e pool. A pool da custódia `pool` é a própria tesouraria (endereço público).
import { ulid } from 'ulid'
import type { Db } from '../db.js'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const MERCHANT_ID = /^mer_[0-9A-Za-z]{6,40}$/

export type ProvisionInput = { id?: string; name: string; apiKeySha256: string; poolAddress: string }

export async function provisionMerchant(db: Db, input: ProvisionInput): Promise<{ id: string; created: boolean }> {
  const name = input.name.trim()
  if (name.length < 2 || name.length > 80) throw new Error('invalid_name: nome do lojista com 2 a 80 caracteres')
  if (!SHA256.test(input.apiKeySha256)) throw new Error('invalid_key_hash: informe o sha256 (64 hexadecimais minúsculos) da chave, nunca a chave')
  if (!ADDRESS.test(input.poolAddress) || /^0x0{40}$/i.test(input.poolAddress)) throw new Error('invalid_pool_address: endereço público da tesouraria (0x + 40 hexadecimais)')
  const id = input.id ?? `mer_${ulid()}`
  if (!MERCHANT_ID.test(id)) throw new Error('invalid_merchant_id: id no formato mer_...')
  const clash = (await db.query(`SELECT id FROM merchants WHERE api_key_hash=$1 AND id<>$2`, [input.apiKeySha256, id])).rows[0]
  if (clash) throw new Error('key_hash_in_use: esse hash de chave já pertence a outro lojista')
  const existed = (await db.query(`SELECT 1 FROM merchants WHERE id=$1`, [id])).rows.length > 0
  await db.query(
    `INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, api_key_hash=EXCLUDED.api_key_hash, payout_address=EXCLUDED.payout_address`,
    [id, name, input.apiKeySha256, input.poolAddress])
  await db.query(
    `INSERT INTO affiliate_policies (merchant_id, pool_address) VALUES ($1,$2)
     ON CONFLICT (merchant_id) DO UPDATE SET pool_address=EXCLUDED.pool_address`,
    [id, input.poolAddress])
  return { id, created: !existed }
}
