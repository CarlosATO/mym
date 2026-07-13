-- ============================================================================
-- 1. Extender integraciones.bsale_document_references
-- ============================================================================
ALTER TABLE integraciones.bsale_document_references
    ADD COLUMN IF NOT EXISTS source_document_type_id bigint,
    ADD COLUMN IF NOT EXISTS source_document_number text;

CREATE INDEX IF NOT EXISTS idx_bsale_doc_ref_source_type 
    ON integraciones.bsale_document_references(company_id, source_document_type_id);

-- ============================================================================
-- 2. Crear integraciones.bsale_sellers
-- ============================================================================
CREATE TABLE IF NOT EXISTS integraciones.bsale_sellers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id),
    bsale_id int NOT NULL,
    name text,
    email text,
    active boolean,
    raw_json jsonb NOT NULL DEFAULT '{}',
    synced_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

CREATE INDEX IF NOT EXISTS idx_bsale_sellers_company ON integraciones.bsale_sellers(company_id, bsale_id);

ALTER TABLE integraciones.bsale_sellers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read access for authenticated users on bsale_sellers"
ON integraciones.bsale_sellers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow all access for service role on bsale_sellers"
ON integraciones.bsale_sellers FOR ALL TO service_role USING (true);

-- ============================================================================
-- 3. Vista Principal Kanban: vw_bsale_sales_orders_for_preparation
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
    
    CAST(nv.raw_json->'seller'->>'id' AS int) AS seller_bsale_id,
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
    ON nv.company_id = s.company_id AND CAST(nv.raw_json->'seller'->>'id' AS int) = s.bsale_id
LEFT JOIN integraciones.bsale_document_references f_ref 
    ON nv.company_id = f_ref.company_id 
    AND nv.bsale_id = f_ref.referenced_document_id
    AND f_ref.source_document_type_id = 5
LEFT JOIN integraciones.bsale_documents f_doc
    ON f_ref.company_id = f_doc.company_id AND f_ref.bsale_document_id = f_doc.bsale_id
WHERE nv.document_type_id = 23;

-- ============================================================================
-- 4. Vista Detalles Kanban: vw_bsale_sales_order_items_for_preparation
-- ============================================================================
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_order_items_for_preparation AS
SELECT 
    nv.company_id,
    nv.bsale_id AS nv_bsale_id,
    nv.number AS nv_folio,
    
    det.bsale_id AS detail_id,
    det.variant_id,
    v.code AS sku,
    v.description AS product_name,
    
    det.quantity,
    det.net_unit_value AS unit_value,
    det.total_amount
    
FROM integraciones.bsale_documents nv
JOIN integraciones.bsale_document_details det 
    ON nv.company_id = det.company_id AND nv.bsale_id = det.bsale_document_id
LEFT JOIN integraciones.bsale_variants v 
    ON det.company_id = v.company_id AND det.variant_id = v.bsale_id
WHERE nv.document_type_id = 23;

-- Permisos
GRANT SELECT ON integraciones.vw_bsale_sales_orders_for_preparation TO authenticated, service_role;
GRANT SELECT ON integraciones.vw_bsale_sales_order_items_for_preparation TO authenticated, service_role;
