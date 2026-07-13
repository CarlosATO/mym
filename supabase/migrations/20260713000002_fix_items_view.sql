-- ============================================================================
-- Fix Vista Detalles Kanban: vw_bsale_sales_order_items_for_preparation
-- ============================================================================
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_order_items_for_preparation AS
SELECT
    nv.company_id,
    nv.bsale_id AS nv_bsale_id,
    nv.number AS nv_folio,
    
    det.bsale_id AS detail_id,
    det.variant_id,
    v.code AS sku,
    COALESCE(NULLIF(v.description, ''), p.name, 'Producto Desconocido') AS product_name,
    
    det.quantity,
    det.net_unit_value AS unit_value,
    det.total_amount
    
FROM integraciones.bsale_documents nv
JOIN integraciones.bsale_document_details det 
    ON nv.company_id = det.company_id AND nv.bsale_id = det.bsale_document_id
LEFT JOIN integraciones.bsale_variants v 
    ON det.company_id = v.company_id AND det.variant_id = v.bsale_id
LEFT JOIN integraciones.bsale_products p
    ON v.company_id = p.company_id AND v.bsale_product_id = p.bsale_id
WHERE nv.document_type_id = 23
  AND nv.state = 0;
