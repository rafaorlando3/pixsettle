# Contrato v0.3: núcleo Pix e liquidação em stablecoin

Projeto do Colosseum Crypto World's Fair, trilha Tempo. Nome de trabalho: PixSettle (provisório).
Autor: Claude, 27/09/2026 (Assunção). Base: v0.2 e a mensagem X-0001 do Codex no canal (27/09 01:55).
Estado: **v0.3 para conferência do Codex só nos trechos da tabela "Mudanças da v0.3"** (5.1, 6 e 7 já estão ok). Nenhum código antes do ok.

## Mudanças da v0.3 (mensagem X-0001 do Codex)

| Ponto | Resolução |
| --- | --- |
| `manual_review` liberava o pedido | `manual_review` é resultado financeiro desconhecido: entra no bloqueio de estorno, no bloqueio de nova liquidação e no conjunto de tentativas ativas (3.6, 4.2, 4.9) |
| Checagem só antes de assinar | Retenção e devolução são conferidas antes de assinar **e** de novo imediatamente antes de transmitir (3.6, 4.7) |
| Obrigação de transmitir toda tentativa assinada | Removida. Com estorno externo ou `exposure_reconciliation`, a tentativa fica `suspended` com bytes e nonce preservados e a fila de assinatura da tesouraria para com diagnóstico (3.5, 4.4) |
| Recuperação da reserva de nonce | Nonce reservado fica ligado a uma tentativa durável (`nonce_reserved`) antes de soltar a trava; queda antes de persistir a assinatura retoma a mesma reserva, sem novo nonce e sem buraco. O serviço de assinatura não transmite (3.5, 4.4, 4.6) |

## Mudanças da v0.2 (conferência do Codex de 01:46)

| Ponto | Resolução |
| --- | --- |
| 3.1 Criação desconhecida | Busca vazia não prova falha; `creation_failed` só com falha definitiva identificada; senão `creation_review`. Mais de uma cobrança achada é `creation_conflict`, sem escolher nem emitir outra |
| 3.2 e 3.3 Pix e devolução | `overdue -> received` incluído. Estado observado da cobrança separado do `refund_case`. Devolução confirmada direto (inclusive iniciada no provedor) e várias parciais até o total, sem passar por `unknown` |
| 3.4 Prazos | Pagamento no prazo quando `paid_at <= expires_at`, comparando instantes com fuso. Sem hora confiável e com decisão dependente da hora: retenção para conciliação. Prazo vem do `expirationDate` do QR, não da regra geral. `late_paid` abre `refund_case` (não confirma devolução) |
| 3.5 Envio | `queued` removido: a espera é `intent_recorded`. A possibilidade de envio é gravada (`broadcast_pending`) antes da chamada RPC, e `broadcast_pending` também pode virar `unknown` |
| 3.6 Exclusão | Trava do pedido nos dois sentidos: sem estorno com liquidação possivelmente enviada, sem assinar ou transmitir com `refund_case` aberto, desconhecido ou confirmado. Estorno observado no provedor nunca é descartado: registra, suspende ações novas e concilia a exposição |
| 4 Deduplicação | Sob trava da liquidação, repetir o mesmo `settlement_id` reutiliza a tentativa ativa ou devolve o resultado confirmado. No banco, no máximo uma tentativa ativa por liquidação. A alocação de nonce considera as reservas do diário e grava a reserva antes de soltar a trava da tesouraria |
| 7 Verificação | Verificador recalcula `SHA-256(JCS(payload))`, compara com o digest do envelope e reconstrói a mensagem só a partir do payload e do digest recalculado. Coerência obrigatória entre `issuer`, `signature.signer`, endereço recuperado e lista confiável. EIP-191 versão `0x45`. Campos obrigatórios por `receipt_type`; `refund_notice` sem transferência on-chain não inventa `tx_hash` |

## Mudanças da v0.1 em relação ao v0 (resposta à revisão)

