// P2 #10/#16 e expiração ativa: a varredura acha o que o webhook perdeu e o pedido vencido vira expirado só com o provedor confirmando.
import { describe, it, expect, afterEach } from 'vitest'
import { setup, settleAll, deliver, asaasEvent, counts } from './helpers.js'
import { createOrder } from '../src/flows/orders.js'
import { sweep } from '../src/flows/sweep.js'
import { drain } from '../src/outbox.js'

let env: Awaited<ReturnType<typeof setup>>
afterEach(async () => { await env?.drop() })

async function order(ref: string, amount = 10090n) {
  const orderId = await createOrder(env.ctx, env.merchantId, { externalRef: ref, amountMinor: amount, description: 't' })
  const pid = (await env.db.query(`SELECT provider_payment_id FROM pix_charges WHERE order_id=$1`, [orderId])).rows[0].provider_payment_id as string
  return { orderId, pid }
}
const liveness = () => env.db.query(`SELECT entity_id, from_state, to_state, reason FROM state_transitions WHERE entity='webhook_liveness'`).then(r => r.rows)

describe('conciliação periódica', () => {
  it('16. fila de webhook parada: a varredura acha o pagamento, liquida uma vez e o teste de vida acusa', async () => {
    env = await setup()
    const a = await order('sw-1')
    env.provider.pay(a.pid) // pago no provedor; nenhum webhook chega
    expect(await sweep(env.ctx)).toMatchObject({ observe: 1 })
    expect(await sweep(env.ctx)).toMatchObject({ observe: 1 }) // segunda rodada não duplica o job pendente
    expect((await env.db.query(`SELECT count(*)::int AS n FROM outbox WHERE topic='observe_charge' AND done_at IS NULL`)).rows[0].n).toBe(1)
    await settleAll(env.ctx, env.chain)
    expect((await counts(env.db, a.orderId)).order.status).toBe('settled')
    expect(env.chain.mined).toHaveLength(1)
    const l = await liveness()
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({ from_state: 'created', to_state: 'missed' })
    expect(l[0].reason).toMatch(/RECEIVED e nenhum webhook/)
  })

  it('com webhook chegando, a varredura não acusa nada e não paga de novo', async () => {
    env = await setup()
    const a = await order('sw-2')
    env.provider.pay(a.pid)
    await deliver(env.ctx, asaasEvent('evt_sw2', 'PAYMENT_RECEIVED', a.pid, 'RECEIVED'))
    await sweep(env.ctx)
    await settleAll(env.ctx, env.chain)
    await sweep(env.ctx)
    await settleAll(env.ctx, env.chain)
    expect(await liveness()).toEqual([])
    expect(env.chain.mined).toHaveLength(1)
  })

  it('pedido vencido: exclui a cobrança no provedor e só então marca expirado', async () => {
    env = await setup()
    const a = await order('sw-3')
    await env.db.query(`UPDATE orders SET expires_at=now()-interval '1 minute' WHERE id=$1`, [a.orderId])
    expect(await sweep(env.ctx)).toMatchObject({ expire: 1 })
    await drain(env.ctx, 10, ['expire_order'])
    expect((await counts(env.db, a.orderId)).order.status).toBe('expired')
    expect(env.provider.charges.get(a.pid)!.status).toBe('DELETED')
    expect((await env.db.query(`SELECT observed_state FROM pix_charges WHERE order_id=$1`, [a.orderId])).rows[0].observed_state).toBe('deleted')
  })

  it('pago no limite do prazo, sem webhook: a exclusão é recusada, a observação aplica a regra de prazo e liquida', async () => {
    env = await setup()
    const a = await order('sw-4')
    const exp = (await env.db.query(`SELECT expires_at FROM orders WHERE id=$1`, [a.orderId])).rows[0].expires_at
    env.provider.pay(a.pid, { at: new Date(new Date(exp).getTime() - 1000) }) // 1 s antes do prazo
    env.ctx.now = () => new Date(new Date(exp).getTime() + 120_000) // a varredura roda 2 min depois
    await sweep(env.ctx)
    await drain(env.ctx, 10, ['expire_order'])
    const c = await counts(env.db, a.orderId)
    expect(c.order.status).toBe('settling')
    expect(env.provider.charges.get(a.pid)!.status).toBe('RECEIVED') // nunca excluída
    env.ctx.now = () => new Date()
    await settleAll(env.ctx, env.chain)
    expect((await counts(env.db, a.orderId)).order.status).toBe('settled')
  })

  it('cobrança sumiu do provedor: retém para revisão com motivo, sem marcar expirado nem pago', async () => {
    env = await setup()
    const a = await order('sw-5')
    env.provider.charges.delete(a.pid)
    await env.db.query(`UPDATE orders SET expires_at=now()-interval '1 minute' WHERE id=$1`, [a.orderId])
    await sweep(env.ctx)
    await drain(env.ctx, 10, ['expire_order'])
    expect((await counts(env.db, a.orderId)).order).toEqual({ status: 'awaiting_payment', hold_reason: 'provider_charge_missing' })
    expect(await sweep(env.ctx)).toMatchObject({ expire: 0, observe: 0 })
    const b = await order('sw-6') // ainda no prazo: a observação também retém em vez de falhar para sempre
    env.provider.charges.delete(b.pid)
    await sweep(env.ctx); await drain(env.ctx, 10, ['observe_charge'])
    expect((await counts(env.db, b.orderId)).order.hold_reason).toBe('provider_charge_missing')
    expect((await env.db.query(`SELECT count(*)::int AS n FROM outbox WHERE done_at IS NULL`)).rows[0].n).toBe(0)
  })
})
