-- ============================================================================
-- 1. vw_bsale_documents_normalized
-- ============================================================================
CREATE OR REPLACE VIEW integraciones.vw_bsale_documents_normalized AS
SELECT 
    d.company_id,
    d.bsale_id,
    d.number AS folio,
    d.document_type_id,
    COALESCE(r.document_type_name, 'UNKNOWN') AS document_type_name,
    d.office_id,
    o.name AS office_name,
    d.emission_date,
    d.generation_date,
    d.synced_at,
    COALESCE(r.sign_for_sales, 0) AS sign_for_sales,
    COALESCE(r.include_in_replenishment, false) AS include_in_replenishment,
    COALESCE(r.include_in_sales_reports, false) AS include_in_sales_reports,
    COALESCE(r.business_category, 'unknown') AS business_category
FROM integraciones.bsale_documents d
LEFT JOIN integraciones.bsale_document_type_rules r 
    ON d.company_id = r.company_id AND d.document_type_id = r.document_type_id
LEFT JOIN integraciones.bsale_offices o 
    ON d.company_id = o.company_id AND d.office_id = o.bsale_id;

-- ============================================================================
-- 2. vw_bsale_document_details_normalized
-- ============================================================================
CREATE OR REPLACE VIEW integraciones.vw_bsale_document_details_normalized AS
SELECT 
    det.company_id,
    det.bsale_document_id,
    det.bsale_id AS detail_bsale_id,
    doc.folio AS document_number,
    doc.document_type_id,
    doc.document_type_name,
    doc.emission_date,
    doc.generation_date,
    doc.office_id,
    doc.office_name,
    det.variant_id,
    COALESCE(v.code, det.variant_code) AS variant_code,
    det.quantity,
    doc.sign_for_sales,
    (det.quantity * doc.sign_for_sales) AS net_quantity,
    doc.include_in_replenishment,
    doc.business_category
FROM integraciones.bsale_document_details det
JOIN integraciones.vw_bsale_documents_normalized doc 
    ON det.company_id = doc.company_id AND det.bsale_document_id = doc.bsale_id
LEFT JOIN integraciones.bsale_variants v 
    ON det.company_id = v.company_id AND det.variant_id = v.bsale_id;

-- ============================================================================
-- 3. vw_bsale_sales_valid
-- ============================================================================
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_valid AS
SELECT *
FROM integraciones.vw_bsale_document_details_normalized
WHERE include_in_replenishment = true;
