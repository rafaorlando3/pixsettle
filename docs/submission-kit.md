# Colosseum submission kit (draft)

Working draft for the Crypto World's Fair, Tempo track. Numbers marked **[TBD]** come from Rafael's merchant interviews (Oct 3 to 8). Everything else is either shown in the demo or sourced at the end.

## Name and tagline

**PixSettle**: Reconcile Pix payments, handle exceptions, verify every settlement.

## One-paragraph description

PixSettle is a reconciliation and exception-handling prototype for merchants who receive Pix from Brazilian shoppers. It links each order to the provider's payment status, a controlled settlement attempt and a verifiable receipt. Duplicate webhooks, interrupted processing, refunds and uncertain RPC responses are treated as explicit states that must be reconciled before another action is allowed. The current demo uses a simulated Pix provider and FX quote, with real test transactions on Tempo Moderato. Its starting market is the Paraguay-Brazil border, where merchant interviews will test whether this workflow solves a meaningful operational problem. Merchant demand and willingness to pay remain unvalidated.

## Problem

- Pix is how Brazil pays: about 148 million individual users at the end of 2025 (Central Bank of Brazil). Brazilian shoppers crossing into Paraguay pay with Pix too; purchases by Brazilians in Paraguay grew 107% in the first four months of 2026 compared with a year earlier (ABC Color).
- Local processors already let merchants receive Pix in guaraníes or US dollars (Bancard: 48 business hours, sales visible in its merchant portal). Access to dollars is not the gap. What remains for merchants **[TBD after interviews]** is the work around each payment: matching it to the order, knowing when and at what rate it settles, and what happens when a payment is refunded or disputed.
- Pix payments can be clawed back. For qualifying fraud cases, a payer may request MED within 80 days; review can continue afterward. Risk allocation depends on the provider and merchant agreements. PixSettle cannot prevent a bank-initiated MED.
- Webhooks are delivered at least once and RPCs time out. A naive "on webhook, send stablecoin" pays twice, or pays and forgets.

## Solution

1. **Checkout**: the merchant creates an order through an API with an idempotency key; the payer scans a Pix QR code.
2. **Confirmation**: the provider webhook is stored durably with an outbox in the same database transaction; we never trust the webhook body, we query the provider and require: received, Pix, same amount, same order.
3. **Settlement on Tempo**: an immutable intent (recipient, amount, 32-byte memo with the settlement id). A separate signer process holds the keys. The nonce is reserved under a lock, the transaction is signed and stored before it is broadcast, and a timeout is reconciled by hash, rebroadcasting only the same bytes. Result: one transfer per order, even with duplicate webhooks, crashes and lost RPC responses.
4. **Refunds and MED**: refunds are blocked while a settlement is in flight, and settlements are never signed while a refund is open. After settlement, a rolling reserve (10% by default) covers refunds and MED claims first; the rest becomes merchant debt. In this version the reserve is accounting only, labeled simulated.
5. **Verifiable receipt**: canonical JSON (RFC 8785) + SHA-256 + EIP-191 signature. The receipt page checks the signature and reads the Tempo transaction directly from the public RPC in the user's browser. Refunds get a linked `refund_notice`.

## Why Tempo

- `transferWithMemo` gives every settlement a reconciliation key on-chain, which is exactly what a payments back office needs.
- Fees are paid in stablecoins and blocks are fast: in our demo a settlement is confirmed about 3 seconds after the Pix is marked received.
- TIP-20 tokens with fixed 6 decimals keep money math exact (integers only, no floating point anywhere in PixSettle).

## What is real in the demo and what is simulated

| Part | Status |
| --- | --- |
| Tempo settlement (testnet Moderato, pathUSD) | Real transactions, verifiable on the explorer |
| Receipt signature and in-browser verification | Real |
| Duplicate webhooks, retries, idempotency, send journal | Real code paths, exercised in the demo and in tests |
| Pix provider | Simulated in the public demo; Asaas sandbox adapter in progress |
| FX quote | Simulated (fixed rate, labeled) |
| Reserve and merchant debt | Simulated accounting, labeled on every screen and receipt |
| MED claim | Simulated case, created explicitly; no real MED event exists in a sandbox |

## Business model (proposal)

- Take rate on settled volume **[TBD after interviews: what merchants pay today to receive Pix in dollars]**.
- Revenue share with the licensed FX partner that does the actual BRL to dollar conversion. PixSettle is software on top of that partner and does not hold customer funds.
- Later: reserve as a product (on-chain reserve with an explicit release policy) and receipts as an audit trail for accounting.

## Traction plan