| Ponto do Codex | Decisão no v0.1 |
| --- | --- |
| 1. Memo não impede pagamento duplo; resultado desconhecido | **Aceito.** Diário durável de envio: intenção imutável, nonce alocado pelo core sob trava, `nonceKey = 0` explícito, transação assinada persistida antes de transmitir, retransmissão só dos mesmos bytes, `unknown` vira `manual_review` (seção 4) |
| 1. Identidade do evento | **Aceito.** chain id, endereço do token, from, to, amount, memo, recibo com sucesso e bloco (seção 4.5) |
| 2. Reserva e MED | **Adaptado.** A reserva continua na demo porque é o centro do pitch, mas como **reserva contábil simulada**, rotulada assim em tela, recibo e pitch. Nada de segregação on-chain nem garantia de cobertura. MED vira `refund_case` com tipo e `simulation_reason` (seção 6) |
| 2. Frase sobre 80 dias | **Corrigido.** O pagador pode pedir devolução pelo MED em até 80 dias. A IN BCB 766/2026 (vigente em 01/09/2026) ampliou de 30 para 80 dias o prazo do **recebedor** contestar uma devolução. Nada de liberação automática por prazo |
| 3. Recibo | **Aceito.** JCS (RFC 8785), números monetários como string decimal inteira, envelope com digest e assinatura EIP-191 sobre mensagem com aplicação, versão, ambiente e digest, vetor de teste PHP e TypeScript, emissor confiável fixado, recibo imutável e devolução em recibo ligado (seção 7) |
| 4. Estados Pix e fronteiras da API | **Aceito.** `CREATED -> RECEIVED` direto; criação com resultado desconhecido; evento durável com outbox; sem regressão por ordem; expiração pela data do pagamento; política de cotação vencida; fluxo de estorno próprio; sessão de checkout; health separado; idempotência por lojista; HMAC com proteção de replay (seções 3 e 5) |
| 5. Critérios de aceite | **Aceito.** Incluídos na seção 9, com a ordem de prioridade até 12/10 |

## 0. Escopo e fronteiras honestas

- Demo: **Asaas sandbox** (`provider_env = sandbox`) e **Tempo testnet Moderato** (`chain_env = testnet`, chain id 42431), token fixado por endereço de contrato, nunca por símbolo. Sem dinheiro real e sem dados pessoais reais.
- Sem câmbio real. Em produção a conversão é de um parceiro autorizado pelo Banco Central (PSAV). O produto é software sobre esse parceiro, sem custódia de clientes.
- Lado Pix: **afirmação assinada pelo operador**. Lado on-chain: **verificável por qualquer pessoa**. O recibo mostra os dois separados.
- Cotação simulada: `quote.source = "simulated"`.

## 1. Componentes

| Pasta | Tecnologia | Responsabilidade |
| --- | --- | --- |
| `core/` | Laravel 12, PHP 8.4, PostgreSQL 16 | Pedidos, cobranças, eventos, diário de envio, livro-razão, casos de devolução, recibos, outbox, API |
| `settlement/` | TypeScript, viem (versão fixada) | Assina com nonce dado pelo core, transmite bytes recebidos, consulta recibos e logs. Não aloca nonce nem decide negócio |
| `checkout/` | TypeScript | Tela do pagador (sessão de checkout) e painel do lojista |
| `contract/` | Markdown, JSON Schema, vetores de teste | Este contrato e os vetores comuns PHP/TypeScript |

## 2. Identificadores e dinheiro

