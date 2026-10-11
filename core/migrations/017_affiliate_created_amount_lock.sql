-- Contrato v7.3 (10/10/2026, revisão X-1211, limites da F1): o valor com que a comissão nasceu fica travado no banco.
-- 1) Originais recuperáveis: se a 015 caiu no valor atual de uma comissão JÁ ajustada (sem transição de criação legível), o
--    original volta do primeiro ajuste registrado (from_minor), que é o valor antes de qualquer redução. Uma linha de
--    auditoria guarda quantas comissões foram corrigidas.
-- 2) Trava: nenhum UPDATE muda created_amount_minor (só o INSERT da criação escreve esse campo).
WITH first_adjust AS (
  SELECT DISTINCT ON (t.entity_id) t.entity_id, (t.reason::jsonb -> 'adjust' ->> 'from_minor')::bigint AS from_minor
    FROM state_transitions t
   WHERE t.entity = 'affiliate_commission' AND t.from_state = 'pending' AND t.to_state = 'pending'
     AND t.reason LIKE '{"adjust"%'
   ORDER BY t.entity_id, t.id
), fixed AS (
  UPDATE affiliate_commissions c SET created_amount_minor = f.from_minor
    FROM first_adjust f
   WHERE f.entity_id = c.id AND f.from_minor > c.created_amount_minor
  RETURNING c.id
)
INSERT INTO state_transitions (entity, entity_id, from_state, to_state, reason, source)
SELECT 'migration', '017_affiliate_created_amount_lock', NULL, 'applied', json_build_object('originals_recovered', count(*))::text, 'migration' FROM fixed;
CREATE OR REPLACE FUNCTION affiliate_created_amount_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'affiliate_commissions.created_amount_minor is immutable (commission %)', OLD.id;
END;
$$;
DROP TRIGGER IF EXISTS affiliate_created_amount_immutable ON affiliate_commissions;
CREATE TRIGGER affiliate_created_amount_immutable BEFORE UPDATE OF created_amount_minor ON affiliate_commissions
  FOR EACH ROW WHEN (OLD.created_amount_minor IS DISTINCT FROM NEW.created_amount_minor) EXECUTE FUNCTION affiliate_created_amount_immutable();
