// Revisão delimitada das devoluções P2: repetição e reserva compartilhada por lojista.
import { it, expect, afterEach } from 'vitest'
import { setup, deliver, asaasEvent } from './helpers.js'
import { createOrder } from '../src/flows/orders.js'
import { requestRefund, executeRefund } from '../src/flows/refunds.js'
import { applyObservation } from '../src/flows/events.js'
import { reconcileAttempt } from '../src/flows/settle.js'
import { withTx } from '../src/db.js'
import { drain } from '../src/outbox.js'
let env: Awaited<ReturnType<typeof setup>>
afterEach(async()=>{ await env?.drop() })
async function settled(ref:string) {
  const orderId=await createOrder(env.ctx,env.merchantId,{externalRef:ref,amountMinor:10090n,description:'review'})
  const pid=(await env.db.query('SELECT provider_payment_id FROM pix_charges WHERE order_id=$1',[orderId])).rows[0].provider_payment_id
  env.provider.pay(pid)
  await deliver(env.ctx,asaasEvent('evt_'+ref,'PAYMENT_RECEIVED',pid,'RECEIVED'))
  await drain(env.ctx,20,['process_provider_event','settle','sign_attempt','broadcast_attempt'])
  env.chain.mine()
  const aid=(await env.db.query('SELECT a.id FROM settlement_attempts a JOIN settlements s ON s.id=a.settlement_id WHERE s.order_id=$1',[orderId])).rows[0].id
  await reconcileAttempt(env.ctx,aid,0)
  return {orderId,pid}
}

it('R4: falha na consulta apos estorno aceito nao autoriza executar a devolucao novamente',async()=>{
  env=await setup()
  const {orderId,pid}=await settled('r4')
  const request=await requestRefund(env.ctx,env.merchantId,orderId,{type:'merchant_refund',amountMinor:1000n,source:'review'})
  if(!request.ok) throw new Error(request.code)
  env.provider.failNext='get_timeout'
  await executeRefund(env.ctx,request.refundCaseId).catch(e=>{ expect(e.message).toMatch(/timeout/) }) // aceita tratar o erro internamente na correcao
  const mid=(await env.db.query('SELECT state, provider_ref FROM refund_cases WHERE id=$1',[request.refundCaseId])).rows[0]
  expect(env.provider.charges.get(pid)!.refundedMinor).toBe(1000n)
  await executeRefund(env.ctx,request.refundCaseId)
  const final=env.provider.charges.get(pid)!.refundedMinor
  console.log('R4_EVIDENCE',JSON.stringify({requested:'1000',stateAfterGetTimeout:mid.state,hasProviderReference:!!mid.provider_ref,refundedAfterRetry:final.toString()}))
  expect(final).toBe(1000n)
})

it('R5: devolucoes de pedidos diferentes nao podem consumir a mesma reserva do lojista',async()=>{
  env=await setup()
  const a=await settled('r5a'),b=await settled('r5b')
  for(const o of [a,b]) {
    const r=await requestRefund(env.ctx,env.merchantId,o.orderId,{type:'merchant_refund',amountMinor:2000n,source:'review'})
    expect(r.ok).toBe(true)
    env.provider.providerRefund(o.pid,2000n)
  }
  const pa=await env.provider.getPayment(a.pid),pb=await env.provider.getPayment(b.pid)
  let seen=0, release!:()=>void
  const bothRead=new Promise<void>(r=>{release=r})
  const pids:number[]=[]
  const apply=async(payment:any)=>withTx(env.db,async tx=>{
    pids.push((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    // Pausa somente a bancada apos ambas as transacoes terem lido o saldo compartilhado.
    const wrapped={query:async(...args:any[])=>{
      const res=await (tx.query as any)(...args)
      if(typeof args[0]==='string' && args[0].includes("sum(CASE kind WHEN 'reserve_simulated'")) {
        seen++; if(seen===2)release(); await bothRead
      }
      return res
    }}
    return applyObservation(wrapped as any,env.ctx,payment,'review_concurrent_refund')
  })
  let completed=false
  const pair=Promise.all([apply(pa),apply(pb)]).finally(()=>{completed=true})
  pair.catch(()=>{})
  try {
    while(!completed) {
      if(seen===2) { release(); break }
      // Uma correcao com trava compartilhada serializa o segundo leitor.
      // Liberar o primeiro nesse caso evita um deadlock criado pela propria bancada.
      const waits=(await env.db.query('SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=ANY($1::int[])',[pids])).rows
      if(waits.some(r=>r.blockers.some((pid:number)=>pids.includes(pid)))) { release(); break }
      await new Promise(r=>setTimeout(r,5))
    }
    await pair
  } finally { release() }
  const rows=(await env.db.query("SELECT kind,sum(amount_units)::text AS v FROM ledger_entries WHERE merchant_id=$1 GROUP BY kind ORDER BY kind",[env.merchantId])).rows
  const vals=Object.fromEntries(rows.map(x=>[x.kind,BigInt(x.v)]))
  const balance=(vals.reserve_simulated??0n)-(vals.reserve_consumed_simulated??0n)
  console.log('R5_EVIDENCE',JSON.stringify({reserve:vals.reserve_simulated?.toString(),consumed:vals.reserve_consumed_simulated?.toString(),debt:(vals.debt_simulated??0n).toString(),balance:balance.toString()}))
  expect(balance>=0n).toBe(true)
},5000)


it('R6: repetir observacao de estorno parcial nao encerra liquidacao ainda em andamento',async()=>{
  env=await setup()
  const orderId=await createOrder(env.ctx,env.merchantId,{externalRef:'r6',amountMinor:10090n,description:'review'})
  const pid=(await env.db.query('SELECT provider_payment_id FROM pix_charges WHERE order_id=$1',[orderId])).rows[0].provider_payment_id
  env.provider.pay(pid)
  await deliver(env.ctx,asaasEvent('evt_r6','PAYMENT_RECEIVED',pid,'RECEIVED'))
  await drain(env.ctx,20,['process_provider_event','settle','sign_attempt','broadcast_attempt'])
  env.provider.providerRefund(pid,1000n)
  const observation=await env.provider.getPayment(pid)
  await withTx(env.db,tx=>applyObservation(tx,env.ctx,observation,'review_external_first'))
  const first=(await env.db.query('SELECT state FROM refund_cases WHERE order_id=$1',[orderId])).rows
  expect(first).toEqual([{state:'unknown'}])
  await withTx(env.db,tx=>applyObservation(tx,env.ctx,observation,'review_external_repeated'))
  const state=(await env.db.query('SELECT o.status AS order_status,s.status AS settlement_status,a.status AS attempt_status FROM orders o JOIN settlements s ON s.order_id=o.id JOIN settlement_attempts a ON a.settlement_id=s.id WHERE o.id=$1',[orderId])).rows[0]
  const refunds=(await env.db.query('SELECT state,amount_minor::text AS amount FROM refund_cases WHERE order_id=$1',[orderId])).rows
  console.log('R6_EVIDENCE',JSON.stringify({...state,refunds,mined:env.chain.mined.length,mempool:env.chain.mempool.size}))
  expect.soft(refunds).toEqual([{state:'unknown',amount:'1000'}])
  expect.soft(state.settlement_status).not.toBe('failed')
  expect(state.order_status).not.toBe('refunded')
})
