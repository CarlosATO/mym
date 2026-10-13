-- Habilita las formas de pago reales de Bsale para Cobranza en CAYLO.
-- Cheque no requiere dynamic attributes obligatorios en la cuenta consultada.
INSERT INTO comercial.collection_payment_type_config
  (company_id, bsale_payment_type_id, label, enabled, dynamic_attributes)
VALUES
  ('d1000000-0000-0000-0000-000000000001', 1, 'EFECTIVO', true, '[]'::jsonb),
  ('d1000000-0000-0000-0000-000000000001', 5, 'CHEQUE', true, '[{"id":2,"name":"Banco","isMandatory":false},{"id":3,"name":"Número","isMandatory":false}]'::jsonb),
  ('d1000000-0000-0000-0000-000000000001', 8, 'TRANSFERENCIA', true, '[]'::jsonb)
ON CONFLICT (company_id, bsale_payment_type_id)
DO UPDATE SET
  label = excluded.label,
  enabled = excluded.enabled,
  dynamic_attributes = excluded.dynamic_attributes,
  updated_at = now();
