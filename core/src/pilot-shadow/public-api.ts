/** Closed public DTOs of typed shadow observations and advisory reviews. GETs only. */
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { ACTIONS, ACTION_LABEL } from '../copilot/verdict.js'
import { ADVISORY_RATIONALE, loadShadowProjection, publicStore, type ShadowCase, type ShadowProjection, type ShadowReview } from './projection.js'
const ENGINE_LABEL={rules:'Rules advisory',model:'Model advisory',operator:'Operator advisory'}
const safeModel=(v:unknown)=>v==='openai/gpt-4.1-mini'||v==='openai/gpt-4o-mini'?v:null
const reasonSummary={amount_mismatch:'The observed payment amount differs from the order amount.',duplicate_payment:'More than one payment reference was observed for this order.',orphan_payment:'A payment was observed without a matching order creation.',payment_conflict:'A payment reference has conflicting observations.',order_conflict:'An order reference has multiple creation observations.',late_payment:'A payment was observed after the explicitly stated expiry.',refund_observed:'A refund observation requires reconciliation review.',orphan_refund:'A refund observation lacks a matching order or payment.',med_observed:'A MED observation requires review of the evidence.',orphan_med:'A MED observation lacks a matching order or payment.'} as const

export function publicShadowVerdict(r:ShadowReview){return {
 id:r.review_id,engine:r.engine,actor:r.actor,engine_label:r.actor==='codex'?'Codex-assisted operator advisory':ENGINE_LABEL[r.engine],model:safeModel(r.model),
 action:r.action,action_label:ACTION_LABEL[r.action]??'Review required',confidence:r.confidence,requires_human:true,
 rationale:ADVISORY_RATIONALE,evidence_refs:[...r.evidence_refs],input_hash:r.input_hash,verdict_hash:r.verdict_hash,
 latency_ms:r.latency_ms,created_at:r.created_at,advisory:true,human_confirmation:false,bank_settlement:false,
 capture_receipt_sha256:r.capture_receipt_sha256,private_verdict_hash:r.private_verdict_hash,
}}

export function publicShadowCase(c:ShadowCase){
 const last=c.reviews.at(-1)??null,model=c.reviews.some(r=>r.engine==='model')
 return {id:c.case_id,kind:c.kind,reason_code:c.reason_code,severity:['amount_mismatch','duplicate_payment','payment_conflict','order_conflict','med_observed'].includes(c.reason_code)?'high':'medium',
  status:'awaiting_human',copilot_state:model?'model_done':c.reviews.some(r=>r.engine==='rules')?'rules_only':'model_off',
  summary:reasonSummary[c.reason_code],detected_at:c.detected_at,updated_at:last?.created_at??c.detected_at,resolved_at:null,
  order_id:null,order_status:c.facts.order?'observed':null,order_amount_minor:c.facts.order?.amount_minor??null,paid_at:c.facts.payment?.paid_at??null,
  ord:c.order_ref,store:publicStore(c.origin,c.store),hold_reason:'shadow_review_required',resolution:null,last_error:null,
  evidence:c.evidence.map(e=>({id:e.id,fact:e.fact})),verdict:last?publicShadowVerdict(last):null,
  advisory:true,human_confirmation:false,bank_settlement:false,
 }
}

