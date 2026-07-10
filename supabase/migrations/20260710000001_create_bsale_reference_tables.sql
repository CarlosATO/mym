-- ============================================================================
-- 1. bsale_document_types
-- ============================================================================
CREATE TABLE IF NOT EXISTS integraciones.bsale_document_types (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        bigint NOT NULL,
    name            text,
    code            text,
    use             text,
    is_credit_note  boolean,
    is_electronic_document boolean,
    raw_json        jsonb,
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

ALTER TABLE integraciones.bsale_document_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read access for authenticated users on bsale_document_types"
ON integraciones.bsale_document_types FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Allow all access for service role on bsale_document_types"
ON integraciones.bsale_document_types FOR ALL
TO service_role
USING (true);

-- ============================================================================
-- 2. bsale_offices
-- ============================================================================
CREATE TABLE IF NOT EXISTS integraciones.bsale_offices (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        bigint NOT NULL,
    name            text,
    code            text,
    is_active       boolean DEFAULT true,
    raw_json        jsonb,
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

ALTER TABLE integraciones.bsale_offices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read access for authenticated users on bsale_offices"
ON integraciones.bsale_offices FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Allow all access for service role on bsale_offices"
ON integraciones.bsale_offices FOR ALL
TO service_role
USING (true);

-- ============================================================================
-- 3. bsale_document_type_rules
-- ============================================================================
CREATE TABLE IF NOT EXISTS integraciones.bsale_document_type_rules (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    document_type_id bigint NOT NULL,
    document_type_name text NOT NULL,
    sign_for_sales  integer NOT NULL CHECK (sign_for_sales IN (-1, 0, 1)),
    include_in_replenishment boolean NOT NULL DEFAULT false,
    include_in_sales_reports boolean NOT NULL DEFAULT false,
    business_category text NOT NULL,
    notes           text,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, document_type_id)
);

ALTER TABLE integraciones.bsale_document_type_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read access for authenticated users on bsale_document_type_rules"
ON integraciones.bsale_document_type_rules FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Allow all access for service role on bsale_document_type_rules"
ON integraciones.bsale_document_type_rules FOR ALL
TO service_role
USING (true);

-- ============================================================================
-- 4. Seed de Reglas
-- ============================================================================
DO $$
DECLARE
    mym_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
BEGIN
    INSERT INTO integraciones.bsale_document_type_rules 
        (company_id, document_type_id, document_type_name, sign_for_sales, include_in_replenishment, business_category)
    VALUES
        (mym_company_id, 1, 'BOLETA ELECTRÓNICA T', 1, true, 'sale'),
        (mym_company_id, 5, 'FACTURA ELECTRÓNICA', 1, true, 'sale'),
        (mym_company_id, 2, 'NOTA DE CRÉDITO ELECTRÓNICA', -1, true, 'reversal'),
        (mym_company_id, 23, 'NOTA VENTA', 0, false, 'quote'),
        (mym_company_id, 7, 'GUÍA DE DESPACHO', 0, false, 'dispatch')
    ON CONFLICT (company_id, document_type_id) 
    DO UPDATE SET 
        document_type_name = EXCLUDED.document_type_name,
        sign_for_sales = EXCLUDED.sign_for_sales,
        include_in_replenishment = EXCLUDED.include_in_replenishment,
        business_category = EXCLUDED.business_category;
END $$;
