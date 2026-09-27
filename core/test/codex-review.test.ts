// Provas de revisão, fora da implementação do Claude. Expectativas representam o contrato.
import { it, expect, afterEach } from 'vitest'
import { setup, deliver, counts, asaasEvent } from './helpers.js'
import { createOrder } from '../src/flows/orders.js'
import { reconcileAttempt } from '../src/flows/settle.js'
import { drain } from '../src/outbox.js'

let env: Awaited<ReturnType<typeof setup>>
afterEach(async () => { await env?.drop() })

async function prepared(suffix: string) {
  const orderId = await createOrder(env.ctx, env.merchantId, {externalRef: suffix, amountMinor: 10090n, description:'review'})
  const paymentId = (await env.db.query('SELECT provider_payment_id FROM pix_charges WHERE order_id=$1',[orderId])).rows[0].provider_payment_id
  env.provider.pay(paymentId)
  await deliver(env.ctx, asaasEvent('evt_'+suffix, 'PAYMENT_RECEIVED', paymentId, 'RECEIVED'))
  await drain(env.ctx,5,['process_provider_event'])
  return {orderId,paymentId}
}

it('R1: observacao antiga sem recibo nao rebaixa uma tentativa ja confirmada', async () => {
  env = await setup()
  const {orderId} = await prepared('race')
  await drain(env.ctx,5,['settle'])
  await drain(env.ctx,5,['sign_attempt'])
  await drain(env.ctx,5,['broadcast_attempt'])
  env.chain.mine()
  const a = (await env.db.query('SELECT a.id FROM settlement_attempts a JOIN settlements s ON s.id=a.settlement_id WHERE s.order_id=$1',[orderId])).rows[0]
  const observe = env.chain.observe.bind(env.chain)
  let announce!: () => void
  let release!: () => void
  const started = new Promise<void>(r => { announce=r })
  const delayed = new Promise<void>(r => { release=r })
  let first=true
  env.chain.observe=async(h,i)=>{
    if(first){ first=false; announce(); await delayed; return null }
    return observe(h,i)
  }
  const stale = reconcileAttempt(env.ctx,a.id,env.ctx.cfg.reconcileMaxTries-1)
  await started
  try { await reconcileAttempt(env.ctx,a.id,0) } finally { release() }
  await stale
  const c = await counts(env.db,orderId)
  console.log('R1_EVIDENCE',JSON.stringify({order:c.order.status,settlement:c.settlements[0].status,attempt:c.attempts[0].status,mined:env.chain.mined.length}))
  const ledgerBefore=(await env.db.query('SELECT kind,count(*)::int AS n FROM ledger_entries WHERE order_id=$1 GROUP BY kind ORDER BY kind',[orderId])).rows
  await reconcileAttempt(env.ctx,a.id,0)
  const ledgerAfter=(await env.db.query('SELECT kind,count(*)::int AS n FROM ledger_entries WHERE order_id=$1 GROUP BY kind ORDER BY kind',[orderId])).rows
  console.log('R1_LEDGER_EVIDENCE',JSON.stringify({before:ledgerBefore,after:ledgerAfter,mined:env.chain.mined.length}))
  expect.soft(c.attempts[0].status).toBe('confirmed')
  expect.soft(c.settlements[0].status).toBe('confirmed')
  expect(ledgerAfter).toEqual(ledgerBefore)
})

it('R2: tesouraria com nonce suspenso nao assina nem transmite pedido posterior', async () => {
  env = await setup()
  const first = await prepared('paused_first')
  await drain(env.ctx,5,['settle'])
  await drain(env.ctx,5,['sign_attempt'])
  await env.db.query("INSERT INTO refund_cases (id,order_id,refund_type,state,amount_minor) VALUES ('rfc_REVIEW',$1,'provider_refund','confirmed',10090)",[first.orderId])
  await drain(env.ctx,5,['broadcast_attempt'])
  expect((await counts(env.db,first.orderId)).attempts[0].status).toBe('suspended')
  const signedBefore=env.chain.signCalls
  const second = await prepared('paused_second')
  await drain(env.ctx,5,['settle'])
  await drain(env.ctx,5,['sign_attempt'])
  await drain(env.ctx,5,['broadcast_attempt'])
  const c=await counts(env.db,second.orderId)
  console.log('R2_EVIDENCE',JSON.stringify({first:(await counts(env.db,first.orderId)).attempts,second:c.attempts,signedBefore,signedAfter:env.chain.signCalls,broadcasts:env.chain.broadcastCalls,mempool:env.chain.mempool.size}))
  expect(env.chain.signCalls).toBe(signedBefore)
  expect(env.chain.broadcastCalls).toBe(0)
})

it('R3a: recebido sem hora, observado antes dos dois prazos, permite prosseguir', async () => {
  env = await setup()
  const orderId = await createOrder(env.ctx,env.merchantId,{externalRef:'timing_before',amountMinor:10090n,description:'review'})
  const id=(await env.db.query('SELECT provider_payment_id FROM pix_charges WHERE order_id=$1',[orderId])).rows[0].provider_payment_id
  env.provider.pay(id)
  env.provider.charges.get(id)!.paidAt = null // omitir hora de fato no retorno autoritativo
  await deliver(env.ctx,asaasEvent('evt_time_before','PAYMENT_RECEIVED',id,'RECEIVED'))
  await drain(env.ctx,5,['process_provider_event'])
  expect((await counts(env.db,orderId)).order).toEqual({status:'settling',hold_reason:null})
})

it('R3b: recebido sem hora depois do prazo ambiguo permanece retido', async () => {
  env=await setup()
  const orderId = await createOrder(env.ctx,env.merchantId,{externalRef:'timing_after',amountMinor:10090n,description:'review'})
  const id=(await env.db.query('SELECT provider_payment_id FROM pix_charges WHERE order_id=$1',[orderId])).rows[0].provider_payment_id
  env.provider.pay(id)
  env.provider.charges.get(id)!.paidAt = null // omitir hora de fato no retorno autoritativo
  await env.db.query("UPDATE orders SET expires_at=now()-interval '1 minute' WHERE id=$1",[orderId])
  await deliver(env.ctx,asaasEvent('evt_time_after','PAYMENT_RECEIVED',id,'RECEIVED'))
  await drain(env.ctx,5,['process_provider_event'])
  const c=await counts(env.db,orderId)
  expect(c.order.hold_reason).toBe('timing_unresolved')
  expect(c.settlements).toHaveLength(0)
})
