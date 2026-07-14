-- ============================================================================
-- Migración: Fix route_date en sync_sales_order_preparation_cards_for_route
-- Fecha: 2026-07-15
-- ============================================================================
-- El INSERT original no mapeaba route_date ni route_location_normalized
-- desde el preview hacia la tabla sales_order_preparation_cards.
-- Columnas confirmadas en la tabla (route_weekday y route_label NO existen):
--   route_date, route_location_raw, route_location_normalized,
--   route_location_source, route_city_id

-- 1. Reemplazar función con mapeo correcto de route_date
CREATE OR REPLACE FUNCTION logistica.sync_sales_order_preparation_cards_for_route(
  p_company_id uuid,
  p_go_live_from_date date,
  p_route_from_date date,
  p_route_to_date date,
  p_limit integer DEFAULT NULL
)
RETURNS integer AS $$
DECLARE
    v_inserted_count integer;
BEGIN
    -- Utilizar el preview para garantizar misma logica de matcheo
    WITH candidates AS (
        SELECT *
        FROM logistica.preview_sales_order_route_candidates(
            p_company_id,
            p_go_live_from_date,
            p_route_from_date,
            p_route_to_date,
            p_limit
        )
    ),
    inserted AS (
        INSERT INTO logistica.sales_order_preparation_cards (
            company_id,
            bsale_nv_id,
            bsale_nv_folio,
            raw_city,
            raw_municipality,
            normalized_city,
            status,
            route_date,
            route_location_raw,
            route_location_normalized,
            route_location_source,
            route_city_id
        )
        SELECT
            p_company_id,
            c.nv_bsale_id,
            c.nv_folio,
            c.nv_city_raw,                   -- raw_city compatibility
            c.nv_municipality_raw,           -- raw_municipality compatibility
            c.route_location_normalized,     -- normalized_city compatibility
            'PENDING_ROUTE_PREP',
            c.route_date,                    -- FIX: ahora se mapea correctamente
            c.route_location_raw,
            c.route_location_normalized,
            c.route_location_source,
            c.route_city_id
        FROM candidates c
        ON CONFLICT (company_id, bsale_nv_id) DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO v_inserted_count FROM inserted;

    RETURN v_inserted_count;
END;
$$ LANGUAGE plpgsql;

-- 2. Grants (mantener igual que migración anterior)
GRANT EXECUTE ON FUNCTION logistica.sync_sales_order_preparation_cards_for_route TO service_role;
REVOKE EXECUTE ON FUNCTION logistica.sync_sales_order_preparation_cards_for_route FROM authenticated;
REVOKE EXECUTE ON FUNCTION logistica.sync_sales_order_preparation_cards_for_route FROM PUBLIC;

-- 3. Backfill controlado: corregir las 4 tarjetas de prueba de Talca
-- Solo afecta folios 3496, 3497, 3498, 3499 con route_date null y status PENDING_ROUTE_PREP
UPDATE logistica.sales_order_preparation_cards
SET
    route_date = '2026-07-15'::date,
    updated_at = now()
WHERE
    company_id = 'd1000000-0000-0000-0000-000000000001'
    AND bsale_nv_folio IN ('3496', '3497', '3498', '3499')
    AND status = 'PENDING_ROUTE_PREP'
    AND route_location_normalized = 'Talca'
    AND route_date IS NULL;
