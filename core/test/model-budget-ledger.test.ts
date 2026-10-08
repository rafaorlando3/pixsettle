import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { BudgetedModel, RecordingModel, ReplayModel, ModelError, budgetFromEnv, copilotFromEnv, type ModelInput } from '../src/copilot/model.js'
import { hashOf } from '../src/copilot/verdict.js'
import { freshDb } from './helpers.js'
const drops: Array<() => Promise<void>> = []
afterEach(async()=>{await Promise.all(drops.splice(0).map(d=>d()));vi.restoreAllMocks()})
const env = async()=>{const x=await freshDb();drops.push(x.drop);return x.db}
const input = (n:number):ModelInput=>({system:'Fixture system',user:`Fixture context ${n}`})
const output = (cost?:number)=>({text:'Fixture response',latencyMs:1,usage:cost===undefined?undefined:{cost}})
const cfg=(capMicros=30,reserveMicros=10,maxCalls=3)=>({capMicros,reserveMicros,maxCalls})
const live=(fn:(x:ModelInput)=>Promise<any>)=>({name:'fixture-budget',mode:'live' as const,complete:fn})
describe('durable private USD budget (Claude C0663 integration)',()=>{
  it('live factory fails closed without USD cap; recording wraps the durable budget and replay needs none',async()=>{
    const db=await env(),base={COPILOT_MODE:'live',COPILOT_PROVIDER:'openai',COPILOT_MODEL:'fixture-budget',COPILOT_API_KEY:'fixture',COPILOT_BASE_URL:'https://fixture.invalid'}
    expect(copilotFromEnv(base,db)).toMatchObject({model:null,offReason:'COPILOT_BUDGET_MICROS ausente'})
    expect(copilotFromEnv({...base,COPILOT_BUDGET_MICROS:'500000'},db).model).toBeInstanceOf(BudgetedModel)
    expect(copilotFromEnv({...base,COPILOT_MODE:'live_record',COPILOT_BUDGET_MICROS:'500000'},db).model).toBeInstanceOf(RecordingModel)
    expect(copilotFromEnv({COPILOT_MODE:'replay',COPILOT_MODEL:'fixture'},db).model).toBeInstanceOf(ReplayModel)
    expect(()=>budgetFromEnv({COPILOT_BUDGET_MICROS:'20000001'})).toThrow('budget_cap_exceeds_shared20')
  })
  it('persists its reservation before HTTP and serializes simultaneous processes without exhausting connections',async()=>{
    const db=await env();let start!:()=>void,finish!:()=>void
    const started=new Promise<void>(r=>{start=r}),barrier=new Promise<void>(r=>{finish=r})
    const provider=vi.fn(async(x:ModelInput)=>{expect((await db.query(`SELECT state FROM copilot_spend WHERE input_hash=$1`,[hashOf(x)])).rows[0].state).toBe('reserved');start();await barrier;return output(0.000005)})
    const a=new BudgetedModel(live(provider),db,cfg())
    const first=a.complete(input(1));await started
    const other=await Promise.allSettled(Array.from({length:8},(_,n)=>new BudgetedModel(live(provider),db,cfg()).complete(input(n+2))))
    expect(other.every(r=>r.status==='rejected'&&r.reason instanceof ModelError&&r.reason.code==='budget')).toBe(true)
    expect(provider).toHaveBeenCalledTimes(1);finish();await first
    await a.complete(input(20));await a.complete(input(21));await expect(a.complete(input(22))).rejects.toThrow('budget_exhausted')
    expect(provider).toHaveBeenCalledTimes(3)
  })
  it('refuses the same model/input hash after restart without a second provider call',async()=>{
    const db=await env(),provider=vi.fn(async()=>output(0.000001))
    await new BudgetedModel(live(provider),db,cfg()).complete(input(1))
    await expect(new BudgetedModel(live(provider),db,cfg()).complete(input(1))).rejects.toThrow('budget_input_already_attempted')
    expect(provider).toHaveBeenCalledTimes(1);expect((await db.query('SELECT count(*)::int AS n FROM copilot_spend')).rows[0].n).toBe(1)
  })
  it('a crash reservation blocks new contexts after restart and retains every reserved micro-USD',async()=>{
    const db=await env();await db.query(`INSERT INTO copilot_spend(model,input_hash,reserved_micros,state) VALUES('fixture-budget',$1,10,'reserved')`,[hashOf(input(1))])
    const provider=vi.fn(async()=>output(0))
    await expect(new BudgetedModel(live(provider),db,cfg()).complete(input(2))).rejects.toThrow('budget_charge_unknown')
    expect(provider).not.toHaveBeenCalled();expect((await db.query('SELECT reserved_micros,state FROM copilot_spend')).rows[0]).toEqual({reserved_micros:'10',state:'reserved'})
  })
  it('first HTTP failure keeps the reservation, stores only its code and halts the entire envelope',async()=>{
    const db=await env(),provider=vi.fn(async()=>{throw new ModelError('http','private@example.invalid',429,'PRIVATE')})
    const model=new BudgetedModel(live(provider),db,cfg())
    await expect(model.complete(input(1))).rejects.toMatchObject({code:'http'})
    await expect(new BudgetedModel(live(provider),db,cfg()).complete(input(2))).rejects.toThrow('budget_charge_unknown')
    const rows=(await db.query('SELECT state,error_code,cost_micros FROM copilot_spend')).rows
    expect(rows).toEqual([{state:'failed',error_code:'http',cost_micros:null}]);expect(JSON.stringify(rows)).not.toContain('PRIVATE');expect(provider).toHaveBeenCalledTimes(1)
  })
  it('missing or invalid actual cost stops subsequent contexts with the conservative reservation held',async()=>{
    const db=await env(),provider=vi.fn(async()=>output())
    await new BudgetedModel(live(provider),db,cfg()).complete(input(1))
    await expect(new BudgetedModel(live(provider),db,cfg()).complete(input(2))).rejects.toThrow('budget_charge_unknown')
    expect(provider).toHaveBeenCalledTimes(1);expect((await db.query('SELECT halted,halt_code FROM copilot_budget_policy')).rows[0]).toEqual({halted:true,halt_code:'unknown_charge'})
  })
  it('a cost above its bound stops admission before another HTTP and preserves actual cost',async()=>{
    const db=await env(),provider=vi.fn(async()=>output(0.000011))
    await new BudgetedModel(live(provider),db,cfg()).complete(input(1))
    await expect(new BudgetedModel(live(provider),db,cfg()).complete(input(2))).rejects.toThrow('budget_charge_unknown')
    expect((await db.query('SELECT cost_micros FROM copilot_spend')).rows[0].cost_micros).toBe('11')
    expect((await db.query('SELECT halt_code FROM copilot_budget_policy')).rows[0].halt_code).toBe('cost_over_reserve');expect(provider).toHaveBeenCalledTimes(1)
  })
  it('never releases the conservative reserve because the reported actual cost is lower',async()=>{
    const db=await env(),provider=vi.fn(async()=>output(0))
    const model=new BudgetedModel(live(provider),db,cfg(20,10,100))
    await model.complete(input(1));await model.complete(input(2));await expect(model.complete(input(3))).rejects.toThrow('budget_exhausted');expect(provider).toHaveBeenCalledTimes(2)
  })
  it('changing cap/model/reserve/call policy after restart cannot enlarge an already frozen envelope',async()=>{
    const db=await env(),provider=vi.fn(async()=>output(0))
    await new BudgetedModel(live(provider),db,cfg()).complete(input(1))
    await expect(new BudgetedModel(live(provider),db,cfg(100,10,20)).complete(input(2))).rejects.toThrow('budget_policy_changed')
    expect(provider).toHaveBeenCalledTimes(1)
  })
  it('oversize UTF8 input and insufficient known-model reserve are refused before any DB/provider operation',async()=>{
    const provider=vi.fn(async()=>output(0)),db={} as any
    await expect(new BudgetedModel(live(provider),db,cfg()).complete({system:'x',user:'é'.repeat(8192)})).rejects.toThrow('budget_input_limit')
    expect(provider).not.toHaveBeenCalled()
    expect(()=>new BudgetedModel({...live(provider),name:'openai/gpt-4.1-mini'},db,cfg(250000,100,24))).toThrow('budget_known_model_reserve_too_small')
  })
  it('a settlement write failure leaves a durable reserved row and blocks HTTP after restart',async()=>{
    const db=await env();await db.query(`CREATE FUNCTION fixture_budget_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$;
      CREATE TRIGGER fixture_budget_failure BEFORE UPDATE ON copilot_spend FOR EACH ROW EXECUTE FUNCTION fixture_budget_failure()`)
    const provider=vi.fn(async()=>output(0.000001))
    await expect(new BudgetedModel(live(provider),db,cfg()).complete(input(1))).rejects.toThrow('budget_storage_failed')
    await db.query(`DROP TRIGGER fixture_budget_failure ON copilot_spend; DROP FUNCTION fixture_budget_failure()`)
    await expect(new BudgetedModel(live(provider),db,cfg()).complete(input(2))).rejects.toThrow('budget_charge_unknown')
    expect(provider).toHaveBeenCalledTimes(1);expect((await db.query('SELECT state FROM copilot_spend')).rows[0].state).toBe('reserved')
  })
  it('010 rollback removes budget schema and migration marker, then reapply recreates empty tables',async()=>{
    const db=await env();await db.query(readFileSync(new URL('../migrations/down/010_copilot_budget.down.sql',import.meta.url),'utf8'))
    expect((await db.query(`SELECT name FROM schema_migrations WHERE name='010_copilot_budget.sql'`)).rows).toHaveLength(0)
    expect((await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('copilot_spend','copilot_budget_policy')`)).rows).toHaveLength(0)
    await db.query(readFileSync(new URL('../migrations/010_copilot_budget.sql',import.meta.url),'utf8'))
    expect((await db.query('SELECT count(*)::int AS n FROM copilot_spend')).rows[0].n).toBe(0)
  })
})
