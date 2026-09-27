-- Revisão do Codex (R4): estado durável entre "autorizado a pedir ao provedor" e "resultado observado".
-- `submitting` é gravado ANTES de chamar o provedor; retomada a partir dele só observa, nunca repete o estorno.
ALTER TABLE refund_cases DROP CONSTRAINT refund_cases_state_check;
ALTER TABLE refund_cases ADD CONSTRAINT refund_cases_state_check
  CHECK (state IN ('requested','submitting','unknown','confirmed','partial','failed'));
