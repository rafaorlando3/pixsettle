-- 007: recibo por lote do piloto.
-- Cada lote aceito em /pilot/v1/events fica registrado uma vez, com o hash do corpo bruto e um recibo assinado
-- (HMAC com o mesmo segredo do lote). Reenviar o MESMO corpo devolve o MESMO recibo sem tocar nos eventos
-- (idempotência de ponta a ponta); reusar um batch_id com corpo diferente é recusado com motivo.
CREATE TABLE pilot_batches (
  source_id    text NOT NULL REFERENCES pilot_sources(id),
  batch_id     text NOT NULL,
  body_sha256  text NOT NULL,
  accepted     integer NOT NULL CHECK (accepted >= 0),
  duplicates   integer NOT NULL CHECK (duplicates >= 0),
  rejected     integer NOT NULL CHECK (rejected >= 0),
  receipt      jsonb NOT NULL,                     -- {source, batch_id, body_sha256, accepted, duplicates, rejected, received_at, sig}
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, batch_id)
);
CREATE UNIQUE INDEX pilot_batches_body ON pilot_batches (source_id, body_sha256);
