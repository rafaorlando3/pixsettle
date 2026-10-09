// Vetores públicos do produtor (tarefa 348, k_commfixture348): os dois lotes PHP reproduzidos byte a byte no receptor TS,
// ingeridos em cadeia, aplicados ao domínio e liquidados na cadeia falsa. As chaves abaixo são FIXTURE pública, não credenciais.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { setup, settleAll } from './helpers.js'
import { validateBatch, type CommissionKey } from '../src/affiliates/batches/batch.js'
import { ingestCommissionBatch, applyCommissionRevisions } from '../src/affiliates/batches/ingest.js'
import { SimulatedQuoteSource } from '../src/affiliates/quotes.js'
import { configureAffiliateJournal } from '../src/affiliates/journal.js'
import { signReceipt, verifyEnvelope } from '../../settlement/src/receipt.js'
import { privateKeyToAccount } from 'viem/accounts'

const ISSUER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const // chave pública de TESTE (Hardhat #0)
const ISSUER = privateKeyToAccount(ISSUER_KEY).address

const DIR = new URL('./fixtures/vectors-348/', import.meta.url)
const B1 = 'COMMISSION-cbbaf4e65ec0399b2b3682b6ed1edd80f5f7aef143d929ac85e00537ca57fa51.json'
const B2 = 'COMMISSION-f5a4fc15cc4cf8db4a448fe47461744e2db99a5af1c35723fa8377c86ba2e941.json'
const KEY: CommissionKey = { key_id: 'k_commfixture348', scope: 'commission', origin: 'src_codex212', stores: ['store_1'], secret: Buffer.from('PUBLIC_FIXTURE_ONLY_348_BATCH_HMAC_20261009', 'ascii') }
const RECEIPT_KEY = Buffer.from('receipt-key-test-0123456789abcdef0123456789')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const drops: Array<() => Promise<void>> = []
afterEach(async () => { for (const d of drops.splice(0)) await d() })

