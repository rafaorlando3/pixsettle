import type {Hex} from 'viem'
import {reconcileDeposits,scanMasterInflows,type IssuedDeposit,type ChainLog} from './deposits.js'
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase()
const need=(ok:unknown,code:string)=>{if(!ok)throw Error(code)}
export function assertCanonical(expectedHash:string,r:any,byHash:any,byNumber:any,head:bigint){
 need(r.status==='success','receipt_failed')
 need(same(r.transactionHash,expectedHash),'transaction_hash_mismatch')
 need(byHash.hash&&byNumber.hash&&same(byHash.hash,r.blockHash)&&same(byNumber.hash,r.blockHash),'canonical_hash_mismatch')
 need(BigInt(byHash.number)===BigInt(r.blockNumber)&&BigInt(byNumber.number)===BigInt(r.blockNumber)&&head>=BigInt(r.blockNumber),'canonical_height_mismatch')
 need(Array.isArray(r.logs),'complete_receipt_logs_required')
 for(const l of r.logs){need(same(l.transactionHash,expectedHash)&&BigInt(l.blockNumber)===BigInt(r.blockNumber)&&(!l.blockHash||same(l.blockHash,r.blockHash))&&!l.removed,'receipt_log_identity_mismatch')}
 return {transactionHash:expectedHash,status:r.status,blockNumber:String(r.blockNumber),blockHash:r.blockHash,byHashEqualsReceipt:true,byNumberEqualsReceipt:true,observedHead:String(head)}
}
export function assertReceivePolicy(policy:any,id:string){
 need(policy.hasReceivePolicy&&policy.senderPolicyId==='allow-all'&&String(policy.tokenPolicyId)===id&&policy.tokenPolicyType==='whitelist'&&policy.claimer==='sender'&&same(policy.recoveryAuthority,'0x0000000000000000000000000000000000000000'),'receive_policy_mismatch')
 return {hasReceivePolicy:policy.hasReceivePolicy,senderPolicyId:policy.senderPolicyId,tokenPolicyId:String(policy.tokenPolicyId),tokenPolicyType:policy.tokenPolicyType,claimer:policy.claimer,recoveryAuthority:policy.recoveryAuthority}
}
export type Expected={master:Hex,payer:Hex,issued:IssuedDeposit[],acceptedRef:string,blockedRef:string,acceptedTx:Hex,blockedTx:Hex,claimTx:Hex,acceptedToken:Hex,blockedToken:Hex,acceptedAmount:bigint,blockedAmount:bigint}
export function verifyNativeEvents(logs:ChainLog[],x:Expected){
 const scan=scanMasterInflows(logs,{master:x.master}),outcomes=reconcileDeposits(x.issued,scan)
 need(outcomes.length===2,'unexpected_outcome_count')
 const accepted=outcomes.find(o=>o.orderRef===x.acceptedRef&&o.code==='matched')
 const blocked=outcomes.find(o=>o.orderRef===x.blockedRef&&o.code==='held_by_receive_policy')
 need(accepted&&same(accepted.payment.txHash,x.acceptedTx)&&same(accepted.payment.payer,x.payer)&&same(accepted.payment.token,x.acceptedToken)&&accepted.payment.amount===x.acceptedAmount,'accepted_order_or_payment_mismatch')
 need(blocked&&same(blocked.payment.txHash,x.blockedTx)&&same(blocked.payment.payer,x.payer)&&same(blocked.payment.token,x.blockedToken)&&blocked.payment.amount===x.blockedAmount&&'status'in blocked&&blocked.status==='returned_to_payer','blocked_order_or_payment_mismatch')
 const held=scan.held.find(h=>same(h.txHash,x.blockedTx))
 need(held?.claimed&&same(held.claimed.txHash,x.claimTx)&&same(held.claimed.to,x.payer)&&same(held.claimed.caller,x.payer),'originator_claim_mismatch')
 need(scan.deposits.length===1&&scan.direct.length===0&&scan.held.length===1,'unexpected_inflows')
 return {outcomes:outcomes.map(o=>({code:o.code,orderRef:o.orderRef,tx:o.payment.txHash,token:o.payment.token,amountMinor:o.payment.amount.toString(),payer:o.payment.payer,explanation:o.explanation,...('status'in o?{status:o.status}:{})})),claim:{transactionHash:held!.claimed!.txHash,to:held!.claimed!.to,caller:held!.claimed!.caller,amountMinor:held!.amount.toString(),token:held!.token},checks:{twoHopForwarding:scan.deposits.length===1,acceptedOrderMatched:!!accepted,blockedOrderRetained:!!blocked,originatorClaimed:!!held?.claimed}}
}
