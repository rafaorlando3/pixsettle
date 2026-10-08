# Adendo v1: piloto com eventos atestados e copiloto de exceções

Claude, 06/10/2026. Complementa o contrato v0.3 (núcleo Pix e liquidação). Decisões do Rafael no chat de 06/10: IA com propósito em todo sistema (não "usar por usar"); piloto sombra com a plataforma multiloja inteira; loja Equilibrium nomeada em público, parceiras como `loja-N`.

## 1. Regra de IA com propósito (vale para qualquer função de IA no produto)

1. Decide ou dá veredito com evidência; não resume nem "explica" o que a tela já mostra.
2. É medida contra a mesma tarefa sem IA: regras determinísticas primeiro, número no README e na demo (`/pilot`).
3. Tem guarda: limiar de confiança, confirmação humana para o irreversível, fallback com motivo visível. Nada de falha silenciosa.
4. Aparece nos primeiros 30 segundos da demo e no slogan.

## 2. Provedor `attested`

- `orders.provider_env = 'attested'` e `pix_charges.provider = 'attested'`: o fato do Pix é afirmado pelo operador da loja em lote assinado (HMAC-SHA256 do corpo bruto, `x-pilot-signature`), nunca consultado num provedor.
- A varredura periódica, a expiração ativa e a execução de devolução não tocam cobranças atestadas (`flows/sweep.ts`, `flows/refunds.ts`); devoluções esperam o atestado do desfecho (`order.refund.completed` ou `.rejected`).
- O caminho de aplicação é o MESMO dos provedores reais: `applyObservation` -> pago -> intenção de liquidação -> diário de envio -> recibo. Com `PILOT_SETTLE=0`, o pedido fica `paid` com a transição `settlement_skipped` e o motivo.
- Cotação do piloto: simulada e em escala reduzida (`pilotRateNum/Den`, padrão 1 unidade por centavo) para caber na tesouraria de testnet; `quotes.source` continua `simulated`.
- Janela de pagamento do pedido = maior vencimento entre as cobranças; cobrança sem vencimento usa horizonte de 30 dias; o atestado `late` (0/1) do operador prevalece sobre a estimativa, com transição `order_window` registrada.
- Várias cobranças por pedido vivem em `pilot_charges`; `pix_charges` guarda a paga (ou a última) para recibos e devoluções.
- MED real da loja: `refund_cases.refund_type = 'med_attested'`, `requested` até o desfecho; bloqueia liquidação nova como qualquer caso aberto.

## 3. Guarda de ingestão (sem dado pessoal, forma fechada)

`core/src/pilot/guard.ts`: lista fechada de chaves; chave com cara de dado pessoal recusada (`name`, `payer`, `document`, `email`, `phone`, `address`, `product`, `key`, `token`...); valor com e-mail, CPF ou 10+ dígitos recusado; ids só de letras (`o_`, `i_`, `w_` + 20 letras); valores `d+.dd`; `ts` ISO UTC. Linha recusada volta com o motivo e nunca é gravada. Dedupe por SHA-256 do JSON canônico (RFC 8785).

## 4. Exceções

Tabela `exceptions`: um caso por impressão digital (`pedido:tipo:chave`), com `severity`, `status` (`open`, `auto_applied`, `awaiting_human`, `resolved`, `dismissed`), `copilot_state` (`pending_rules`, `rules_only`, `pending_model`, `model_done`, `model_error`, `model_off`), `evidence` (`[{id, fact}]`), `facts` (entrada estruturada, sem dado pessoal), `last_error` (motivo visível), `resolution` (`{action, by, note, at}`). Evidência nova numa exceção aberta sem decisão humana reabre e julga de novo pelas regras.

Tipos: `duplicate_charge`, `duplicate_payment`, `amount_mismatch`, `late_payment`, `expired_unpaid`, `charge_failed`, `refund_requested`, `med_reported`, `manual_divergent`, `withdrawal_failed`, `withdrawal_reversal`.

## 5. Veredito e política

- Veredito: `{action, confidence, requires_human, rationale, evidence_refs}`; ação de lista fechada por tipo (`copilot/verdict.ts`); validação estrita (ação, faixa, referências só às evidências dadas); ação irreversível força `requires_human`.
- Aplicação sozinha: só ação REVERSÍVEL (`close_*`, `hold_request_balance`, `flag_review`), confiança >= 0,85 e sem desacordo entre regras e modelo. O resto espera o operador.
- `copilot_verdicts` é só inserção (gatilho `append_only`), com `input_hash`, `verdict_hash` (SHA-256 do JSON canônico), `engine` (`rules`, `model`, `replay`, `operator`), latência e uso.
- Modelo: `COPILOT_MODE` `off` | `replay` | `live` | `live_record`; provedores Anthropic Messages e OpenAI-compatible; primeira falha do job `copilot_judge` = `model_error` com código controlado e exceção para o humano, sem retentativa automática paga. Resposta só é gravada após guarda estrita e CAS de fatos/evidências dentro do lock; contexto alterado não recebe veredito nem replay. Replay é leitura de entrada/modelo exatos, sem job/política/decisão; ausência = `replay_miss`. Orçamento em chamadas não substitui a reserva monetária privada nem o teto compartilhado no fornecedor.
- Decisão do operador: `POST /pilot/api/exceptions/:id/decide` com `PILOT_OPERATOR_TOKEN`; vira veredito `operator`; `agreed_with_copilot` registrado (métrica da página).

## 6. Critérios de aceite (todos cobertos em `core/test/pilot.test.ts`, 21 testes)

1. Linha com dado pessoal ou chave desconhecida: recusada com motivo, as demais entram.
2. Lote repetido: 0 aceitas, N duplicadas, nada reprocessado.
3. Evento fora de ordem: adiado e aplicado na mesma chamada.
4. Pedido atestado pago: liquidação na cadeia e recibo `settlement` (com assinante real nos testes).
5. Três cobranças, uma paga: `duplicate_charge` fechada pelas regras; `expired_unpaid` e `charge_failed` informativas fechadas.
6. Valor 1 centavo a menos: retenção + `hold_request_balance` automático; diferença grande: modelo; sem modelo: humano com motivo.
7. Modelo com resposta inválida: `model_error` com motivo, sem veredito gravado; veredito gravado é imutável.
8. Devolução atestada: caso sem chamada a provedor, confirmado no `completed`, recibo `refund_notice`.
9. MED atestado real; pagamento atrasado atestado; cobrança sem vencimento no prazo.
10. Rotas: assinatura do corpo bruto, tipo de conteúdo, leitura pública sem ids internos, decisão só com token.

## 7. Fora desta versão

Hash do veredito dentro do recibo assinado (próximo passo, exige vetor novo); link do recibo no extrato das carteiras dos parceiros (E5); exportação incremental ao vivo da loja (comando agendado na Odin); avaliação do modelo no resíduo (métrica de concordância do operador, que a página já calcula).
