-- Recusa quando existe comissão ajustada (valor atual diferente do original): a volta nunca apaga o valor com que a
-- comissão nasceu, que é o que mantém a criação idempotente depois do ajuste.
LOCK TABLE affiliate_commissions IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM affiliate_commissions WHERE amount_minor <> created_amount_minor) THEN
    RAISE EXCEPTION 'adjusted commissions exist; refusing to drop the created amount';
  END IF;
END;
$$;
ALTER TABLE affiliate_commissions DROP CONSTRAINT IF EXISTS affiliate_commissions_created_amount;
ALTER TABLE affiliate_commissions DROP COLUMN IF EXISTS created_amount_minor;