- IDs: ULID com prefixo `ord_`, `chg_`, `stl_`, `att_` (tentativa), `rfc_` (caso de devolução), `rct_`, `mer_`, `quo_`, `cks_` (sessão de checkout).
- Externos em colunas próprias: `asaas_payment_id`, `asaas_event_id`, `pix_e2e_id` quando exposto, `tx_hash`, `block_number`, `block_hash`, `log_index`.
- Dinheiro: inteiro em unidade mínima, moeda explícita. Em JSON sempre string decimal: `{"amount": "10090", "currency": "BRL", "scale": 2}`. Token TIP-20 tem 6 casas: `{"amount": "18250000", "currency": "pathUSD", "scale": 6, "token": "0x..."}`.
- Cotação: razão inteira exata (`rate_num`, `rate_den`) com unidade definida (unidades de token por centavo), `quote_id`, `valid_until`, regra de arredondamento `floor`. Tarifas simuladas explícitas. Identidade contábil: bruto = líquido + tarifas + reserva simulada, sem valor negativo.
- Memo: `bytes32` com ASCII de `stl_<ULID>` (30 bytes) e zeros à direita; teste de codificação obrigatório.

## 3. Máquinas de estado

Regras gerais: transições só pelo serviço de domínio, em transação com trava da linha; transição inválida é erro registrado com motivo; toda transição vai para `state_transitions` (só inserção). Retenção (`hold_reason`) é campo separado dos estados Pix, de devolução e on-chain, para não apagar o estado financeiro.

### 3.1 Cobrança (criação)

```
creating -> created
creating -> creation_unknown -> (conciliação por externalReference)
    -> created               (exatamente uma cobrança encontrada e conferida)
    -> creation_conflict     (mais de uma: retenção, sem escolher nem emitir outra)
    -> creation_review       (nenhuma encontrada: não prova falha; retenção e revisão)
creating -> creation_failed  (só com falha definitiva identificada; corpo da resposta guardado)
```

Timeout na criação nunca gera segunda cobrança automaticamente. A API responde 202 enquanto não houver QR confirmado.

### 3.2 Estado observado da cobrança no provedor

```
created -> received                  (PAYMENT_RECEIVED; pode vir direto, sem CONFIRMED)
created -> confirmed -> received
created -> overdue -> received       (pagamento depois do vencimento do provedor)
created | overdue -> deleted
received -> partially_refunded -> ... -> refunded   (observado; várias parciais até o total)
received -> refunded                 (observado; inclusive iniciado no provedor)
```

Sem regressão: a verdade é o estado consultado no provedor; evento antigo ou não aplicável é registrado como `stale`, sem retry infinito. Liquidação só depois de consulta que confirme `RECEIVED`, `billingType = PIX`, valor igual e `externalReference` igual.

### 3.3 Caso de devolução (`refund_case`), separado da cobrança

```
requested -> unknown -> confirmed | partial | failed
requested -> confirmed | partial | failed        (resposta direta)
(observado no provedor sem pedido nosso) -> confirmed | partial
partial -> novo refund_case até o total
```

`refunded` na cobrança só depois de confirmação observada. Tipos: `merchant_refund`, `provider_refund`, `late_payment_refund`, `med_simulated` (este exige `simulation_reason`).

### 3.4 Pedido e prazos

```
created -> awaiting_payment -> paid -> settling -> settled
awaiting_payment -> expired           (nosso prazo; pedimos DELETE da cobrança e conciliamos o resultado)
paid_at <= expires_at                 -> paid, mesmo que o aviso chegue depois
paid_at > expires_at                  -> late_paid -> abre refund_case (late_payment_refund)
sem horário confiável e decisão depende da hora -> hold_reason = timing_unresolved
paid_at > quote.valid_until           -> hold_reason = quote_expired; nova cotação só por ação explícita
```

- `paid_at` é o instante informado pelo provedor, com fuso; se o provedor só der a data, e a data não decidir sozinha, retém.
- O prazo do QR é o `expirationDate` retornado pelo provedor, não a regra geral de 12 meses (há exceção publicada para cobrança sem chave Pix cadastrada).
- Saída de retenção: só por ação registrada (correção e revalidação), mantendo o histórico.

### 3.5 Liquidação e tentativas

