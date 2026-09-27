# Publicar a demo (passo a passo para o Rafael)

Resultado: um endereço público tipo `https://pixsettle-demo.onrender.com/demo` para os jurados. Custo: zero (planos gratuitos). Tempo: uns 20 minutos, só cliques e colar texto.

Nada de chave privada passa pela sua mão: as carteiras de testnet saem de uma semente que a própria Render gera e guarda. A tesouraria se abastece sozinha no faucet da testnet.

## 1. Repositório no GitHub (5 min)

1. Em github.com, clique em **New repository**. Nome: `pixsettle`. Marque **Public** (código aberto conta ponto no Colosseum). Não marque README nem licença. Clique em **Create repository**.
2. No Mac, abra o Terminal e cole (troque `SEU_USUARIO` pelo seu usuário do GitHub):

```bash
cd ~/Documents/Codex/2026-09-13/as/HANDOFF-CLAUDE-2026-09-26/revisoes/pixsettle/publicar
git clone pixsettle.bundle pixsettle
cd pixsettle
git remote set-url origin https://github.com/SEU_USUARIO/pixsettle.git
git push -u origin main
```

Se o Terminal pedir login, use o do GitHub (ou o GitHub Desktop, se preferir: "Add existing repository" apontando para essa pasta e depois "Publish").

## 2. Banco de dados na Neon (5 min)

1. Entre em neon.com e clique em **Sign up** com a conta do GitHub.
2. Crie um projeto: nome `pixsettle`, região **AWS São Paulo** (ou a mais próxima que aparecer), Postgres 16.
3. Na tela do projeto, clique em **Connect** e copie a **connection string** (começa com `postgresql://` e termina com `?sslmode=require`). Guarde para o passo 3.

Por que Neon e não o banco da Render: o banco gratuito da Render apaga em 30 dias, e o resultado do Colosseum só sai em 05/12.

## 3. Servidor na Render (10 min)

1. Entre em render.com e clique em **Get Started** com a conta do GitHub. Autorize o acesso ao repositório `pixsettle`.
2. Clique em **New** e depois **Blueprint**. Escolha o repositório `pixsettle`. A Render lê o arquivo `render.yaml` sozinha.
3. Ela vai pedir um único valor: **DATABASE_URL**. Cole a connection string da Neon. Os outros segredos ela gera sozinha.
4. Clique em **Apply**. O primeiro build leva de 5 a 10 minutos.
5. Quando aparecer **Live**, abra o endereço que a Render mostrar e acrescente `/demo` no fim.

## 4. Conferir

- `/demo`: crie um pedido e clique em "Payer pays". Em poucos segundos deve aparecer "Settled" e o botão do recibo.
- O recibo abre com "Receipt verified" em verde.
- Plano gratuito: depois de 15 minutos sem visita o servidor dorme e a primeira visita leva cerca de 1 minuto. Antes de gravar vídeo ou mandar o link, abra a página uma vez.

## 5. Asaas sandbox (quando você criar as contas)

Na Render, em **Environment**, acrescente:

| Variável | Valor |
| --- | --- |
| `PIX_PROVIDER` | `asaas` |
| `ASAAS_API_KEY` | chave da conta sandbox que RECEBE (começa com `$aact_hmlg_`) |
| `ASAAS_CUSTOMER_ID` | id de um cliente de teste criado nessa conta (começa com `cus_`) |
| `ASAAS_PAYER_API_KEY` | chave da segunda conta sandbox, a que PAGA (opcional; sem ela usamos a confirmação de sandbox) |

E no painel do Asaas sandbox da conta que recebe, em **Integrações > Webhooks**: URL `https://SEU-ENDERECO.onrender.com/webhooks/asaas`, eventos de cobrança, e o token de autenticação igual ao valor de `ASAAS_WEBHOOK_TOKEN` que a Render gerou (em Environment, clique no olho para ver). Chave de produção é recusada pelo sistema.

## O que fica de fora de propósito

- Chave privada em qualquer arquivo, log ou mensagem.
- Dinheiro real: Pix simulado ou sandbox, Tempo testnet.
