# Failure coverage matrix

This file maps the failure scenarios that matter for a payment settlement system to the automated tests that cover them, and says plainly what is still open. Test names are quoted exactly as they appear in the code (in Portuguese), so each one can be found with a search.

The evidence is the test run for the same commit as this file: GitHub Actions runs every suite on every push (`.github/workflows/tests.yml`). Last local run of the same steps, on 2026-09-28: **146 passed, 1 skipped** (the testnet integration test, see below), and the Python vector check passed.

## How the tests run

| Kind | What is real | What is simulated | Where |
| --- | --- | --- | --- |
| Core | PostgreSQL 16 (a fresh database per test), the outbox, the send journal, the ledger, receipt signing | Pix provider (`SimulatedPixProvider`, with fault injection), Tempo (`FakeChain`, with nonces, mining, lost responses and reverts), process crashes (`crashAt`) | `core/test` |
| Settlement | Receipt format, JCS, SHA-256, EIP-191 signatures, memo encoding, event identity rules | Transaction receipts built in the test | `settlement/test` |
| Browser verifier | The verifier bundled into `web/public/verify.js`, real HTTP calls | A local JSON-RPC server that can answer, fail, return errors or hang | `web/test` |
| Independent check | A second implementation of the receipt format in Python, with no shared code | None | `contract/tools/verify_receipt_vectors.py` |
| Testnet | Tempo Moderato: sign, broadcast, resend the same bytes, confirm | None | `settlement/test/moderato.it.test.ts`, runs only with `TEMPO_IT=1` and a funded test key. **Not run in CI.** |

## Matrix

Status: **Covered** means the expected behavior is asserted by the listed tests and they pass. **Open** means a known gap, with the plan.

### 1. Repeated and out-of-order events never cause a second settlement

Expected: any number of copies of the same webhook, in any order, and two workers racing, produce one settlement intent, one nonce and one transfer. Old events never move a state backwards.

Status: **Covered.**

- `p1.test.ts` › `1. mesmo webhook 5 vezes: 1 liquidação e 4 duplicatas registradas`
- `p1.test.ts` › `2. dois workers pegam a mesma liquidação: uma intenção, um nonce, uma transferência`
- `p1.test.ts` › `6. Pix chega direto como recebido e evento antigo chega depois: uma liquidação, sem regressão`
- `p1.test.ts` › `7. evento persistido e processo cai antes de terminar: a outbox recupera, mesmo com duplicata`
- `codex-review.test.ts` › `R1: observacao antiga sem recibo nao rebaixa uma tentativa ja confirmada`
- `sweep.test.ts` › `com webhook chegando, a varredura não acusa nada e não paga de novo`
- `web.test.ts` › `fluxo da demo: cria pelo endpoint real, webhook 3x, liquida, recibo e link do explorer`

### 2. A crash at any step of sending resumes the same attempt; a lost RPC response stays unknown until reconciled

Expected: a crash after reserving the nonce, after signing, or after broadcasting resumes the same durable attempt with the same signed bytes. A lost response is "unknown", reconciled by transaction hash, and never releases a second payment. A new nonce is used only after a revert is proven.

Status: **Covered** with the simulated chain. The testnet test exercises resending the same bytes on Tempo Moderato, but only when run by hand.

- `p1.test.ts` › `3. queda em ${point}: recupera sem novo nonce e sem segundo pagamento`, run for `after_pre_sign_check`, `after_sign_before_persist`, `after_broadcast_pending_before_rpc`, `after_rpc_before_record`
- `p1.test.ts` › `3b. resposta da RPC perdida depois de aceitar: fica desconhecido, reconcilia pelo hash, um pagamento`
- `p1.test.ts` › `revert comprovado: nova tentativa com novo nonce, um pagamento no fim`
- `review-fixes.test.ts` › `R1: erro de RPC atrasado não apaga a evidência conclusiva nem muda o estado`
- `codex-review.test.ts` › `R2: tesouraria com nonce suspenso nao assina nem transmite pedido posterior`
- `review-fixes.test.ts` › `R2: B já com nonce reservado ou assinado antes da pausa não assina nem transmite enquanto A estiver suspenso`
- `chain.test.ts` › `classificação do reenvio (observado na Moderato)`: `already known` and `nonce too low` go to reconciliation, a timeout is unknown and never a failure
- `moderato.it.test.ts` › `fluxo completo com os mesmos bytes` (testnet, manual)

