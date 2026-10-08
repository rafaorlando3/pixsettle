/** Pure, read-only projection of accepted E1 1.3 facts. No financial-core access. */
import { applyRules, type ExceptionFacts } from '../copilot/rules.js'
import { buildModelInput } from '../copilot/judge.js'
import { ACTIONS, hashOf, validateVerdict, type Evidence, type ExceptionKind, type Verdict } from '../copilot/verdict.js'
import type { Db } from '../db.js'
import { EVENT_TYPES, type ShadowEventType } from './types.js'

const HASH=/^[0-9a-f]{64}$/;const ORIGIN=/^src_[a-z0-9]{1,16}$/;const STORE=/^store_[0-9]{1,3}$/
const REF=/^(ord|pay|cli|par)_[0-9a-f]{16}$/;const EVENT=/^evt_[0-9a-f]{16}$/
export const ADVISORY_RATIONALE='Advisory recorded from validated shadow evidence. Human confirmation is still required.'
export type ShadowRow={origin:string;store:string;event_id:string;cursor:string;event_type:ShadowEventType;event_at:string;
 amount_minor:string;currency:'BRL';order_ref:string|null;payment_ref:string|null;refers_to:string|null;party_ref:string|null;
 expires_at:string|null;payer_self_identified:boolean|null;line_sha256:string;first_batch:string;received_at:string}
export type ShadowBatchRow={origin:string;store:string;lote_sha256:string;trio_sha256:string;atestado_sha256:string;pronto_sha256:string;committed_at:string}
export type ShadowReview={review_id:string;case_id:string;origin:string;store:string;input_hash:string;projection_hash:string;
 engine:'rules'|'model'|'operator';actor:'rules'|'model'|'codex'|'human_operator';model:'openai/gpt-4.1-mini'|'openai/gpt-4o-mini'|null;
 action:string;confidence:number;requires_human:true;advisory:true;evidence_refs:string[];verdict_hash:string;
 capture_receipt_sha256:string|null;private_verdict_hash:string|null;latency_ms:number|null;created_at:string}
export type ShadowReason='amount_mismatch'|'duplicate_payment'|'orphan_payment'|'payment_conflict'|'order_conflict'|'late_payment'|'refund_observed'|'orphan_refund'|'med_observed'|'orphan_med'
export type ShadowCase={case_id:string;origin:string;store:string;kind:ExceptionKind;reason_code:ShadowReason;facts:ExceptionFacts;
 evidence:Evidence[];model_input_hash:string;projection_hash:string;detected_at:string;order_ref:string|null;
 source_bindings:Array<{lote_sha256:string;trio_sha256:string;atestado_sha256:string;pronto_sha256:string;event_ids:string[]}>;
 advisory_rules:Verdict|null;reviews:ShadowReview[]}
export type ShadowProjection={events:ShadowRow[];batches:ShadowBatchRow[];cases:ShadowCase[];reviews:ShadowReview[];
 orders:Array<{origin:string;store:string;order_ref:string;amount_minor:string;paid_exact:boolean;paid_minor:string;hold:boolean;created_at:string;expires_at:string|null;paid_at:string|null;status:string}>;
 payment_stats:{events:number;observed_minor:string;unique_payment_refs:number;unambiguous_minor:string;semantic_duplicate_events:number;conflicting_payment_refs:number};
 all_streams:number;active_order_streams:number;active_order_stores:number;generated_at:string}

function iso(value:unknown):string|null{
 const s=value instanceof Date?value.toISOString():value
 if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|\+00:00)$/.test(s)||!Number.isFinite(Date.parse(s)))return null
 return new Date(s).toISOString().replace('.000Z','Z')
}
export const formatMinor=(value:string|bigint):string=>{const n=BigInt(value);return `${n<0n?'-':''}R$ ${(n<0n?-n:n)/100n}.${((n<0n?-n:n)%100n).toString().padStart(2,'0')}`}
export const publicStore=(origin:string,store:string):string=>'store-'+hashOf({origin,store}).slice(0,12)
const key=(origin:string,store:string,ref:string)=>JSON.stringify([origin,store,ref])
const safeHash=(v:unknown):v is string=>typeof v==='string'&&HASH.test(v)

