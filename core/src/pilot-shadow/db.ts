import { createHash } from 'node:crypto'
import { withTx, type Db, type Tx } from '../db.js'
import { authorizedMaterial, instantUtc, nextCheckpoint, signReceipt, verifyShadowReceipt } from './guard.js'
import type { TrustedShadowContext, ValidatedTrio, ShadowBatchReceipt, ShadowIngestResult } from './types.js'
export class ShadowEventConflict extends Error {
  constructor(readonly codes: string[] = ['l1:conflito'], public receipt: ShadowBatchReceipt | null = null) { super('shadow_event_conflict'); this.name = 'ShadowEventConflict' }
}
export class ShadowKeyPeriodClosed extends Error { constructor() { super('shadow_key_period_closed'); this.name = 'ShadowKeyPeriodClosed' } }
export class ShadowReceiptInvalid extends Error { constructor() { super('shadow_receipt_invalid'); this.name = 'ShadowReceiptInvalid' } }
export class ShadowBatchBindingConflict extends Error { constructor() { super('shadow_batch_binding_conflict'); this.name = 'ShadowBatchBindingConflict' } }
export function shadowStreamLockKey(origin: string, store: string): string { return createHash('sha256').update('pilot-shadow-stream\0' + origin + '\0' + store).digest().readBigInt64BE(0).toString() }
async function priorReceipt(tx: Tx, v: ValidatedTrio, trusted: TrustedShadowContext): Promise<ShadowBatchReceipt | null> {
  const prior = (await tx.query('SELECT trio_sha256,receipt FROM pilot_shadow_batches WHERE origin=$1 AND store=$2 AND lote_sha256=$3', [trusted.origin, trusted.store, v.binding.lote_sha256])).rows[0]
  if (!prior) return null
  if (prior.trio_sha256 !== v.binding.trio_sha256) throw new ShadowBatchBindingConflict()
  if (!verifyShadowReceipt(prior.receipt, v, trusted)) throw new ShadowReceiptInvalid()
  return prior.receipt
}
async function buildReceipt(tx: Tx, v: ValidatedTrio, trusted: TrustedShadowContext, key: Buffer, accepted: number, duplicates: number, checkpoint: string | null, codes: string[]): Promise<ShadowBatchReceipt> {
  const a = v.attestation
  const now = (await tx.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS at")).rows[0].at as string
  const issuer = trusted.keyring[a.key_id], time = instantUtc(now), from = issuer && instantUtc(issuer.valid_from), until = issuer && instantUtc(issuer.valid_until)
  if (time === null || from == null || until == null || !(from <= time && time < until)) throw new ShadowKeyPeriodClosed()
  const receipt: ShadowBatchReceipt = { ...v.binding, schema: 'pixsettle-shadow-receipt/1', mode: 'shadow', bank_settlement: false,
    origin: trusted.origin, store: trusted.store, key_id: a.key_id, count: a.count, result: codes.length ? 'rejected' : 'accepted', codes,
    accepted, duplicates, rejected: codes.length ? a.count : 0, first_cursor: a.first_cursor, last_cursor: a.last_cursor, checkpoint, committed_at: now, sig: '' }
  receipt.sig = signReceipt(receipt, key); return receipt
}
async function saveReceipt(tx: Tx, v: ValidatedTrio, r: ShadowBatchReceipt): Promise<void> {
  const a = v.attestation
  await tx.query(`INSERT INTO pilot_shadow_batches(origin,store,lote_sha256,trio_sha256,atestado_sha256,pronto_sha256,key_id,event_count,overlap_count,first_cursor,last_cursor,totals_minor,result,codes,accepted,duplicates,rejected,checkpoint,receipt,committed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19::jsonb,$20)`,
  [r.origin,r.store,r.lote_sha256,r.trio_sha256,r.atestado_sha256,r.pronto_sha256,r.key_id,r.count,a.overlap_count,a.first_cursor,a.last_cursor,JSON.stringify(a.totals_minor),r.result,r.codes,r.accepted,r.duplicates,r.rejected,r.checkpoint,JSON.stringify(r),r.committed_at])
}
/** A rejection is saved only after acceptance has fully rolled back, with no raw line or checkpoint advance. */
async function saveRejection(db: Db, v: ValidatedTrio, trusted: TrustedShadowContext, codes: string[]): Promise<ShadowBatchReceipt> {
  const { key } = authorizedMaterial(v, trusted)
  return withTx(db, async tx => {
    await tx.query('SET LOCAL synchronous_commit = on')
    await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [shadowStreamLockKey(trusted.origin, trusted.store)])
    const prior = await priorReceipt(tx, v, trusted); if (prior) return prior
    const checkpoint = (await tx.query('SELECT checkpoint FROM pilot_shadow_streams WHERE origin=$1 AND store=$2', [trusted.origin, trusted.store])).rows[0]?.checkpoint ?? null
    const receipt = await buildReceipt(tx, v, trusted, key, 0, 0, checkpoint, codes)
    await saveReceipt(tx, v, receipt); return receipt
  })
}
/** One connection/transaction: stream lock before any read/write, exact line bytes, durable receipt+checkpoint. */
export async function ingestShadowBatch(db: Db, validated: ValidatedTrio, trusted: TrustedShadowContext): Promise<ShadowIngestResult> {
  // Scope/key configuration is captured synchronously, before any await.
  trusted = { origin: trusted.origin, store: trusted.store, keyring: Object.fromEntries(Object.entries(trusted.keyring).map(([kid, entry]) => [kid, { ...entry, stores: [...entry.stores] }])), secrets: { ...trusted.secrets } }
  const { key, lineHashes } = authorizedMaterial(validated, trusted), a = validated.attestation
  try {
    return await withTx(db, async tx => {
      await tx.query('SET LOCAL synchronous_commit = on')
      const lock = await tx.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS ok', [shadowStreamLockKey(trusted.origin, trusted.store)])
      if (!lock.rows[0].ok) return { busy: true, replayed: false, accepted: 0, duplicates: 0, checkpoint: null, receipt: null }
      const prior = await priorReceipt(tx, validated, trusted)
      if (prior) {
        if (prior.result === 'rejected') throw new ShadowEventConflict(prior.codes, prior)
        return { busy: false, replayed: true, accepted: 0, duplicates: a.count, checkpoint: prior.checkpoint, receipt: prior }
      }
      await tx.query('INSERT INTO pilot_shadow_streams(origin,store) VALUES($1,$2) ON CONFLICT DO NOTHING', [trusted.origin, trusted.store])
      const saved = (await tx.query('SELECT checkpoint FROM pilot_shadow_streams WHERE origin=$1 AND store=$2 FOR UPDATE', [trusted.origin, trusted.store])).rows[0].checkpoint as string | null
      let accepted = 0, duplicates = 0
      const totals: Record<string, number> = {}
      for (const [index, event] of validated.events.entries()) {
        totals[event.type] = (totals[event.type] ?? 0) + event.amount_minor
        const lineHash = lineHashes[index]!
        const inserted = await tx.query(`INSERT INTO pilot_shadow_events(origin,store,event_id,cursor,event_type,event_at,amount_minor,currency,order_ref,payment_ref,refers_to,party_ref,expires_at,payer_self_identified,line_sha256,first_batch)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(origin,store,event_id) DO NOTHING RETURNING event_id`,
        [trusted.origin,trusted.store,event.event_id,event.cursor,event.type,event.at,event.amount_minor,event.currency,event.order_ref ?? null,event.payment_ref ?? null,event.refers_to ?? null,event.party_ref ?? null,event.expires_at ?? null,event.payer_self_identified ?? null,lineHash,validated.binding.lote_sha256])
        if (inserted.rowCount) accepted++
        else {
          const stored = (await tx.query('SELECT line_sha256 FROM pilot_shadow_events WHERE origin=$1 AND store=$2 AND event_id=$3', [trusted.origin,trusted.store,event.event_id])).rows[0]
          if (!stored || stored.line_sha256 !== lineHash) throw new ShadowEventConflict([`l${index + 1}:conflito`])
          duplicates++
        }
      }
      if (accepted + duplicates !== a.count || Object.keys(totals).length !== Object.keys(a.totals_minor).length || Object.entries(totals).some(([type, n]) => a.totals_minor[type as keyof typeof a.totals_minor] !== n)) throw new Error('shadow_batch_invariant')
      const checkpoint = nextCheckpoint(saved, a.last_cursor)
      const receipt = await buildReceipt(tx, validated, trusted, key, accepted, duplicates, checkpoint, [])
      await tx.query('UPDATE pilot_shadow_streams SET checkpoint=$3,updated_at=now() WHERE origin=$1 AND store=$2', [trusted.origin,trusted.store,checkpoint])
      await saveReceipt(tx, validated, receipt)
      return { busy: false, replayed: false, accepted, duplicates, checkpoint, receipt }
    })
  } catch (e) {
    if (e instanceof ShadowEventConflict && !e.receipt) e.receipt = await saveRejection(db, validated, trusted, e.codes)
    throw e
  }
}