### 3. A refund or MED racing a settlement

Expected: a refund blocks signing and broadcasting while that is still possible. If the transfer was already broadcast, PixSettle reconciles the exposure (reserve first, then merchant debt) and never claims to have reversed an on-chain transfer. A refund is never executed twice, even with lost or ambiguous provider responses.

Status: **Covered.** The reserve and the merchant debt are accounting entries marked as simulated.

- `p1.test.ts` › `3.6 estorno solicitado antes de assinar: não assina nem transmite`
- `p1.test.ts` › `3.6 estorno surge entre assinar e transmitir: bytes preservados, nada transmitido`
- `refunds.test.ts` › `12b. estorno com liquidação ainda em intent_recorded: não assina, registra o motivo e encerra a liquidação`
- `refunds.test.ts` › `13. estorno com liquidação em unknown ou manual_review: bloqueado com motivo registrado`
- `refunds.test.ts` › `estorno feito direto no provedor: nunca descartado; com liquidação em andamento retém e não transmite`
- `refunds.test.ts` › `MED simulado depois de liquidar: a reserva contábil cobre o que pode, o resto vira dívida simulada; recibos em cadeia`
- `refunds.test.ts` › `resposta do estorno perdida: fica unknown e a conciliação confirma pelo provedor; recusa vira failed com motivo`
- `review-fixes.test.ts` › `R4: queda logo depois de marcar submitting não reenvia; sem prova no provedor o caso fica aberto e bloqueando`
- `review-fixes.test.ts` › `R4: queda depois do provedor aceitar: retomada só observa e confirma, um estorno só`
- `review-fixes.test.ts` › `R6: estorno externo parcial antes de liquidar retém para revisão, sem encerrar liquidação nem marcar devolvido`
- `review-fixes.test.ts` › `R6: depois que a liquidação conclui, a varredura confirma o estorno externo pendente e contabiliza uma vez`
- `codex-refunds-review.test.ts` › `R4`, `R5`, `R6`
- `codex-provider-sweep-review.test.ts` › `R7`, `R8`
- `asaas.test.ts` › `R8: estorno executado com resposta 5xx vira desconhecido, concilia e nunca devolve duas vezes`

### 4. Provider or RPC unavailable

Expected: the system waits with a recorded reason. No balance, order state or receipt announces success without evidence.

Status: **Covered.**

- `p1.test.ts` › `3c. RPC fora do ar na conferência: nunca marca sucesso`
- `review-fixes.test.ts` › `R2: B espera com diagnóstico, sem erro no job; nonce menor que o suspenso não é bloqueado`
- `asaas.test.ts` › `resposta perdida na criação: fica desconhecida e a conciliação acha a cobrança e busca o QR verdadeiro`
- `asaas.test.ts` › `QR indisponível depois de criar vira desconhecido (não falho), e erro HTTP guarda só código e descrição`
- `asaas.test.ts` › `R8: só 4xx com corpo de erro prova recusa; 5xx, 429, corpo ilegível e falha de leitura são ambíguos`
- `asaas.test.ts` › `criação com 5xx concilia pelo externalReference em vez de falhar`
- `sweep.test.ts` › `16. fila de webhook parada: a varredura acha o pagamento, liquida uma vez e o teste de vida acusa`
- `sweep.test.ts` › `cobrança sumiu do provedor: retém para revisão com motivo, sem marcar expirado nem pago`
- `web/test/verify.test.ts`: closed port, HTTP 500, JSON-RPC error and timeout all give "unavailable" (see scenario 7)

