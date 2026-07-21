-- Fase 3C: vendedores reales por documento Bsale.
-- Fuente certificada: GET /documents/{id}/sellers.json

CREATE TABLE IF NOT EXISTS integraciones.bsale_document_sellers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    bsale_document_id bigint NOT NULL,
    document_type_id integer,
    document_number bigint,
    seller_bsale_id bigint NOT NULL,
    seller_name text,
    seller_first_name text,
    seller_last_name text,
    seller_email text,
    seller_office text,
    seller_percent numeric,
    seller_amount numeric,
    is_primary boolean NOT NULL DEFAULT true,
    source text NOT NULL DEFAULT 'documents_sellers_endpoint',
    raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    payload_hash text,
    last_sync_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_bsale_document_sellers_document_seller UNIQUE (company_id, bsale_document_id, seller_bsale_id),
    CONSTRAINT chk_bsale_document_sellers_source CHECK (source IN ('documents_sellers_endpoint'))
);

CREATE INDEX IF NOT EXISTS idx_bsale_document_sellers_document
    ON integraciones.bsale_document_sellers (company_id, bsale_document_id);

CREATE INDEX IF NOT EXISTS idx_bsale_document_sellers_seller
    ON integraciones.bsale_document_sellers (company_id, seller_bsale_id);

CREATE INDEX IF NOT EXISTS idx_bsale_document_sellers_type
    ON integraciones.bsale_document_sellers (company_id, document_type_id);

CREATE INDEX IF NOT EXISTS idx_bsale_document_sellers_last_sync
    ON integraciones.bsale_document_sellers (company_id, last_sync_at);

ALTER TABLE integraciones.bsale_document_sellers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view Bsale document sellers by company" ON integraciones.bsale_document_sellers;
CREATE POLICY "Users can view Bsale document sellers by company"
ON integraciones.bsale_document_sellers
FOR SELECT
TO authenticated
USING (core.has_company_access(auth.uid(), company_id));

DROP POLICY IF EXISTS "Service role can manage Bsale document sellers" ON integraciones.bsale_document_sellers;
CREATE POLICY "Service role can manage Bsale document sellers"
ON integraciones.bsale_document_sellers
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

GRANT SELECT ON integraciones.bsale_document_sellers TO authenticated;
GRANT ALL ON integraciones.bsale_document_sellers TO service_role;