function typedEvent(raw:Record<string,unknown>):ShadowRow{
 if(!ORIGIN.test(String(raw.origin))||!STORE.test(String(raw.store))||!EVENT.test(String(raw.event_id))||
    !EVENT_TYPES.includes(raw.event_type as ShadowEventType)||typeof raw.amount_minor!=='string'||!/^\d{1,13}$/.test(raw.amount_minor)||
    BigInt(raw.amount_minor)<=0n||BigInt(raw.amount_minor)>1000000000000n||raw.currency!=='BRL'||!safeHash(raw.line_sha256)||!safeHash(raw.first_batch))throw new Error('shadow_projection_invalid_event')
 const at=iso(raw.event_at),received=iso(raw.received_at),expires=raw.expires_at==null?null:iso(raw.expires_at)
 if(!at||!received||raw.expires_at!=null&&!expires||typeof raw.cursor!=='string'||!/^\d{8}T\d{6}Z\/evt_[0-9a-f]{16}$/.test(raw.cursor))throw new Error('shadow_projection_invalid_time')
 const reference=(field:string,prefix:string):string|null=>{const v=raw[field];if(v==null)return null;if(typeof v!=='string'||!REF.test(v)||!v.startsWith(prefix+'_'))throw new Error('shadow_projection_invalid_reference');return v}
 const e:ShadowRow={origin:String(raw.origin),store:String(raw.store),event_id:String(raw.event_id),cursor:raw.cursor,event_type:raw.event_type as ShadowEventType,
  event_at:at,received_at:received,expires_at:expires,amount_minor:BigInt(raw.amount_minor).toString(),currency:'BRL',line_sha256:raw.line_sha256,first_batch:raw.first_batch,
  order_ref:reference('order_ref','ord'),payment_ref:reference('payment_ref','pay'),refers_to:reference('refers_to','pay'),
  party_ref:raw.party_ref==null?null:reference('party_ref',raw.event_type==='partner_withdrawal'?'par':'cli'),
  payer_self_identified:typeof raw.payer_self_identified==='boolean'?raw.payer_self_identified:null}
 const needsOrder=['order_created','pix_received','refund','med','order_cancelled'].includes(e.event_type)
 if(needsOrder&&!e.order_ref||e.event_type==='pix_received'&&!e.payment_ref||['refund','med'].includes(e.event_type)&&!e.refers_to)throw new Error('shadow_projection_invalid_matrix')
 return e
}

function typedBatch(raw:Record<string,unknown>):ShadowBatchRow{
 if(!ORIGIN.test(String(raw.origin))||!STORE.test(String(raw.store))||!['lote_sha256','trio_sha256','atestado_sha256','pronto_sha256'].every(k=>safeHash(raw[k]))||!iso(raw.committed_at))throw new Error('shadow_projection_invalid_batch')
 return {origin:String(raw.origin),store:String(raw.store),lote_sha256:String(raw.lote_sha256),trio_sha256:String(raw.trio_sha256),atestado_sha256:String(raw.atestado_sha256),pronto_sha256:String(raw.pronto_sha256),committed_at:iso(raw.committed_at)!}
}

const REVIEW_FIELDS=['review_id','case_id','origin','store','input_hash','projection_hash','engine','actor','model','action','confidence','requires_human','advisory','evidence_refs','verdict_hash','capture_receipt_sha256','private_verdict_hash','latency_ms','created_at']
export function advisoryVerdict(review:Pick<ShadowReview,'action'|'confidence'|'evidence_refs'>):Verdict{
 return {action:review.action,confidence:review.confidence,requires_human:true,rationale:ADVISORY_RATIONALE,evidence_refs:[...review.evidence_refs]}
}
export function canonicalReviewTimestamp(value:string):string{const normalized=iso(value);if(!normalized)throw new Error('shadow_review_timestamp');return normalized}
export function reviewId(row:Omit<ShadowReview,'review_id'>):string{return hashOf({...row,created_at:canonicalReviewTimestamp(row.created_at)})}
/** Closed advisory row; stale input/projection and unproved model rows are ignored. */
export function validateShadowReview(raw:unknown,c:ShadowCase):ShadowReview|null{
 try{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null
  const r=raw as Record<string,unknown>
  if(Object.keys(r).length!==REVIEW_FIELDS.length||Object.keys(r).some(k=>!REVIEW_FIELDS.includes(k))||
   r.case_id!==c.case_id||r.origin!==c.origin||r.store!==c.store||r.input_hash!==c.model_input_hash||r.projection_hash!==c.projection_hash||
   r.requires_human!==true||r.advisory!==true||!safeHash(r.review_id)||!safeHash(r.verdict_hash)||!iso(r.created_at)||
   r.latency_ms!==null&&(typeof r.latency_ms!=='number'||!Number.isInteger(r.latency_ms)||r.latency_ms<0||r.latency_ms>3600000)||
   !Array.isArray(r.evidence_refs)||r.evidence_refs.length>50||new Set(r.evidence_refs).size!==r.evidence_refs.length)return null
  const engine=r.engine,actor=r.actor,model=r.model
  if(!(engine==='rules'&&actor==='rules'&&model===null||engine==='model'&&actor==='model'&&['openai/gpt-4.1-mini','openai/gpt-4o-mini'].includes(String(model))&&safeHash(r.capture_receipt_sha256)&&safeHash(r.private_verdict_hash)||engine==='operator'&&['codex','human_operator'].includes(String(actor))&&model===null))return null
  if(r.capture_receipt_sha256!==null&&!safeHash(r.capture_receipt_sha256)||r.private_verdict_hash!==null&&!safeHash(r.private_verdict_hash))return null
  const confidence=typeof r.confidence==='string'&&/^0(?:\.\d{1,32})?$|^1(?:\.0{1,32})?$/.test(r.confidence)?Number(r.confidence):r.confidence
  const candidate={action:r.action,confidence,requires_human:true,rationale:ADVISORY_RATIONALE,evidence_refs:r.evidence_refs}
  const checked=validateVerdict(c.kind,candidate,c.evidence)
  if(!checked.ok||hashOf(checked.verdict)!==r.verdict_hash)return null
  const normalized={...r,confidence,created_at:iso(r.created_at)!} as unknown as ShadowReview
  const {review_id,...body}=normalized
  if(reviewId(body)!==review_id)return null
  return normalized
 }catch{return null}
}

