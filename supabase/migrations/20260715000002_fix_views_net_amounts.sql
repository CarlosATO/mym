-- ============================================================================
-- Fix Montos Netos y Brutos explícitos preservando total_amount legacy
-- ============================================================================

-- 1. Vista Principal Kanban (Orders)
-- Agregamos las nuevas columnas al final para evitar romper dependencias
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
    
    nv.total_amount, -- LEGACY COMPATIBILITY
    
    (SELECT COUNT(d.id) FROM integraciones.bsale_document_details d WHERE d.bsale_document_id = nv.bsale_id) AS products_count,
    (SELECT SUM(d.quantity) FROM integraciones.bsale_document_details d WHERE d.bsale_document_id = nv.bsale_id) AS total_quantity,
    
    f_ref.bsale_document_id AS invoice_bsale_id,
    f_ref.source_document_number AS invoice_folio,
    f_doc.emission_date AS invoice_emission_date,
    (f_ref.bsale_document_id IS NOT NULL) AS is_invoiced,
    
    -- COLUMNAS RUTA DE LA MIGRACION 20260714000002
    nv.client_id AS client_bsale_id,
    nv.raw_json->>'city' AS nv_city_raw,
    nv.raw_json->>'municipality' AS nv_municipality_raw,
    c.city AS client_city_raw,
    c.commune AS client_municipality_raw,

    CASE
      WHEN c.commune IS NOT NULL AND trim(c.commune) <> '' THEN trim(c.commune)
      WHEN nv.raw_json->>'municipality' IS NOT NULL AND trim(nv.raw_json->>'municipality') <> '' THEN trim(nv.raw_json->>'municipality')
      WHEN c.city IS NOT NULL AND trim(c.city) <> '' THEN trim(c.city)
      WHEN nv.raw_json->>'city' IS NOT NULL AND trim(nv.raw_json->>'city') <> '' THEN trim(nv.raw_json->>'city')
      ELSE 'SIN COMUNA'
    END AS route_location_raw,
    
    CASE
      WHEN c.commune IS NOT NULL AND trim(c.commune) <> '' THEN 'CLIENT_MUNICIPALITY'
      WHEN nv.raw_json->>'municipality' IS NOT NULL AND trim(nv.raw_json->>'municipality') <> '' THEN 'NV_MUNICIPALITY'
      WHEN c.city IS NOT NULL AND trim(c.city) <> '' THEN 'CLIENT_CITY'
      WHEN nv.raw_json->>'city' IS NOT NULL AND trim(nv.raw_json->>'city') <> '' THEN 'NV_CITY'
      ELSE 'UNKNOWN'
    END AS route_location_source,
    
    -- Montos Explícitos Nuevos al final
    nv.net_amount,
    nv.tax_amount,
    nv.total_amount AS gross_amount
    
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


-- 2. Vista Lectura Tablero (Board)
-- Agregamos las nuevas columnas al final
CREATE OR REPLACE VIEW logistica.vw_sales_order_preparation_board AS
SELECT 
    c.id AS card_id,
    c.company_id,
    c.status,
    c.priority,
    c.assigned_user_id,
    c.route_date,
    c.normalized_city,
    
    nv.nv_bsale_id,
    nv.nv_folio,
    nv.nv_emission_date,
    nv.nv_generation_date,
    
    nv.client_name,
    nv.city_raw,
    nv.municipality_raw,
    nv.address_raw,
    
    nv.seller_bsale_id,
    nv.seller_name,
    nv.total_quantity,
    nv.total_amount, -- LEGACY COMPATIBILITY
    
    nv.invoice_folio,
    nv.is_invoiced,
    
    c.created_at,
    c.updated_at,
    
    -- Montos Explícitos Nuevos al final
    nv.net_amount,
    nv.tax_amount,
    nv.gross_amount
    
FROM logistica.sales_order_preparation_cards c
JOIN integraciones.vw_bsale_sales_orders_for_preparation nv 
  ON c.company_id = nv.company_id AND c.bsale_nv_id = nv.nv_bsale_id;


-- 3. Vista Detalles Kanban (Items)
-- Agregamos las nuevas columnas al final
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_order_items_for_preparation AS
SELECT
    nv.company_id,
    nv.bsale_id AS nv_bsale_id,
    nv.number AS nv_folio,
    
    det.bsale_id AS detail_id,
    det.variant_id,
    v.code AS sku,
    
    -- Mantener lógica de nombres de la migración previa 01
    CASE 
        WHEN NULLIF(TRIM(v.description), '') IS NULL THEN COALESCE(NULLIF(TRIM(p.name), ''), 'Producto Desconocido')
        WHEN NULLIF(TRIM(p.name), '') IS NULL THEN COALESCE(NULLIF(TRIM(v.description), ''), 'Producto Desconocido')
        WHEN TRIM(LOWER(v.description)) = TRIM(LOWER(p.name)) THEN TRIM(p.name)
        ELSE TRIM(CONCAT(p.name, ' ', v.description))
    END AS product_name,
    
    det.quantity,
    det.net_unit_value AS unit_value, -- LEGACY COMPATIBILITY
    det.total_amount, -- LEGACY COMPATIBILITY
    
    -- Montos Explícitos Nuevos al final
    det.net_unit_value AS unit_net_value,
    det.net_amount AS line_net_amount,
    det.tax_amount AS line_tax_amount,
    det.total_amount AS line_gross_amount
    
FROM integraciones.bsale_documents nv
JOIN integraciones.bsale_document_details det 
    ON nv.company_id = det.company_id AND nv.bsale_id = det.bsale_document_id
LEFT JOIN integraciones.bsale_variants v 
    ON det.company_id = v.company_id AND det.variant_id = v.bsale_id
LEFT JOIN integraciones.bsale_products p
    ON v.company_id = p.company_id AND v.bsale_product_id = p.bsale_id
WHERE nv.document_type_id = 23
  AND nv.state = 0;
