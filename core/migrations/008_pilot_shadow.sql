-- E1 1.3 entry storage: exact bytes attested, scoped identities, no writes into payment core.
CREATE TABLE pilot_shadow_streams (
  origin text NOT NULL CHECK (origin ~ '^src_[a-z0-9]{1,16}$'),
  store text NOT NULL CHECK (store ~ '^store_[0-9]{1,3}$'),
  checkpoint text CHECK (checkpoint ~ '^[0-9]{8}T[0-9]{6}Z/evt_[0-9a-f]{16}$'),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (origin, store)
);
CREATE TABLE pilot_shadow_batches (
  origin text NOT NULL CHECK (origin ~ '^src_[a-z0-9]{1,16}$'),
  store text NOT NULL CHECK (store ~ '^store_[0-9]{1,3}$'),
  lote_sha256 text NOT NULL CHECK (lote_sha256 ~ '^[0-9a-f]{64}$'),
  trio_sha256 text NOT NULL CHECK (trio_sha256 ~ '^[0-9a-f]{64}$'),
  atestado_sha256 text NOT NULL CHECK (atestado_sha256 ~ '^[0-9a-f]{64}$'),
  pronto_sha256 text NOT NULL CHECK (pronto_sha256 ~ '^[0-9a-f]{64}$'),
  key_id text NOT NULL CHECK (key_id ~ '^k_[a-z0-9]{1,16}$'),
  event_count integer NOT NULL CHECK (event_count BETWEEN 1 AND 5000),
  overlap_count integer NOT NULL CHECK (overlap_count BETWEEN 0 AND event_count),
  first_cursor text NOT NULL CHECK (first_cursor ~ '^[0-9]{8}T[0-9]{6}Z/evt_[0-9a-f]{16}$'),
  last_cursor text NOT NULL CHECK (last_cursor ~ '^[0-9]{8}T[0-9]{6}Z/evt_[0-9a-f]{16}$'),
  totals_minor jsonb NOT NULL CHECK (jsonb_typeof(totals_minor) = 'object'),
  result text NOT NULL CHECK (result IN ('accepted','rejected')), codes text[] NOT NULL,
  accepted integer NOT NULL CHECK (accepted >= 0), duplicates integer NOT NULL CHECK (duplicates >= 0),
  rejected integer NOT NULL CHECK (rejected >= 0),
  checkpoint text CHECK (checkpoint ~ '^[0-9]{8}T[0-9]{6}Z/evt_[0-9a-f]{16}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'), committed_at timestamptz NOT NULL,
  PRIMARY KEY (origin, store, lote_sha256), UNIQUE(origin, store, trio_sha256),
  CHECK (accepted + duplicates + rejected = event_count),
  CHECK ((result='accepted' AND rejected=0 AND cardinality(codes)=0 AND checkpoint IS NOT NULL) OR
         (result='rejected' AND rejected=event_count AND accepted=0 AND duplicates=0 AND cardinality(codes)>0)),
  CHECK (receipt->>'origin' = origin AND receipt->>'store' = store AND receipt->>'lote_sha256' = lote_sha256)
);
CREATE TABLE pilot_shadow_events (
  origin text NOT NULL, store text NOT NULL,
  event_id text NOT NULL CHECK (event_id ~ '^evt_[0-9a-f]{16}$'),
  cursor text NOT NULL CHECK (cursor ~ '^[0-9]{8}T[0-9]{6}Z/evt_[0-9a-f]{16}$'),
  event_type text NOT NULL CHECK (event_type IN ('order_created','pix_received','refund','med','partner_withdrawal','wallet_charge','order_cancelled')),
  event_at timestamptz NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
  currency text NOT NULL CHECK (currency='BRL'),
  order_ref text CHECK (order_ref ~ '^ord_[0-9a-f]{16}$'), payment_ref text CHECK (payment_ref ~ '^pay_[0-9a-f]{16}$'),
  refers_to text CHECK (refers_to ~ '^pay_[0-9a-f]{16}$'), party_ref text CHECK (party_ref ~ '^(cli|par)_[0-9a-f]{16}$'),
  expires_at timestamptz, payer_self_identified boolean,
  line_sha256 text NOT NULL CHECK (line_sha256 ~ '^[0-9a-f]{64}$'), first_batch text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(origin,store,event_id),
  FOREIGN KEY(origin,store) REFERENCES pilot_shadow_streams(origin,store),
  FOREIGN KEY(origin,store,first_batch) REFERENCES pilot_shadow_batches(origin,store,lote_sha256) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX pilot_shadow_events_cursor ON pilot_shadow_events(origin,store,cursor);
CREATE FUNCTION pilot_shadow_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'shadow_append_only'; END;
$$;
CREATE TRIGGER pilot_shadow_events_immutable BEFORE UPDATE OR DELETE ON pilot_shadow_events FOR EACH ROW EXECUTE FUNCTION pilot_shadow_immutable();
CREATE TRIGGER pilot_shadow_batches_immutable BEFORE UPDATE OR DELETE ON pilot_shadow_batches FOR EACH ROW EXECUTE FUNCTION pilot_shadow_immutable();
CREATE FUNCTION pilot_shadow_checkpoint_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin IS DISTINCT FROM OLD.origin OR NEW.store IS DISTINCT FROM OLD.store OR
     (OLD.checkpoint IS NOT NULL AND (NEW.checkpoint IS NULL OR NEW.checkpoint < OLD.checkpoint)) THEN RAISE EXCEPTION 'shadow_checkpoint_rewind'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pilot_shadow_checkpoint_guard BEFORE UPDATE ON pilot_shadow_streams FOR EACH ROW EXECUTE FUNCTION pilot_shadow_checkpoint_monotonic();