export function buildShadowProjection(rawEvents:Record<string,unknown>[],rawBatches:Record<string,unknown>[],rawReviews:unknown[],nowISO:string):ShadowProjection{
 if(rawEvents.length>100000||rawBatches.length>10000||rawReviews.length>100000||!iso(nowISO))throw new Error('shadow_projection_bounds')
 const events=rawEvents.map(typedEvent).sort((a,b)=>Date.parse(a.event_at)-Date.parse(b.event_at)||key(a.origin,a.store,a.event_id).localeCompare(key(b.origin,b.store,b.event_id)))
 const batches=rawBatches.map(typedBatch).sort((a,b)=>key(a.origin,a.store,a.lote_sha256).localeCompare(key(b.origin,b.store,b.lote_sha256)))
 const batchMap=new Map(batches.map(b=>[key(b.origin,b.store,b.lote_sha256),b]));const eventIds=new Set<string>()
 for(const e of events){const id=key(e.origin,e.store,e.event_id);if(eventIds.has(id)||!batchMap.has(key(e.origin,e.store,e.first_batch)))throw new Error('shadow_projection_event_binding');eventIds.add(id)}
 const groups=new Map<string,ShadowRow[]>(),payments=new Map<string,ShadowRow[]>(),cases:ShadowCase[]=[]
 for(const e of events){if(e.order_ref){const k=key(e.origin,e.store,e.order_ref);groups.set(k,[...(groups.get(k)??[]),e])}if(e.event_type==='pix_received'){const k=key(e.origin,e.store,e.payment_ref!);payments.set(k,[...(payments.get(k)??[]),e])}}
 const conflictingPayments=new Set<string>();let semanticDuplicates=0,unambiguousMinor=0n
 for(const [k,p] of payments){const meanings=new Set(p.map(e=>JSON.stringify([e.order_ref,e.amount_minor,e.event_at])));if(meanings.size>1)conflictingPayments.add(k);else{semanticDuplicates+=p.length-1;unambiguousMinor+=BigInt(p[0]!.amount_minor)}}
 const makeCase=(reason:ShadowReason,related:ShadowRow[],order:ShadowRow|null,payment:ShadowRow|null):void=>{
  const sorted=[...new Map(related.map(e=>[key(e.origin,e.store,e.event_id),e])).values()].sort((a,b)=>key(a.origin,a.store,a.event_id).localeCompare(key(b.origin,b.store,b.event_id)))
  const first=sorted[0]!;const projection_hash=hashOf(sorted.map(({received_at,...e})=>e))
  const kind:ExceptionKind=reason==='amount_mismatch'?'amount_mismatch':reason==='duplicate_payment'?'duplicate_payment':reason==='late_payment'?'late_payment':reason==='refund_observed'?'refund_requested':reason==='med_observed'?'med_reported':'manual_divergent'
  const evidence:Evidence[]=sorted.slice(0,50).map((e,i)=>({id:`e${i+1}`,fact:`${e.event_type.replaceAll('_',' ')} observed: ${formatMinor(e.amount_minor)} at ${e.event_at}.`,ref:{event_id:e.event_id,line_sha256:e.line_sha256}}))
  const facts:ExceptionFacts={kind,store:first.store,context:{reason_code:reason,origin:first.origin,projection_hash,validated_events:sorted.length,bank_settlement:false},
   ...(order?{order:{amount_minor:order.amount_minor,status:'observed',created_at:order.event_at,expires_at:order.expires_at,paid_at:payment?.event_at??null}}:{}),
   ...(payment&&order?{payment:{chg:payment.payment_ref??payment.refers_to??'unknown',amount_minor:payment.amount_minor,paid_at:payment.event_at,expected_minor:order.amount_minor}}:{})}
  if(kind==='duplicate_payment')facts.charges=sorted.filter(e=>e.event_type==='pix_received').slice(0,50).map(e=>({chg:e.payment_ref!,state:'paid',amount_minor:e.amount_minor,created_at:null,expires_at:null,paid_at:e.event_at,paid_minor:e.amount_minor,provider:'shadow_observation'}))
  if(kind==='refund_requested'){const r=sorted.find(e=>e.event_type==='refund')!;facts.refund={amount_minor:r.amount_minor,state:'observed'}}
  if(kind==='med_reported'){const m=sorted.find(e=>e.event_type==='med')!;facts.med={amount_minor:m.amount_minor,reported_at:m.event_at,status:'observed',order_status:'observed',days_since_payment:null}}
  const model_input_hash=hashOf(buildModelInput(kind,facts,evidence));const case_id='shx_'+hashOf({origin:first.origin,store:first.store,reason,refs:sorted.flatMap(e=>[e.order_ref,e.payment_ref,e.refers_to]).filter(Boolean).sort(),projection_hash})
  const bindings=new Map<string,ShadowCase['source_bindings'][number]>()
  for(const e of sorted){const b=batchMap.get(key(e.origin,e.store,e.first_batch))!;let entry=bindings.get(b.lote_sha256);if(!entry){entry={lote_sha256:b.lote_sha256,trio_sha256:b.trio_sha256,atestado_sha256:b.atestado_sha256,pronto_sha256:b.pronto_sha256,event_ids:[]};bindings.set(b.lote_sha256,entry)}entry.event_ids.push(e.event_id)}
  const out=applyRules(facts,evidence);const validation='verdict'in out?validateVerdict(kind,{...out.verdict,requires_human:true},evidence):null
  cases.push({case_id,origin:first.origin,store:first.store,kind,reason_code:reason,facts,evidence,model_input_hash,projection_hash,detected_at:sorted.map(e=>e.event_at).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)!,order_ref:order?.order_ref??payment?.order_ref??first.order_ref,
   source_bindings:[...bindings.values()].sort((a,b)=>a.lote_sha256.localeCompare(b.lote_sha256)),advisory_rules:validation?.ok?{...validation.verdict,rationale:ADVISORY_RATIONALE}:null,reviews:[]})
 }
 for(const k of conflictingPayments){const related=payments.get(k)!;makeCase('payment_conflict',related,null,related[0]!)}
 const orders:ShadowProjection['orders']=[]
 for(const related of groups.values()){
  const created=related.filter(e=>e.event_type==='order_created'),received=related.filter(e=>e.event_type==='pix_received');const order=created.length===1?created[0]!:null
  if(created.length>1)makeCase('order_conflict',related,null,received[0]??null)
  const canonicalPayments=[...new Map(received.filter(e=>!conflictingPayments.has(key(e.origin,e.store,e.payment_ref!))).map(e=>[e.payment_ref!,e])).values()]
  if(!created.length)for(const p of canonicalPayments)makeCase('orphan_payment',[p],null,p)
  if(order&&canonicalPayments.length>1)makeCase('duplicate_payment',[order,...canonicalPayments],order,canonicalPayments[0]!)
  if(order)for(const p of canonicalPayments){if(p.amount_minor!==order.amount_minor)makeCase('amount_mismatch',[order,p],order,p);if(order.expires_at&&Date.parse(p.event_at)>Date.parse(order.expires_at))makeCase('late_payment',[order,p],order,p)}
  for(const e of related.filter(e=>['refund','med'].includes(e.event_type))){const observed=payments.get(key(e.origin,e.store,e.refers_to!));const p=observed&&!conflictingPayments.has(key(e.origin,e.store,e.refers_to!))&&observed[0]?.order_ref===e.order_ref?observed[0]:null;
   makeCase(e.event_type==='refund'?(order&&p?'refund_observed':'orphan_refund'):(order&&p?'med_observed':'orphan_med'),[e,...(order?[order]:[]),...(p?[p]:[])],order,p)}
  if(created.length){const base=created[0]!,one=canonicalPayments.length===1?canonicalPayments[0]!:null;const exact=created.length===1&&one?.amount_minor===base.amount_minor&&!received.some(e=>conflictingPayments.has(key(e.origin,e.store,e.payment_ref!)))
   orders.push({origin:base.origin,store:base.store,order_ref:base.order_ref!,amount_minor:base.amount_minor,paid_exact:exact,paid_minor:exact?one!.amount_minor:'0',hold:created.length!==1||canonicalPayments.length>1||received.some(p=>p.amount_minor!==base.amount_minor||conflictingPayments.has(key(p.origin,p.store,p.payment_ref!))),created_at:base.event_at,expires_at:base.expires_at,paid_at:exact?one!.event_at:null,status:created.length!==1?'conflicting':exact?'paid_exact_observed':'awaiting_payment'})}
 }
 const caseIds=new Set<string>();for(const c of cases){if(caseIds.has(c.case_id))throw new Error('shadow_projection_duplicate_case');caseIds.add(c.case_id);c.reviews=rawReviews.map(r=>validateShadowReview(r,c)).filter((r):r is ShadowReview=>r!==null).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||a.review_id.localeCompare(b.review_id))}
 const reviews=cases.flatMap(c=>c.reviews)
 return {events,batches,cases:cases.sort((a,b)=>a.case_id.localeCompare(b.case_id)),reviews,orders,payment_stats:{events:events.filter(e=>e.event_type==='pix_received').length,observed_minor:events.filter(e=>e.event_type==='pix_received').reduce((n,e)=>n+BigInt(e.amount_minor),0n).toString(),unique_payment_refs:payments.size,unambiguous_minor:unambiguousMinor.toString(),semantic_duplicate_events:semanticDuplicates,conflicting_payment_refs:conflictingPayments.size},
 all_streams:new Set(events.map(e=>key(e.origin,e.store,''))).size,active_order_streams:new Set(orders.map(o=>key(o.origin,o.store,''))).size,active_order_stores:new Set(orders.map(o=>key(o.origin,o.store,''))).size,generated_at:iso(nowISO)!}
}

