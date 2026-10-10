-- Contrato v4 (10/10/2026): cotação do LANÇAMENTO. Comissões que nasceram em reais antes do dólar viram dólar pela cotação
-- de uma conversão REAL informada pelo lojista (reais pagos ÷ dólares que chegaram na tesouraria), marcada quote_mode='launch'
-- e com a prova guardada (quote_evidence: reais pagos, unidades recebidas, transações). Nunca apresentada como "no instante do Pix".
ALTER TABLE affiliate_commissions DROP CONSTRAINT IF EXISTS affiliate_commissions_quote_mode_check;
ALTER TABLE affiliate_commissions ADD CONSTRAINT affiliate_commissions_quote_mode_check CHECK (quote_mode IN ('at_pix','backfill','launch'));
ALTER TABLE affiliate_commissions ADD COLUMN IF NOT EXISTS quote_evidence jsonb;
ALTER TABLE affiliate_commissions ADD CONSTRAINT affiliate_commissions_launch_evidence CHECK ((quote_mode = 'launch') = (quote_evidence IS NOT NULL));