- Rafael lives in Pedro Juan Caballero, a Paraguayan border city whose shops serve Brazilian shoppers. Between Oct 3 and 8 he interviews **[TBD: 5 to 10]** local merchants (how they receive Pix today, fees, settlement time, disputes) and asks for letters of interest **[TBD]**.

## Team

- Rafael Orlando Mendes, Pedro Juan Caballero, Paraguay: payments and e-commerce operations with Pix and crypto, PHP/Laravel. Works in Portuguese and Spanish, written English.
- Built with an independent review loop: every change to the settlement core that the reviewer reproduced came with failing cases that had to pass before the next step. **[Rafael decides whether to mention the AI tooling here; if a judge asks, answer truthfully.]**

## Pitch video script (target 2:30, captions on screen)

> Historical: this is the script of the first recording, made at commit f7bcbab under the earlier "stablecoin out" positioning. The current demo and pitch videos follow the reconciliation and exception-handling script.

Written for on-screen captions plus an optional synthetic voice-over, pending the organizer's answer on voice.

| Time | Screen | Caption |
| --- | --- | --- |
| 0:00 | Border street, shops, Pix QR on a counter (stock or own footage) | Brazilians pay with Pix. 148 million of them. |
| 0:08 | Map: Brazil and Paraguay border | Across the border, 35,000+ Paraguayan shops already take Pix. They want dollars. |
| 0:18 | Text | But settlement is a black box. And a Pix can be clawed back for 80 days. |
| 0:28 | Logo | PixSettle: Pix in, stablecoin out, with a receipt anyone can verify. |
| 0:35 | Demo console: create order, payer phone shows QR | The merchant creates an order. The payer scans a Pix QR. |
| 0:45 | Click "Payer pays, webhook delivered 3 times" | The provider sends the same webhook three times. We settle once. |
| 0:55 | Timeline animates to "Order settled", 3 s | About 3 seconds later, dollars arrive on Tempo, tagged with a memo. |
| 1:05 | Explorer tab with the transaction | Real transaction on Tempo testnet. |
| 1:12 | Receipt page: green "Receipt verified" | Anyone can check the on-chain part of the receipt in their browser, against the public Tempo RPC. |
| 1:25 | Refund and MED buttons; reserve panel | Refunds and fraud claims hit a reserve first, never a surprise. |
| 1:40 | Diagram of the send journal | Never paid twice: durable journal, same bytes on retry, reconcile by hash. |
| 1:55 | Tests running (60 passing) | Crashes, lost responses, races: tested, and reviewed independently. |
| 2:05 | Business slide | Take rate on settled volume, with a licensed FX partner. No custody. |
| 2:15 | Rafael's interviews **[TBD]** | We are starting in Pedro Juan Caballero, with **[TBD]** merchants interviewed. |
| 2:25 | Logo and repo link | PixSettle, built on Tempo. |

## Technical demo script (target 3:00)

1. `/demo`: create an order for R$ 100,90; show the API call in the timeline (Idempotency-Key).
2. Payer phone: QR and copy and paste code; expiry countdown.
3. "Payer pays, webhook delivered 3 times": timeline shows provider confirmation, immutable intent, nonce reserved, signed offline, broadcast, confirmed; webhook panel shows 3 deliveries, 1 processed, 2 duplicates ignored.
4. Open the explorer link; point at the memo.
5. Open the receipt: signature check, Pix step marked as attested (not provable on-chain), on-chain step verified by the browser. Change one digit in the downloaded JSON and show that verification fails (optional).
6. "Payer sends R$ 0,01 less": order on hold, nothing on-chain, payer sees "under review".
7. Refund R$ 10,00 through the API; then a simulated MED claim: reserve covers what it can, the rest becomes merchant debt; two linked refund notices.
8. Terminal: test suite passing; mention the reviewer's failing cases that now pass.

## Sources

- Central Bank of Brazil, Pix management report 2023 to 2025: https://www.bcb.gov.br/content/estabilidadefinanceira/pix/relatorio_de_gestao_pix/relatorio_gestao_pix_2026.pdf (148.3 million individual users at the end of 2025, as reported by O Tempo: https://www.otempo.com.br/economia/2026/8/10/o-brasil-fechou-2025-com-920-milhoes-de-chaves-pix-cadastradas-confira-dados-de-relatorio-do-bc)
- ABC Color, Jul 15, 2026, border shopping and Pix acceptance in Paraguay: https://www.abc.com.py/negocios/2026/07/15/la-frontera-cambio-de-escala-el-turismo-de-compras-mueve-al-gran-retail/
- MED return window of 80 days and IN BCB 766/2026: see `contract/CONTRATO.md`, section on refunds, and https://digital.sebraers.com.br/blog/leis-e-normas/pix-med-prazo-contestar-devolucao-80-dias/
- Tempo: https://tempo.xyz