/** Single SELECT snapshot. Only typed shadow tables; never core financial objects/outbox. */
export async function loadShadowProjection(db:Pick<Db,'query'>,nowISO:string):Promise<ShadowProjection>{
 const row=(await db.query(`SELECT
 coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM (SELECT p.origin,p.store,p.event_id,p.cursor,p.event_type,to_char(p.event_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS event_at,p.amount_minor::text,p.currency,p.order_ref,p.payment_ref,p.refers_to,p.party_ref,to_char(p.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at,p.payer_self_identified,p.line_sha256,p.first_batch,to_char(p.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received_at FROM pilot_shadow_events p JOIN pilot_shadow_batches b ON b.origin=p.origin AND b.store=p.store AND b.lote_sha256=p.first_batch WHERE b.result='accepted') e),'[]'::jsonb) AS events,
 coalesce((SELECT jsonb_agg(to_jsonb(b)) FROM (SELECT origin,store,lote_sha256,trio_sha256,atestado_sha256,pronto_sha256,to_char(committed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS committed_at FROM pilot_shadow_batches WHERE result='accepted') b),'[]'::jsonb) AS batches,
 coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT review_id,case_id,origin,store,input_hash,projection_hash,engine,actor,model,action,confidence::float8,requires_human,advisory,evidence_refs,verdict_hash,capture_receipt_sha256,private_verdict_hash,latency_ms,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at FROM pilot_shadow_reviews) r),'[]'::jsonb) AS reviews`)).rows[0]
 if(!row||!Array.isArray(row.events)||!Array.isArray(row.batches)||!Array.isArray(row.reviews))throw new Error('shadow_projection_snapshot_invalid')
 return buildShadowProjection(row.events,row.batches,row.reviews,nowISO)
}

/** Private capture bridge. Hashes bind exact prompts, typed facts and accepted trios. */
export function privateCases(p:ShadowProjection,provenance:{export_sha256:string}){
 if(!HASH.test(provenance.export_sha256))throw new Error('shadow_projection_export_identity')
 return p.cases.map(c=>({case_id:c.case_id,origin:c.origin,store:c.store,kind:c.kind,reason_code:c.reason_code,facts:structuredClone(c.facts),evidence:structuredClone(c.evidence),model_input:buildModelInput(c.kind,c.facts,c.evidence),model_input_hash:c.model_input_hash,projection_hash:c.projection_hash,detected_at:c.detected_at,export_sha256:provenance.export_sha256,source_bindings:structuredClone(c.source_bindings)}))
}
