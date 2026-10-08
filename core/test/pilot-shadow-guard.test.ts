import { describe, it, expect } from 'vitest'
import { validateTrio, verifyShadowReceipt, parseContractJson, validateFeed, parseKeyring, MAX_ATT_BYTES, MAX_PRONTO_BYTES } from '../src/pilot-shadow/guard.js'
import { event, trio, trusted, checked } from './pilot-shadow-fixtures.js'
import { ingestShadowBatch } from '../src/pilot-shadow/db.js'
import type { Db } from '../src/db.js'
describe('E1 1.3 trusted trio guard', () => {
  it('requires exact trio bytes and fixed safe filenames; never echoes private field names', () => {
    const input = trio(); expect(validateTrio(input, trusted()).ok).toBe(true)
    expect(validateTrio({ ...input, atestado: Buffer.concat([input.atestado, Buffer.from(' ')]) }, trusted())).toMatchObject({ ok: false, errors: ['pronto:atestado_sha256'] })
    expect(validateTrio({ ...input, lote: Buffer.concat([input.lote, Buffer.from(' ')]) }, trusted()).ok).toBe(false)
    for (const prontoName of ['QUARENTENA-test.json', 'PRONTO-test.json.tmp', '../PRONTO-test.json', 'PRONTO-test.parcial']) expect(validateTrio({ ...input, prontoName }, trusted())).toMatchObject({ ok: false, errors: ['trio:names'] })
    const secretName = 'cpf_12345678900'; const bad = trio([{ ...event(1), [secretName]: 'private' } as any])
    const r = validateTrio(bad, trusted()); expect(r).toMatchObject({ ok: false, exitCode: 1 }); expect(JSON.stringify(r)).not.toContain(secretName); expect(JSON.stringify(r)).not.toContain('private')
  })
  it('rejects lexical float/exponent integers, malformed calendars, offsets and oversized files', () => {
    const ctx = trusted(), input = trio(); const a = parseContractJson(input.atestado)
    const ring = parseKeyring(Buffer.from(JSON.stringify(ctx.keyring)), ctx.secrets)
    for (const token of ['1500.0', '15e2', 'true', '0', '-1', '1000000000001']) expect(validateFeed(Buffer.from(input.lote.toString().replace('"amount_minor":1500', '"amount_minor":' + token)), a, ring, [ctx.origin, ctx.store])[0]).toContain('l1:amount_minor')
    for (const at of ['2026-02-30T13:00:00Z', '2026-10-06T13:00:00-03:00', '2026-10-06T13:00:00.5Z']) expect(validateTrio(trio([event(1, at)]), ctx).ok).toBe(false)
    expect(validateTrio({ ...input, atestado: Buffer.alloc(MAX_ATT_BYTES + 1) }, ctx)).toMatchObject({ ok: false, errors: ['trio:file_too_large'] })
    expect(validateTrio({ ...input, pronto: Buffer.alloc(MAX_PRONTO_BYTES + 1) }, ctx)).toMatchObject({ ok: false, errors: ['trio:file_too_large'] })
  })
  it('fails closed on missing/revoked/expired/wrong-scope/inline-secret keys and forged signatures', () => {
    const input = trio()
    for (const ctx of [trusted('src_2'), trusted('src_1', 'store_2'), { ...trusted(), secrets: {} }, { ...trusted(), secrets: { SHADOW_TEST_SECRET: 'b'.repeat(40) } }]) expect(validateTrio(input, ctx).ok).toBe(false)
    for (const change of [{ revoked: true }, { valid_until: '2026-10-07T03:00:00Z' }, { origin: 'src_2' }, { stores: ['store_2'] }, { key: 'inline-forbidden' }, { env: ['INVALID'] }]) {
      const ctx = trusted(); Object.assign(ctx.keyring.k_test1!, change); expect(validateTrio(input, ctx).ok).toBe(false)
    }
  })
  it('supports all seven E1 types and rejects the old v1 envelope', () => {
    const base = event(1)
    const refs = { order_ref: 'ord_' + 'a'.repeat(16), payment_ref: 'pay_' + 'b'.repeat(16), refers_to: 'pay_' + 'b'.repeat(16) }
    const events = [
      { ...base, type: 'order_created', order_ref: refs.order_ref },
      { ...base, type: 'pix_received', order_ref: refs.order_ref, payment_ref: refs.payment_ref },
      { ...base, type: 'refund', order_ref: refs.order_ref, refers_to: refs.refers_to },
      { ...base, type: 'med', order_ref: refs.order_ref, refers_to: refs.refers_to },
      { ...base, type: 'order_cancelled', order_ref: refs.order_ref },
      { ...base, type: 'partner_withdrawal', party_ref: 'par_' + 'c'.repeat(16) },
      { ...base, type: 'wallet_charge', payment_ref: refs.payment_ref, party_ref: 'cli_' + 'd'.repeat(16), payer_self_identified: false },
    ].map((e, i) => { const x = { ...e, event_id: 'evt_' + (i + 1).toString(16).padStart(16, '0') }; x.cursor = '20261006T130000Z/' + x.event_id; if (x.type === 'partner_withdrawal' || x.type === 'wallet_charge') delete (x as any).order_ref; return x })
    expect(validateTrio(trio(events as any), trusted()).ok).toBe(true)
    const input = trio(); input.lote = Buffer.from(JSON.stringify({ ev: 'order.created', ts: base.at, ord: base.order_ref, amt: '15.00' }) + '\n')
    expect(validateTrio(input, trusted()).ok).toBe(false)
  })

  it('brands validated objects and freezes them; raw buffers and key/context changes cannot change an accepted batch', async () => {
    const ctx = trusted(), input = trio(), v = checked(input, ctx); input.lote.fill(0); input.atestado.fill(0); input.pronto.fill(0)
    expect(v.events[0]!.amount_minor).toBe(1500); expect(Object.isFrozen(v.events[0])).toBe(true)
    const db = { connect: () => { throw new Error('DB must not be touched') } } as unknown as Db
    await expect(ingestShadowBatch(db, { ...v }, ctx)).rejects.toThrow('shadow_unvalidated')
    await expect(ingestShadowBatch(db, v, trusted('src_2'))).rejects.toThrow('shadow_context_changed')
    await expect(ingestShadowBatch(db, v, { ...ctx, secrets: { SHADOW_TEST_SECRET: 'b'.repeat(40) } })).rejects.toThrow('shadow_context_changed')
    expect(verifyShadowReceipt({}, v, ctx)).toBe(false)
  })
})
