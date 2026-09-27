// Casos complementares às provas do Codex (R1, R2, R3), escritos pelo Claude.
import { describe, it, expect, afterEach } from 'vitest'
import { setup, deliver, counts, asaasEvent, settleAll } from './helpers.js'
import { createOrder } from '../src/flows/orders.js'
import { reconcileAttempt } from '../src/flows/settle.js'
import { drain } from '../src/outbox.js'
import { buildApp } from '../src/app.js'
import { registerWeb } from '../src/web.js'
import { registerDemo } from '../src/demo.js'

let env: Awaited<ReturnType<typeof setup>>
afterEach(async () => { await env?.drop() })

async function paid(ref: string) {
  const orderId = await createOrder(env.ctx, env.merchantId, { externalRef: ref, amountMinor: 10090n, description: 't' })
  const pid = (await env.db.query('SELECT provider_payment_id FROM pix_charges WHERE order_id=$1', [orderId])).rows[0].provider_payment_id
  env.provider.pay(pid)
  await deliver(env.ctx, asaasEvent('evt_' + ref, 'PAYMENT_RECEIVED', pid, 'RECEIVED'))
  await drain(env.ctx, 5, ['process_provider_event'])
  return orderId
}
const attemptOf = (orderId: string) => env.db.query(`SELECT a.* FROM settlement_attempts a JOIN settlements s ON s.id=a.settlement_id WHERE s.order_id=$1 ORDER BY attempt_no DESC LIMIT 1`, [orderId]).then(r => r.rows[0])