```
intent_recorded -> nonce_reserved -> signed -> broadcast_pending -> broadcast_sent -> confirmed
broadcast_pending | broadcast_sent -> unknown -> (reconciliação) -> confirmed | manual_review
nonce_reserved (processo caiu antes de assinar) -> retoma a MESMA reserva e a mesma tentativa
signed | broadcast_pending (processo caiu) -> retransmitir os MESMOS bytes
signed + retenção nova (estorno externo, exposure_reconciliation) -> suspended (bytes e nonce preservados; fila da tesouraria parada com diagnóstico)
tentativa com recibo revertido -> attempt_reverted (prova final daquela tentativa)
   -> erro corrigível (ex.: saldo da tesouraria): nova tentativa com novo nonce, só depois do revert confirmado
   -> erro definitivo: settlement failed + hold_reason
```

- `intent_recorded` aguarda a reserva; `nonce_reserved` aguarda a assinatura; nenhum dos dois comprova envio. Não existe `queued`.
- `broadcast_pending` é gravado **antes** da chamada RPC: a partir dele, envio é possível e falta de resposta vira `unknown`, nunca "não enviado".

### 3.6 Exclusão entre estorno e liquidação (nos dois sentidos)

- Com liquidação em `nonce_reserved`, `signed`, `suspended`, `broadcast_pending`, `broadcast_sent`, `unknown` ou `manual_review`: pedido de estorno bloqueado com motivo. `manual_review` é resultado financeiro desconhecido e só sai com prova conclusiva.
- Com `refund_case` em `requested`, `unknown`, `confirmed` ou `partial`, ou com `hold_reason` ativo: o assinante não assina e o transmissor não transmite. A checagem acontece sob a trava do pedido antes de assinar **e de novo imediatamente antes de transmitir**, e as duas ficam registradas na tentativa.
- Estorno observado no provedor (que a trava local não impede) nunca é descartado: registra o fato, suspende ações novas no pedido e marca `hold_reason = exposure_reconciliation`.

## 4. Diário durável de envio (Tempo)

1. **Um assinante por tesouraria.** Trava consultiva do PostgreSQL por `(chain_id, sender)`. Só esse worker aloca nonce.
2. **Deduplicação por liquidação.** Sob a trava da liquidação, repetir o mesmo `settlement_id` reutiliza a tentativa ativa ou devolve o resultado confirmado, sem alocar nonce. No banco: índice único parcial garantindo no máximo **uma tentativa ativa** por liquidação (ativa = `nonce_reserved`, `signed`, `suspended`, `broadcast_pending`, `broadcast_sent`, `unknown`, `manual_review`). Nova tentativa só depois de `attempt_reverted` confirmado.
3. **Modo de nonce explícito:** `nonceKey = 0` (sequência comum), nonce passado explicitamente ao viem na versão fixada; teste que prova que o SDK não trocou o modo. Unicidade no banco: `unique(chain_id, sender, nonce_key, nonce)`.
4. **Alocação de nonce:** próximo nonce = maior entre o nonce pendente da cadeia e (maior nonce reservado no diário + 1). A reserva é gravada e **ligada a uma tentativa durável em `nonce_reserved`** antes de soltar a trava da tesouraria. Se o processo cair depois de reservar e antes de persistir a assinatura, a retomada usa a mesma tentativa e o mesmo nonce, sem alocar outro e sem deixar buraco. Uma tentativa assinada é transmitida com os mesmos bytes, **exceto** quando uma retenção nova proíbe o pagamento: aí fica `suspended`, com bytes e nonce preservados, e a fila de assinatura dessa tesouraria para com diagnóstico até decisão registrada. Nunca transmitir um pagamento proibido só para liberar a sequência de nonces. Cancelamento e substituição ficam fora desta versão.
5. **Intenção imutável** gravada antes de tudo: rede, contrato do token, origem, destino, unidades, memo. Mesmo `settlement_id` com conteúdo diferente é conflito.
6. **Assinar e persistir antes de transmitir:** o serviço de assinatura só assina, nunca transmite. O core pede ao `settlement/` a assinatura com o nonce reservado e grava na mesma transação: bytes assinados, hash, nonce, parâmetros de taxa e a ordem "transmitir" na outbox. Bytes assinados em coluna de acesso restrito, fora de logs e do checkout.
7. **Transmitir só os mesmos bytes.** Reconfere retenção e devolução sob a trava do pedido, grava `broadcast_pending` e só então chama a RPC. Timeout ou queda: reconciliar e, se preciso, retransmitir exatamente os mesmos bytes. Nunca novo nonce nem nova validade por causa de timeout.
8. **Identidade validada do evento:** recibo com sucesso, `chain_id`, endereço do token, `from` = tesouraria, `to`, `amount`, `memo`, `block_number`, `block_hash`, `log_index`. Evento de outro token com o mesmo nome não serve.
9. **Resultado desconhecido:** nonce consumido e resultado não identificado vira `manual_review`, que continua bloqueando estorno e nova tentativa até prova conclusiva. Substituição de taxa fica fora desta versão.
10. Taxa da Tempo é paga em stablecoin: o diagnóstico mostra o saldo do token de taxa da tesouraria.

