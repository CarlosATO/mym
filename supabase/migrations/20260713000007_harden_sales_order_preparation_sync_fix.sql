-- ============================================================================
-- Migración: Endurecimiento de la Función de Sincronización de Preparación
-- Fecha: 2026-07-13
-- ============================================================================

-- 1. Eliminar la versión anterior para limpiar la firma
DROP FUNCTION IF EXISTS logistica.sync_sales_order_preparation_cards(uuid);

-- 2. Crear nueva función estricta con rango de fechas y retorno de contador
CREATE OR REPLACE FUNCTION logistica.sync_sales_order_preparation_cards(
  p_company_id uuid,
  p_from_date date,
  p_to_date date,
  p_limit integer DEFAULT NULL
) RETURNS integer AS $$
DECLARE
    v_inserted_count integer;
BEGIN
    -- Validaciones de seguridad
    IF p_from_date IS NULL OR p_to_date IS NULL THEN
        RAISE EXCEPTION 'p_from_date y p_to_date son obligatorios';
    END IF;

    IF p_to_date < p_from_date THEN
        RAISE EXCEPTION 'p_to_date no puede ser menor que p_from_date';
    END IF;

    WITH inserted AS (
        INSERT INTO logistica.sales_order_preparation_cards (
            company_id,
            bsale_nv_id,
            bsale_nv_folio,
            raw_city,
            raw_municipality,
            normalized_city,
            status
        )
        SELECT 
            nv.company_id,
            nv.nv_bsale_id,
            nv.nv_folio::text,
            nv.city_raw,
            nv.municipality_raw,
            logistica.normalize_city(nv.company_id, nv.city_raw),
            'PENDING_ROUTE_PREP'
        FROM integraciones.vw_bsale_sales_orders_for_preparation nv
        WHERE nv.company_id = p_company_id
          AND nv.nv_emission_date::date >= p_from_date
          AND nv.nv_emission_date::date <= p_to_date
        LIMIT p_limit
        ON CONFLICT (company_id, bsale_nv_id) DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO v_inserted_count FROM inserted;

    RETURN v_inserted_count;
END;
$$ LANGUAGE plpgsql;

-- 3. Crear función de preview segura (Read-only)
CREATE OR REPLACE FUNCTION logistica.preview_sales_order_preparation_candidates(
  p_company_id uuid,
  p_from_date date,
  p_to_date date
) RETURNS TABLE (
  total_candidates bigint,
  already_materialized bigint,
  pending_to_create bigint
) AS $$
BEGIN
    -- Validaciones de seguridad
    IF p_from_date IS NULL OR p_to_date IS NULL THEN
        RAISE EXCEPTION 'p_from_date y p_to_date son obligatorios';
    END IF;

    IF p_to_date < p_from_date THEN
        RAISE EXCEPTION 'p_to_date no puede ser menor que p_from_date';
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT nv.nv_bsale_id
        FROM integraciones.vw_bsale_sales_orders_for_preparation nv
        WHERE nv.company_id = p_company_id
          AND nv.nv_emission_date::date >= p_from_date
          AND nv.nv_emission_date::date <= p_to_date
    ),
    materialized AS (
        SELECT c.bsale_nv_id
        FROM logistica.sales_order_preparation_cards c
        JOIN candidates can ON c.bsale_nv_id = can.nv_bsale_id
        WHERE c.company_id = p_company_id
    )
    SELECT 
        (SELECT count(*) FROM candidates) AS total_candidates,
        (SELECT count(*) FROM materialized) AS already_materialized,
        (SELECT count(*) FROM candidates) - (SELECT count(*) FROM materialized) AS pending_to_create;
END;
$$ LANGUAGE plpgsql STABLE;

-- Otorgar permisos a la función
GRANT EXECUTE ON FUNCTION logistica.sync_sales_order_preparation_cards TO service_role;
GRANT EXECUTE ON FUNCTION logistica.preview_sales_order_preparation_candidates TO service_role;
