import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { hashOf } from '../src/copilot/verdict.js'
import { buildModelInput } from '../src/copilot/judge.js'
import { buildShadowProjection, privateCases, reviewId, advisoryVerdict, validateShadowReview, canonicalReviewTimestamp, formatMinor, publicStore, type ShadowCase, type ShadowReview } from '../src/pilot-shadow/projection.js'
import { publicShadowCase, shadowSummary } from '../src/pilot-shadow/public-api.js'
import { registerPilot } from '../src/pilot/routes.js'
import { corePassthroughEnv } from '../scripts/start-all.js'
import type { Ctx } from '../src/context.js'

const NOW='2026-10-08T00:00:00Z'
const hex=(n:number)=>n.toString(16).padStart(16,'0')
const batch=(origin='src_test',store='store_1')=>({origin,store,lote_sha256:'a'.repeat(64),trio_sha256:'b'.repeat(64),atestado_sha256:'c'.repeat(64),pronto_sha256:'d'.repeat(64),committed_at:NOW})
const event=(id:number,type:string,changes:Record<string,unknown>={})=>({origin:'src_test',store:'store_1',event_id:'evt_'+hex(id),cursor:'20261001T120000Z/evt_'+hex(id),event_type:type,event_at:'2026-10-01T12:00:00Z',received_at:NOW,
 amount_minor:'1000',currency:'BRL',order_ref:'ord_'+hex(1),payment_ref:type==='pix_received'?'pay_'+hex(id):null,refers_to:['refund','med'].includes(type)?'pay_'+hex(2):null,party_ref:null,expires_at:null,payer_self_identified:null,line_sha256:hashOf({id,type,changes}),first_batch:'a'.repeat(64),...changes})
const projection=(events:Record<string,unknown>[],reviews:unknown[]=[],batches=[batch()])=>buildShadowProjection(events,batches,reviews,NOW)
function review(c:ShadowCase,changes:Partial<ShadowReview>={}):ShadowReview{
 const body:Omit<ShadowReview,'review_id'>={case_id:c.case_id,origin:c.origin,store:c.store,input_hash:c.model_input_hash,projection_hash:c.projection_hash,
  engine:'model',actor:'model',model:'openai/gpt-4.1-mini',action:'escalate',confidence:0.84999999,requires_human:true,advisory:true,
  evidence_refs:[c.evidence[0]!.id],verdict_hash:'',capture_receipt_sha256:'e'.repeat(64),private_verdict_hash:'f'.repeat(64),latency_ms:123,
  created_at:canonicalReviewTimestamp('2026-10-08T00:00:00.123Z'),...changes}
 body.verdict_hash=hashOf(advisoryVerdict(body))
 return {...body,review_id:reviewId(body)}
}
afterEach(()=>vi.unstubAllGlobals())