## 5. Webhooks e API

### 5.1 Webhook do Asaas

1. Conferir `asaas-access-token` em tempo constante; falha: 401 com motivo registrado, sem guardar o corpo com dados pessoais.
2. Na **mesma transação**: gravar o evento (`unique(asaas_event_id)`), estado de processamento (`received_event`, `processing`, `processed`, `error`) e a mensagem na outbox.
3. Duplicata: 200, mas se o evento anterior estiver pendente ou com erro, reprocessar pela outbox. Persistido não é processado.
4. O processamento consulta o provedor (`GET /v3/payments/{id}`); resposta inesperada guarda status e corpo (sem dados pessoais), retry com espera crescente, alerta depois de 5.
5. Conciliação por consulta a cada 5 minutos, paginada e com janela sobreposta: cobranças pendentes, recém-recebidas, estornos e casos `creation_unknown`. Teste de vida alerta quando o provedor mostra mudança e nenhum webhook chegou (a fila do Asaas pausa após 15 falhas e apaga eventos com mais de 14 dias).

### 5.2 API

- **Lojista** (servidor do lojista, chave secreta): `POST /api/v1/orders` devolve `order_id` e `checkout_token` (sessão `cks_` só daquele pedido, leitura, com expiração). O lojista é derivado da autenticação, nunca do corpo.
- **Pagador** (tela pública): `GET /api/v1/checkout/{checkout_token}` com QR, valor, validade e estado. Sem chave do lojista no navegador.
- **Lojista:** `GET /api/v1/orders/{id}`, `GET /api/v1/merchants/me/ledger`, `POST /api/v1/orders/{id}/requote` (ação explícita), `POST /api/v1/orders/{id}/refund`.
- **Recibos:** `GET /r/{receipt_id}` projeção pública mínima; `GET /api/v1/receipts/{id}` detalhe autenticado.
- `GET /health` público mínimo (`ok` ou `degraded`); `GET /internal/diagnostics` autenticado (banco, provedor, RPC, saldos, fila, liquidações paradas).
- `Idempotency-Key` em todo POST da API, com escopo `(merchant_id, operação)`; mesma chave e mesmo corpo devolvem a mesma resposta, corpo diferente devolve 409. O webhook não usa essa chave: a identidade dele é `asaas_event_id`.
- Isolamento: lojista B não lê nem altera nada do lojista A; `checkout_token` não lista livro-razão nem cria pedido.
- Erro único: `{"error": {"code": "...", "message": "...", "details": {}}}`.

### 5.3 Core e `settlement/`

HTTP só em localhost. Assinatura HMAC de `método\nrota\ntimestamp\nsha256(corpo)`, janela de 60 segundos e cache de nonce de requisição contra replay. Nenhum token ou corpo com dados pessoais em log.

## 6. Devoluções e reserva contábil simulada

