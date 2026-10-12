# Tempo deposit addresses (TIP-1022) and receive policy (TIP-403)

Every PixSettle exception starts with one question: which order does this payment belong to? With Pix, the answer comes from the provider's reference. On-chain, it usually depends on a memo that the payer can forget or mistype. Tempo answers it in the protocol. This module adds two Tempo primitives to PixSettle's reconciliation, with rules, tests and live runs on Tempo testnet; the hosted checkout does not issue deposit addresses yet (see Limits):

1. **A deposit address per order (TIP-1022 virtual addresses).** The merchant's settlement wallet registers a `masterId` once. Each order then gets its own address: `masterId` (4 bytes) + `0xfd` x 10 + a 6-byte tag derived from the merchant and the order. When someone pays that address, the TIP-20 token forwards the funds to the merchant wallet in the same transaction and emits two `Transfer` events (payer to deposit address, deposit address to merchant wallet). The order is identified by the address itself, with no memo. Deposit addresses never hold a balance.
2. **A receive policy on the merchant wallet (TIP-403 policy registry; guard receipts per TIP-1028).** The wallet accepts only the stablecoins it settles in. A payment in any other token is not credited to the merchant: the `ReceivePolicyGuard` holds it and emits a receipt (`TransferBlocked`) that still records the deposit address the payer used, so even a refused payment points to its order. With the recovery authority left empty, the payer can reclaim it with that receipt.

`core/src/chain/deposits.ts` turns the logs of full transaction receipts into outcomes with the same approach as the exception copilot: deterministic rules first, a reason and a next step for every case. Payments to the same order add up, so a top-up after a short payment completes the order instead of looking like a duplicate. Anything that touched the merchant wallet and cannot be proven from the logs becomes `not_reconciled` with the reason; nothing is dropped silently. It reads logs only; it never signs or holds a key.

| Outcome | What happened on chain | Next step | Pix analogue |
|---|---|---|---|
| `matched` | Exact amount to the order's deposit address | Settle the order | Pix matched to its charge |
| `amount_short` / `amount_over` | Total received so far is below / above the order amount | Ask for the difference at the same address / refund the excess | Valor a menos / a mais |
| `completed_by_top_up` | A later payment brought the total to the exact amount | Settle the order | Pix complemented |
| `second_payment` | Another payment after the order was already paid in full | Refund it | Duplicate Pix |
| `wrong_token` | A listed stablecoin the order does not accept | Convert or return | n/a |
| `unknown_deposit_address` | A deposit address the merchant never issued | Hold for review, return if unclaimed | Pix without a matching charge |
| `no_reference` | Paid straight to the merchant wallet | Ask which order, or return | Pix without reference |
| `held_by_receive_policy` | Token outside the policy, held by the guard (status: held, returned to payer, released, burned) | Payer reclaims with the receipt | Payment refused before it reaches the merchant |
| `not_reconciled` | Missing payer hop in the logs, unwatched token, non-TIP-20 emitter or undecodable receipt | Fetch the full receipt or review by hand | Unidentified credit |

## Live run on Tempo Moderato (testnet, chain id 42431)

Disposable testnet accounts and faucet test tokens with no value. Merchant wallet `0x49A10B709d296406Fdf68F88CfE26DF339F761Bc`, `masterId` `0x533041b7`.

