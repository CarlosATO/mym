-- ============================================================================
-- 1. Alter integraciones.bsale_document_references para soportar XML source
-- ============================================================================
ALTER TABLE integraciones.bsale_document_references 
    DROP CONSTRAINT IF EXISTS bsale_document_references_company_id_bsale_id_key;

ALTER TABLE integraciones.bsale_document_references 
    ALTER COLUMN bsale_id DROP NOT NULL;

ALTER TABLE integraciones.bsale_document_references 
    ADD COLUMN IF NOT EXISTS source_key text,
    ADD COLUMN IF NOT EXISTS line_number integer,
    ADD COLUMN IF NOT EXISTS referenced_document_type text;

-- Add new unique constraint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bsale_document_references_company_source_key_key') THEN
        ALTER TABLE integraciones.bsale_document_references ADD CONSTRAINT bsale_document_references_company_source_key_key UNIQUE (company_id, source_key);
    END IF;
END $$;

-- Drop and recreate the logical view to handle possible null reference_code correctly
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
        WHEN doc.sign_for_sales = -1 AND r.reference_code IS NULL THEN true
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