describe('correções da revisão', () => {
  it('R1: erro de RPC atrasado não apaga a evidência conclusiva nem muda o estado', async () => {
    env = await setup()
    const orderId = await paid('r1b')
    await settleAll(env.ctx, env.chain)
    const before = await attemptOf(orderId)
    expect(before.status).toBe('confirmed')
    env.chain.observeDown = true
    expect(await reconcileAttempt(env.ctx, before.id, 0)).toBe('done') // terminal: nem consulta
    const after = await attemptOf(orderId)
    expect(after.status).toBe('confirmed')
    expect(after.observed).toEqual(before.observed)
  })

  it('R1: o banco recusa lançamento contábil em dobro para a mesma liquidação', async () => {
    env = await setup()
    const orderId = await paid('r1c')
    await settleAll(env.ctx, env.chain)
    const s = (await env.db.query(`SELECT id, s.amount_units FROM settlements s WHERE order_id=$1`, [orderId])).rows[0]
    await expect(env.db.query(`INSERT INTO ledger_entries (merchant_id, order_id, kind, amount_units, currency, simulated, op_key) VALUES ($1,$2,'settlement_net',$3,'pathUSD',false,$4)`,
      [env.merchantId, orderId, s.amount_units, `settlement:${s.id}:net`])).rejects.toThrow(/ledger_entries_op_key/)
  })

  it('R2: B espera com diagnóstico, sem erro no job; nonce menor que o suspenso não é bloqueado', async () => {
    env = await setup()
    const low = await paid('r2-low'), high = await paid('r2-high')
    await drain(env.ctx, 10, ['settle']) // low recebe nonce 0, high nonce 1
    const aLow = await attemptOf(low), aHigh = await attemptOf(high)
    expect([aLow.nonce, aHigh.nonce]).toEqual(['0', '1'])
    await drain(env.ctx, 5, ['sign_attempt'])
    // high (nonce 1) é suspenso por estorno; low (nonce 0) não depende dele e segue.
    await env.db.query("INSERT INTO refund_cases (id,order_id,refund_type,state,amount_minor) VALUES ('rfc_R2',$1,'provider_refund','confirmed',10090)", [high])
    await drain(env.ctx, 10, ['broadcast_attempt'])
    expect((await attemptOf(high)).status).toBe('suspended')
    expect((await attemptOf(low)).status).toBe('broadcast_sent')
    // Pedido novo: espera com diagnóstico gravado e job reagendado, sem last_error.
    const late = await paid('r2-late')
    await drain(env.ctx, 5, ['settle'])
    const s = (await env.db.query(`SELECT id FROM settlements WHERE order_id=$1`, [late])).rows[0]
    const w = (await env.db.query(`SELECT to_state, reason FROM state_transitions WHERE entity='settlement_waiting' AND entity_id=$1`, [s.id])).rows
    expect(w).toEqual([{ to_state: 'waiting', reason: expect.stringMatching(/^treasury_paused:att_.*:nonce_1$/) }])
    const job = (await env.db.query(`SELECT done_at, last_error, available_at > now() AS later FROM outbox WHERE topic='settle' AND entity_id=$1`, [s.id])).rows[0]
    expect(job).toEqual({ done_at: null, last_error: null, later: true })
    expect(await attemptOf(late)).toBeUndefined()
    // Reconsultas não inundam o histórico.
    await env.db.query(`UPDATE outbox SET available_at=now() WHERE topic='settle' AND entity_id=$1`, [s.id])
    await drain(env.ctx, 5, ['settle'])
    expect((await env.db.query(`SELECT count(*)::int AS n FROM state_transitions WHERE entity='settlement_waiting' AND entity_id=$1`, [s.id])).rows[0].n).toBe(1)
    env.chain.mine()
    expect(env.chain.mined.map(t => t.nonce)).toEqual([0])
  })

  it('R2: B já com nonce reservado ou assinado antes da pausa não assina nem transmite enquanto A estiver suspenso', async () => {
    env = await setup()
    const a = await paid('r2-a'), b = await paid('r2-b'), c = await paid('r2-c')
    await drain(env.ctx, 10, ['settle']) // a:0, b:1, c:2
    await drain(env.ctx, 1, ['sign_attempt']) // só a assina
    await env.db.query("INSERT INTO refund_cases (id,order_id,refund_type,state,amount_minor) VALUES ('rfc_R2A',$1,'provider_refund','confirmed',10090)", [a])
    await drain(env.ctx, 5, ['broadcast_attempt'])
    expect((await attemptOf(a)).status).toBe('suspended')
    await drain(env.ctx, 1, ['sign_attempt']) // b: nonce reservado antes da pausa
    expect((await attemptOf(b))).toMatchObject({ status: 'nonce_reserved', pre_sign_check: { ok: false, waiting: expect.stringMatching(/^treasury_paused:/) } })
    expect(env.chain.signCalls).toBe(1)
    // c já assinado por outro caminho antes da pausa (simulado): não transmite.
    await env.db.query(`UPDATE settlement_attempts SET status='signed', raw_tx='0xdead', tx_hash='0xbeef' WHERE id=$1`, [(await attemptOf(c)).id])
    await env.db.query(`INSERT INTO outbox (topic, entity_id, payload) VALUES ('broadcast_attempt',$1,'{}')`, [(await attemptOf(c)).id])
    await drain(env.ctx, 5, ['broadcast_attempt'])
    expect((await attemptOf(c))).toMatchObject({ status: 'signed', pre_broadcast_check: { ok: false } })
    expect(env.chain.broadcastCalls).toBe(0)
  })

  it('R3: link vencido devolve 410 só com o estado; QR vencido não sai', async () => {
    env = await setup()
    const app = buildApp(env.ctx, { asaasWebhookToken: 'tok', diagnosticsToken: 'd' })
    registerWeb(app, env.ctx, { tempoRpc: 'https://rpc.moderato.tempo.xyz', explorer: 'https://explore.testnet.tempo.xyz', demo: true })
    await registerDemo(app, env.ctx, { webhookToken: 'tok', merchantAddress: '0x8ee643c15C603856A76d05020b5ccB0FceA425BF', explorer: 'https://explore.testnet.tempo.xyz' })
    const { checkout_token, order_id } = (await app.inject({ method: 'POST', url: '/demo/api/orders', payload: { amount_minor: 10090 } })).json()
    await app.inject({ method: 'POST', url: `/demo/api/orders/${order_id}/simulate`, payload: { deliveries: 1 } })
    await env.db.query("UPDATE checkout_sessions SET expires_at=now()-interval '1 second' WHERE order_id=$1", [order_id])
    const d = await app.inject({ method: 'GET', url: `/api/v1/checkout/${checkout_token}` })
    expect(d.statusCode).toBe(410)
    expect(d.json()).toEqual({ error: { code: 'checkout_expired', message: 'link de pagamento expirado', details: { status: expect.any(String) } } })
    expect(d.body).not.toContain('SIMULATED-PIX')
    const q = await app.inject({ method: 'GET', url: `/api/v1/checkout/${checkout_token}/qr.svg` })
    expect(q.statusCode).toBe(410); expect(q.body).not.toContain('<svg')
    await app.close()
  })
})
