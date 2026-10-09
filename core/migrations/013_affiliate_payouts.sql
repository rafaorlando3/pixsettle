-- Phase 2: affiliate payouts in digital dollars (docs/affiliate-payouts.md).
-- The durable send journal is reused: a payout is a settlement with kind='affiliate_payout' and no order.

ALTER TABLE settlements ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE settlements ADD COLUMN kind text NOT NULL DEFAULT 'order' CHECK (kind IN ('order','affiliate_payout'));
ALTER TABLE settlements ADD COLUMN beneficiary_ref text NULL;
ALTER TABLE settlements ADD CONSTRAINT settlements_kind_shape CHECK (
  (kind = 'order' AND order_id IS NOT NULL AND beneficiary_ref IS NULL) OR
  (kind = 'affiliate_payout' AND order_id IS NULL AND beneficiary_ref IS NOT NULL)
);

CREATE TABLE affiliate_beneficiaries (
  id               text PRIMARY KEY,                       -- ben_<ULID>
  merchant_id      text NOT NULL REFERENCES merchants(id),
  beneficiary_ref  text NOT NULL,                          -- opaque hash from the merchant; never a name, CPF or Pix key
  kind             text NOT NULL CHECK (kind IN ('affiliate','partner_percent')),
  payout_address   text NULL,                              -- own wallet; null = merchant pool address with memo
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, beneficiary_ref)
);

CREATE TABLE affiliate_commissions (
  id               text PRIMARY KEY,                       -- com_<ULID>
  merchant_id      text NOT NULL REFERENCES merchants(id),
  beneficiary_id   text NOT NULL REFERENCES affiliate_beneficiaries(id),
  source_event_id  text NOT NULL,                          -- id of the commission in the merchant's program
  order_ref        text NULL,                              -- merchant's order reference (opaque)
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),   -- BRL, scale 2
  fee_bps          integer NOT NULL DEFAULT 0 CHECK (fee_bps >= 0 AND fee_bps <= 10000),
  usd_units        numeric(78,0) NOT NULL CHECK (usd_units > 0), -- token units, scale 6, fixed at Pix time
  rate_num         numeric(78,0) NOT NULL,                 -- token units per BRL cent = rate_num / rate_den
  rate_den         numeric(78,0) NOT NULL CHECK (rate_den > 0),
  quote_source     text NOT NULL,
  quote_at         timestamptz NOT NULL,
  quote_hash       text NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending','released','settling','settled','voided','failed')),
  custody          text NOT NULL DEFAULT 'pool' CHECK (custody IN ('pool','own_wallet')),   -- fixed at release: pool = withdrawable balance; own_wallet = paid straight to the beneficiary
  quote_mode       text NOT NULL DEFAULT 'at_pix' CHECK (quote_mode IN ('at_pix','backfill')), -- backfill = quoted later than the Pix (historical import); shown as such
  reason_code      text NULL,
  occurred_at      timestamptz NOT NULL,
  released_at      timestamptz NULL,
  voided_at        timestamptz NULL,
  settlement_id    text NULL REFERENCES settlements(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, source_event_id)
);
CREATE INDEX affiliate_commissions_beneficiary ON affiliate_commissions (beneficiary_id, status);

