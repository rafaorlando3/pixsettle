# PixSettle native Tempo lab, 7 November 2026

An isolated testnet experiment links each synthetic commission order to its own TIP-1022 virtual address. Native TIP-1028 receive policy accepts pathUSD, diverts betaUSD to the protocol guard, and lets the test payer reclaim the blocked token. All assets here are faucet tokens on Tempo Moderato, chain 42431, with no real value.

## Fresh transactions

| Role | Public explorer |
|---|---|
| Register master | https://explore.testnet.tempo.xyz/tx/0xe1b5039d395079537bc3c9ad6e2b0d2adab5ab66b43af706d639bb0b6f149b53 |
| Token allowlist | https://explore.testnet.tempo.xyz/tx/0xf57874583f3736ebbf517a716a6d52a935891c655806954a7d179b18709901fb |
| Receive policy | https://explore.testnet.tempo.xyz/tx/0x1b8ef362caa8e627dff457d6746eb038f4d61916cae3fee392c076ab4eda276d |
| Accepted order | https://explore.testnet.tempo.xyz/tx/0x1d222c2458f338ebdfc81f5e65766876658496ce851166fe7c83a76cc1937589 |
| Token held by protocol | https://explore.testnet.tempo.xyz/tx/0x7e9722db5c7a7193be928b28a055e6a0d8291f9c725473625dc33ea82f7fdc21 |
| Payer reclaims | https://explore.testnet.tempo.xyz/tx/0x74f14deac571dcb9ed20645337945c40524ccd23144148939699fcb5b0f2d819 |

The accepted order is u10-097d13e0-accepted, virtual address 0x798F7346FdfDfdfDFdfDFDFdFDfdbd22c0822965. The blocked order is u10-097d13e0-blocked, virtual address 0x798F7346fdFDFdFDFdFdFdFdFdfD99Ff2dE72F11. Each expected 10000 integer units of pathUSD at scale 6, equivalent to 0.01 test units. The second event actually sent betaUSD and was retained. Receiver master 0x40EC57356461582ac22eda7E229E3D638faa6935 represents a synthetic commission beneficiary, not PixSettle custody for a merchant.

A successful transaction status alone does not prove the beneficiary received the token. Inspect TransferBlocked, ReceiptClaimed, both forwarding Transfer logs, exact token/amount/order and balances in [the read-only evidence](evidence/native-testnet-readonly-20261107.json). Both virtual balances and the remaining guard receipt balance are zero. The beneficiary's betaUSD balance stayed unchanged, and the payer's historical betaUSD balance returned to its initial value. Block hashes were checked both by hash and by height at the recorded heads. This is a point-in-time testnet observation, not a stronger finality guarantee.

## What is new

The pure deposits module, its 27 tests and the historical fixture are byte-identical copies of feature commit a477e53d7056f11f7c6409184fae9f3e23c8582f from 11 October. [Blob comparisons](evidence/ORIGIN-BLOB-MATCH-20261107.json) establish provenance. That feature is prior capability. This separate lab adds a new runner, read-only verifier, 18 evidence/gate tests and fresh transactions on 7 November. It does not modify the judged version, main, demos, GitLab or CI.

The original new run used local SHA e67639a198e38ed9871a8d724a08311420f2f29b. [Its source is preserved](evidence/preliminary-runner-e67639a-20261107.ts) as historical evidence only. Its preliminary output did not compare canonical block hashes. The authoritative evidence was independently re-read on the VPS by core/scripts/verify-native-lab.ts at local SHA 52484de47d8fcc4cc06ed14f3915e100a4062c20; it compares receipt, block by hash and block by height, reconstructs exact order outcomes from complete logs, and reads full policy and historical balances. The verifier source in this release is byte-identical to that run. The revised sending runner was checked with network disabled for safe exit gates; it was not used to send a second set of transactions.

## Running and reviewing

Implementation, Git and tests run only on the authorized VPS .244. The Mac contains documentation and read-only copies. Existing cached viem 2.56.9, tsx 4.23.15 and vitest 5.0.2 were mounted read-only into Node22 containers. No production key or customer data is used. private/ and proofs/ are excluded from Git; public evidence above contains chain data only.

45 tests passed on the VPS: 27 deposits, 13 canonical evidence and 5 runner exit gates. The exit-gate tests run with Docker network disabled and disposable temp directories. They verify completed state, started/uncertain state, wrong network and pre-existing lock stop before key creation or chain calls. They are not full fault injection across every SDK send.

A durable operation journal records intent before a testnet effect, disables HTTP retries and stops on uncertain state. A completed run exits without new effects. Never delete a lock unless its owner is confirmed dead. Never repeat an uncertain send. Reconcile public transaction hashes and protocol state first. Only policyId and transaction hashes are retained from SDK responses; raw responses, error messages and signatures are never journaled or published.

Independent reviews by Codex, actual Claude Code CLI and actual Argon accompany the shared task report. No Colosseum update was posted by this lab task.

Primary protocol references: https://github.com/tempoxyz/tempo/blob/main/tips/tip-1022.md and https://github.com/tempoxyz/tempo/blob/main/tips/tip-1028.md .

[Final provenance checks](evidence/FINAL-PROVENANCE-20261107.json) compare the verifier and preliminary source blobs and bind the 45-test log to the unchanged core tree. Only documentation and evidence changed after the test run.
