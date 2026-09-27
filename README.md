# PixSettle (nome de trabalho)

Checkout Pix que liquida em stablecoin na Tempo, com liquidação que nunca paga duas vezes,
controle de devoluções (reserva contábil simulada na demo) e recibo verificável.
Projeto do Colosseum Crypto World's Fair, trilha Tempo. Demo: Pix simulado (Asaas sandbox na P2) + Tempo testnet Moderato.

- `contract/CONTRATO.md`: contrato do núcleo (v0.3 + adendo v0.3.1, revisado pelo Codex).
- `contract/vectors/`: vetores comuns do recibo; `contract/tools/`: verificador independente em Python.
- `settlement/`: processo de assinatura (único com chaves), transmissão e conferência na Tempo.
- `core/`: pedidos, cobranças, eventos, diário de envio, recibos, API, páginas e demo.
- `web/`: páginas (console da demo, checkout do pagador, recibo) e verificador do recibo no navegador.

Sem dinheiro real. Chaves só de teste, fora do Git.

## Rodar a demo local

Precisa de Node 22 e PostgreSQL 16. Arquivo local de chaves de TESTNET (fora do Git):
`{"treasury": "0x...", "merchant": "0x...", "issuer": "0x..."}` (issuer é opcional).

```bash
cd core && npm ci && cd ../settlement && npm ci && cd ../web && npm ci && npm run build && cd ../core
DATABASE_URL=postgres://.../pixsettle_demo E2E_KEYS=/caminho/chaves.json npx tsx scripts/dev-demo.ts
# abrir http://127.0.0.1:8080/demo
```

Em produção são dois processos: `settlement/src/server.ts` (chaves, só em 127.0.0.1, HMAC) e
`core/src/server.ts` (API, páginas, worker; sem chaves). Variáveis do core: `DATABASE_URL`, `DEMO_MODE=1`,
`SETTLEMENT_URL`, `SETTLEMENT_HMAC_SECRET`, `TREASURY_ADDRESS`, `ISSUER_ADDRESS`, `DEMO_MERCHANT_ADDRESS`,
`ASAAS_WEBHOOK_TOKEN`, `DIAGNOSTICS_TOKEN`, opcionais `PORT`, `HOST`, `TEMPO_RPC`, `EXPLORER`.

## Páginas

- `/demo`: console do operador (cria pedido pela API real, simula pagador e webhook 3x, linha do tempo ao vivo).
- `/pay/:token`: checkout do pagador (QR, copia e cola, prazo, estado).
- `/receipt/:id`: recibo conferido NO NAVEGADOR (assinatura EIP-191 sobre SHA-256 do JSON canônico e a
  transação lida direto da RPC pública da Tempo). `?issuer=0x...` fixa o emissor confiável.

## Testes

```bash
cd settlement && npx vitest run      # 24 + 1 integração (TEMPO_IT=1)
cd core && npx vitest run            # P1, API, web e demo (precisa de PostgreSQL; TEST_DATABASE_ADMIN)
python3 contract/tools/verify_receipt_vectors.py
```
