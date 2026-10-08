-- Retorno da 006 (piloto + copiloto). Esquema volta ao da 005.
-- Regra: NÃO apaga dados do núcleo. Se existirem pedidos/cobranças/casos do piloto (provider_env='attested',
-- provider='attested', refund_type='med_attested'), as restrições originais não podem voltar e o retorno
-- FALHA inteiro (transação), com o motivo. Nesse caso, remova o piloto primeiro (scripts/pilot-purge) e repita.
DROP TABLE copilot_replay;
DROP TABLE copilot_verdicts;        -- o gatilho append_only cai junto com a tabela
DROP TABLE exceptions;
DROP TABLE pilot_charges;
DROP TABLE attested_events;
DROP TABLE pilot_stores;
DROP TABLE pilot_sources;
ALTER TABLE refund_cases DROP CONSTRAINT refund_cases_refund_type_check;
ALTER TABLE refund_cases ADD CONSTRAINT refund_cases_refund_type_check
  CHECK (refund_type IN ('merchant_refund','provider_refund','late_payment_refund','med_simulated'));
ALTER TABLE pix_charges DROP CONSTRAINT pix_charges_provider_check;
ALTER TABLE pix_charges ADD CONSTRAINT pix_charges_provider_check CHECK (provider IN ('asaas','simulated'));
ALTER TABLE orders DROP CONSTRAINT orders_provider_env_check;
ALTER TABLE orders ADD CONSTRAINT orders_provider_env_check CHECK (provider_env IN ('sandbox','simulated'));
