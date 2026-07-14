-- ============================================================================
-- Migración: Corrección de Tipos en Preview de Candidatos a Ruta
-- Fecha: 2026-07-14
-- ============================================================================

-- 1. Actualizar función preview_sales_order_route_candidates
DROP FUNCTION IF EXISTS logistica.preview_sales_order_route_candidates(uuid, date, date, date, integer);
CREATE OR REPLACE FUNCTION logistica.preview_sales_order_route_candidates(
  p_company_id uuid,
  p_go_live_from_date date,
  p_route_from_date date,
  p_route_to_date date,
  p_limit integer DEFAULT NULL
)
RETURNS TABLE (
  nv_bsale_id bigint,
  nv_folio text,
  nv_emission_date date,
  client_bsale_id bigint,
  client_name text,
  nv_city_raw text,
  nv_municipality_raw text,
  client_city_raw text,
  client_municipality_raw text,
  route_location_raw text,
  route_location_normalized text,
  route_location_source text,
  route_city_id uuid,
  seller_name text,
  total_quantity numeric,
  total_amount numeric,
  route_date date,
  route_weekday int,
  route_label text,
  match_status text
) AS $$
BEGIN
    IF p_go_live_from_date IS NULL OR p_route_from_date IS NULL OR p_route_to_date IS NULL THEN
        RAISE EXCEPTION 'Fechas obligatorias: p_go_live_from_date, p_route_from_date, p_route_to_date';
    END IF;
    
    IF p_route_to_date < p_route_from_date THEN
        RAISE EXCEPTION 'p_route_to_date no puede ser menor a p_route_from_date';
    END IF;
    
    IF (p_route_to_date - p_route_from_date) > 6 THEN
        RAISE EXCEPTION 'La ventana de ruta no puede ser mayor a 7 dias';
    END IF;

    RETURN QUERY
    WITH base_nvs AS (
        SELECT 
            nv.nv_bsale_id::bigint,
            nv.nv_folio::text,
            nv.nv_emission_date,
            nv.client_bsale_id::bigint,
            nv.client_name,
            nv.nv_city_raw,
            nv.nv_municipality_raw,
            nv.client_city_raw,
            nv.client_municipality_raw,
            nv.route_location_raw,
            logistica.normalize_city(p_company_id, nv.route_location_raw) AS route_location_normalized,
            nv.route_location_source,
            COALESCE(
               (SELECT city_id FROM logistica.city_aliases ca WHERE ca.company_id = p_company_id AND lower(ca.raw_city) = lower(trim(nv.route_location_raw)) AND ca.active = true LIMIT 1),
               (SELECT id FROM logistica.dispatch_cities dc WHERE dc.company_id = p_company_id AND lower(dc.name) = lower(trim(nv.route_location_raw)) AND dc.active = true LIMIT 1)
            ) AS resolved_city_id,
            nv.seller_name,
            nv.total_quantity::numeric,
            nv.total_amount::numeric
        FROM integraciones.vw_bsale_sales_orders_for_preparation nv
        WHERE nv.company_id = p_company_id
          AND nv.nv_emission_date >= p_go_live_from_date
          -- Excluir materializadas
          AND NOT EXISTS (
              SELECT 1 FROM logistica.sales_order_preparation_cards c
              WHERE c.company_id = p_company_id AND c.bsale_nv_id = nv.nv_bsale_id
          )
    ),
    route_dates AS (
        SELECT generate_series(p_route_from_date, p_route_to_date, '1 day'::interval)::date AS r_date
    ),
    route_mapping AS (
        SELECT 
            rd.r_date,
            EXTRACT(ISODOW FROM rd.r_date)::int AS r_weekday,
            dcc.normalized_city,
            dcc.city_id,
            dcc.route_label
        FROM route_dates rd
        JOIN logistica.dispatch_calendar_cities dcc 
          ON dcc.company_id = p_company_id 
          AND dcc.active = true 
          AND dcc.weekday = EXTRACT(ISODOW FROM rd.r_date)
    )
    SELECT 
        b.nv_bsale_id,
        b.nv_folio,
        b.nv_emission_date,
        b.client_bsale_id,
        b.client_name,
        b.nv_city_raw,
        b.nv_municipality_raw,
        b.client_city_raw,
        b.client_municipality_raw,
        b.route_location_raw,
        b.route_location_normalized,
        b.route_location_source,
        b.resolved_city_id,
        b.seller_name,
        b.total_quantity,
        b.total_amount,
        rm.r_date AS route_date,
        rm.r_weekday AS route_weekday,
        rm.route_label,
        'MATCH'::text AS match_status
    FROM base_nvs b
    JOIN route_mapping rm 
      ON (b.resolved_city_id IS NOT NULL AND b.resolved_city_id = rm.city_id)
      OR (b.resolved_city_id IS NULL AND b.route_location_normalized = rm.normalized_city)
    ORDER BY rm.r_date, b.route_location_normalized, b.nv_emission_date
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- 2. Aseguramos que la función de materialización siga sin errores de tipos al leer de la nueva definicion
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
            route_location_raw,
            route_location_normalized,
            route_location_source,
            route_city_id
        )
        SELECT 
            p_company_id,
            c.nv_bsale_id,
            c.nv_folio,
            c.nv_city_raw,          -- compatibility
            c.nv_municipality_raw,  -- compatibility
            c.route_location_normalized, -- compatibility
            'PENDING_ROUTE_PREP',
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

-- 3. Grants
GRANT EXECUTE ON FUNCTION logistica.preview_sales_order_route_candidates TO service_role;
GRANT EXECUTE ON FUNCTION logistica.sync_sales_order_preparation_cards_for_route TO service_role;

REVOKE EXECUTE ON FUNCTION logistica.sync_sales_order_preparation_cards_for_route FROM authenticated;
REVOKE EXECUTE ON FUNCTION logistica.sync_sales_order_preparation_cards FROM authenticated;
REVOKE EXECUTE ON FUNCTION logistica.sync_sales_order_preparation_cards_for_route FROM PUBLIC;
