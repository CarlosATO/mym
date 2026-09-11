-- ============================================================================
-- Hardening y Coherencia de Preparación de Pedidos
-- ============================================================================

-- 1. Hardening RLS para Preparation Cards y Movements
DROP POLICY IF EXISTS "Allow read for authenticated on prep_cards" ON logistica.sales_order_preparation_cards;
DROP POLICY IF EXISTS "Allow read for authenticated on prep_movements" ON logistica.sales_order_preparation_movements;

CREATE POLICY "Logistica prep_cards read access for company users"
ON logistica.sales_order_preparation_cards
FOR SELECT TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM core.user_company_access uca
        WHERE uca.user_id = auth.uid()
        AND uca.company_id = sales_order_preparation_cards.company_id
        AND uca.is_active = true
    )
);

CREATE POLICY "Logistica prep_movements read access for company users"
ON logistica.sales_order_preparation_movements
FOR SELECT TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM core.user_company_access uca
        WHERE uca.user_id = auth.uid()
        AND uca.company_id = sales_order_preparation_movements.company_id
        AND uca.is_active = true
    )
);

-- 2. Corregir vw_bsale_sales_orders_for_preparation para state = 0
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
WHERE nv.document_type_id = 23
  AND nv.state = 0;

ALTER VIEW integraciones.vw_bsale_sales_orders_for_preparation SET (security_invoker = true);
ALTER VIEW logistica.vw_sales_order_preparation_board SET (security_invoker = true);
ALTER VIEW integraciones.vw_bsale_sales_order_items_for_preparation SET (security_invoker = true);

-- 3. Automatización de cancelación en tarjetas logísticas cuando la NV pasa a inactiva
CREATE OR REPLACE FUNCTION logistica.cancel_preparation_card_on_nv_cancellation()
RETURNS TRIGGER AS $$
BEGIN
    -- Si es documento 23 (NV) y pasa de activo (state 0) a anulado (state 1)
    IF NEW.document_type_id = 23 AND NEW.state = 1 AND OLD.state = 0 THEN
        UPDATE logistica.sales_order_preparation_cards
        SET status = 'CANCELLED',
            cancellation_reason = 'NV_BSALE_ANULADA',
            updated_at = now()
        WHERE company_id = NEW.company_id 
          AND bsale_nv_id = NEW.bsale_id
          AND status = 'PENDING_ROUTE_PREP';
          -- Conservador: NO cancelar automáticamente operaciones humanas si está en IN_PREPARATION o IN_AUDIT
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_cancel_preparation_card ON integraciones.bsale_documents;
CREATE TRIGGER trg_cancel_preparation_card
AFTER UPDATE OF state ON integraciones.bsale_documents
FOR EACH ROW
EXECUTE FUNCTION logistica.cancel_preparation_card_on_nv_cancellation();