describe('vetores do produtor 348 no receptor TS', () => {
  it('valida os dois lotes byte a byte (sha, assinatura, identidade dos eventos, ordem) e o JSONL de eventos', () => {
    const raw1 = readFileSync(new URL(B1, DIR)), raw2 = readFileSync(new URL(B2, DIR))
    const manifest = JSON.parse(readFileSync(new URL('VECTOR-MANIFEST.json', DIR), 'utf8'))
    expect(sha(raw1)).toBe(manifest.batches[0].sha256); expect(sha(raw2)).toBe(manifest.batches[1].sha256)
    const v1 = validateBatch(raw1, 'k_commfixture348', [KEY]), v2 = validateBatch(raw2, 'k_commfixture348', [KEY])
    expect(v1.batch_sha256).toBe(manifest.batches[0].sha256); expect(v1.batch.events_sha256).toBe(manifest.batches[0].events_sha256)
    expect(v2.batch.previous_batch_sha256).toBe(v1.batch_sha256); expect(v1.batch.count + v2.batch.count).toBe(manifest.event_count)
    const jsonl = readFileSync(new URL('events.jsonl', DIR))
    expect(sha(jsonl)).toBe(manifest.files[0].sha256)
    const lines = jsonl.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(lines.map(e => e.event_id).sort()).toEqual([...v1.batch.events, ...v2.batch.events].map(e => e.event_id).sort())
    expect(() => validateBatch(raw1, 'k_other', [KEY])).toThrow(/commission_key_invalid/)
    expect(() => validateBatch(raw1, 'k_commfixture348', [{ ...KEY, secret: Buffer.from('x'.repeat(43)) }])).toThrow(/commission_signature_invalid/)
    expect(() => validateBatch(Buffer.concat([raw1.subarray(0, raw1.length - 1), Buffer.from(' \n')]), 'k_commfixture348', [KEY])).toThrow(/commission_batch_not_canonical/)
  })

  it('ingere em cadeia, repete sem duplicar, aplica ao domínio (pendente, liberada, transição) e liquida com um memo por comissão', async () => {
    const e = await setup(); drops.push(e.drop)
    e.ctx.affiliates = { quotes: new SimulatedQuoteSource(52000n), settle: true, lockTtlMs: 120_000, streams: { 'src_codex212|store_1': e.merchantId } }
    configureAffiliateJournal({ settle: true })
    e.ctx.cfg.issuer = { id: 'pixsettle-test', address: ISSUER }; e.chain.signReceipt = (payload: any) => signReceipt(payload, ISSUER_KEY)
    await e.db.query(`INSERT INTO affiliate_policies (merchant_id, pool_address) VALUES ($1, '0x00000000000000000000000000000000000000A1')`, [e.merchantId])
    const raw1 = readFileSync(new URL(B1, DIR)), raw2 = readFileSync(new URL(B2, DIR))
    await expect(ingestCommissionBatch(e.db, validateBatch(raw2, 'k_commfixture348', [KEY]), RECEIPT_KEY)).rejects.toMatchObject({ code: 'commission_chain_gap' }) // lote 2 antes do 1
    const r1 = await ingestCommissionBatch(e.db, validateBatch(raw1, 'k_commfixture348', [KEY]), RECEIPT_KEY)
    expect(r1).toMatchObject({ replayed: false, receipt: { result: 'accepted', count: 2, accepted: 2, previous_batch_sha256: null, key_id: 'k_commfixture348' } })
    expect(await ingestCommissionBatch(e.db, validateBatch(raw1, 'k_commfixture348', [KEY]), RECEIPT_KEY)).toMatchObject({ replayed: true, receipt: r1.receipt })
    const r2 = await ingestCommissionBatch(e.db, validateBatch(raw2, 'k_commfixture348', [KEY]), RECEIPT_KEY)
    expect(r2.receipt).toMatchObject({ accepted: 1, previous_batch_sha256: r1.receipt.batch_sha256 })
    expect(await applyCommissionRevisions(e.ctx, 'src_codex212', 'store_1')).toEqual({ applied: 3, failed: 0, retry: false })
    const dom = (await e.db.query(`SELECT source_event_id AS src, status, amount_minor::text AS brl, usd_units::text AS usd, quote_mode, custody FROM affiliate_commissions ORDER BY source_event_id`)).rows
    expect(dom).toEqual([
      { src: 'com_1c2d52a2503e38b519c84fbc42d8a913', status: 'settling', brl: '5678', usd: '10919230', quote_mode: 'backfill', custody: 'pool' }, // 56,78 / 5,2000 = 10,919230
      { src: 'com_d97f8cb6aad3dbc9ab4f1af61db7fc46', status: 'settling', brl: '1234', usd: '2373076', quote_mode: 'backfill', custody: 'pool' },  // 12,34 / 5,2000 = 2,373076
    ])
    const apps = (await e.db.query(`SELECT result FROM affiliate_commission_applications`)).rows.map(a => a.result).sort()
    expect(apps).toEqual(['created', 'created_released', 'released'])
    expect(await applyCommissionRevisions(e.ctx, 'src_codex212', 'store_1')).toEqual({ applied: 0, failed: 0, retry: false }) // idempotente
    await settleAll(e.ctx, e.chain)
    expect((await e.db.query(`SELECT count(*)::int AS n FROM affiliate_commissions WHERE status='settled'`)).rows[0].n).toBe(2)
    expect(e.chain.mined.length).toBe(2); expect(e.chain.transfersByMemo.size).toBe(2)
    const receipts = (await e.db.query(`SELECT envelope FROM affiliate_receipts`)).rows
    expect(receipts.length).toBe(2)
    for (const r of receipts) { expect(await verifyEnvelope(r.envelope, [ISSUER])).toEqual({ ok: true, recovered: ISSUER }); expect(r.envelope.payload.commission.quote.mode).toBe('backfill'); expect(JSON.stringify(r.envelope)).not.toContain('ord_') }
    const agg = (await e.db.query(`SELECT count(*)::int AS n FROM affiliate_beneficiaries`)).rows[0].n
    expect(agg).toBe(2)
  })
})
