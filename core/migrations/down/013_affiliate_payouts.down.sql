-- Refuses to run when any economic state exists: a down migration never deletes money.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM settlements WHERE kind = 'affiliate_payout') THEN
    RAISE EXCEPTION 'affiliate_payout settlements exist; refusing to drop affiliate tables';
  END IF;
  IF EXISTS (SELECT 1 FROM affiliate_commissions) OR EXISTS (SELECT 1 FROM affiliate_withdrawals) OR EXISTS (SELECT 1 FROM affiliate_ledger) THEN
    RAISE EXCEPTION 'affiliate commissions, withdrawals or ledger rows exist; refusing to drop affiliate tables';
  END IF;
  IF EXISTS (SELECT 1 FROM affiliate_commission_revisions) THEN
    RAISE EXCEPTION 'signed commission revisions exist; refusing to drop affiliate tables';
  END IF;
END;
$$;
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
ALTER TABLE settlements DROP CONSTRAINT settlements_kind_shape;
ALTER TABLE settlements DROP COLUMN beneficiary_ref;
ALTER TABLE settlements DROP COLUMN kind;
ALTER TABLE settlements ALTER COLUMN order_id SET NOT NULL;
