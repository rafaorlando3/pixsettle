import {describe,it,expect} from 'vitest'
import fixture from './fixtures/tempo-deposits-moderato.json'
import {issueDepositAddresses} from '../src/chain/deposits.js'
import {assertCanonical,assertReceivePolicy,verifyNativeEvents} from '../src/chain/lab-proof.js'
const f:any=fixture
const acceptedTx=f.transactions.A_exact.tx,blockedTx=f.transactions.C_wrong_token.tx,claimTx=f.transactions.claim_C.tx
const logs=f.logs.filter((l:any)=>[acceptedTx,blockedTx,claimTx].includes(l.transactionHash))
const issued=issueDepositAddresses(f.masterId,f.merchantId,[f.orders[0],f.orders[2]].map((o:any)=>({...o,amount:BigInt(o.amount)})))
const x:any={master:f.master,payer:f.payer,issued,acceptedRef:'ord-A',blockedRef:'ord-C',acceptedTx,blockedTx,claimTx,acceptedToken:f.orders[0].tokens[0],blockedToken:'0x20c0000000000000000000000000000000000002',acceptedAmount:25000000n,blockedAmount:12000000n}
const hash='0x'+'ab'.repeat(32),tx='0x'+'cd'.repeat(32)
const receipt={transactionHash:tx,status:'success',blockHash:hash,blockNumber:12n,logs:[]}
const block={hash,number:12n}
describe('read-only native evidence',()=>{
 it('rederives accepted and retained order with actual historical fixture logs',()=>expect(verifyNativeEvents(logs,x).checks.originatorClaimed).toBe(true))
 it('rejects wrong accepted reference',()=>expect(()=>verifyNativeEvents(logs,{...x,acceptedRef:'other'})).toThrow('accepted_order'))
 it('rejects wrong payer',()=>expect(()=>verifyNativeEvents(logs,{...x,payer:f.master})).toThrow())
 it('rejects wrong claim transaction',()=>expect(()=>verifyNativeEvents(logs,{...x,claimTx:acceptedTx})).toThrow('originator_claim'))
 it('rejects missing first hop',()=>expect(()=>verifyNativeEvents(logs.filter((l:any)=>!(l.transactionHash===acceptedTx&&l.logIndex===logs.find((q:any)=>q.transactionHash===acceptedTx).logIndex)),x)).toThrow())
 it('checks canonical hash and height',()=>expect(assertCanonical(tx,receipt,block,block,13n).byHashEqualsReceipt).toBe(true))
 it('rejects hash changed at height',()=>expect(()=>assertCanonical(tx,receipt,block,{...block,hash:tx},13n)).toThrow('canonical_hash'))
 it('rejects wrong hash block number',()=>expect(()=>assertCanonical(tx,receipt,{...block,number:11n},block,13n)).toThrow('canonical_height'))
 it('rejects failed receipt',()=>expect(()=>assertCanonical(tx,{...receipt,status:'reverted'},block,block,13n)).toThrow('receipt_failed'))
 it('rejects unrelated transaction',()=>expect(()=>assertCanonical(hash,receipt,block,block,13n)).toThrow('transaction_hash'))
 it('rejects removed log',()=>expect(()=>assertCanonical(tx,{...receipt,logs:[{transactionHash:tx,blockNumber:12n,blockHash:hash,removed:true}]},block,block,13n)).toThrow('receipt_log'))
 it('confirms sender recovery and full policy',()=>expect(assertReceivePolicy({hasReceivePolicy:true,senderPolicyId:'allow-all',tokenPolicyId:7n,tokenPolicyType:'whitelist',claimer:'sender',recoveryAuthority:'0x'+'00'.repeat(20)},'7').claimer).toBe('sender'))
 it('rejects delegated recovery',()=>expect(()=>assertReceivePolicy({hasReceivePolicy:true,senderPolicyId:'allow-all',tokenPolicyId:7n,tokenPolicyType:'whitelist',claimer:f.master,recoveryAuthority:f.master},'7')).toThrow('receive_policy'))
})