export function shadowSummary(p:ShadowProjection,configuredModel:unknown=null){
 const scopes=[...new Map(p.orders.map(o=>[publicStore(o.origin,o.store),{origin:o.origin,store:o.store}])).values()]
 const stores=scopes.map(({origin,store})=>{const orders=p.orders.filter(o=>o.origin===origin&&o.store===store);return {code:publicStore(origin,store),store_type:'shadow',orders:orders.length,paid:orders.filter(o=>o.paid_exact).length,
  paid_minor:orders.reduce((n,o)=>n+BigInt(o.paid_minor),0n).toString(),exceptions:p.cases.filter(c=>c.origin===origin&&c.store===store).length}}).sort((a,b)=>a.code.localeCompare(b.code))
 const by_event=[...new Set(p.events.map(e=>e.event_type))].sort().map(ev=>({ev,n:p.events.filter(e=>e.event_type===ev).length}))
 const by_kind_status=[...new Set(p.cases.map(c=>c.kind))].sort().map(kind=>({kind,status:'awaiting_human',n:p.cases.filter(c=>c.kind===kind).length}))
 const verdicts=['rules','model','operator'].map(engine=>({engine,n:p.reviews.filter(r=>r.engine===engine).length})).filter(r=>r.n>0)
 const byModel=p.cases.filter(c=>c.reviews.some(r=>r.engine==='model')).length,byRules=p.cases.filter(c=>c.reviews.some(r=>r.engine==='rules')).length
 const last=p.events.at(-1)
 return {generated_at:p.generated_at,public_read_only:true,copilot_model:{name:safeModel(configuredModel),mode:'replay',reason:'stored_advisories_only'},pilot_settle:false,
  scope:'validated_shadow_observations_and_advisory_reviews',store_count_basis:'scoped origin/store aliases; no claim of distinct physical merchants',bank_settlement:false,all_streams:p.all_streams,active_order_streams:p.active_order_streams,active_order_stores:p.active_order_stores,
  events:{total:p.events.length,processed:p.events.length,ignored:0,pending:0,unmapped:0,errors:0,first_ts:p.events[0]?.event_at??null,last_ts:last?.event_at??null,last_received_at:p.events.map(e=>e.received_at).sort().at(-1)??null},
  stores,by_event,exceptions:{by_kind_status,exceptions:p.cases.length,resolved:0,resolved_by_rules:0,auto_applied:0,awaiting_human:p.cases.length,
   decided_by_operator:0,operator_agreed:0,operator_disagreed:0,by_rules:byRules,by_model:byModel,model_pending:0,model_error:0,model_off:p.cases.length-byModel,
   model_jobs_pending:0,model_advisories:p.reviews.filter(r=>r.engine==='model').length,rules_advisories:p.reviews.filter(r=>r.engine==='rules').length,
   operator_advisories:p.reviews.filter(r=>r.engine==='operator').length,codex_advisories:p.reviews.filter(r=>r.actor==='codex').length,
   explanation:'Shadow reviews are advisory. No resolution or human approval is recorded by this projection.'},verdicts,
  orders:{orders:p.orders.length,paid:p.orders.filter(o=>o.paid_exact).length,paid_minor:p.orders.reduce((n,o)=>n+BigInt(o.paid_minor),0n).toString(),settled:0,
   on_hold:p.orders.filter(o=>o.hold).length,settlements_confirmed:0,receipts:0,pix_observed:p.payment_stats.events,pix_observed_minor:p.payment_stats.observed_minor,
   pix_unique_payment_refs:p.payment_stats.unique_payment_refs,pix_unambiguous_minor:p.payment_stats.unambiguous_minor,pix_semantic_duplicate_events:p.payment_stats.semantic_duplicate_events,
   pix_conflicting_payment_refs:p.payment_stats.conflicting_payment_refs,pix_observed_basis:'unique validated event identities; not bank settlement'},
  projection:{events:p.events.length,by_type:Object.fromEntries(['order_created','pix_received','refund','med','partner_withdrawal','wallet_charge','order_cancelled'].map(type=>[type,p.events.filter(e=>e.event_type===type).length]))},
  last_event:last?{ev:last.event_type,ts:last.event_at,store_code:publicStore(last.origin,last.store),received_at:last.received_at}:null,
 }
}

export function registerShadowPublic(app:FastifyInstance,db:Pick<Db,'query'>,opts:{now:()=>Date;configuredModel?:unknown}){
 const load=()=>loadShadowProjection(db,opts.now().toISOString())
 const fail=(reply:any)=>reply.code(503).send({error:{code:'shadow_projection_unavailable',message:'validated shadow projection is unavailable'}})
 app.get('/pilot/api/summary',async(_req,reply)=>{try{return shadowSummary(await load(),opts.configuredModel)}catch{return fail(reply)}})
 app.get('/pilot/api/exceptions',async(req,reply)=>{try{
  const q=(req.query??{}) as Record<string,unknown>;const p=await load()
  const kind=typeof q.kind==='string'&&Object.hasOwn(ACTIONS,q.kind)?q.kind:null
  const store=typeof q.store==='string'&&/^store-[0-9a-f]{12}$/.test(q.store)?q.store:null
  const status=typeof q.status==='string'?q.status:null
  const limit=typeof q.limit==='string'&&/^\d{1,3}$/.test(q.limit)?Math.min(200,Math.max(1,Number(q.limit))):50
  const filtered=p.cases.filter(c=>(!kind||c.kind===kind)&&(!store||publicStore(c.origin,c.store)===store)&&(!status||status==='awaiting_human'))
  return {exceptions:filtered.slice(0,limit).map(publicShadowCase)}
 }catch{return fail(reply)}})
 app.get('/pilot/api/exceptions/:id',async(req,reply)=>{try{
  const id=String((req.params as {id:string}).id)
  if(!/^shx_[0-9a-f]{64}$/.test(id))return reply.code(404).send({error:{code:'not_found',message:'shadow review case not found'}})
  const p=await load(),c=p.cases.find(c=>c.case_id===id)
  if(!c)return reply.code(404).send({error:{code:'not_found',message:'shadow review case not found'}})
  return {...publicShadowCase(c),allowed_actions:ACTIONS[c.kind].map(action=>({action,label:ACTION_LABEL[action]??'Review required'})),
   verdicts:c.reviews.map(publicShadowVerdict),timeline:c.reviews.map(r=>({from_state:'awaiting_human',to_state:'awaiting_human',
    reason:r.actor==='codex'?'Codex-assisted advisory recorded; human confirmation is still required.':`${ENGINE_LABEL[r.engine]} recorded; human confirmation is still required.`,
    source:r.actor==='codex'?'codex_advisory':r.engine+'_advisory',created_at:r.created_at})),receipts:[]}
 }catch{return fail(reply)}})
}
