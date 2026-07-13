-- ============================================================================
-- Fix Vista Principal Kanban: vw_bsale_sales_orders_for_preparation (Seller Join Fix)
-- ============================================================================
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_orders_for_preparation AS
SELECT 
    nv.company_id,
    nv.bsale_id AS nv_bsale_id,
    nv.number AS nv_folio,
    nv.emission_date AS nv_emission_date,
    nv.generation_date AS nv_generation_date,
    
    nv.client_id,
    c.company AS client_name,
    c.code AS client_rut,
    
    nv.raw_json->>'city' AS city_raw,
    nv.raw_json->>'municipality' AS municipality_raw,
    nv.raw_json->>'address' AS address_raw,
    
    CAST(nv.raw_json->'user'->>'id' AS int) AS seller_bsale_id,
    s.name AS seller_name,
    
    nv.total_amount,
    
    -- Subquery for quantities
    (SELECT COUNT(d.id) FROM integraciones.bsale_document_details d WHERE d.bsale_document_id = nv.bsale_id) AS products_count,
    (SELECT SUM(d.quantity) FROM integraciones.bsale_document_details d WHERE d.bsale_document_id = nv.bsale_id) AS total_quantity,
    
    -- Invoiced detection (Factura Tipo 5 -> NV Tipo 23)
    f_ref.bsale_document_id AS invoice_bsale_id,
    f_ref.source_document_number AS invoice_folio,
    f_doc.emission_date AS invoice_emission_date,
    (f_ref.bsale_document_id IS NOT NULL) AS is_invoiced
    
FROM integraciones.bsale_documents nv
LEFT JOIN integraciones.bsale_clients c 
    ON nv.company_id = c.company_id AND nv.client_id = c.bsale_client_id
LEFT JOIN integraciones.bsale_sellers s 
    ON nv.company_id = s.company_id AND CAST(nv.raw_json->'user'->>'id' AS int) = s.bsale_id
LEFT JOIN integraciones.bsale_document_references f_ref 
    ON nv.company_id = f_ref.company_id 
    AND nv.bsale_id = f_ref.referenced_document_id
    AND f_ref.source_document_type_id = 5
LEFT JOIN integraciones.bsale_documents f_doc
    ON f_ref.company_id = f_doc.company_id AND f_ref.bsale_document_id = f_doc.bsale_id
WHERE nv.document_type_id = 23;
