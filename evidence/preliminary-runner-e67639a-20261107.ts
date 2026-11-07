// New isolated synthetic experiment. Only Tempo Moderato 42431 and faucet tokens.
// No production key, customer, bank, provider, wallet login, or financial release.
import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {randomBytes} from 'node:crypto'
import {decodeEventLog,erc20Abi,formatUnits,http,parseAbi,type Hex} from 'viem'
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts'
import {Account,Actions,VirtualMaster,createClient} from 'viem/tempo'
import {issueDepositAddresses,reconcileDeposits,scanMasterInflows,RECEIVE_POLICY_GUARD,type ChainLog} from '../src/chain/deposits.js'
const RPC='https://rpc.moderato.tempo.xyz',CHAIN=42431,EXPLORER='https://explore.testnet.tempo.xyz'
const PATH='0x20c0000000000000000000000000000000000000' as Hex
const BETA='0x20c0000000000000000000000000000000000002' as Hex
const DIR=resolve('../private'),PROOF=resolve('../proofs')
mkdirSync(DIR,{recursive:true,mode:0o700});mkdirSync(PROOF,{recursive:true})
const lock=join(DIR,'run.lock');const lockfd=openSync(lock,'wx',0o600)
writeFileSync(lockfd,JSON.stringify({pid:process.pid,at:new Date().toISOString(),chainId:CHAIN}));fsyncSync(lockfd)
const json=(v:unknown)=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x,2)+'\n'
function durable(file:string,value:unknown){const tmp=file+'.tmp';writeFileSync(tmp,json(value),{mode:0o600});const f=openSync(tmp,'r');fsyncSync(f);closeSync(f);renameSync(tmp,file);const d=openSync(DIR,'r');fsyncSync(d);closeSync(d)}
const stateFile=join(DIR,'state.json')
const state:any=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{chainId:CHAIN,rpc:RPC,runId:'u10-'+randomBytes(4).toString('hex'),operations:{}}
const save=()=>durable(stateFile,state)
async function main(){
 if(state.chainId!==CHAIN||state.rpc!==RPC)throw Error('state_network_mismatch')
 if(Object.values(state.operations).some((v:any)=>v.status!=='confirmed'))throw Error('unresolved_operation_requires_readonly_reconciliation')
 const keysFile=join(DIR,'testnet-only-keys.json')
 if(!existsSync(keysFile))durable(keysFile,{warning:'DISPOSABLE TESTNET ONLY, never use on mainnet',master:generatePrivateKey(),payer:generatePrivateKey()})
 const keys=JSON.parse(readFileSync(keysFile,'utf8'))
 const client=(key:Hex)=>createClient({account:Account.fromSecp256k1(key),testnet:true,transport:http(RPC,{retryCount:0,timeout:20000}),feeToken:PATH})
 const master=client(keys.master),payer=client(keys.payer)
 if(await master.getChainId()!==CHAIN||await payer.getChainId()!==CHAIN)throw Error('wrong_chain_refused_before_effects')
 const m=privateKeyToAccount(keys.master).address,p=privateKeyToAccount(keys.payer).address
 if(state.master&&state.master.toLowerCase()!==m.toLowerCase())throw Error('master_changed')
 Object.assign(state,{master:m,payer:p});save()
 const balance=(token:Hex,who:Hex)=>master.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[who]})
 async function effect(name:string,intention:any,fn:()=>Promise<any>,hash:(r:any)=>Hex|Hex[]|undefined){
  const old=state.operations[name]
  if(old){if(old.status!=='confirmed')throw Error('uncertain_operation_stop:'+name);return old}
  state.operations[name]={status:'started',at:new Date().toISOString(),chainId:CHAIN,rpc:RPC,intention};save()
  try{
   const r=await fn(),tx=hash(r)
   state.operations[name]={...state.operations[name],status:'confirmed',tx:tx??null,confirmedAt:new Date().toISOString()};save()
   console.log(JSON.stringify({operation:name,status:'confirmed',tx:tx??null}));return {result:r,...state.operations[name]}
  }catch{state.operations[name]={...state.operations[name],status:'uncertain',stop_no_retry:true};save();throw Error('operation_uncertain_stop:'+name)}
 }
 for(const [name,c,who] of [['master',master,m],['payer',payer,p]] as const){
  if(await balance(PATH,who)<1000000n){await effect('faucet-'+name,{recipient:who,asset:'TEST TOKENS',purpose:'synthetic-only'},()=>Actions.faucet.fundSync(c,{account:c.account!}),(r:any)=>Array.isArray(r)?r.filter((x:any)=>typeof x==='string'):undefined)}
  if(await balance(PATH,who)<1000000n)throw Error('faucet_balance_not_observed')
 }
 if(await balance(BETA,p)<10000n)throw Error('beta_test_tokens_missing')
 if(!state.salt){
  const start=BigInt('0x'+randomBytes(8).toString('hex'))<<64n
  state.mining={startedAt:new Date().toISOString(),workers:2,count:2**32,start:start.toString()};save()
  let last=0
  const mined=await VirtualMaster.mineSaltAsync({address:m,start,count:2**32,workers:2,chunkSize:1000000,signal:AbortSignal.timeout(15*60*1000),onProgress:x=>{if(Date.now()-last>30000){last=Date.now();console.log(JSON.stringify({stage:'TIP1022 PoW',attempts:x.attempts,hashes_per_second:Math.round(x.rate)}))}}})
  if(!mined)throw Error('mining_range_exhausted_no_registration')
  state.salt={salt:mined.salt,masterId:mined.masterId};save()
 }
 const id=state.salt.masterId as Hex
 const registered=await Actions.virtualAddress.getMasterAddress(master,{masterId:id})
 if(!registered)await effect('register-master',{master:m,masterId:id},()=>Actions.virtualAddress.registerMasterSync(master,{salt:state.salt.salt}),(r:any)=>r.receipt.transactionHash)
 else if(registered.toLowerCase()!==m.toLowerCase())throw Error('master_id_conflict_stop')
 const resolved=await Actions.virtualAddress.getMasterAddress(master,{masterId:id});if(resolved?.toLowerCase()!==m.toLowerCase())throw Error('registration_readback_failed')
 if(!state.tokenPolicyId){
  const made=await effect('token-policy',{admin:m,type:'whitelist',tokens:[PATH]},()=>Actions.policy.createSync(master,{admin:m,type:'whitelist',addresses:[PATH]}),(r:any)=>r.receipt.transactionHash)
  if(!made.result)throw Error('policy_id_missing_reconcile_receipt_do_not_create_again')
  state.tokenPolicyId=made.result.policyId.toString();save()
 }
 const policy=await Actions.receivePolicy.get(master,{account:m})
 if(!policy.hasReceivePolicy||String(policy.tokenPolicyId)!==state.tokenPolicyId){
  await effect('receive-policy',{master:m,senderPolicy:'allow-all',tokenPolicyId:state.tokenPolicyId,recovery:'originator'},()=>Actions.receivePolicy.setSync(master,{senderPolicyId:'allow-all',tokenPolicyId:BigInt(state.tokenPolicyId),claimer:'sender'}),(r:any)=>r.receipt.transactionHash)
 }
 const policyAfter=await Actions.receivePolicy.get(master,{account:m});if(!policyAfter.hasReceivePolicy||String(policyAfter.tokenPolicyId)!==state.tokenPolicyId)throw Error('policy_readback_failed')
 const merchant='synthetic-commission-beneficiary'
 const issued=issueDepositAddresses(id,merchant,[{orderRef:state.runId+'-accepted',amount:10000n,tokens:[PATH]},{orderRef:state.runId+'-blocked',amount:10000n,tokens:[PATH]}])
 state.orders=issued.map(x=>({orderRef:x.orderRef,address:x.address,amount:x.amount.toString(),tokens:x.tokens}));save()
 for(const [name,to,token] of [['accepted',issued[0]!.address,PATH],['blocked',issued[1]!.address,BETA]] as const){
  if(!state.operations['payment-'+name]){
   state.before=state.before??{};state.before[name]={masterTokenBalance:(await balance(token,m)).toString(),virtualTokenBalance:(await balance(token,to)).toString()};save()
  }
  await effect('payment-'+name,{payer:p,beneficiary:m,order:state.runId+'-'+name,virtualAddress:to,token,amountMinor:'10000',scale:6,realMoney:false},()=>Actions.token.transferSync(payer,{to,token,amount:10000n}),(r:any)=>r.receipt.transactionHash)
 }
 const blockedTx=state.operations['payment-blocked'].tx as Hex
 const blockedReceipt=await payer.getTransactionReceipt({hash:blockedTx})
 const guardAbi=parseAbi(['event TransferBlocked(address indexed token,address indexed receiver,uint64 indexed blockedNonce,uint256 amount,uint8 receiptVersion,bytes receipt)'])
 const log=blockedReceipt.logs.find(l=>l.address.toLowerCase()===RECEIVE_POLICY_GUARD.toLowerCase())
 if(!log)throw Error('missing_protocol_blocked_event')
 const blocked=decodeEventLog({abi:guardAbi,data:log.data,topics:log.topics})
 await effect('payer-reclaims-test-token',{claimer:p,to:p,blockedTx,receiptVersion:1},()=>Actions.receivePolicy.claimSync(payer,{to:p,receipt:blocked.args.receipt}),(r:any)=>r.receipt.transactionHash)
 const names=['payment-accepted','payment-blocked','payer-reclaims-test-token'];const chainLogs:ChainLog[]=[];const receipts:any[]=[]
 for(const name of names){
  const hash=state.operations[name].tx as Hex;const r=await master.getTransactionReceipt({hash});if(r.status!=='success')throw Error('failed_receipt:'+name)
  const block=await master.getBlock({blockNumber:r.blockNumber});const tip=await master.getBlockNumber();if(tip<r.blockNumber)throw Error('receipt_not_in_canonical_height')
  receipts.push({name,hash,status:r.status,blockNumber:r.blockNumber.toString(),blockHash:r.blockHash,blockTimestamp:block.timestamp.toString(),observedHead:tip.toString(),explorer:EXPLORER+'/tx/'+hash})
  for(const l of r.logs)chainLogs.push({address:l.address,topics:l.topics,data:l.data,transactionHash:l.transactionHash,logIndex:l.logIndex,blockNumber:l.blockNumber})
 }
 const scan=scanMasterInflows(chainLogs,{master:m}),outcomes=reconcileDeposits(issued,scan)
 if(outcomes.length!==2||outcomes[0]?.code!=='matched'||outcomes[1]?.code!=='held_by_receive_policy'||outcomes[1]?.status!=='returned_to_payer')throw Error('unexpected_native_outcomes')
 if(await balance(PATH,issued[0]!.address)!==0n||await balance(BETA,issued[1]!.address)!==0n)throw Error('virtual_balance_nonzero')
 if(await balance(PATH,m)-BigInt(state.before.accepted.masterTokenBalance)!==10000n)throw Error('accepted_beneficiary_delta')
 if(await balance(BETA,m)!==BigInt(state.before.blocked.masterTokenBalance))throw Error('blocked_token_reached_beneficiary')
 const out={schema:'pixsettle-tempo-native-lab/v1',checkedAt:new Date().toISOString(),chainId:CHAIN,rpc:RPC,synthetic:true,realMoney:false,runId:state.runId,master:m,payer:p,masterId:id,tokenPolicyId:state.tokenPolicyId,orders:state.orders,
  operations:Object.fromEntries(Object.entries(state.operations).map(([k,v]:[string,any])=>[k,{status:v.status,tx:v.tx}])),receipts,outcomes:outcomes.map(o=>({code:o.code,orderRef:o.orderRef,tx:o.payment.txHash,explanation:o.explanation,...('status'in o?{status:o.status}:{})})),checks:{native_two_hop_forwarding:true,virtual_balances_zero:true,beneficiary_received_exact_10000_test_units:true,wrong_token_not_credited_to_beneficiary:true,originator_claimed_blocked_test_token:true},finality:'Receipt success, canonical blockHash read, and observed head; no stronger finality assertion.'}
 writeFileSync(join(PROOF,'native-testnet-20261107.json'),json(out));console.log(json(out));state.completed=true;save()
}
main().catch(e=>{console.error(JSON.stringify({ok:false,reason:e instanceof Error&&/^[a-z0-9_:-]{1,160}$/.test(e.message)?e.message:'native_lab_failed',no_blind_retry:true}));process.exitCode=1}).finally(()=>{closeSync(lockfd);unlinkSync(lock)})
