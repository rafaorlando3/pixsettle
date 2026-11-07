// Independent read-only verification. Never imports keys or submits an operation.
import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync,renameSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {decodeEventLog,erc20Abi,http,parseAbi,type Hex} from 'viem'
import {Actions,createClient} from 'viem/tempo'
import {issueDepositAddresses,type ChainLog,RECEIVE_POLICY_GUARD} from '../src/chain/deposits.js'
import {assertCanonical,assertReceivePolicy,verifyNativeEvents} from '../src/chain/lab-proof.js'
const RPC='https://rpc.moderato.tempo.xyz',CHAIN=42431,EXPLORER='https://explore.testnet.tempo.xyz'
const PATH='0x20c0000000000000000000000000000000000000' as Hex,BETA='0x20c0000000000000000000000000000000000002' as Hex
const stringify=(x:unknown)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n'
async function main(){
 const input=resolve('../proofs/native-testnet-20261107.json'),bytes=readFileSync(input),p=JSON.parse(bytes.toString())
 if(p.chainId!==CHAIN||p.rpc!==RPC||p.synthetic!==true||p.realMoney!==false)throw Error('preliminary_scope_mismatch')
 const client=createClient({testnet:true,transport:http(RPC,{retryCount:0,timeout:20000})})
 if(await client.getChainId()!==CHAIN)throw Error('wrong_chain')
 const receipts:any[]=[],logs:ChainLog[]=[]
 const names=['register-master','token-policy','receive-policy','payment-accepted','payment-blocked','payer-reclaims-test-token']
 for(const name of names){
  const hash=p.operations[name]?.tx as Hex
  if(!/^0x[0-9a-f]{64}$/i.test(hash??''))throw Error('missing_confirmed_transaction:'+name)
  const r=await client.getTransactionReceipt({hash})
  const byHash=await client.getBlock({blockHash:r.blockHash}),byNumber=await client.getBlock({blockNumber:r.blockNumber}),head=await client.getBlockNumber()
  const checked=assertCanonical(hash,r,byHash,byNumber,head)
  const completeLogs=r.logs.map(l=>({address:l.address,topics:l.topics,data:l.data,transactionHash:l.transactionHash,logIndex:l.logIndex,blockNumber:l.blockNumber,blockHash:l.blockHash,removed:l.removed}))
  receipts.push({name,...checked,blockTimestamp:byHash.timestamp.toString(),explorer:EXPLORER+'/tx/'+hash,logs:completeLogs})
  if(names.indexOf(name)>=3)logs.push(...completeLogs)
 }
 const issued=issueDepositAddresses(p.masterId,'synthetic-commission-beneficiary',[{orderRef:p.runId+'-accepted',amount:10000n,tokens:[PATH]},{orderRef:p.runId+'-blocked',amount:10000n,tokens:[PATH]}])
 if(p.orders.length!==2||issued.some((o,i)=>o.address.toLowerCase()!==p.orders[i].address.toLowerCase()||o.orderRef!==p.orders[i].orderRef))throw Error('preliminary_order_address_mismatch')
 const observed=verifyNativeEvents(logs,{master:p.master,payer:p.payer,issued,acceptedRef:p.runId+'-accepted',blockedRef:p.runId+'-blocked',acceptedTx:p.operations['payment-accepted'].tx,blockedTx:p.operations['payment-blocked'].tx,claimTx:p.operations['payer-reclaims-test-token'].tx,acceptedToken:PATH,blockedToken:BETA,acceptedAmount:10000n,blockedAmount:10000n})
 if((await Actions.virtualAddress.getMasterAddress(client,{masterId:p.masterId}))?.toLowerCase()!==p.master.toLowerCase())throw Error('master_resolution_mismatch')
 const policy=assertReceivePolicy(await Actions.receivePolicy.get(client,{account:p.master}),p.tokenPolicyId)
 if(!(await Actions.policy.isAuthorized(client,{policyId:BigInt(p.tokenPolicyId),user:PATH}))||(await Actions.policy.isAuthorized(client,{policyId:BigInt(p.tokenPolicyId),user:BETA})))throw Error('token_policy_membership_mismatch')
 const blockedAbi=parseAbi(['event TransferBlocked(address indexed token,address indexed receiver,uint64 indexed blockedNonce,uint256 amount,uint8 receiptVersion,bytes receipt)'])
 const blockedLog=receipts.find(r=>r.name==='payment-blocked').logs.find((l:any)=>l.address.toLowerCase()===RECEIVE_POLICY_GUARD.toLowerCase())
 const blocked=decodeEventLog({abi:blockedAbi,data:blockedLog.data,topics:blockedLog.topics})
 if(blocked.args.receiptVersion!==1)throw Error('receipt_version_mismatch')
 if(await Actions.receivePolicy.getBlockedBalance(client,{receipt:blocked.args.receipt})!==0n)throw Error('unclaimed_guard_balance')
 const balance=(token:Hex,who:Hex,blockNumber?:bigint)=>client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[who],...(blockNumber!==undefined?{blockNumber}:{})})
 const blockedHeight=BigInt(receipts.find(r=>r.name==='payment-blocked').blockNumber),claimHeight=BigInt(receipts.find(r=>r.name==='payer-reclaims-test-token').blockNumber)
 const payerBefore=await balance(BETA,p.payer,blockedHeight-1n),payerAfter=await balance(BETA,p.payer,claimHeight)
 const masterBefore=await balance(BETA,p.master,blockedHeight-1n),masterAfter=await balance(BETA,p.master,claimHeight)
 const virtualAccepted=await balance(PATH,issued[0]!.address),virtualBlocked=await balance(BETA,issued[1]!.address)
 if(payerBefore!==payerAfter||masterBefore!==masterAfter||virtualAccepted!==0n||virtualBlocked!==0n)throw Error('measured_balance_mismatch')
 const out={schema:'pixsettle-tempo-native-readonly-proof/v1',checkedAt:new Date().toISOString(),chainId:CHAIN,rpc:RPC,synthetic:true,realMoney:false,runId:p.runId,verificationSource:process.env.VERIFICATION_SHA??'uncommitted',preliminarySource:'e67639a198e38ed9871a8d724a08311420f2f29b',preliminarySha256:createHash('sha256').update(bytes).digest('hex'),preliminaryLimitation:'Initial runner did not compare canonical block hashes. This separate read-only verifier does.',master:p.master,payer:p.payer,masterId:p.masterId,policy,orders:issued.map(o=>({orderRef:o.orderRef,virtualAddress:o.address,expectedAmountMinor:o.amount.toString(),acceptedTokens:o.tokens,scale:6})),receipts,...observed,measurements:{BETA:{token:BETA,beforeBlock:(blockedHeight-1n).toString(),afterBlock:claimHeight.toString(),payerBefore:payerBefore.toString(),payerAfter:payerAfter.toString(),payerNetChange:(payerAfter-payerBefore).toString(),beneficiaryBefore:masterBefore.toString(),beneficiaryAfter:masterAfter.toString(),beneficiaryNetChange:(masterAfter-masterBefore).toString()},virtualAcceptedBalance:virtualAccepted.toString(),virtualBlockedBalance:virtualBlocked.toString(),guardReceiptRemaining:'0'},finality:'Successful receipts with block hashes checked both by height and hash at the recorded observed heads. This is a point-in-time testnet observation, not a stronger finality guarantee.'}
 const output=resolve('../proofs/native-testnet-readonly-20261107.json'),tmp=output+'.tmp';writeFileSync(tmp,stringify(out));const fd=openSync(tmp,'r');fsyncSync(fd);closeSync(fd);renameSync(tmp,output);const dir=openSync(dirname(output),'r');fsyncSync(dir);closeSync(dir)
 console.log(stringify({ok:true,chainId:CHAIN,checks:observed.checks,receipts:receipts.map(r=>({name:r.name,hash:r.transactionHash,explorer:r.explorer}))}))
}
main().catch(e=>{console.error(JSON.stringify({ok:false,reason:e instanceof Error&&/^[a-z0-9_:-]{1,160}$/.test(e.message)?e.message:'readonly_verification_failed',effectsSubmitted:0}));process.exitCode=1})