describe('typed shadow public projection',()=>{
 it('counts scoped unique orders, exact values and observed Pix separately',()=>{
  const p=projection([event(1,'order_created'),event(2,'pix_received'),event(3,'order_created',{order_ref:'ord_'+hex(2),amount_minor:'2000'}),event(4,'pix_received',{order_ref:'ord_'+hex(2),amount_minor:'1900'})])
  const s=shadowSummary(p)
  expect(s.orders).toMatchObject({orders:2,paid:1,paid_minor:'1000',pix_observed:2,pix_observed_minor:'2900',receipts:0,settlements_confirmed:0,settled:0})
  expect(s.exceptions).toMatchObject({exceptions:1,resolved:0,auto_applied:0,awaiting_human:1})
  expect(p.cases[0]?.reason_code).toBe('amount_mismatch')
 })
 it('keeps repeated identical payment observations unique economically without inflating paid',()=>{
  const p=projection([event(1,'order_created'),event(2,'pix_received'),event(3,'pix_received',{payment_ref:'pay_'+hex(2)})])
  const s=shadowSummary(p)
  expect(s.orders).toMatchObject({paid:1,paid_minor:'1000',pix_observed:2,pix_observed_minor:'2000',pix_unique_payment_refs:1,pix_semantic_duplicate_events:1,pix_unambiguous_minor:'1000'})
 })
 it('different payment refs and multiple creation facts remain review rather than inflated paid',()=>{
  const p=projection([event(1,'order_created'),event(2,'pix_received'),event(3,'pix_received')])
  expect(shadowSummary(p).orders.paid).toBe(0);expect(p.cases.map(c=>c.reason_code)).toContain('duplicate_payment')
  const duplicate=projection([event(1,'order_created'),event(2,'order_created'),event(3,'pix_received')])
  expect(shadowSummary(duplicate).orders).toMatchObject({orders:1,paid:0})
  expect(duplicate.cases.map(c=>c.reason_code)).toContain('order_conflict')
 })
 it('payment reference conflict includes amount, order and timestamp',()=>{
  for(const changes of [{amount_minor:'1001'},{order_ref:'ord_'+hex(9)},{event_at:'2026-10-01T12:00:01Z'}]){
   const p=projection([event(1,'order_created'),event(2,'pix_received'),event(3,'pix_received',{payment_ref:'pay_'+hex(2),...changes})])
   expect(shadowSummary(p).orders.paid).toBe(0);expect(p.payment_stats.conflicting_payment_refs).toBe(1)
   expect(p.cases.map(c=>c.reason_code)).toContain('payment_conflict')
  }
 })
 it('same ref in another origin/store remains separate and public filters cannot merge scopes',()=>{
  const other={origin:'src_other',store:'store_1'}
  const p=projection([event(1,'order_created'),event(2,'pix_received'),event(1,'order_created',other),event(2,'pix_received',other)],[],[batch(),batch(other.origin,other.store)])
  const s=shadowSummary(p)
  expect(s.orders).toMatchObject({orders:2,paid:2,paid_minor:'2000'})
  expect(s.stores).toHaveLength(2);expect(s.stores[0]!.code).not.toBe(s.stores[1]!.code)
  expect(s).toMatchObject({all_streams:2,active_order_stores:2,active_order_streams:2})
  expect(JSON.stringify(s.stores)).not.toContain('src_other')
 })
 it('orphan and wallet-only scopes are honest and not presented as active order stores',()=>{
  const p=projection([event(2,'pix_received'),event(3,'wallet_charge',{store:'store_2',order_ref:null,payment_ref:'pay_'+hex(3),party_ref:'cli_'+hex(3)})],[],[batch(),batch('src_test','store_2')])
  const s=shadowSummary(p);expect(s).toMatchObject({all_streams:2,active_order_stores:0})
  expect(s.stores).toEqual([]);expect(s.orders.orders).toBe(0);expect(p.cases[0]?.reason_code).toBe('orphan_payment')
 })
 it('never infers late payment without explicit expiry',()=>{
  const noExpiry=projection([event(1,'order_created'),event(2,'pix_received',{event_at:'2026-10-07T12:00:00Z'})])
  expect(noExpiry.cases).toHaveLength(0)
  const expired=projection([event(1,'order_created',{expires_at:'2026-10-02T00:00:00Z'}),event(2,'pix_received',{event_at:'2026-10-07T12:00:00Z'})])
  expect(expired.cases[0]?.reason_code).toBe('late_payment')
 })
 it('refund and MED use observed typed refs and cannot become settlements or receipts',()=>{
  const p=projection([event(1,'order_created'),event(2,'pix_received'),event(3,'refund'),event(4,'med')])
  expect(p.cases.map(c=>c.reason_code).sort()).toEqual(['med_observed','refund_observed'])
  expect(shadowSummary(p).orders).toMatchObject({paid:1,settled:0,settlements_confirmed:0,receipts:0})
  const orphan=projection([event(3,'refund'),event(4,'med')]);expect(orphan.cases.map(c=>c.reason_code).sort()).toEqual(['orphan_med','orphan_refund'])
 })
 it('all public evidence is constructed from typed amounts/dates, never supplied free text/PII',()=>{
  const p=projection([event(1,'order_created',{email:'private@example.com',note:'CPF 123.456.789-00'}),event(2,'pix_received',{amount_minor:'900',raw_response:'private provider body'})])
  const pub=publicShadowCase(p.cases[0]!),serialized=JSON.stringify(pub)
  expect(serialized).not.toContain('private@');expect(serialized).not.toContain('123.456');expect(serialized).not.toContain('provider body')
  expect(pub.evidence.map(e=>e.fact).join(' ')).toContain('R$ 9.00')
  expect(pub).not.toHaveProperty('facts');expect(pub.evidence[0]).not.toHaveProperty('ref')
 })
 it('private cases expose exact pure prompt hashes and accepted source bindings',()=>{
  const p=projection([event(1,'order_created'),event(2,'pix_received',{amount_minor:'900'})])
  const cases=privateCases(p,{export_sha256:'0'.repeat(64)}),c=cases[0]!
  expect(c.model_input_hash).toBe(hashOf(buildModelInput(c.kind,c.facts,c.evidence)))
  expect(c.source_bindings[0]).toMatchObject({lote_sha256:'a'.repeat(64),trio_sha256:'b'.repeat(64),event_ids:['evt_'+hex(1),'evt_'+hex(2)]})
  expect(c.export_sha256).toBe('0'.repeat(64));expect(c.case_id).toMatch(/^shx_[a-f0-9]{64}$/)
  const reordered=projection([...p.events].reverse());expect(privateCases(reordered,{export_sha256:'0'.repeat(64)})[0]?.model_input_hash).toBe(c.model_input_hash)
 })
 it('model/Codex advisories stay awaiting_human and stale or unsafe rows are ignored',()=>{
  const events=[event(1,'order_created'),event(2,'pix_received',{amount_minor:'900'})],p=projection(events),c=p.cases[0]!
  const model=review(c),operator=review(c,{engine:'operator',actor:'codex',model:null,capture_receipt_sha256:null,private_verdict_hash:null})
  const reviewed=projection(events,[model,operator]),s=shadowSummary(reviewed)
  expect(s.exceptions).toMatchObject({by_model:1,codex_advisories:1,resolved:0,awaiting_human:1,decided_by_operator:0})
  expect(publicShadowCase(reviewed.cases[0]!).verdict?.engine_label).toBe('Codex-assisted operator advisory')
  for(const broken of [{...model,input_hash:'0'.repeat(64)},{...model,requires_human:false},{...model,rationale:'private@example.com'},{...model,capture_receipt_sha256:null},{...model,confidence:0.85}])expect(validateShadowReview(broken,c)).toBeNull()
  const changed=projection([events[0]!,event(2,'pix_received',{amount_minor:'800'})],[model]);expect(changed.reviews).toEqual([])
 })
 it('confidence and millisecond timestamps reproduce typed review hashes without rounding',()=>{
  const c=projection([event(1,'order_created'),event(2,'pix_received',{amount_minor:'900'})]).cases[0]!,r=review(c)
  expect(validateShadowReview(r,c)?.confidence).toBe(0.84999999)
  expect(validateShadowReview({...r,confidence:'0.84999999'},c)?.review_id).toBe(r.review_id)
  expect(validateShadowReview({...r,created_at:'2026-10-08T00:00:00Z'},c)).toBeNull()
  const zero=review(c,{created_at:'2026-10-08T00:00:00.000Z'})
  expect(validateShadowReview(zero,c)?.created_at).toBe('2026-10-08T00:00:00Z')
 })
 it('BigInt aggregation remains exact beyond safe-number cents',()=>{
  const events:Record<string,unknown>[]=[]
  for(let i=1;i<=10000;i++){const common={order_ref:'ord_'+hex(i),amount_minor:'999999999999'};events.push(event(i*2-1,'order_created',common),event(i*2,'pix_received',common))}
  events.push(event(20001,'order_created',{order_ref:'ord_'+hex(10001),amount_minor:'1'}),event(20002,'pix_received',{order_ref:'ord_'+hex(10001),amount_minor:'1'}))
  const s=shadowSummary(projection(events));expect(s.orders.paid_minor).toBe('9999999999990001')
  expect(formatMinor('9007199254740993')).toBe('R$ 90071992547409.93')
 })
 it('rejects missing batch binding and invalid typed financial values',()=>{
  for(const bad of [{amount_minor:'0'},{amount_minor:'NaN'},{currency:'USD'},{order_ref:'email@example.com'},{first_batch:'0'.repeat(64)}])expect(()=>projection([event(1,'order_created',bad)])).toThrow()
 })
 it('GET topology reads one typed SELECT snapshot and never touches core/model/network/writes',async()=>{
  const events=[event(1,'order_created'),event(2,'pix_received',{amount_minor:'900'})],sqls:string[]=[]
  const fetch=vi.fn(()=>{throw new Error('network forbidden')});vi.stubGlobal('fetch',fetch)
  const ctx={now:()=>new Date(NOW),cfg:{publicReplayReadOnly:false,pilotSettle:false},db:{query:async(sql:string)=>{sqls.push(sql);expect(sql.trim()).toMatch(/^SELECT/);expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|outbox|orders|exceptions|receipts|settlements|copilot_verdicts|attested_events)\b/);const tables=[...sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)].map(m=>m[1]);expect(tables).toEqual(expect.arrayContaining(['pilot_shadow_events','pilot_shadow_batches','pilot_shadow_reviews']));for(const table of tables)expect(['pilot_shadow_events','pilot_shadow_batches','pilot_shadow_reviews']).toContain(table);return {rows:[{events,batches:[batch()],reviews:[]}]}}}} as unknown as Ctx
  const app=Fastify();registerPilot(app,ctx,{hmacSecret:'',operatorToken:'',shadowPublic:true})
  try{
   const s=await app.inject('/pilot/api/summary');expect(s.statusCode).toBe(200);expect(s.json().public_read_only).toBe(true)
   const listed=await app.inject('/pilot/api/exceptions?store='+publicStore('src_test','store_1'));expect(listed.statusCode).toBe(200);const id=listed.json().exceptions[0].id
   const detail=await app.inject('/pilot/api/exceptions/'+id);expect(detail.statusCode).toBe(200);expect(detail.json().receipts).toEqual([])
   for(const [url,code] of [['/pilot/v1/events','pilot_v1_disabled'],['/pilot/v1/process','pilot_v1_disabled'],['/pilot/api/exceptions/'+id+'/decide','replay_readonly']]){const r=await app.inject({method:'POST',url,payload:{}});expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe(code)}
   expect(sqls).toHaveLength(3);expect(fetch).not.toHaveBeenCalled()
  }finally{await app.close()}
 })
 it('store filter is scoped across origins and failed snapshot never falls back to core',async()=>{
  const other={origin:'src_other'},events=[event(1,'order_created'),event(2,'pix_received',{amount_minor:'900'}),event(1,'order_created',other),event(2,'pix_received',{...other,amount_minor:'800'})]
  let fail=false;const ctx={now:()=>new Date(NOW),cfg:{},db:{query:async(sql:string)=>{expect(sql).toContain('pilot_shadow_events');if(fail)throw new Error('private@example.com');return {rows:[{events,batches:[batch(),batch('src_other')],reviews:[]}]}}}} as unknown as Ctx
  const app=Fastify();registerPilot(app,ctx,{hmacSecret:'',operatorToken:'',shadowPublic:true})
  try{const list=await app.inject('/pilot/api/exceptions?store='+publicStore('src_test','store_1'));expect(list.json().exceptions).toHaveLength(1)
   fail=true;const bad=await app.inject('/pilot/api/summary');expect(bad.statusCode).toBe(503);expect(bad.body).not.toContain('private@')
  }finally{await app.close()}
 })
 it('passes the public flag solely to core environment',()=>{
  expect(corePassthroughEnv({PILOT_SHADOW_PUBLIC:'1',TREASURY_KEY:'do-not-pass'})).toMatchObject({PILOT_SHADOW_PUBLIC:'1'})
  expect(corePassthroughEnv({PILOT_SHADOW_PUBLIC:'1',TREASURY_KEY:'do-not-pass'})).not.toHaveProperty('TREASURY_KEY')
 })
})
