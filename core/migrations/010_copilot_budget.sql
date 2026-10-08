-- Claude C0663's USD reservation, integrated after 007 batches / 008 shadow / 009 runtime.
-- Policy is immutable at admission; a deliberate new private stage uses a new scoped DB.
CREATE TABLE copilot_budget_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  model text NOT NULL,
  cap_micros bigint NOT NULL CHECK(cap_micros > 0),
  reserve_micros bigint NOT NULL CHECK(reserve_micros > 0 AND reserve_micros <= cap_micros),
  max_calls bigint NOT NULL CHECK(max_calls > 0),
  halted boolean NOT NULL DEFAULT false,
  halt_code text NULL CHECK(halt_code IS NULL OR halt_code IN ('unknown_charge','cost_over_reserve')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE copilot_spend (
  id bigserial PRIMARY KEY,
  model text NOT NULL,
  input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  reserved_micros bigint NOT NULL CHECK(reserved_micros > 0),
  state text NOT NULL CHECK(state IN ('reserved','spent','failed')),
  cost_micros bigint NULL CHECK(cost_micros IS NULL OR cost_micros >= 0),
  error_code text NULL CHECK(error_code IS NULL OR error_code IN ('config','http','timeout','invalid_response','replay_miss','budget','internal_error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz NULL,
  UNIQUE(model,input_hash)
);
CREATE INDEX copilot_spend_created ON copilot_spend(created_at);
