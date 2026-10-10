-- Contrato v7.2 (10/10/2026): o valor com que a comissão NASCEU fica gravado e nunca muda. O ajuste para baixo (v7.1) muda
-- amount_minor/usd_units; a idempotência da criação (replay do mesmo source_event_id) e a comparação das revisões do lote
-- comparam com o valor ORIGINAL, então repetir a criação original depois de um ajuste continua sendo 200 sem efeito.
-- Comissões que já existiam: o valor original vem da transição de criação (JSON com amount_minor); sem ela, o valor atual.
ALTER TABLE affiliate_commissions ADD COLUMN IF NOT EXISTS created_amount_minor bigint;
UPDATE affiliate_commissions c SET created_amount_minor = COALESCE(
  (SELECT (t.reason::jsonb ->> 'amount_minor')::bigint
     FROM state_transitions t
    WHERE t.entity = 'affiliate_commission' AND t.entity_id = c.id AND t.from_state IS NULL AND t.to_state = 'pending'
      AND t.reason LIKE '{%'
    ORDER BY t.id LIMIT 1),
  c.amount_minor)
 WHERE c.created_amount_minor IS NULL;
-- Nunca abaixo do valor atual (o ajuste só reduz): se a transição antiga disser menos que o atual, vale o atual.
UPDATE affiliate_commissions SET created_amount_minor = amount_minor WHERE created_amount_minor < amount_minor;
ALTER TABLE affiliate_commissions ALTER COLUMN created_amount_minor SET NOT NULL;
ALTER TABLE affiliate_commissions ADD CONSTRAINT affiliate_commissions_created_amount CHECK (amount_minor > 0 AND amount_minor <= created_amount_minor);