Setup:
[master registration](https://explore.testnet.tempo.xyz/tx/0xb8b3796f83d4cfa61e731dbd6e0a40af8d4afbb2d2a0b622ae933b98bb8adb7d) ·
[token whitelist policy 1253228 (pathUSD, AlphaUSD)](https://explore.testnet.tempo.xyz/tx/0x561f6315bd1f6bd5f50dbd5e2163c288d90ba6d1f7aa56e2d273e75953c40766) ·
[receive policy on the merchant wallet](https://explore.testnet.tempo.xyz/tx/0x7b8f546a78875b8ecfb61aefcafec3cc39ed6ce512dea586393e34020187d07e)

Run `a56207`, produced by `core/scripts/tempo-deposits-moderato.ts`:

| Payment | Outcome | Transaction |
|---|---|---|
| Order A, US$ 25.00 in pathUSD, no memo | `matched` | [0xe8c5ee08…](https://explore.testnet.tempo.xyz/tx/0xe8c5ee082739181654601375176f2f1028f8fc40a450ac170714d40551c30f94) |
| Order B expects US$ 40.00, receives 39.50 | `amount_short` (US$ 0.50) | [0x31b6f229…](https://explore.testnet.tempo.xyz/tx/0x31b6f22915bbf552c1bb69917481dfec4701e602bfdc41ed788c26ad559ce356) |
| Order A paid again | `second_payment` | [0xcda31191…](https://explore.testnet.tempo.xyz/tx/0xcda31191f87ae91559487392cc0bfb6732bed10b652179e6c71ef056d6672ebb) |
| US$ 5.00 to a deposit address never issued | `unknown_deposit_address` | [0xbb6991be…](https://explore.testnet.tempo.xyz/tx/0xbb6991bef788c45416ccd01db9bb1908e716cb798af3d96864a76d7cdbb3ed25) |
| Order C paid in BetaUSD, outside the policy | `held_by_receive_policy`, then returned to the payer ([claim](https://explore.testnet.tempo.xyz/tx/0xe01b2b5cc46b038de3f4d416031539240df811beddb76e77826cfaa99d033547)) | [0x0f40ea11…](https://explore.testnet.tempo.xyz/tx/0x0f40ea1127ed2978a703289137579bcb28aed85949274c4eef0bbfdb391a0759) |
| US$ 7.00 straight to the merchant wallet | `no_reference` | [0x0e5281e2…](https://explore.testnet.tempo.xyz/tx/0x0e5281e24aaf4ac23fc6fb851ca6c32f6a421f0cb9721e6e69b16648262c54da) |
| Order D, US$ 18.90 in AlphaUSD with a memo | `matched` | [0x12792d8e…](https://explore.testnet.tempo.xyz/tx/0x12792d8e509770c5ab644f50ca778e1d135c5df0435c6072a9990c4527d3425a) |

The full output is in [`docs/evidence/tempo-deposits-moderato.json`](evidence/tempo-deposits-moderato.json). Network fees in every transaction were paid in pathUSD; there is no separate gas token.

A second run from a clean state (new disposable accounts, salt mined in about 10 minutes on 2 CPU cores) gave the same seven outcomes: merchant wallet `0x87ED7b267615F7def7759E1947cDbC26336063AD`, `masterId` `0x37762a73`, [registration](https://explore.testnet.tempo.xyz/tx/0x2b4d5afc1aa5fcbf8e7922588c8347ccf3ce27116cea29d5ee583cdd28e57598), output in [`docs/evidence/tempo-deposits-moderato-fresh.json`](evidence/tempo-deposits-moderato-fresh.json).

## Reproduce

```
cd core
npx tsx scripts/tempo-deposits-moderato.ts          # creates disposable testnet accounts in .tempo-deposits/
npx vitest run test/tempo-deposits.test.ts          # rules, checked against logs copied from Moderato
```

The script funds the accounts from the Moderato faucet, mines the TIP-1022 salt (32-bit proof of work, minutes with all cores), registers the merchant wallet, sets the receive policy, makes the seven payments above with new order ids, reclaims the held payment, reconciles from the chain logs and exits with an error if any outcome differs from the plan. Each step is recorded in the state file: an interrupted run continues where it stopped, and a payment interrupted mid-send is never resent blindly.

The tests use the logs of an earlier run on the same merchant wallet (`core/test/fixtures/tempo-deposits-moderato.json`), plus synthetic logs in the same format for what the network did not show: top-ups, the merchant paying its own deposit address, a forward hop without its first hop, two deposits in one transaction, fee, DEX, mint and guard transfers, contracts that are not TIP-20 tokens, memos from another payer, claims by the payer and by a recovery authority, burned receipts and an unknown receipt version. Each of the 27 guards in the rules was removed once and every removal makes a test fail.

## Limits, stated plainly

- Testnet only. The hosted demo's checkout does not issue deposit addresses yet; wiring it means storing one tag per order and running the scan in the worker that already follows settlements.
- A `masterId` cannot be moved to another wallet (TIP-1022). In production the merchant would register it from a wallet that can rotate keys, such as a multisig.
- Forwarding works only for TIP-20 tokens; tokens sent to a deposit address on other contracts would be lost (TIP-1022), which the receive policy does not cover.
- A payment to a deposit address whose `masterId` is not registered reverts (TIP-1022), so nothing is stranded on an unregistered address. A typo in the tag still reaches the merchant wallet and shows up as `unknown_deposit_address`.
