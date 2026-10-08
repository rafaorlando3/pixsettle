import { describe,it,expect,afterEach } from 'vitest'
import { setup } from './helpers.js'
import { runOnce } from '../src/outbox.js'
import { startWorker,type Worker } from '../src/worker.js'
let env:Awaited<ReturnType<typeof setup>>;let worker:Worker|null=null
const wait=async(fn:()=>boolean)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw new Error('worker did not idle')}
afterEach(async()=>{await worker?.stop();worker=null;await env?.drop()})
async function seed(){env=await setup();env.ctx.cfg.publicReplayReadOnly=true;for(const [id,provider] of [['ord_attested','attested'],['ord_simulated','simulated']])await env.db.query(`INSERT INTO orders(id,merchant_id,external_ref,amount_minor,status,expires_at,provider_env,chain_env) VALUES($1,$2,$1,1500,'paid',now()+interval '1 hour',$3,'testnet')`,[id,env.merchantId,provider]);await env.db.query(`INSERT INTO outbox(topic,entity_id,payload) VALUES('expire_order','ord_attested','{}'),('copilot_judge','exc_missing','{}')`)}
describe('public replay queue with PostgreSQL',()=>{
 it('does not claim pilot/model jobs while a simulated demo job remains executable',async()=>{await seed();const before=(await env.db.query('SELECT * FROM outbox ORDER BY id')).rows;expect(await runOnce(env.ctx)).toBeNull();expect((await env.db.query('SELECT * FROM outbox ORDER BY id')).rows).toEqual(before);await env.db.query(`INSERT INTO outbox(topic,entity_id,payload) VALUES('expire_order','ord_simulated','{}')`);expect(await runOnce(env.ctx)).toBe('expire_order');expect((await env.db.query(`SELECT * FROM outbox WHERE entity_id IN ('ord_attested','exc_missing') ORDER BY id`)).rows).toEqual(before);expect((await env.db.query(`SELECT done_at FROM outbox WHERE entity_id='ord_simulated'`)).rows[0].done_at).not.toBeNull()})
 it('idles with blocked jobs instead of repeatedly consulting or updating them',async()=>{await seed();const before=(await env.db.query('SELECT * FROM outbox ORDER BY id')).rows;worker=startWorker(env.ctx,{sweepEveryMs:300000,log:()=>{}});await wait(()=>worker!.state==='idle');expect((await env.db.query('SELECT * FROM outbox ORDER BY id')).rows).toEqual(before);await new Promise(r=>setTimeout(r,30));expect(worker.state).toBe('idle')})
})
