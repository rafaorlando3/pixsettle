-- Contrato v7.3 (10/10/2026, revisões X-1211 e X-1212): o banco da produção dos afiliados fica preso a UM perfil: modo
-- (produção ou ensaio), rede, token, tesouraria e a política de cotação. Uma linha só (id = 1), imutável: trocar o vínculo
-- é operação manual registrada, nunca automática. O boot confere este perfil ANTES das migrações de negócio pendentes, de
-- qualquer escrita e de qualquer processo com chave; este arquivo também é executado sozinho (idempotente) para criar só a
-- identidade num banco novo, antes do resto.
CREATE TABLE IF NOT EXISTS instance_profile (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode         text NOT NULL CHECK (mode IN ('production', 'rehearsal')),
  chain_id     integer NOT NULL CHECK (chain_id > 0),
  token        text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  treasury     text NOT NULL CHECK (treasury ~ '^0x[0-9a-f]{40}$'),
  quote_source text NOT NULL CHECK (quote_source IN ('binance_usdtbrl', 'simulated')),
  adopted      boolean NOT NULL DEFAULT false,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instance_profile_real_quote CHECK (mode = 'rehearsal' OR quote_source = 'binance_usdtbrl')
);
CREATE OR REPLACE FUNCTION instance_profile_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'instance_profile is immutable: changing the binding is a manual, recorded operation';
END;
$$;
DROP TRIGGER IF EXISTS instance_profile_immutable ON instance_profile;
CREATE TRIGGER instance_profile_immutable BEFORE UPDATE OR DELETE ON instance_profile FOR EACH ROW EXECUTE FUNCTION instance_profile_immutable();
