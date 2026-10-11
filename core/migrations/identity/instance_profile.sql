-- Identidade do banco da produção dos afiliados (contrato v7.5, 11/10/2026; revisões X-1211, X-1212, X-1222 e X-1277).
-- NÃO é migração: o boot executa este arquivo inteiro (idempotente) SÓ dentro da transação que prende um banco NOVO ao
-- perfil da instância. v7.5 (X-1277 B3): banco já preso nunca recebe este arquivo de novo; identidade de versão anterior ou
-- incompleta é recusada só lendo (não há atualização nem conserto no boot). A migração 016 continua byte a byte a da v7.3
-- corrigida (b8cc379); este arquivo é o superconjunto que o boot instala.
--
-- O que protege, e o que não protege:
--   * a linha do perfil (uma só, id = 1) recusa UPDATE, DELETE e TRUNCATE por gatilho;
--   * a guarda de escrita recusa INSERT, UPDATE, DELETE e TRUNCATE em qualquer tabela do esquema public de um banco preso,
--     a menos que a sessão tenha declarado o perfil (`pixsettle.profile` = impressão digital do perfil gravado). O runtime
--     declara em toda conexão; código antigo (v7.2 e anteriores, um retorno de versão, uma ferramenta solta) não declara e é
--     recusado. Não é controle de acesso: a impressão digital sai de valores públicos;
--   * v7.5 (X-1277 H2): a guarda compara com a impressão SELADA no catálogo no momento em que o banco é preso
--     (`instance_profile_sealed_fingerprint()`), nunca com a linha lida pela foto da transação: uma sessão REPEATABLE READ
--     aberta antes de prender não enxerga a linha, mas enxerga a função confirmada. Sem impressão selada, a guarda recusa
--     (falha fechada);
--   * gatilhos só valem nos estados O (origem/local) e A (sempre); R (só réplica) e D (desligado) não disparam numa sessão
--     normal e o boot recusa (X-1277 K5), sem consertar;
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

-- v7.5 (X-1277 H2): impressão SELADA. Nasce nula (só se ainda não existir: rodar este arquivo de novo nunca desfaz o selo) e
-- é trocada pela constante do perfil por `instance_profile_seal()`, na mesma transação que grava a linha.
DO $$
BEGIN
  IF to_regprocedure('public.instance_profile_sealed_fingerprint()') IS NULL THEN
    EXECUTE 'CREATE FUNCTION instance_profile_sealed_fingerprint() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT NULL::text $f$';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION instance_profile_seal() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  fp text := instance_profile_fingerprint();
  have text := instance_profile_sealed_fingerprint();
BEGIN
  IF fp IS NULL THEN
    RAISE EXCEPTION 'instance_profile_seal: banco sem perfil; o selo só existe junto com a linha';
  END IF;
  IF have IS NOT NULL THEN
    IF have = fp THEN RETURN fp; END IF;
    RAISE EXCEPTION 'instance_profile_seal: impressão selada diferente da linha; trocar o vínculo é gesto manual registrado';
  END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION instance_profile_sealed_fingerprint() RETURNS text LANGUAGE sql STABLE AS %L', 'SELECT ' || quote_literal(fp) || '::text');
  RETURN fp;
END;
$$;

-- Guarda de escrita (por comando). Só existe em banco preso (nasce na transação que prende ou na migração que cria a tabela).
-- v7.5 (X-1277 H2): compara com a impressão SELADA (catálogo confirmado), não com a linha lida pela foto da transação; sem
-- selo, recusa (falha fechada).
CREATE OR REPLACE FUNCTION instance_profile_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  want text := instance_profile_sealed_fingerprint();
BEGIN
  IF want IS NULL THEN
    RAISE EXCEPTION 'legacy_writer_refused: % em %: guarda sem impressão selada (falha fechada)', TG_OP, TG_TABLE_NAME
      USING ERRCODE = '42501';
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
  -- v7.5: guarda só em banco selado (a guarda sem selo recusaria tudo; instalar sem selo é erro de ordem, falha fechada)
  IF instance_profile_sealed_fingerprint() IS NULL THEN
    RAISE EXCEPTION 'instance_profile_guard_install: banco sem impressão selada; a guarda nasce depois do selo';
  END IF;
  -- gatilho existente com o nome da guarda que não dispara numa sessão normal (R ou D, X-1277 K5) ou que não é a guarda
  -- (outra função, outros eventos, outro momento ou nível, condição WHEN, argumentos: X-1282 V75-K5-O) não é pulado em
  -- silêncio: recusa (reparo manual registrado)
  FOR r IN
    SELECT c.relname, t.tgenabled, t.tgtype, t.tgfoid::regprocedure::text AS fn FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND t.tgname = 'instance_profile_write_guard'
       AND (t.tgenabled NOT IN ('O', 'A') OR t.tgfoid <> 'public.instance_profile_write_guard()'::regprocedure OR t.tgtype <> 62
            OR t.tgqual IS NOT NULL OR t.tgnargs <> 0 OR t.tgconstraint <> 0 OR coalesce(array_length(t.tgattr::int2[], 1), 0) <> 0)
     ORDER BY c.relname
  LOOP
    IF r.tgenabled NOT IN ('O', 'A') THEN
      RAISE EXCEPTION 'instance_profile_guard_install: guarda existente fora de O/A em % (estado %); reparo manual registrado', r.relname, r.tgenabled;
    END IF;
    RAISE EXCEPTION 'instance_profile_guard_install: gatilho instance_profile_write_guard em % não é a guarda (função %, tipo %); reparo manual registrado', r.relname, r.fn, r.tgtype;
  END LOOP;
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