### 5. A process restart recovers every reference

Expected: after a restart, the order, the Pix charge, the send attempt, the receipt and the reconciliation continue with their original references.

Status: **Covered.** The simulated Pix provider now keeps its charges in its own table (`simulated_pix_charges`, isolated from the real providers: no core table references it, and ids must start with `pay_sim_`). Each "restart" in these tests is a new provider object with empty memory on the same database.

- `simulator-restart.test.ts` › `cria, reinicia, paga, reinicia, webhook: liquida uma vez com o mesmo pedido e a mesma cobrança`
- `simulator-restart.test.ts` › `webhook perdido e reinício: a varredura acha o pagamento pelo banco do simulador, sem reter como cobrança sumida`
- `simulator-restart.test.ts` › `estorno depois de reiniciar: o provedor novo acha a cobrança, estorna uma vez e grava no banco`
- `simulator-restart.test.ts` › `demo: pedido criado antes do reinício continua pagável pelo botão da demo (antes dava 409 stale_demo_order)`. This test also found that every demo boot created a new demo merchant, so the console lost access to older orders (HTTP 404). The demo merchant now has a fixed id and only its key rotates on each boot.
- `simulator-restart.test.ts` › `cobrança que nunca existiu no simulador continua 404 (a varredura retém com motivo, como antes)` and `o banco recusa id que não seja do simulador (isolamento dos provedores reais)`
- `simulator-restart.test.ts` › `escrita que falha não deixa estado fantasma na memória (ITEM2-02, revisão X-0027): pagamento e estorno`. Found in review: the simulator changed its in-memory copy before the database write was confirmed. It now writes first and only then updates memory; on a failed write it drops the memory copy so the next read comes from the database.
- `simulator-concurrency.test.ts` (ITEM2-03, review X-0032), seven tests with a barrier that holds a chosen database query: `caso A: dois estornos simultâneos de 1000 somam 2000 (respostas, memória, banco e depois de reiniciar)`; `caso A entre dois processos no mesmo banco: o lock da linha soma 2000`; `caso B1: pagamento entra na seção primeiro; a exclusão responde 400 (paga) e nunca apaga RECEIVED`; `caso B2: exclusão confere PENDING e é segurada antes de gravar; o pagamento espera; o fim é RECEIVED, nunca DELETED por cima`; `exclusão de cobrança já paga, sem concorrência: 400 e nada gravado`; `erro na primeira mutação não trava a fila`; `leitura com memória vazia durante uma mutação nunca deixa estado velho na memória`. Found in review: two concurrent changes to the same simulated charge could both start from the same copy, so one was lost (two refunds of 1000 recorded as 1000), and a deletion checked "pending" outside the write, so it could erase a payment (final state DELETED over RECEIVED). Each change is now one database transaction that re-reads the row with `FOR UPDATE`, checks the precondition inside, writes, commits and only then updates memory; in the process, the operations on one charge (changes and database reads) go through a queue, so memory never receives an older state than the one already published.
- Limit: the fixed demo merchant id helps restarts from now on; it does not bring back charges that existed only in memory before this version.
- Limit: the demo runs one process. With more than one process on the same database, the row lock keeps writes correct, but each process's memory only sees its own writes (the second test above shows this). Nothing here promises more.
- Still covered from before: `p1.test.ts` › the four crash points of scenario 2 and `7. evento persistido e processo cai antes de terminar: a outbox recupera, mesmo com duplicata`; `review-fixes.test.ts` › both `R4` tests; `worker.test.ts` › `lease de um worker que morreu: espera o lease vencer e retoma o job`.

### 6. Amounts, rounding and minimum units

