// Cenário 6 da matriz (docs/coverage.md): valores em unidades mínimas preservam bruto = líquido + reserva,
// sem ponto flutuante, e a reserva gravada é a da intenção mesmo se a taxa de reserva mudar depois.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setup, settleAll, deliver, asaasEvent } from './helpers.js'
import { createOrder } from '../src/flows/orders.js'
import { computeAmounts } from '../src/flows/events.js'
import { reserveOfIntent } from '../src/flows/amounts.js'
import { drain } from '../src/outbox.js'
import { signReceipt, verifyEnvelope } from '../../settlement/src/receipt.js'
import { privateKeyToAccount } from 'viem/accounts'

const ISSUER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const // chave pública de TESTE
const ISSUER = privateKeyToAccount(ISSUER_KEY).address

describe('valores: aritmética inteira', () => {
  const amounts = [1n, 2n, 3n, 99n, 100n, 101n, 10090n, 33333n, 50000n, 999999n, 123456789n]
  const rates: [bigint, bigint][] = [[1810n, 1n], [181n, 1000n], [5437n, 3n], [1n, 7n]]
  const bpsList = [0, 1, 333, 1000, 2500, 9999]

  it('bruto é o piso de valor x cotação; reserva é o piso de bruto x bps; líquido + reserva = bruto', () => {
    let checked = 0
    for (const a of amounts) for (const [n, d] of rates) for (const bps of bpsList) {
      const gross = (a * n) / d
      const reserve = (gross * BigInt(bps)) / 10000n
      if (gross - reserve <= 0n) { expect(() => computeAmounts(a, n, d, bps)).toThrow(/identidade contábil/); continue }
      const r = computeAmounts(a, n, d, bps)
      expect(r.gross).toBe(gross)
      expect(r.reserve).toBe(reserve)
      expect(r.fees).toBe(0n)
      expect(r.net + r.reserve + r.fees).toBe(r.gross)
      expect(r.gross * d <= a * n && a * n < (r.gross + 1n) * d).toBe(true) // piso exato, sem arredondar para cima
      expect(reserveOfIntent(a, n, d, r.net)).toBe(r.reserve)
      checked++
    }
    expect(checked).toBeGreaterThan(200)
  })

  it('reserva de 100% (líquido zero) é recusada, não vira liquidação de 0', () => {
    expect(() => computeAmounts(10090n, 1810n, 1n, 10000)).toThrow(/identidade contábil/)
  })

  it('líquido registrado maior que o bruto é recusado', () => {
    expect(() => reserveOfIntent(10090n, 1810n, 1n, 18262901n)).toThrow(/identidade contábil/)
    expect(() => reserveOfIntent(10090n, 1810n, 1n, 0n)).toThrow(/identidade contábil/)
  })
})

describe('valores: reserva congelada na intenção', () => {
  let env: Awaited<ReturnType<typeof setup>>
  afterEach(async () => { await env?.drop() })

  it('taxa de reserva muda entre intenção e confirmação: livro-razão e recibo usam a da intenção', async () => {
    env = await setup()
    env.ctx.cfg.issuer = { id: 'pixsettle-test', address: ISSUER }
    env.chain.signReceipt = (payload: any) => signReceipt(payload, ISSUER_KEY)
    const orderId = await createOrder(env.ctx, env.merchantId, { externalRef: 'r-' + randomUUID(), amountMinor: 10090n, description: 't' })
    const ch = (await env.db.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [orderId])).rows[0]
    env.provider.pay(ch.provider_payment_id)
    await deliver(env.ctx, asaasEvent('evt_' + orderId, 'PAYMENT_RECEIVED', ch.provider_payment_id, 'RECEIVED'))
    await drain(env.ctx, 50, ['process_provider_event'])
    const s = (await env.db.query(`SELECT amount_units::text AS net FROM settlements WHERE order_id=$1`, [orderId])).rows[0]
    expect(s.net).toBe('16436610') // R$ 100,90 x 1810 = 18.262900 bruto; reserva 10% = 1.826290
    await env.db.query(`UPDATE merchants SET reserve_bps=2500 WHERE id=$1`, [env.merchantId])

    await settleAll(env.ctx, env.chain)
    const ledger = Object.fromEntries((await env.db.query(
      `SELECT kind, sum(amount_units)::text AS v FROM ledger_entries WHERE order_id=$1 GROUP BY kind`, [orderId])).rows.map(r => [r.kind, r.v]))
    expect(ledger).toEqual({ settlement_net: '16436610', reserve_simulated: '1826290' })
    expect(BigInt(ledger.settlement_net) + BigInt(ledger.reserve_simulated)).toBe(18262900n)

    const env2 = (await env.db.query(`SELECT envelope FROM receipts WHERE order_id=$1 AND receipt_type='settlement'`, [orderId])).rows[0].envelope
    expect(await verifyEnvelope(env2, [ISSUER])).toMatchObject({ ok: true })
    const am = env2.payload.amounts
    expect(am).toMatchObject({ gross: '18262900', reserve_simulated: '1826290', net: '16436610', fees_simulated: '0' })
    expect(env2.payload.settlement.amount).toBe(am.net)
  })
})