- `refund_case` com `type` em `merchant_refund`, `provider_refund`, `med_simulated`. Tipo simulado exige `simulation_reason`. Não inventamos evento de MED do Asaas nem da Eulen.
- Reserva: **contábil e simulada**. Um lançamento no livro-razão separa `reserve_bps` (parâmetro experimental, padrão 1000) do líquido do lojista, em unidades do token. Não é saldo segregado on-chain, não garante cobertura e não cobra dívida automaticamente. BRL e unidades de token nunca se somam diretamente.
- Na demo: um `med_simulated` mostra a reserva contábil sendo consumida e o saldo remanescente, tudo rotulado como simulação.
- Futuro (fora desta versão): contrato de bloqueio com política de liberação e autorização próprias.

## 7. Recibo verificável

### 7.1 Payload

JCS (RFC 8785), chaves duplicadas rejeitadas, dinheiro como string decimal inteira. Campos comuns: `schema_version`, `receipt_id`, `receipt_type`, `previous_receipt_id` (quando houver), `issuer` (`id`, `address`), `provider_env`, `chain_env`, `chain_id`, `order` (id público, valor), `issued_at`.

| `receipt_type` | Campos obrigatórios adicionais |
| --- | --- |
| `settlement` | `token`, `treasury`, `pix` (provider, estado observado, `observed_at`), `quote` (id, razão, validade, arredondamento), `amounts` (bruto, tarifas simuladas, reserva simulada, líquido), `settlement` (`to`, `amount`, `memo`, `tx_hash`, `block_number`, `block_hash`, `log_index`, `confirmation_observed_at`) |
| `refund_notice` | `refund` (valor, moeda, `refund_type`, estado observado, `observed_at`, origem: `provider_attested`), e `settlement_ref` **somente** se existiu liquidação on-chain antes. Sem liquidação anterior (ex.: pagamento tardio devolvido), não há `tx_hash` nem bloco |

### 7.2 Envelope e assinatura

```
{ "payload": {...},
  "digest": { "alg": "sha256", "hex": "<sha256(JCS(payload)) em hex minúsculo>" },
  "signature": { "scheme": "eip191-0x45", "signer": "0x...", "value": "0x..." } }
```

Mensagem assinada: bytes UTF-8 de

```
PixSettle receipt v1
provider_env=<payload.provider_env>
chain_env=<payload.chain_env>
chain_id=<payload.chain_id>
digest=<hex recalculado>
```

com quebras LF reais e **sem** quebra final. Assinatura EIP-191 versão `0x45` (`personal_sign`/`signMessage`): prefixo `"\x19Ethereum Signed Message:\n" + tamanho em BYTES`, aplicado uma única vez.

### 7.3 Verificação (a mesma no navegador, no PHP e no TypeScript)

1. Recalcular `SHA-256(JCS(payload))` e comparar com `digest.hex`. Diferente: recusa.
2. Reconstruir a mensagem **só** a partir do payload e do digest recalculado.
3. Recuperar o endereço da assinatura. Exigir `recuperado == signature.signer == payload.issuer.address` e que esteja na lista de emissores confiáveis do repositório. Qualquer diferença: recusa.
4. `settlement`: buscar o recibo da transação na RPC e conferir todos os campos da identidade da seção 4 contra o payload assinado. RPC fora do ar: "verificação indisponível", nunca sucesso.
5. `refund_notice`: mostrar como **declaração assinada do emissor sobre o provedor**, nunca como prova on-chain independente.

Vetor comum em `contract/vectors/`: Unicode, número grande, chaves fora de ordem, payload adulterado e emissor desconhecido.

### 7.4 Regras

Recibo imutável; devolução gera `refund_notice` ligado ao anterior; situação atual é consulta separada. Página pública `/r/{id}` sem `external_ref`, dados do pagador ou IDs privados do provedor.

## 8. Persistência

