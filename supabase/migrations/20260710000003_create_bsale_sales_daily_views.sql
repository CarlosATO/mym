-- ============================================================================
-- 1. vw_bsale_sales_daily_sku
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
