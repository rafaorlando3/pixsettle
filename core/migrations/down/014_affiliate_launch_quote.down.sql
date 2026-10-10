-- Recusa quando existe comissão fixada pela cotação do lançamento: a volta nunca apaga a prova de uma conversão real.
LOCK TABLE affiliate_commissions IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM affiliate_commissions WHERE quote_mode = 'launch' OR quote_evidence IS NOT NULL) THEN
    RAISE EXCEPTION 'launch-quoted commissions exist; refusing to drop the launch quote';
  END IF;
END;
$$;
ALTER TABLE affiliate_commissions DROP CONSTRAINT IF EXISTS affiliate_commissions_launch_evidence;
ALTER TABLE affiliate_commissions DROP COLUMN IF EXISTS quote_evidence;
ALTER TABLE affiliate_commissions DROP CONSTRAINT IF EXISTS affiliate_commissions_quote_mode_check;
ALTER TABLE affiliate_commissions ADD CONSTRAINT affiliate_commissions_quote_mode_check CHECK (quote_mode IN ('at_pix','backfill'));
