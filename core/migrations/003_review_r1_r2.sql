-- Revisão do Codex (X-0004).
-- R1: evidência conclusiva não é sobrescrita por erro de RPC nem por retransmissão; livro-razão com chave de operação única.
ALTER TABLE settlement_attempts ADD COLUMN last_rpc_error jsonb NULL;   -- consulta que falhou (nunca apaga `observed`)
ALTER TABLE settlement_attempts ADD COLUMN last_reconcile jsonb NULL;   -- última retransmissão dos mesmos bytes (não apaga `broadcast_outcome`)

ALTER TABLE ledger_entries ADD COLUMN op_key text NULL;
ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_append_only;       -- só nesta migração, para preencher linhas antigas
UPDATE ledger_entries SET op_key = 'legacy:' || id WHERE op_key IS NULL;
ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_append_only;
ALTER TABLE ledger_entries ALTER COLUMN op_key SET NOT NULL;
CREATE UNIQUE INDEX ledger_entries_op_key ON ledger_entries (op_key);
