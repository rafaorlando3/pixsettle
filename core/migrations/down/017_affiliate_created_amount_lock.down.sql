-- Volta só a trava (a auditoria e os originais recuperados ficam: são o valor certo).
DROP TRIGGER IF EXISTS affiliate_created_amount_immutable ON affiliate_commissions;
DROP FUNCTION IF EXISTS affiliate_created_amount_immutable();
