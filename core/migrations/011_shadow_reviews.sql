-- Advisory reviews of typed shadow facts. No free text, raw response, note or JSON payload.
CREATE TABLE pilot_shadow_reviews (
  review_id text PRIMARY KEY CHECK (review_id ~ '^[0-9a-f]{64}$'),
  case_id text NOT NULL CHECK (case_id ~ '^shx_[0-9a-f]{64}$'),
  origin text NOT NULL CHECK (origin ~ '^src_[a-z0-9]{1,16}$'),
  store text NOT NULL CHECK (store ~ '^store_[0-9]{1,3}$'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  projection_hash text NOT NULL CHECK (projection_hash ~ '^[0-9a-f]{64}$'),
  engine text NOT NULL CHECK (engine IN ('rules','model','operator')),
  actor text NOT NULL CHECK (actor IN ('rules','model','codex','human_operator')),
  model text CHECK (model IN ('openai/gpt-4.1-mini','openai/gpt-4o-mini')),
  action text NOT NULL CHECK (action IN ('close_benign_retry','flag_review','escalate','refund_duplicate','credit_customer','hold_request_balance','refund_partial','refund_excess','accept_as_paid','refund_late','accept_late','close_expired','close_superseded','approve_refund','reject_refund','contest_with_evidence','accept_refund','close_reversed','retry_withdrawal')),
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  requires_human boolean NOT NULL CHECK (requires_human = true),
  advisory boolean NOT NULL CHECK (advisory = true),
  evidence_refs text[] NOT NULL CHECK (cardinality(evidence_refs) BETWEEN 1 AND 50 AND array_to_string(evidence_refs,',') ~ '^e[1-9][0-9]{0,3}(,e[1-9][0-9]{0,3})*$'),
  verdict_hash text NOT NULL CHECK (verdict_hash ~ '^[0-9a-f]{64}$'),
  capture_receipt_sha256 text CHECK (capture_receipt_sha256 ~ '^[0-9a-f]{64}$'),
  private_verdict_hash text CHECK (private_verdict_hash ~ '^[0-9a-f]{64}$'),
  latency_ms integer CHECK (latency_ms BETWEEN 0 AND 3600000),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (origin,store) REFERENCES pilot_shadow_streams(origin,store),
  CHECK ((engine='rules' AND actor='rules' AND model IS NULL) OR
         (engine='model' AND actor='model' AND model IS NOT NULL AND capture_receipt_sha256 IS NOT NULL AND private_verdict_hash IS NOT NULL) OR
         (engine='operator' AND actor IN ('codex','human_operator') AND model IS NULL))
);
CREATE INDEX pilot_shadow_reviews_case ON pilot_shadow_reviews(origin,store,case_id,created_at,review_id);
CREATE TRIGGER pilot_shadow_reviews_immutable BEFORE UPDATE OR DELETE ON pilot_shadow_reviews FOR EACH ROW EXECUTE FUNCTION pilot_shadow_immutable();