Tabelas: `merchants`, `checkout_sessions`, `quotes`, `orders`, `pix_charges`, `provider_events`, `settlements`, `settlement_attempts`, `nonce_allocations`, `ledger_entries`, `refund_cases`, `receipts`, `state_transitions`, `outbox`, `idempotency_keys`. Restrições: `unique(merchant_id, external_ref)`, `unique(asaas_event_id)`, `unique(order_id)` na liquidação principal, `unique(memo)`, `unique(chain_id, sender, nonce_key, nonce)`. Ao iniciar, a reconciliação confere tudo que está em `signed`, `broadcast_*` ou `unknown` antes de alocar nonce novo.

## 9. Critérios de aceite, em ordem de prioridade até 12/10

**Obrigatórios para a demo (P1)**

1. Mesmo webhook 5 vezes: 1 liquidação, 4 duplicatas registradas.
2. Dois workers pegam a mesma liquidação: uma intenção, um nonce, uma transferência.
3. Queda em cada ponto (depois de assinar, depois de persistir, depois de transmitir, sem resposta da RPC): recuperável, sem novo nonce.
4. Valor pago diferente: retido com motivo, sem liquidação.
5. Mesmo memo com token, rede, remetente ou valor diferente: não conta como liquidação.
6. Pix chega direto como recebido e evento antigo chega depois: uma liquidação, sem regressão.
7. Evento persistido e processo cai antes do job: a outbox recupera.
8. Recibo: vetor PHP/TypeScript igual; payload adulterado ou emissor desconhecido é recusado; página pública verifica a transação.
9. Lojista B não acessa pedido do lojista A; `checkout_token` não lista livro-razão.

**Importantes (P2, se o tempo permitir antes de 12/10)**

10. Criação da cobrança com resposta perdida: a conciliação acha, sem segunda cobrança.
11. Pagamento antes da expiração, aviso depois: não é tardio.
12. Pagamento depois da expiração: abre `refund_case`; `refunded` só após confirmação.
12b. Estorno solicitado com liquidação ainda em `intent_recorded`: o assinante recusa assinar e registra o motivo.
13. Devolução com liquidação em `unknown`: estorno bloqueado com motivo.
14. Cotação com fração, tarifas e arredondamento: identidade contábil preservada.
15. RPC B não conhece a transação que a RPC A recebeu: continua `unknown`, sem segundo pagamento.
16. Fila de webhook parada: a conciliação acha e o teste de vida acusa.

## 10. Fora desta versão

Câmbio real, produção, substituição de taxa, contrato de reserva on-chain, provedores Eulen e Efí, várias moedas, painel de administração completo.

## 11. Pedido ao Codex

Conferir só os trechos da tabela "Mudanças da v0.3" e responder no canal (`CANAL/CANAL-CLAUDE-CODEX.md`) com "ok" ou a correção. Com o ok, o Claude começa o código pela ordem P1.

## Fontes

- Codex, revisão de 27/09 em `CONTRATO-NUCLEO-PIX-v0.md` e conferência de 27/09 01:46 em `CONTRATO-NUCLEO-PIX-v0.1.md`
- Asaas: [eventos de cobrança](https://docs.asaas.com/docs/webhook-para-cobrancas), [webhooks](https://docs.asaas.com/docs/sobre-os-webhooks), [cobranças Pix](https://docs.asaas.com/docs/cobrancas-via-pix)
- Tempo: [TIP-20](https://tempo.xyz/developers/docs/protocol/tip20/spec), [memos](https://tempo.xyz/developers/docs/guide/payments/transfer-memos), [transações](https://docs.tempo.xyz/protocol/transactions)
- [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785), [EIP-191](https://eips.ethereum.org/EIPS/eip-191)
- MED: [Sebrae RS sobre a IN BCB 766/2026](https://digital.sebraers.com.br/blog/leis-e-normas/pix-med-prazo-contestar-devolucao-80-dias/)

## Conferência do Codex (v0.3)

Ok técnico na mensagem X-0002 do canal (27/09 02:05), com uma correção redacional na seção 3.5 já aplicada. Regra de implementação acordada em C-0003/X-0002: `already known` e `nonce too low` na retransmissão levam a reconciliar pelo hash; não provam sucesso nem falha e não autorizam novo nonce.