Expected: all money is integers in minimum units (centavos for BRL, 6 decimals for pathUSD). Gross is the floor of amount × rate. Net + reserve + fees = gross, always. Reserved, settled and pending money are separate ledger entries, and a ledger entry is never written twice.

Status: **Covered.** One defect was found and fixed while building this matrix, and one low-risk case is open.

- `amounts.test.ts` › `bruto é o piso de valor x cotação; reserva é o piso de bruto x bps; líquido + reserva = bruto` (more than 200 combinations of amount, rate and reserve rate)
- `amounts.test.ts` › `reserva de 100% (líquido zero) é recusada, não vira liquidação de 0`
- `amounts.test.ts` › `líquido registrado maior que o bruto é recusado`
- `amounts.test.ts` › `taxa de reserva muda entre intenção e confirmação: livro-razão e recibo usam a da intenção`. **Fixed defect:** the ledger and the receipt used to recompute the reserve from the merchant's reserve rate at confirmation time. If the rate changed after the settlement intent, net + reserve would no longer equal gross (the test fails on the previous code with reserve 4,565,725 instead of 1,826,290). Now the reserve comes from the intent (gross minus net). No API changes the reserve rate today, so this was latent.
- `api.test.ts` › `8. fluxo completo pela API: pedido, Pix, liquidação e recibo verificável` (net + reserve = gross in the signed receipt)
- `asaas.test.ts` › `conversão de dinheiro exata e recusa de casas extras`
- `p1.test.ts` › `4. valor pago diferente: retido com motivo, sem liquidação`; `web.test.ts` › `valor diferente: pedido retido, nada liquidado, pagador vê "em análise" sem o motivo interno`
- `review-fixes.test.ts` › `R1: o banco recusa lançamento contábil em dobro para a mesma liquidação`
- `codex-refunds-review.test.ts` › `R5: devolucoes de pedidos diferentes nao podem consumir a mesma reserva do lojista`
- `receipt.test.ts` › `número fracionário ou grande demais é recusado (dinheiro vai como string)`
- **Open (low):** the database allows a merchant reserve rate of 100%. The settlement intent then refuses to create a zero transfer (tested above), but the order waits in the outbox with the error recorded, instead of being held for review with a reason. No API sets this rate.

### 7. Receipt verification in the browser

Expected: a receipt that contradicts the chain is "failed". Anything the chain did not answer conclusively is "unavailable", with its own reason, and the page never calls such a receipt valid or invalid. A valid signature alone does not prove that the Pix was received: the page shows the Pix part as the issuer's signed statement.

Status: **Covered.** Two defects were fixed: a receipt for another network and a malformed field were reported as "unavailable" instead of "failed". A third case was corrected after review (REV-01): a transaction the RPC does not return is **not** proof of a false receipt, because it may still be pending or the node may be behind, so it is "unavailable" with the reason `receipt_not_found`, not "failed". A structurally incomplete RPC answer is "unavailable" with the reason `rpc_incomplete` and no longer leaves the page stuck.

- `web/test/verify.test.ts` (23 tests, local JSON-RPC server that behaves like a node: malformed hash gets a parameter error, unknown hash gets no receipt):
  - valid receipt: signature ok, settlement ok
  - tampered after signing, untrusted issuer: signature fails
  - failed: wrong network (checked before any RPC call), malformed `tx_hash`, malformed amount and recipient, reverted, different block, different amount, different memo, different token, different log index
  - unavailable, `receipt_not_found`: the RPC has no receipt; the same envelope verifies as ok on the next check once the receipt exists (one RPC call per check, no endless polling)
  - unavailable, `rpc_incomplete`: receipt without block hash, receipt without logs; an odd log without topics is skipped and the right log still matches
  - unavailable, `rpc_unreachable`: closed port, HTTP 500, JSON-RPC error, timeout
  - refund notice: informational only, no RPC call
