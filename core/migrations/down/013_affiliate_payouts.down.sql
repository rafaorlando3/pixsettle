DROP TABLE IF EXISTS affiliate_commission_applications;
DROP TABLE IF EXISTS affiliate_commission_revisions;
DROP TABLE IF EXISTS affiliate_commission_batches;
DROP TABLE IF EXISTS affiliate_commission_streams;
DROP FUNCTION IF EXISTS affiliate_append_only() CASCADE;
DROP TABLE IF EXISTS affiliate_policies;
DROP TABLE IF EXISTS affiliate_receipts;
DROP TABLE IF EXISTS affiliate_withdrawals;
DROP TABLE IF EXISTS affiliate_quote_locks;
DROP TABLE IF EXISTS affiliate_ledger;
DROP TABLE IF EXISTS affiliate_commissions;
DROP TABLE IF EXISTS affiliate_beneficiaries;
-- Only safe when no affiliate_payout settlement exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM settlements WHERE kind = 'affiliate_payout') THEN
    RAISE EXCEPTION 'affiliate_payout settlements exist; refusing to drop the kind columns';
  END IF;
END;
$$;
ALTER TABLE settlements DROP CONSTRAINT settlements_kind_shape;
ALTER TABLE settlements DROP COLUMN beneficiary_ref;
ALTER TABLE settlements DROP COLUMN kind;
ALTER TABLE settlements ALTER COLUMN order_id SET NOT NULL;
