import {test} from 'vitest'
import assert from 'node:assert/strict'
import {buildModelInput} from '../src/copilot/judge.js'
import {hashOf} from '../src/copilot/verdict.js'

test('model input preserves the exact hash across recursive facts-key reordering',()=>{
 const left={kind:'amount_mismatch' as const,store:'store_001',context:{origin:'src_fixture',projection_hash:'a'.repeat(64),bank_settlement:false},payment:{amount_minor:'500',expected_minor:'1000',paid_at:null,chg:'pay_'+'a'.repeat(16)}}
 const right={payment:{chg:left.payment.chg,paid_at:null,expected_minor:'1000',amount_minor:'500'},context:{bank_settlement:false,projection_hash:'a'.repeat(64),origin:'src_fixture'},store:'store_001',kind:'amount_mismatch' as const}
 const evidence=[{id:'e1',fact:'Synthetic observed payment.'}]
 assert.deepEqual(buildModelInput('amount_mismatch',left,evidence),buildModelInput('amount_mismatch',right,evidence))
 assert.equal(hashOf(buildModelInput('amount_mismatch',left,evidence)),hashOf(buildModelInput('amount_mismatch',right,evidence)))
 assert.notEqual(hashOf(buildModelInput('amount_mismatch',left,evidence)),hashOf(buildModelInput('amount_mismatch',{...left,payment:{...left.payment,amount_minor:'501'}},evidence)))
})

import {setup} from './helpers.js'
import {withTx} from '../src/db.js'
import {openException,judgeWithModel} from '../src/copilot/judge.js'
import {RecordingModel,ScriptedModel} from '../src/copilot/model.js'

async function pgRoundTrip(changeContext=false){
 const env=await setup()
 try{
  const facts={kind:'manual_divergent' as const,store:'store_001',context:{z_field:'synthetic',a_field:'first'},manual:{amount_minor:'1000',received_minor:'500',status:'divergent'}}
  const evidence=[{id:'e1',fact:'Synthetic typed balance differs from expected amount.'}]
  const original=buildModelInput(facts.kind,facts,evidence),inputHash=hashOf(original)
  let id=''
  const live=new ScriptedModel('synthetic-canonical-input',async input=>{
   assert.deepEqual(input,original)
   if(changeContext)await env.db.query(`UPDATE exceptions SET facts=jsonb_set(facts,'{manual,received_minor}','"501"') WHERE id=$1`,[id])
   return JSON.stringify({action:'hold_request_balance',confidence:0.8499,requires_human:false,rationale:'Synthetic balance needs review from an operator.',evidence_refs:['e1']})
  })
  env.ctx.copilot={model:new RecordingModel(live,env.db)}
  id=(await withTx(env.db,tx=>openException(tx,env.ctx,{merchantId:env.merchantId,orderId:null,kind:facts.kind,fingerprint:'synthetic-canonical-input',summary:'Synthetic case',facts,evidence,detectedAt:env.ctx.now(),source:'synthetic_test'}))).id
  const read=(await env.db.query('SELECT facts,evidence FROM exceptions WHERE id=$1',[id])).rows[0]
  assert.notEqual(JSON.stringify(read.facts),JSON.stringify(facts),'fixture proves PostgreSQL actually reorders JSONB keys')
  assert.equal(hashOf(buildModelInput(facts.kind,read.facts,read.evidence)),inputHash)
  assert.equal(await judgeWithModel(env.ctx,id,0),'done')
  assert.equal(live.calls.length,1)
  const verdicts=(await env.db.query('SELECT * FROM copilot_verdicts WHERE exception_id=$1',[id])).rows
  const replays=(await env.db.query('SELECT * FROM copilot_replay WHERE input_hash=$1',[inputHash])).rows
  if(changeContext){
   assert.equal(verdicts.length,0);assert.equal(replays.length,0)
   assert.equal((await env.db.query('SELECT last_error FROM exceptions WHERE id=$1',[id])).rows[0].last_error.reason,'context_changed')
  }else{
   assert.equal(verdicts.length,1);assert.equal(replays.length,1)
   assert.equal(verdicts[0].input_hash,inputHash)
   assert.equal(hashOf(JSON.parse(replays[0].response.text)),verdicts[0].verdict_hash)
   assert.equal((await env.db.query('SELECT status FROM exceptions WHERE id=$1',[id])).rows[0].status,'awaiting_human')
  }
 }finally{await env.drop()}
}

test('JSONB key reorder preserves original model input through guard/CAS, immutable verdict and exact replay',()=>pgRoundTrip())
test('actual facts mutation during model still fails CAS after canonicalization',()=>pgRoundTrip(true))
