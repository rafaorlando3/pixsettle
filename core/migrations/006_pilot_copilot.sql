-- Piloto com eventos atestados pelo operador (plataforma multiloja real, pseudonimizada) e
-- copiloto de exceções (regras primeiro; modelo só no resíduo; veredito imutável e auditável).
--
-- Nada aqui guarda dado pessoal: os eventos chegam com ids embaralhados e sem nome, documento,
-- contato, endereço ou produto; o guarda de ingestão recusa campos proibidos antes de gravar.

-- 1. O provedor "attested": o fato do Pix é afirmado pelo operador da loja (lote assinado por HMAC),
--    nunca consultado num provedor. A varredura periódica e a expiração ativa não tocam nessas cobranças.
ALTER TABLE orders DROP CONSTRAINT orders_provider_env_check;
ALTER TABLE orders ADD CONSTRAINT orders_provider_env_check CHECK (provider_env IN ('sandbox','simulated','attested'));
ALTER TABLE pix_charges DROP CONSTRAINT pix_charges_provider_check;
ALTER TABLE pix_charges ADD CONSTRAINT pix_charges_provider_check CHECK (provider IN ('asaas','simulated','attested'));

-- 2. MED atestado pelo operador: reclamação real registrada na loja, não simulada. Fica aberta (requested)
--    até o operador atestar o desfecho; enquanto aberta, bloqueia liquidação nova como qualquer caso.
ALTER TABLE refund_cases DROP CONSTRAINT refund_cases_refund_type_check;
ALTER TABLE refund_cases ADD CONSTRAINT refund_cases_refund_type_check
  CHECK (refund_type IN ('merchant_refund','provider_refund','late_payment_refund','med_simulated','med_attested'));

-- 3. Fontes do piloto (um operador por plataforma) e lojas (código público sem nome -> lojista).
CREATE TABLE pilot_sources (
  id           text PRIMARY KEY,                 -- ex.: odin
  label        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pilot_stores (
  source_id    text NOT NULL REFERENCES pilot_sources(id),
  code         text NOT NULL,                    -- equilibrium, loja-2 ... (nunca o nome da loja parceira)
  store_type   text NOT NULL DEFAULT '',
  merchant_id  text NOT NULL UNIQUE REFERENCES merchants(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, code)
);

-- 4. Eventos atestados: só inserção; dedupe pela chave (hash canônico da linha); estado de processamento com motivo.
CREATE TABLE attested_events (
  id                bigserial PRIMARY KEY,
  source_id         text NOT NULL REFERENCES pilot_sources(id),
  batch_id          text NOT NULL,
  event_key         text NOT NULL UNIQUE,         -- sha256(JCS(linha))
  ev                text NOT NULL,
  ts                timestamptz NULL,
  store_code        text NOT NULL,
  ord               text NULL,                    -- id embaralhado do pedido (external_ref no core)
  payload           jsonb NOT NULL,               -- a linha, já sem dado pessoal (guarda de ingestão)
  processing_state  text NOT NULL CHECK (processing_state IN ('received','processed','ignored','deferred','unmapped','error')),
  attempts          integer NOT NULL DEFAULT 0,
  result            jsonb NULL,                   -- o que o evento produziu (ids no core) ou o motivo de ignorado/unmapped
  last_error        jsonb NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz NULL
);
CREATE INDEX attested_events_pending ON attested_events (id) WHERE processing_state IN ('received','deferred','error');
CREATE INDEX attested_events_ord ON attested_events (ord);
CREATE INDEX attested_events_ev_ts ON attested_events (ev, ts);

-- 5. Cobranças do piloto: um pedido real pode ter várias cobranças (tentativas); o core guarda só a que pagou
--    (ou a última) em pix_charges; todas ficam aqui para a detecção de exceções.
CREATE TABLE pilot_charges (
  chg          text PRIMARY KEY,                  -- id embaralhado da cobrança
  order_id     text NOT NULL REFERENCES orders(id),
  provider     text NOT NULL DEFAULT '',          -- nome do trilho na loja (eulen, asaas...), sem credencial
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  state        text NOT NULL CHECK (state IN ('created','paid','expired','failed','cancelled','refunded')),
  created_at   timestamptz NULL,
  expires_at   timestamptz NULL,
  paid_at      timestamptz NULL,
  paid_minor   bigint NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pilot_charges_order ON pilot_charges (order_id);

-- 6. Exceções: um caso por (pedido, tipo, chave), com evidência estruturada e estado do copiloto.
CREATE TABLE exceptions (
  id             text PRIMARY KEY,                -- exc_<ULID>
  merchant_id    text NOT NULL REFERENCES merchants(id),
  order_id       text NULL REFERENCES orders(id),
  kind           text NOT NULL CHECK (kind IN ('duplicate_charge','duplicate_payment','amount_mismatch','late_payment','expired_unpaid','charge_failed','refund_requested','med_reported','manual_divergent','withdrawal_failed','withdrawal_reversal')),
  severity       text NOT NULL CHECK (severity IN ('info','low','medium','high')),
  status         text NOT NULL CHECK (status IN ('open','auto_applied','awaiting_human','resolved','dismissed')),
  copilot_state  text NOT NULL CHECK (copilot_state IN ('pending_rules','rules_only','pending_model','model_done','model_error','model_off')),
  fingerprint    text NOT NULL UNIQUE,
  summary        text NOT NULL,
  evidence       jsonb NOT NULL,                  -- [{id:'e1', fact:'...', ref:{...}}]
  facts          jsonb NOT NULL,                  -- entrada estruturada do copiloto (sem dado pessoal)
  last_error     jsonb NULL,
  resolution     jsonb NULL,                      -- {action, by:'auto'|'operator'|'system', note, at}
  detected_at    timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz NULL
);
CREATE INDEX exceptions_merchant_status ON exceptions (merchant_id, status);
CREATE INDEX exceptions_order ON exceptions (order_id);

-- 7. Vereditos: imutáveis (append-only), com hash do conteúdo para auditoria.
CREATE TABLE copilot_verdicts (
  id              text PRIMARY KEY,               -- vrd_<ULID>
  exception_id    text NOT NULL REFERENCES exceptions(id),
  engine          text NOT NULL CHECK (engine IN ('rules','model','replay','operator')),
  model           text NULL,
  action          text NOT NULL,
  confidence      numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  requires_human  boolean NOT NULL,
  rationale       text NOT NULL,
  evidence_refs   jsonb NOT NULL,
  input_hash      text NOT NULL,                  -- sha256(JCS(entrada))
  verdict_hash    text NOT NULL,                  -- sha256(JCS(veredito))
  latency_ms      integer NULL,
  usage           jsonb NULL,                     -- tokens/custo informados pelo provedor, quando houver
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX copilot_verdicts_exception ON copilot_verdicts (exception_id, created_at);
CREATE TRIGGER trg_copilot_verdicts_append_only BEFORE UPDATE OR DELETE ON copilot_verdicts FOR EACH ROW EXECUTE FUNCTION append_only();

-- 8. Replay: resposta gravada do modelo por hash da entrada, para a demo pública (sem chave, sem custo)
--    e para os testes. Rotulado como replay em todo veredito que sair daqui.
CREATE TABLE copilot_replay (
  input_hash   text NOT NULL,
  model        text NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (input_hash, model)
);
