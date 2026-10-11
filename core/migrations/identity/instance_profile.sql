-- Identidade do banco da produção dos afiliados (contrato v7.4, 11/10/2026; revisões X-1211, X-1212 e X-1222).
-- NÃO é migração: o boot executa este arquivo inteiro (idempotente) dentro da transação que prende um banco NOVO ao perfil
-- da instância, ou quando atualiza a identidade de um banco já preso a ESTE mesmo perfil. Banco preso a outro perfil é
-- recusado antes de qualquer escrita (o boot só lê o catálogo e a linha). A migração 016 continua byte a byte a da v7.3
-- corrigida (b8cc379); este arquivo é o superconjunto que o boot mantém.
--
-- O que protege, e o que não protege:
--   * a linha do perfil (uma só, id = 1) recusa UPDATE, DELETE e TRUNCATE por gatilho;
--   * a guarda de escrita recusa INSERT, UPDATE, DELETE e TRUNCATE em qualquer tabela do esquema public de um banco preso,
--     a menos que a sessão tenha declarado o perfil (`pixsettle.profile` = impressão digital do perfil gravado). O runtime da
--     v7.4 declara em toda conexão; código antigo (v7.2 e anteriores, um retorno de versão, uma ferramenta solta) não declara
--     e é recusado. Não é controle de acesso: a impressão digital sai de valores públicos;
--   * quem tem privilégio de dono ou superusuário continua podendo apagar a tabela, desligar gatilho ou declarar o perfil à
--     mão. Isso é operação manual, fora do runtime, e tem de ser registrada; o runtime não faz nenhuma dessas operações.
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
DROP TRIGGER IF EXISTS instance_profile_no_truncate ON instance_profile;
CREATE TRIGGER instance_profile_no_truncate BEFORE TRUNCATE ON instance_profile FOR EACH STATEMENT EXECUTE FUNCTION instance_profile_immutable();

-- Impressão digital do perfil gravado (null num banco sem perfil): sha256 de "modo|rede|token|tesouraria|cotação".
CREATE OR REPLACE FUNCTION instance_profile_fingerprint() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(mode || '|' || chain_id::text || '|' || token || '|' || treasury || '|' || quote_source, 'UTF8')), 'hex')
    FROM instance_profile WHERE id = 1
$$;

-- Guarda de escrita (por comando): banco sem perfil não é guardado; banco preso só aceita a sessão que declarou o perfil.
CREATE OR REPLACE FUNCTION instance_profile_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  want text := instance_profile_fingerprint();
BEGIN
  IF want IS NULL THEN
    RETURN NULL;
  END IF;
  IF current_setting('pixsettle.profile', true) IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'legacy_writer_refused: % em %: o banco está preso a um perfil de instância e esta sessão não declarou esse perfil (pixsettle.profile)', TG_OP, TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END;
$$;

-- Liga a guarda em toda tabela do esquema public que ainda não a tem (devolve quantas ligou). Chamado na transação que prende
-- o banco, no fim de cada migração (mesma transação que cria a tabela nova) e no fim do boot.
CREATE OR REPLACE FUNCTION instance_profile_guard_install() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname <> 'instance_profile'
       AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'instance_profile_write_guard')
     ORDER BY c.relname
  LOOP
    EXECUTE format('CREATE TRIGGER instance_profile_write_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION instance_profile_write_guard()', r.relname);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
