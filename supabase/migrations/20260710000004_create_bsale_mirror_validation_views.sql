-- ============================================================================
-- 1. vw_bsale_mirror_sync_health
-- ============================================================================
CREATE OR REPLACE VIEW integraciones.vw_bsale_mirror_sync_health AS
SELECT 
    company_id,
    COUNT(bsale_id) AS total_documents,
    MAX(emission_date) AS max_emission_date,
    MAX(generation_date) AS max_generation_date,
    MAX(synced_at) AS last_synced_at
FROM integraciones.bsale_documents
GROUP BY company_id;

-- ============================================================================
-- 2. vw_bsale_orphan_details
-- ============================================================================
CREATE OR REPLACE VIEW integraciones.vw_bsale_orphan_details AS
SELECT det.*
FROM integraciones.bsale_document_details det
LEFT JOIN integraciones.bsale_documents doc 
    ON det.company_id = doc.company_id AND det.bsale_document_id = doc.bsale_id
WHERE doc.bsale_id IS NULL;

-- ============================================================================
-- 3. vw_bsale_headers_without_details
-- ============================================================================
CREATE OR REPLACE VIEW integraciones.vw_bsale_headers_without_details AS
SELECT doc.*
FROM integraciones.bsale_documents doc
LEFT JOIN integraciones.bsale_document_details det 
    ON doc.company_id = det.company_id AND doc.bsale_id = det.bsale_document_id
WHERE det.bsale_id IS NULL;

-- ============================================================================
-- 4. vw_bsale_sales_by_doc_type_daily
-- ============================================================================
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_by_doc_type_daily AS
SELECT 
    company_id,
    emission_date,
    document_type_id,
    document_type_name,
    COUNT(detail_bsale_id) AS total_lines,
    SUM(quantity) AS raw_quantity,
    SUM(net_quantity) AS net_quantity
FROM integraciones.vw_bsale_document_details_normalized
GROUP BY 
    company_id,
    emission_date,
    document_type_id,
    document_type_name;
