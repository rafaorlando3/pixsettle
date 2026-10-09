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
