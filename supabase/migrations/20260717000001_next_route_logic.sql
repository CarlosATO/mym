-- ============================================================================
-- Migración: Próxima Ruta Hábil, Corte y Excepciones (V5 FINAL)
-- Fecha: 2026-07-17
-- ============================================================================

-- 1. Agregar hora de corte por defecto a calendarios
ALTER TABLE logistica.dispatch_calendars 
ADD COLUMN IF NOT EXISTS default_cutoff_time time NOT NULL DEFAULT '12:00';

-- 2. Guardar historial de reprogramación de tarjetas
ALTER TABLE logistica.sales_order_preparation_cards
ADD COLUMN IF NOT EXISTS original_route_date date NULL;

-- 3. Tabla de Excepciones para NV fuera de corte
CREATE TABLE IF NOT EXISTS logistica.sales_order_route_exceptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    bsale_nv_id bigint NOT NULL,
    nv_folio text NOT NULL,
    route_date date NOT NULL,
    route_city_id uuid,
    cutoff_at timestamptz,
    reason text NOT NULL,
    observation text,
    authorized_by uuid NOT NULL,
    authorized_by_name text,
    authorized_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    active boolean NOT NULL DEFAULT true,
    UNIQUE(company_id, bsale_nv_id, route_date)
);

CREATE INDEX IF NOT EXISTS idx_sales_order_route_exceptions_company_route ON logistica.sales_order_route_exceptions(company_id, route_date);
CREATE INDEX IF NOT EXISTS idx_sales_order_route_exceptions_company_nv ON logistica.sales_order_route_exceptions(company_id, bsale_nv_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_route_exceptions_active ON logistica.sales_order_route_exceptions(company_id, active);

-- ============================================================================
-- 4. Funciones de Preview (Read-Only)
-- ============================================================================

-- Función para buscar la próxima ruta hábil
CREATE OR REPLACE FUNCTION logistica.get_next_dispatch_route_context(p_company_id uuid)
RETURNS TABLE (
    route_date date,
    route_weekday integer,
    cutoff_at timestamptz,
    calendar_id uuid,
    calendar_name text,
    normalized_cities text[]
) AS $$
DECLARE
    v_today_chile date := (now() AT TIME ZONE 'America/Santiago')::date;
    v_search_date date := v_today_chile + 1; -- Empezar mañana
    v_calendar_id uuid;
    v_calendar_name text;
    v_cutoff_time time;
    v_day_of_week integer;
    v_cities text[];
BEGIN
    SELECT id, name, default_cutoff_time 
    INTO v_calendar_id, v_calendar_name, v_cutoff_time
    FROM logistica.dispatch_calendars
    WHERE company_id = p_company_id AND active = true
    LIMIT 1;

    IF v_calendar_id IS NULL THEN
        RETURN;
    END IF;

    FOR i IN 0..30 LOOP
        v_day_of_week := EXTRACT(ISODOW FROM v_search_date);
        
        SELECT array_agg(DISTINCT normalized_city)
        INTO v_cities
        FROM logistica.dispatch_calendar_cities
        WHERE dispatch_calendar_cities.company_id = p_company_id 
          AND dispatch_calendar_cities.calendar_id = v_calendar_id
          AND dispatch_calendar_cities.weekday = v_day_of_week
          AND dispatch_calendar_cities.active = true;

        IF v_cities IS NOT NULL AND array_length(v_cities, 1) > 0 THEN
            RETURN QUERY SELECT 
                v_search_date AS route_date,
                v_day_of_week AS route_weekday,
                ((v_search_date - interval '1 day')::date || ' ' || v_cutoff_time::text || ' America/Santiago')::timestamptz AS cutoff_at,
                v_calendar_id AS calendar_id,
                v_calendar_name AS calendar_name,
                v_cities AS normalized_cities;
            RETURN;
        END IF;

        v_search_date := v_search_date + interval '1 day';
    END LOOP;

    RETURN;
END;
$$ LANGUAGE plpgsql STABLE;


-- Función para previsualizar los candidatos de la próxima ruta
CREATE OR REPLACE FUNCTION logistica.preview_next_route_candidates(
    p_company_id uuid,
    p_min_generation_date timestamptz DEFAULT '2026-07-14 00:00:00 America/Santiago'::timestamptz
)
RETURNS jsonb AS $$
DECLARE
    v_context record;
    v_cutoff_chile text;
    v_candidates jsonb;
    v_out_of_cutoff jsonb;
    v_authorized_exceptions jsonb;
    v_existing_cards jsonb;
    v_previous_pending jsonb;
BEGIN
    SELECT * INTO v_context FROM logistica.get_next_dispatch_route_context(p_company_id);

    IF v_context.route_date IS NULL THEN
        RETURN jsonb_build_object(
            'has_route', false
        );
    END IF;
    
    v_cutoff_chile := to_char(v_context.cutoff_at AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI');

    -- EXCEPCIONES AUTORIZADAS (Enriquecido con NV)
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'bsale_nv_id', nv.nv_bsale_id,
            'nv_folio', nv.nv_folio,
            'client_name', nv.client_name,
            'route_location_normalized', logistica.normalize_city(p_company_id, nv.route_location_raw),
            'route_city_id', exc.route_city_id,
            'seller_name', nv.seller_name,
            'nv_emission_date', nv.nv_emission_date,
            'nv_generation_date', nv.nv_generation_date,
            'nv_generation_date_chile', to_char(nv.nv_generation_date AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS'),
            'net_amount', nv.net_amount,
            'gross_amount', COALESCE(nv.gross_amount, nv.total_amount),
            'route_date', exc.route_date,
            'cutoff_at', exc.cutoff_at,
            'cutoff_at_chile', to_char(exc.cutoff_at AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI'),
            'reason', exc.reason,
            'observation', exc.observation,
            'authorized_by_name', exc.authorized_by_name,
            'authorized_at', exc.authorized_at,
            'inclusion_status', 'AUTHORIZED_EXCEPTION'
        )
    ), '[]'::jsonb)
    INTO v_authorized_exceptions
    FROM logistica.sales_order_route_exceptions exc
    LEFT JOIN integraciones.vw_bsale_sales_orders_for_preparation nv ON nv.nv_bsale_id = exc.bsale_nv_id AND nv.company_id = exc.company_id
    WHERE exc.company_id = p_company_id
      AND exc.route_date = v_context.route_date
      AND exc.active = true;

    -- ALREADY MATERIALIZED (existing_cards)
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'bsale_nv_id', nv.nv_bsale_id,
            'nv_folio', nv.nv_folio,
            'client_name', nv.client_name,
            'route_location_normalized', logistica.normalize_city(p_company_id, nv.route_location_raw),
            'route_city_id', c.route_city_id,
            'seller_name', nv.seller_name,
            'nv_emission_date', nv.nv_emission_date,
            'nv_generation_date', nv.nv_generation_date,
            'nv_generation_date_chile', to_char(nv.nv_generation_date AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS'),
            'net_amount', nv.net_amount,
            'gross_amount', COALESCE(nv.gross_amount, nv.total_amount),
            'route_date', c.route_date,
            'cutoff_at', v_context.cutoff_at,
            'cutoff_at_chile', v_cutoff_chile,
            'card_id', c.id,
            'card_status', c.status,
            'card_route_date', c.route_date,
            'original_route_date', c.original_route_date,
            'inclusion_status', 'ALREADY_MATERIALIZED'
        )
    ), '[]'::jsonb)
    INTO v_existing_cards
    FROM integraciones.vw_bsale_sales_orders_for_preparation nv
    JOIN logistica.sales_order_preparation_cards c 
      ON c.bsale_nv_id = nv.nv_bsale_id AND c.company_id = p_company_id
    WHERE nv.company_id = p_company_id
      AND c.route_date = v_context.route_date;

    -- PREVIOUS ROUTE PENDING (previous_pending)
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'bsale_nv_id', nv.nv_bsale_id,
            'nv_folio', nv.nv_folio,
            'client_name', nv.client_name,
            'route_location_normalized', logistica.normalize_city(p_company_id, nv.route_location_raw),
            'route_city_id', c.route_city_id,
            'seller_name', nv.seller_name,
            'nv_emission_date', nv.nv_emission_date,
            'nv_generation_date', nv.nv_generation_date,
            'nv_generation_date_chile', to_char(nv.nv_generation_date AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS'),
            'net_amount', nv.net_amount,
            'gross_amount', COALESCE(nv.gross_amount, nv.total_amount),
            'route_date', c.route_date,
            'cutoff_at', v_context.cutoff_at,
            'cutoff_at_chile', v_cutoff_chile,
            'card_id', c.id,
            'card_status', c.status,
            'card_route_date', c.route_date,
            'original_route_date', c.original_route_date,
            'inclusion_status', 'PREVIOUS_ROUTE_PENDING'
        )
    ), '[]'::jsonb)
    INTO v_previous_pending
    FROM integraciones.vw_bsale_sales_orders_for_preparation nv
    JOIN logistica.sales_order_preparation_cards c 
      ON c.bsale_nv_id = nv.nv_bsale_id AND c.company_id = p_company_id
    WHERE nv.company_id = p_company_id
      AND logistica.normalize_city(p_company_id, nv.route_location_raw) = ANY(v_context.normalized_cities)
      AND c.route_date < v_context.route_date
      AND c.status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT');

    -- IN_CUTOFF (candidatos automáticos)
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'bsale_nv_id', nv.nv_bsale_id,
            'nv_folio', nv.nv_folio,
            'client_name', nv.client_name,
            'route_location_normalized', logistica.normalize_city(p_company_id, nv.route_location_raw),
            'route_city_id', (SELECT id FROM logistica.dispatch_cities WHERE company_id = p_company_id AND name = logistica.normalize_city(p_company_id, nv.route_location_raw) LIMIT 1),
            'seller_name', nv.seller_name,
            'nv_emission_date', nv.nv_emission_date,
            'nv_generation_date', nv.nv_generation_date,
            'nv_generation_date_chile', to_char(nv.nv_generation_date AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS'),
            'net_amount', nv.net_amount,
            'gross_amount', COALESCE(nv.gross_amount, nv.total_amount),
            'route_date', v_context.route_date,
            'cutoff_at', v_context.cutoff_at,
            'cutoff_at_chile', v_cutoff_chile,
            'inclusion_status', 'IN_CUTOFF'
        )
    ), '[]'::jsonb)
    INTO v_candidates
    FROM integraciones.vw_bsale_sales_orders_for_preparation nv
    WHERE nv.company_id = p_company_id
      AND logistica.normalize_city(p_company_id, nv.route_location_raw) = ANY(v_context.normalized_cities)
      AND NOT EXISTS (
          SELECT 1 FROM logistica.sales_order_preparation_cards c
          WHERE c.bsale_nv_id = nv.nv_bsale_id AND c.company_id = p_company_id
      )
      AND NOT EXISTS (
          SELECT 1 FROM logistica.sales_order_route_exceptions exc
          WHERE exc.bsale_nv_id = nv.nv_bsale_id AND exc.company_id = p_company_id
            AND exc.route_date = v_context.route_date AND exc.active = true
      )
      AND nv.nv_generation_date >= p_min_generation_date
      AND nv.nv_generation_date <= v_context.cutoff_at;

    -- OUT_OF_CUTOFF (fuera de corte)
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'bsale_nv_id', nv.nv_bsale_id,
            'nv_folio', nv.nv_folio,
            'client_name', nv.client_name,
            'route_location_normalized', logistica.normalize_city(p_company_id, nv.route_location_raw),
            'route_city_id', (SELECT id FROM logistica.dispatch_cities WHERE company_id = p_company_id AND name = logistica.normalize_city(p_company_id, nv.route_location_raw) LIMIT 1),
            'seller_name', nv.seller_name,
            'nv_emission_date', nv.nv_emission_date,
            'nv_generation_date', nv.nv_generation_date,
            'nv_generation_date_chile', to_char(nv.nv_generation_date AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS'),
            'net_amount', nv.net_amount,
            'gross_amount', COALESCE(nv.gross_amount, nv.total_amount),
            'route_date', v_context.route_date,
            'cutoff_at', v_context.cutoff_at,
            'cutoff_at_chile', v_cutoff_chile,
            'inclusion_status', 'OUT_OF_CUTOFF'
        )
    ), '[]'::jsonb)
    INTO v_out_of_cutoff
    FROM integraciones.vw_bsale_sales_orders_for_preparation nv
    WHERE nv.company_id = p_company_id
      AND logistica.normalize_city(p_company_id, nv.route_location_raw) = ANY(v_context.normalized_cities)
      AND NOT EXISTS (
          SELECT 1 FROM logistica.sales_order_preparation_cards c
          WHERE c.bsale_nv_id = nv.nv_bsale_id AND c.company_id = p_company_id
      )
      AND NOT EXISTS (
          SELECT 1 FROM logistica.sales_order_route_exceptions exc
          WHERE exc.bsale_nv_id = nv.nv_bsale_id AND exc.company_id = p_company_id
            AND exc.route_date = v_context.route_date AND exc.active = true
      )
      AND nv.nv_generation_date >= p_min_generation_date
      AND nv.nv_generation_date > v_context.cutoff_at;

    -- Retornar el JSONB final
    RETURN jsonb_build_object(
        'has_route', true,
        'route_date', v_context.route_date,
        'route_weekday', v_context.route_weekday,
        'cutoff_at', v_context.cutoff_at,
        'cutoff_at_chile', v_cutoff_chile,
        'calendar_id', v_context.calendar_id,
        'calendar_name', v_context.calendar_name,
        'cities', v_context.normalized_cities,
        'counts', jsonb_build_object(
            'in_cutoff', jsonb_array_length(v_candidates),
            'out_cutoff', jsonb_array_length(v_out_of_cutoff),
            'exceptions', jsonb_array_length(v_authorized_exceptions),
            'existing_cards', jsonb_array_length(v_existing_cards),
            'previous_pending', jsonb_array_length(v_previous_pending)
        ),
        'candidates', v_candidates,
        'out_of_cutoff', v_out_of_cutoff,
        'authorized_exceptions', v_authorized_exceptions,
        'existing_cards', v_existing_cards,
        'previous_pending', v_previous_pending
    );
END;
$$ LANGUAGE plpgsql STABLE;
