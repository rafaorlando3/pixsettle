-- PixSettle core: esquema inicial (contrato v0.3 + adendo v0.3.1).
-- Dinheiro sempre inteiro: BRL em centavos (bigint), token em unidades mínimas (numeric(78,0)).

CREATE TABLE merchants (
  id               text PRIMARY KEY,                       -- mer_<ULID>
  name             text NOT NULL,
  api_key_hash     text NOT NULL UNIQUE,                   -- sha256 da chave secreta
  payout_address   text NOT NULL,                          -- endereço do lojista na Tempo
  reserve_bps      integer NOT NULL DEFAULT 1000 CHECK (reserve_bps BETWEEN 0 AND 10000),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id               text PRIMARY KEY,                       -- ord_<ULID>
  merchant_id      text NOT NULL REFERENCES merchants(id),
  external_ref     text NOT NULL,
  description      text NOT NULL DEFAULT '',
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  currency         text NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  status           text NOT NULL CHECK (status IN ('created','awaiting_payment','paid','settling','settled','expired','late_paid')),
  hold_reason      text NULL,
  expires_at       timestamptz NOT NULL,
  paid_at          timestamptz NULL,
  provider_env     text NOT NULL CHECK (provider_env IN ('sandbox','simulated')),
  chain_env        text NOT NULL CHECK (chain_env IN ('testnet')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, external_ref)
);

