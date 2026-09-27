-- P2: devoluções com recibo próprio e pedido devolvido antes da liquidação.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('created','awaiting_payment','paid','settling','settled','expired','late_paid','refunded'));

-- Um refund_notice por caso de devolução; o recibo de liquidação continua um por pedido.
ALTER TABLE receipts ADD COLUMN refund_case_id text NULL UNIQUE REFERENCES refund_cases(id);
ALTER TABLE receipts ADD CONSTRAINT receipts_refund_link CHECK ((receipt_type = 'refund_notice') = (refund_case_id IS NOT NULL));
CREATE UNIQUE INDEX one_settlement_receipt_per_order ON receipts (order_id) WHERE receipt_type = 'settlement';

-- Motivo e momento da observação do caso de devolução (sem dados pessoais).
ALTER TABLE refund_cases ADD COLUMN last_error jsonb NULL;
ALTER TABLE refund_cases ADD COLUMN observed_at timestamptz NULL;