-- Append only. Balance = sum(usd_units) per beneficiary and bucket.
CREATE TABLE affiliate_ledger (
  id               bigserial PRIMARY KEY,
  beneficiary_id   text NOT NULL REFERENCES affiliate_beneficiaries(id),
  kind             text NOT NULL CHECK (kind IN ('credit_pending','release','void','settle','withdraw_pix','withdraw_pix_reversal','withdraw_wallet','withdraw_wallet_reversal','fee','adjustment')),
  usd_units        numeric(78,0) NOT NULL,                 -- signed
  ref_kind         text NOT NULL,                          -- commission | withdrawal | settlement | manual
  ref_id           text NOT NULL,
  op_key           text NOT NULL UNIQUE,                   -- idempotency of the entry
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX affiliate_ledger_beneficiary ON affiliate_ledger (beneficiary_id);

CREATE TABLE affiliate_quote_locks (
  id               text PRIMARY KEY,                       -- qlk_<ULID>
  beneficiary_id   text NOT NULL REFERENCES affiliate_beneficiaries(id),
  kind             text NOT NULL CHECK (kind IN ('pix','wallet')),
  usd_units        numeric(78,0) NOT NULL CHECK (usd_units > 0),
  rate_num         numeric(78,0) NOT NULL,                 -- BRL cents per token unit = rate_num / rate_den (sell side)
  rate_den         numeric(78,0) NOT NULL CHECK (rate_den > 0),
  quote_source     text NOT NULL,
  gross_minor      bigint NOT NULL,
  fee_minor        bigint NOT NULL,
  net_minor        bigint NOT NULL,                        -- exact BRL promised (pix) or 0 (wallet)
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE affiliate_withdrawals (
  id               text PRIMARY KEY,                       -- wdr_<ULID>
  beneficiary_id   text NOT NULL REFERENCES affiliate_beneficiaries(id),
  kind             text NOT NULL CHECK (kind IN ('pix','wallet')),
  lock_id          text NOT NULL UNIQUE REFERENCES affiliate_quote_locks(id),
  usd_units        numeric(78,0) NOT NULL,
  net_minor        bigint NOT NULL,
  fee_minor        bigint NOT NULL,
  status           text NOT NULL CHECK (status IN ('requested','paid','failed','settling','settled')),
  pix_e2e_id       text NULL,
  reason_code      text NULL,
  settlement_id    text NULL REFERENCES settlements(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE affiliate_receipts (
  id               text PRIMARY KEY,                       -- rct_<ULID>
  settlement_id    text NOT NULL UNIQUE REFERENCES settlements(id),
  commission_id    text NULL REFERENCES affiliate_commissions(id),
  withdrawal_id    text NULL REFERENCES affiliate_withdrawals(id),
  digest_hex       text NOT NULL UNIQUE,
  envelope         jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Per-merchant policy for phase 2 (fees may be zero during a promotion).
CREATE TABLE affiliate_policies (
  merchant_id          text PRIMARY KEY REFERENCES merchants(id),
  conversion_fee_bps   integer NOT NULL DEFAULT 0 CHECK (conversion_fee_bps >= 0 AND conversion_fee_bps <= 10000),
  withdrawal_fee_bps   integer NOT NULL DEFAULT 0 CHECK (withdrawal_fee_bps >= 0 AND withdrawal_fee_bps <= 10000),
  withdrawal_fee_minor bigint NOT NULL DEFAULT 0 CHECK (withdrawal_fee_minor >= 0),
  pool_address         text NULL,                          -- payouts go here with memo while the beneficiary has no wallet
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Ingestão por lote assinado (produtor; contrato pixsettle-commission-batch/1). Revisões e lotes são só inserção.
CREATE TABLE affiliate_commission_streams (
  origin text NOT NULL CHECK (origin ~ '^src_[a-z0-9]{1,16}$'),
  store text NOT NULL CHECK (store ~ '^store_[0-9]{1,3}$'),
  last_batch_sha256 text CHECK (last_batch_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (origin, store)
);
CREATE TABLE affiliate_commission_batches (
  origin text NOT NULL, store text NOT NULL,
  batch_sha256 text NOT NULL CHECK (batch_sha256 ~ '^[0-9a-f]{64}$'),
  previous_batch_sha256 text CHECK (previous_batch_sha256 ~ '^[0-9a-f]{64}$'),
  key_id text NOT NULL CHECK (key_id ~ '^k_[a-z0-9]{1,16}$'),
  event_count integer NOT NULL CHECK (event_count BETWEEN 1 AND 5000),
  accepted integer NOT NULL CHECK (accepted >= 0), unchanged integer NOT NULL CHECK (unchanged >= 0),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'), committed_at timestamptz NOT NULL,
  PRIMARY KEY (origin, store, batch_sha256), CHECK (accepted + unchanged = event_count),
  FOREIGN KEY (origin, store) REFERENCES affiliate_commission_streams(origin, store)
);
CREATE TABLE affiliate_commission_revisions (
  origin text NOT NULL, store text NOT NULL,
  commission_id text NOT NULL CHECK (commission_id ~ '^com_[0-9a-f]{32}$'),
  revision text NOT NULL CHECK (revision ~ '^[0-9a-f]{64}$'),
  event_id text NOT NULL CHECK (event_id ~ '^cev_[0-9a-f]{64}$'),
  order_id text NOT NULL CHECK (order_id ~ '^ord_[0-9a-f]{16}$'),
  affiliate_id text NOT NULL CHECK (affiliate_id ~ '^(aff|par)_[0-9a-f]{32}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0 AND amount_minor <= 1000000000000),
  status text NOT NULL CHECK (status IN ('pending','review','active','voided','lost')),
  reason_code text, created_at timestamptz NOT NULL, source_updated_at timestamptz NOT NULL,
  release_at timestamptz, released_at timestamptz, voided_at timestamptz,
  event jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object'), batch_sha256 text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (origin, store, commission_id, revision), UNIQUE (origin, store, event_id),
  FOREIGN KEY (origin, store, batch_sha256) REFERENCES affiliate_commission_batches(origin, store, batch_sha256) DEFERRABLE INITIALLY DEFERRED
);
-- Resultado da aplicação de cada revisão ao domínio (uma linha por revisão aplicada ou falhada; retry não grava).
CREATE TABLE affiliate_commission_applications (
  origin text NOT NULL, store text NOT NULL, commission_id text NOT NULL, revision text NOT NULL,
  event_id text NOT NULL, result text NOT NULL, domain_commission_id text NULL REFERENCES affiliate_commissions(id),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (origin, store, commission_id, revision)
);
CREATE FUNCTION affiliate_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'affiliate_append_only'; END;
$$;
CREATE TRIGGER affiliate_revisions_immutable BEFORE UPDATE OR DELETE ON affiliate_commission_revisions FOR EACH ROW EXECUTE FUNCTION affiliate_append_only();
CREATE TRIGGER affiliate_batches_immutable BEFORE UPDATE OR DELETE ON affiliate_commission_batches FOR EACH ROW EXECUTE FUNCTION affiliate_append_only();
CREATE TRIGGER affiliate_ledger_immutable BEFORE UPDATE OR DELETE ON affiliate_ledger FOR EACH ROW EXECUTE FUNCTION affiliate_append_only();