CREATE TABLE checkout_sessions (
  id               text PRIMARY KEY,                       -- cks_<ULID>
  order_id         text NOT NULL REFERENCES orders(id),
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id               text PRIMARY KEY,                       -- quo_<ULID>
  order_id         text NOT NULL UNIQUE REFERENCES orders(id),
  rate_num         numeric(78,0) NOT NULL CHECK (rate_num > 0),   -- unidades de token por centavo = rate_num / rate_den
  rate_den         numeric(78,0) NOT NULL CHECK (rate_den > 0),
  rounding         text NOT NULL DEFAULT 'floor' CHECK (rounding = 'floor'),
  source           text NOT NULL CHECK (source = 'simulated'),
  valid_until      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pix_charges (
  id                 text PRIMARY KEY,                     -- chg_<ULID>
  order_id           text NOT NULL UNIQUE REFERENCES orders(id),
  provider           text NOT NULL CHECK (provider IN ('asaas','simulated')),
  provider_payment_id text NULL UNIQUE,
  creation_state     text NOT NULL CHECK (creation_state IN ('creating','created','creation_unknown','creation_review','creation_conflict','creation_failed')),
  observed_state     text NULL CHECK (observed_state IN ('created','confirmed','received','overdue','deleted','partially_refunded','refunded')),
  amount_minor       bigint NOT NULL,
  qr_payload         text NULL,
  qr_expires_at      timestamptz NULL,
  last_observed_at   timestamptz NULL,
  last_provider_status integer NULL,
  last_provider_error jsonb NULL,                          -- sem dados pessoais
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_events (
  id                 bigserial PRIMARY KEY,
  provider           text NOT NULL,
  provider_event_id  text NOT NULL,                        -- asaas: evt_...
  event_type         text NOT NULL,
  provider_payment_id text NULL,
  payload            jsonb NOT NULL,                       -- já sem dados pessoais
  processing_state   text NOT NULL CHECK (processing_state IN ('received_event','processing','processed','stale','error')),
  duplicate_count    integer NOT NULL DEFAULT 0,
  attempts           integer NOT NULL DEFAULT 0,
  last_error         jsonb NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz NULL,
  UNIQUE (provider, provider_event_id)
);

-- Intenção imutável da liquidação (contrato 4.5).
CREATE TABLE settlements (
  id               text PRIMARY KEY,                       -- stl_<ULID>
  order_id         text NOT NULL UNIQUE REFERENCES orders(id),
  chain_id         integer NOT NULL,
  token            text NOT NULL,
  sender           text NOT NULL,
  recipient        text NOT NULL,
  amount_units     numeric(78,0) NOT NULL CHECK (amount_units > 0),
  memo             text NOT NULL UNIQUE,
  status           text NOT NULL CHECK (status IN ('intent_recorded','in_progress','confirmed','failed','manual_review')),
  hold_reason      text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION settlements_intent_immutable() RETURNS trigger AS $$
BEGIN
  IF (NEW.order_id, NEW.chain_id, NEW.token, NEW.sender, NEW.recipient, NEW.amount_units, NEW.memo)
     IS DISTINCT FROM (OLD.order_id, OLD.chain_id, OLD.token, OLD.sender, OLD.recipient, OLD.amount_units, OLD.memo) THEN
    RAISE EXCEPTION 'intent_immutable: intenção da liquidação % não pode mudar', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_settlements_intent_immutable BEFORE UPDATE ON settlements
  FOR EACH ROW EXECUTE FUNCTION settlements_intent_immutable();

-- Diário de envio (contrato 3.5 e 4).
CREATE TABLE settlement_attempts (
  id                   text PRIMARY KEY,                   -- att_<ULID>
  settlement_id        text NOT NULL REFERENCES settlements(id),
  attempt_no           integer NOT NULL,
  chain_id             integer NOT NULL,
  sender               text NOT NULL,
  nonce_key            integer NOT NULL DEFAULT 0 CHECK (nonce_key = 0),
  nonce                bigint NOT NULL,
  status               text NOT NULL CHECK (status IN ('nonce_reserved','signed','suspended','broadcast_pending','broadcast_sent','unknown','manual_review','confirmed','attempt_reverted')),
  raw_tx               text NULL,                          -- acesso restrito: nunca em log, API ou checkout
  tx_hash              text NULL UNIQUE,
  fee_params           jsonb NULL,
  pre_sign_check       jsonb NULL,
  pre_broadcast_check  jsonb NULL,
  broadcast_outcome    jsonb NULL,
  observed             jsonb NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (settlement_id, attempt_no),
  UNIQUE (chain_id, sender, nonce_key, nonce)
);
-- No máximo UMA tentativa ativa por liquidação (contrato 4.2, v0.3).
CREATE UNIQUE INDEX one_active_attempt_per_settlement ON settlement_attempts (settlement_id)
  WHERE status IN ('nonce_reserved','signed','suspended','broadcast_pending','broadcast_sent','unknown','manual_review');

CREATE TABLE refund_cases (
  id                 text PRIMARY KEY,                     -- rfc_<ULID>
  order_id           text NOT NULL REFERENCES orders(id),
  refund_type        text NOT NULL CHECK (refund_type IN ('merchant_refund','provider_refund','late_payment_refund','med_simulated')),
  state              text NOT NULL CHECK (state IN ('requested','unknown','confirmed','partial','failed')),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  simulation_reason  text NULL,
  provider_ref       text NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (refund_type <> 'med_simulated' OR simulation_reason IS NOT NULL)
);

CREATE TABLE ledger_entries (
  id               bigserial PRIMARY KEY,
  merchant_id      text NOT NULL REFERENCES merchants(id),
  order_id         text NULL REFERENCES orders(id),
  kind             text NOT NULL CHECK (kind IN ('settlement_net','reserve_simulated','reserve_release_simulated','reserve_consumed_simulated','debt_simulated')),
  amount_units     numeric(78,0) NOT NULL,
  currency         text NOT NULL,
  simulated        boolean NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE receipts (
  id                  text PRIMARY KEY,                    -- rct_<ULID>
  order_id            text NOT NULL REFERENCES orders(id),
  receipt_type        text NOT NULL CHECK (receipt_type IN ('settlement','refund_notice')),
  previous_receipt_id text NULL REFERENCES receipts(id),
  digest_hex          text NOT NULL UNIQUE,
  envelope            jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE state_transitions (
  id           bigserial PRIMARY KEY,
  entity       text NOT NULL,
  entity_id    text NOT NULL,
  from_state   text NULL,
  to_state     text NOT NULL,
  reason       text NULL,
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  topic         text NOT NULL,
  entity_id     text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  available_at  timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  locked_until  timestamptz NULL,
  done_at       timestamptz NULL,
  last_error    jsonb NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox (available_at) WHERE done_at IS NULL;

CREATE TABLE idempotency_keys (
  merchant_id    text NOT NULL REFERENCES merchants(id),
  operation      text NOT NULL,
  key            text NOT NULL,
  request_hash   text NOT NULL,
  status_code    integer NULL,
  response       jsonb NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, operation, key)
);

-- Tabelas só de inserção: histórico e recibos não mudam.
CREATE OR REPLACE FUNCTION append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append_only: % não aceita % ', TG_TABLE_NAME, TG_OP;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_state_transitions_append_only BEFORE UPDATE OR DELETE ON state_transitions FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER trg_receipts_append_only BEFORE UPDATE OR DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER trg_ledger_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION append_only();
