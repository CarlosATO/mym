-- ============================================================================
-- Actualizar reglas para incluir FE y Boleta en reportes de ventas (bruto)
-- ============================================================================
UPDATE integraciones.bsale_document_type_rules
SET include_in_sales_reports = true
WHERE document_type_id IN (1, 5);

-- ============================================================================
-- Recrear vw_bsale_document_details_normalized con include_in_sales_reports
-- ============================================================================
DROP VIEW IF EXISTS integraciones.vw_bsale_sales_by_doc_type_daily CASCADE;
DROP VIEW IF EXISTS integraciones.vw_bsale_sales_daily_sku CASCADE;
DROP VIEW IF EXISTS integraciones.vw_bsale_sales_valid CASCADE;
DROP VIEW IF EXISTS integraciones.vw_bsale_sales_gross_bsale_like CASCADE;
DROP VIEW IF EXISTS integraciones.vw_bsale_document_details_normalized CASCADE;

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
    doc.include_in_sales_reports,
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

-- ============================================================================
-- 4. vw_bsale_sales_daily_sku
-- ============================================================================
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_daily_sku AS
SELECT 
    company_id,
    emission_date,
    variant_code,
    office_id,
    document_type_id,
    SUM(CASE WHEN net_quantity > 0 THEN net_quantity ELSE 0 END) AS gross_quantity_positive,
    SUM(CASE WHEN net_quantity < 0 THEN net_quantity ELSE 0 END) AS gross_quantity_negative,
    SUM(net_quantity) AS net_quantity,
    COUNT(DISTINCT bsale_document_id) AS documents_count,
    COUNT(detail_bsale_id) AS lines_count
FROM integraciones.vw_bsale_sales_valid
GROUP BY 
    company_id,
    emission_date,
    variant_code,
    office_id,
    document_type_id;

-- ============================================================================
-- 5. vw_bsale_sales_by_doc_type_daily
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

-- ============================================================================
-- vw_bsale_sales_gross_bsale_like
-- ============================================================================
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_gross_bsale_like AS
SELECT *
FROM integraciones.vw_bsale_document_details_normalized
WHERE include_in_sales_reports = true
  AND sign_for_sales = 1
  AND business_category = 'sale'
  AND quantity > 0;

GRANT SELECT ON integraciones.vw_bsale_document_details_normalized TO authenticated, service_role;
GRANT SELECT ON integraciones.vw_bsale_sales_valid TO authenticated, service_role;
GRANT SELECT ON integraciones.vw_bsale_sales_daily_sku TO authenticated, service_role;
GRANT SELECT ON integraciones.vw_bsale_sales_by_doc_type_daily TO authenticated, service_role;
GRANT SELECT ON integraciones.vw_bsale_sales_gross_bsale_like TO authenticated, service_role;
