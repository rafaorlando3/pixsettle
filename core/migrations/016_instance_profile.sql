-- Contrato v7.3 (10/10/2026): o banco da produção dos afiliados fica preso a UM perfil no primeiro boot: modo (produção ou
-- ensaio), rede, token e tesouraria. Um ensaio (cotação simulada) apontado para o banco da produção, ou a produção apontada
-- para o banco de um ensaio, de outra rede ou de outra tesouraria, é recusado no boot com o motivo. Uma linha só (id = 1).
CREATE TABLE IF NOT EXISTS instance_profile (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode       text NOT NULL CHECK (mode IN ('production', 'rehearsal')),
  chain_id   integer NOT NULL CHECK (chain_id > 0),
  token      text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  treasury   text NOT NULL CHECK (treasury ~ '^0x[0-9a-f]{40}$'),
  claimed_at timestamptz NOT NULL DEFAULT now()
);
