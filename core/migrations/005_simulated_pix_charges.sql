-- Estado do provedor Pix SIMULADO (demo e bancada), para a cobrança sobreviver a reinício do processo.
-- Isolado dos provedores reais: só o SimulatedPixProvider lê e escreve aqui; nenhuma tabela do núcleo
-- referencia esta. Os ids começam com pay_sim_ para nunca se confundir com cobranças de provedor real.
CREATE TABLE simulated_pix_charges (
  id             text PRIMARY KEY CHECK (id LIKE 'pay_sim\_%'),
  order_id       text NOT NULL,
  value_minor    bigint NOT NULL CHECK (value_minor > 0),
  status         text NOT NULL CHECK (status IN ('PENDING','RECEIVED','REFUNDED','PARTIALLY_REFUNDED','DELETED')),
  paid_at        timestamptz,
  paid_minor     bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX simulated_pix_charges_order ON simulated_pix_charges (order_id);
