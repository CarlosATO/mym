-- ============================================================================
-- 1. Crear tabla integraciones.bsale_document_references
-- ============================================================================
DROP TABLE IF EXISTS integraciones.bsale_document_references CASCADE;

CREATE TABLE integraciones.bsale_document_references (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id),
    bsale_id bigint NOT NULL,
    bsale_document_id bigint NOT NULL,
    referenced_document_id bigint,
    referenced_document_number text,
    referenced_document_type_id bigint,
    reference_code text,
    reference_reason text,
    reference_date date,
    raw_json jsonb,
    synced_at timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

CREATE INDEX idx_bsale_doc_ref_doc_id ON integraciones.bsale_document_references(company_id, bsale_document_id);
CREATE INDEX idx_bsale_doc_ref_num ON integraciones.bsale_document_references(company_id, referenced_document_number);
CREATE INDEX idx_bsale_doc_ref_code ON integraciones.bsale_document_references(company_id, reference_code);

ALTER TABLE integraciones.bsale_document_references ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read access for authenticated users on bsale_document_references"
ON integraciones.bsale_document_references FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow all access for service role on bsale_document_references"
ON integraciones.bsale_document_references FOR ALL TO service_role USING (true);

-- ============================================================================
-- 2. Crear tabla integraciones.bsale_reference_code_rules
-- ============================================================================
DROP TABLE IF EXISTS integraciones.bsale_reference_code_rules CASCADE;

CREATE TABLE integraciones.bsale_reference_code_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id),
    reference_code text NOT NULL,
    reference_name text NOT NULL,
    affects_financial_amount boolean NOT NULL DEFAULT true,
    affects_logistic_quantity boolean NOT NULL DEFAULT false,
    sign_for_logistic_quantity integer NOT NULL CHECK (sign_for_logistic_quantity IN (-1, 0, 1)),
    notes text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    UNIQUE (company_id, reference_code)
);

ALTER TABLE integraciones.bsale_reference_code_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read access for authenticated users on bsale_reference_code_rules"
ON integraciones.bsale_reference_code_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow all access for service role on bsale_reference_code_rules"
ON integraciones.bsale_reference_code_rules FOR ALL TO service_role USING (true);

-- Seed de Reglas (MYM)
DO $$
DECLARE
    mym_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
BEGIN
    INSERT INTO integraciones.bsale_reference_code_rules 
        (company_id, reference_code, reference_name, affects_financial_amount, affects_logistic_quantity, sign_for_logistic_quantity)
    VALUES
        (mym_company_id, '1', 'Anula Documento', true, true, -1),
        (mym_company_id, '2', 'Corrige Texto', false, false, 0),
        (mym_company_id, '3', 'Corrige Montos', true, false, 0)
    ON CONFLICT (company_id, reference_code) 
    DO UPDATE SET 
        reference_name = EXCLUDED.reference_name,
        affects_logistic_quantity = EXCLUDED.affects_logistic_quantity,
        sign_for_logistic_quantity = EXCLUDED.sign_for_logistic_quantity;
END $$;

-- ============================================================================
-- 3. Seed manual de las Referencias extraídas del XML de Bsale para validación
-- ============================================================================
DO $$
DECLARE
    mym_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
BEGIN
    INSERT INTO integraciones.bsale_document_references
        (company_id, bsale_id, bsale_document_id, referenced_document_number, referenced_document_type_id, reference_code, reference_reason, reference_date)
    VALUES
        -- 87855 = Folio 4149
        (mym_company_id, 1000001, 87855, '22571', 33, '3', 'SNACK OBSEQUIO', '2026-06-01'),
        -- 87860 = Folio 4153
        (mym_company_id, 1000002, 87860, '22789', 33, '3', 'PROMOCION DE REGALO', '2026-06-15'),
        -- 87913 = Folio 4166
        (mym_company_id, 1000003, 87913, '22782', 33, '3', 'PRODUCTOS OBSEQUIO', '2026-06-15')
    ON CONFLICT (company_id, bsale_id) DO NOTHING;
END $$;

-- ============================================================================
-- 4. Crear vista integraciones.vw_bsale_sales_logistic_valid
-- ============================================================================
DROP VIEW IF EXISTS integraciones.vw_bsale_sales_logistic_valid CASCADE;

CREATE VIEW integraciones.vw_bsale_sales_logistic_valid AS
SELECT 
    det.company_id,
    doc.folio AS document_number,
    doc.document_type_id,
    doc.document_type_name,
    doc.emission_date,
    det.variant_code,
    det.raw_quantity,
    
    -- financial_net_quantity
    det.net_quantity AS financial_net_quantity,
    
    -- logistic_net_quantity
    CASE
        WHEN doc.sign_for_sales = 1 THEN ABS(det.raw_quantity)
        WHEN doc.sign_for_sales = -1 THEN
            CASE
                WHEN r.reference_code IS NULL THEN -ABS(det.raw_quantity)
                WHEN ref_rules.affects_logistic_quantity = true THEN -ABS(det.raw_quantity)
                ELSE 0
            END
        ELSE 0
    END AS logistic_net_quantity,
    
    r.reference_code,
    r.reference_reason,
    COALESCE(ref_rules.affects_logistic_quantity, (r.reference_code IS NULL AND doc.sign_for_sales = -1)) AS affects_logistic_quantity,
    
    CASE 
        WHEN doc.sign_for_sales = -1 AND r.reference_code IS NOT NULL AND ref_rules.id IS NULL THEN true
        ELSE false
    END AS needs_review

FROM integraciones.vw_bsale_document_details_normalized det
JOIN integraciones.vw_bsale_documents_normalized doc 
    ON det.company_id = doc.company_id AND det.bsale_document_id = doc.bsale_id
LEFT JOIN integraciones.bsale_document_references r
    ON doc.company_id = r.company_id AND doc.bsale_id = r.bsale_document_id
LEFT JOIN integraciones.bsale_reference_code_rules ref_rules
    ON r.company_id = ref_rules.company_id AND r.reference_code = ref_rules.reference_code
WHERE doc.include_in_replenishment = true;

GRANT SELECT ON integraciones.vw_bsale_sales_logistic_valid TO authenticated, service_role;