- The receipt page shows a different message for each reason and a "Verify again" button; if the verifier itself throws, the page says the check could not complete instead of spinning forever.
- `receipt.test.ts`: shared vectors (`contract/vectors/receipt-v1.json`), valid and invalid, duplicate JSON keys refused
- `chain.test.ts` › `identidade do evento (seção 4.8)`: same memo on another token, sender, recipient, amount or network does not count; a reverted receipt does not count
- `contract/tools/verify_receipt_vectors.py`: the same vectors checked by an independent Python implementation

### 8. Idle worker: zero database queries when there is nothing to do

Expected: with an empty queue and nothing left to reconcile, the worker makes no database queries at all until a request wakes it, so it no longer keeps the hosted database awake (Neon suspends a compute after 5 minutes without queries; the suspension itself has not been observed on the hosted demo yet, zero queries in a test is not that proof). It never treats a database error as an empty queue, never loses a wake-up, and still runs future jobs, expired leases and the periodic sweep on time.

Status: **Covered.** Measured with `core/scripts/measure-idle.ts` on an empty database, 10 seconds, in two separate runs: the previous loop (200 ms polling) made **150 and 147 queries (900 and 882 per minute)**; the new worker made **0** in both.

- `worker.test.ts` › `sem nada a fazer: fica idle e faz ZERO consultas enquanto ninguém chama wake` (every query is counted: direct and inside transactions)
- `worker.test.ts` › `pedido aguardando pagamento: não fica idle (varredura pendente), espera o intervalo da varredura sem consultar no meio`
- `worker.test.ts` › `evento chega (commit) + wake: liquida até o fim e volta a idle; depois, zero consultas`
- `worker.test.ts` › `wake durante o trabalho não se perde: o job gravado nesse meio-tempo roda sem esperar timer`
- `worker.test.ts` › `job com horário futuro: fica waiting e roda sozinho na hora, sem wake`
- `worker.test.ts` › `lease de um worker que morreu: espera o lease vencer e retoma o job`
- `worker.test.ts` › `botão "pagar" da demo (POST) acorda o worker ocioso, que liquida sem nenhum wake manual`
- `worker.test.ts` › `consulta falhando: estado error com o motivo, nunca idle; quando o banco volta, conclui e fica idle`
- `worker.test.ts` › `criação com resposta perdida + pagamento sem webhook + reinício: só o worker, sem wake, liquida uma vez` and `mesma situação sem pagamento: depois de recuperar a cobrança o worker fica esperando a varredura, não ocioso`. Found in review (ITEM2-01): the worker decided whether a sweep was needed before draining the queue, so a job that turned an order into "awaiting payment" left it asleep with nothing watching that order. It now re-checks after draining.
- Known limit, stated in `src/worker.ts`: the wake-up is in-process. With more than one process writing to the outbox, set `WORKER_MAX_IDLE_MS` to cap the sleep. The demo runs one core process.
- With the simulated Pix provider nothing changes outside without one of our own requests, so already received charges are not re-observed (`SWEEP_RECENT_RECEIVED_MS` defaults to 0 there; with Asaas it keeps the 2-day window).

## What these tests do not prove

- No real Pix provider in production was used. The production adapter is tested only on the bench and stays blocked until a licensed partner is in place.
- The testnet integration test is manual; CI never talks to Tempo.
- There are no load or long-running soak tests.
- The pages are tested through HTTP requests, not browser automation. The demo videos were recorded against the public demo.

## Run it yourself

```bash
# PostgreSQL 16 reachable at TEST_DATABASE_ADMIN (each test creates and drops its own database)
export TEST_DATABASE_ADMIN=postgres://postgres:postgres@localhost:5432/postgres
for p in settlement core web; do (cd $p && npm ci); done
(cd settlement && npm test) && (cd core && npm test) && (cd web && npm test)
pip install pycryptodome==3.23.0 eth-keys==0.8.0 && python contract/tools/verify_receipt_vectors.py
```
