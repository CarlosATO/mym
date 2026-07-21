ALTER TABLE integraciones.bsale_payment_types
ADD COLUMN IF NOT EXISTS bsale_payment_type_id bigint,
ADD COLUMN IF NOT EXISTS is_active boolean,
ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

UPDATE integraciones.bsale_payment_types
SET bsale_payment_type_id = bsale_id
WHERE bsale_payment_type_id IS NULL;

ALTER TABLE integraciones.bsale_payment_types
ALTER COLUMN raw_json SET DEFAULT '{}'::jsonb,
ALTER COLUMN raw_json SET NOT NULL,
ALTER COLUMN synced_at SET NOT NULL,
ALTER COLUMN created_at SET NOT NULL,
ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE integraciones.bsale_payment_types
ALTER COLUMN bsale_payment_type_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bsale_payment_types_company_payment_type
ON integraciones.bsale_payment_types(company_id, bsale_payment_type_id);

ALTER TABLE integraciones.bsale_payments
ADD COLUMN IF NOT EXISTS bsale_payment_id bigint,
ADD COLUMN IF NOT EXISTS payment_type_bsale_id bigint,
ADD COLUMN IF NOT EXISTS state integer,
ADD COLUMN IF NOT EXISTS created_at_bsale timestamptz,
ADD COLUMN IF NOT EXISTS operation_number text,
ADD COLUMN IF NOT EXISTS check_date date,
ADD COLUMN IF NOT EXISTS check_number bigint;

UPDATE integraciones.bsale_payments
SET bsale_payment_id = bsale_id
WHERE bsale_payment_id IS NULL;

UPDATE integraciones.bsale_payments
SET payment_type_bsale_id = payment_type_id
WHERE payment_type_bsale_id IS NULL;

ALTER TABLE integraciones.bsale_payments
ALTER COLUMN raw_json SET DEFAULT '{}'::jsonb,
ALTER COLUMN raw_json SET NOT NULL,
ALTER COLUMN synced_at SET NOT NULL,
ALTER COLUMN created_at SET NOT NULL,
ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE integraciones.bsale_payments
ALTER COLUMN bsale_payment_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bsale_payments_company_payment
ON integraciones.bsale_payments(company_id, bsale_payment_id);

CREATE TABLE IF NOT EXISTS integraciones.bsale_document_payments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  bsale_payment_id bigint NOT NULL,
  bsale_document_id bigint NOT NULL,
  document_type_id integer,
  document_number bigint,
  client_id bigint,
  payment_record_date timestamptz,
  amount_applied numeric NOT NULL DEFAULT 0,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, bsale_payment_id, bsale_document_id)
);

CREATE INDEX IF NOT EXISTS idx_bsale_document_payments_payment
ON integraciones.bsale_document_payments(company_id, bsale_payment_id);

CREATE INDEX IF NOT EXISTS idx_bsale_document_payments_document
ON integraciones.bsale_document_payments(company_id, bsale_document_id);

CREATE INDEX IF NOT EXISTS idx_bsale_document_payments_client
ON integraciones.bsale_document_payments(company_id, client_id);

CREATE INDEX IF NOT EXISTS idx_bsale_document_payments_record_date
ON integraciones.bsale_document_payments(company_id, payment_record_date);

ALTER TABLE integraciones.bsale_payment_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_document_payments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE integraciones.bsale_payment_types FROM anon;
REVOKE ALL ON TABLE integraciones.bsale_payments FROM anon;
REVOKE ALL ON TABLE integraciones.bsale_document_payments FROM anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE integraciones.bsale_payment_types FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE integraciones.bsale_payments FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE integraciones.bsale_document_payments FROM authenticated;

GRANT SELECT ON TABLE integraciones.bsale_payment_types TO authenticated;
GRANT SELECT ON TABLE integraciones.bsale_payments TO authenticated;
GRANT SELECT ON TABLE integraciones.bsale_document_payments TO authenticated;

GRANT ALL ON TABLE integraciones.bsale_payment_types TO service_role;
GRANT ALL ON TABLE integraciones.bsale_payments TO service_role;
GRANT ALL ON TABLE integraciones.bsale_document_payments TO service_role;

DROP POLICY IF EXISTS "bsale_payment_types company select"
ON integraciones.bsale_payment_types;

CREATE POLICY "bsale_payment_types company select"
ON integraciones.bsale_payment_types
FOR SELECT
TO authenticated
USING (core.has_company_access(auth.uid(), company_id));

DROP POLICY IF EXISTS "bsale_payments company select"
ON integraciones.bsale_payments;

CREATE POLICY "bsale_payments company select"
ON integraciones.bsale_payments
FOR SELECT
TO authenticated
USING (core.has_company_access(auth.uid(), company_id));

DROP POLICY IF EXISTS "bsale_document_payments company select"
ON integraciones.bsale_document_payments;

CREATE POLICY "bsale_document_payments company select"
ON integraciones.bsale_document_payments
FOR SELECT
TO authenticated
USING (core.has_company_access(auth.uid(), company_id));
