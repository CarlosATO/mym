CREATE OR REPLACE FUNCTION logistica.authorize_sales_order_route_exception(
  p_company_id uuid,
  p_bsale_nv_id bigint,
  p_route_date date,
  p_reason text,
  p_observation text,
  p_authorized_by uuid,
  p_authorized_by_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_context record;
    v_nv record;
    v_exception_id uuid;
    v_card_id uuid;
    v_route_city_id uuid;
    v_normalized_city text;
BEGIN
    -- 1. Validaciones obligatorias
    IF p_company_id IS NULL OR p_bsale_nv_id IS NULL OR p_route_date IS NULL OR p_reason IS NULL OR p_authorized_by IS NULL THEN
        RAISE EXCEPTION 'Faltan parámetros obligatorios.';
    END IF;

    IF trim(p_reason) = '' THEN
        RAISE EXCEPTION 'El motivo no puede estar vacío.';
    END IF;

    IF p_observation IS NULL OR trim(p_observation) = '' THEN
        RAISE EXCEPTION 'La observación no puede estar vacía.';
    END IF;

    IF p_authorized_by_name IS NULL OR trim(p_authorized_by_name) = '' THEN
        RAISE EXCEPTION 'El nombre del autorizador no puede estar vacío.';
    END IF;

    -- 2. Validar que la NV NO TENGA TARJETA (Evita falsas excepciones)
    IF EXISTS (
        SELECT 1
        FROM logistica.sales_order_preparation_cards
        WHERE company_id = p_company_id
          AND bsale_nv_id = p_bsale_nv_id
    ) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'Ya existe una tarjeta de preparación para esta NV.',
            'status', 'already_exists'
        );
    END IF;

    -- 3. Obtener contexto de ruta
    SELECT * INTO v_context FROM logistica.get_next_dispatch_route_context(p_company_id);

    IF v_context.route_date IS NULL OR v_context.route_date != p_route_date THEN
        RAISE EXCEPTION 'La fecha de ruta provista no coincide con la ruta activa/próxima (%).', COALESCE(v_context.route_date::text, 'Ninguna');
    END IF;

    -- 4. Obtener info de NV
    SELECT nv.* INTO v_nv 
    FROM integraciones.vw_bsale_sales_orders_for_preparation nv
    WHERE nv.company_id = p_company_id AND nv.nv_bsale_id = p_bsale_nv_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Nota de venta % no encontrada en esta compañía.', p_bsale_nv_id;
    END IF;

    -- 5. Normalizar localidad y validar
    v_normalized_city := logistica.normalize_city(p_company_id, v_nv.route_location_raw);

    IF v_normalized_city IS NULL OR trim(v_normalized_city) = '' THEN
        RAISE EXCEPTION 'No se pudo normalizar la localidad de la NV (%).', COALESCE(v_nv.route_location_raw, 'NULL');
    END IF;

    IF NOT (v_normalized_city = ANY(v_context.normalized_cities)) THEN
        RAISE EXCEPTION 'La localidad de la NV (%) no pertenece a la ruta activa.', COALESCE(v_nv.route_location_raw, 'NULL');
    END IF;

    SELECT id INTO v_route_city_id FROM logistica.dispatch_cities 
    WHERE company_id = p_company_id AND name = v_normalized_city LIMIT 1;

    IF v_route_city_id IS NULL THEN
        RAISE EXCEPTION 'No se encontró route_city_id para la localidad normalizada %.', v_normalized_city;
    END IF;

    -- 6. Validar que realmente esté FUERA DE CORTE
    IF v_nv.nv_generation_date <= v_context.cutoff_at THEN
        RAISE EXCEPTION 'La NV no está fuera de corte. (Generada: %, Corte: %)', v_nv.nv_generation_date, v_context.cutoff_at;
    END IF;

    -- 7. Check de idempotencia (Excepción activa)
    IF EXISTS (
        SELECT 1 FROM logistica.sales_order_route_exceptions 
        WHERE company_id = p_company_id AND bsale_nv_id = p_bsale_nv_id AND route_date = p_route_date AND active = true
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Ya existe una excepción activa para esta NV y ruta.', 'status', 'already_exists');
    END IF;

    -- 8. Insertar Excepción
    INSERT INTO logistica.sales_order_route_exceptions (
        company_id, bsale_nv_id, nv_folio, route_date, route_city_id, 
        cutoff_at, reason, observation, authorized_by, authorized_by_name, 
        authorized_at, active
    ) VALUES (
        p_company_id, p_bsale_nv_id, v_nv.nv_folio::text, p_route_date, v_route_city_id, 
        v_context.cutoff_at, p_reason, p_observation, p_authorized_by, p_authorized_by_name, 
        now(), true
    ) RETURNING id INTO v_exception_id;

    -- 9. Insertar Tarjeta (Limpio, con DO NOTHING que revierte todo por el RAISE transaccional)
    INSERT INTO logistica.sales_order_preparation_cards (
        company_id, bsale_nv_id, bsale_nv_folio, status, 
        route_date, original_route_date, route_city_id, 
        route_location_normalized, normalized_city
    ) VALUES (
        p_company_id, p_bsale_nv_id, v_nv.nv_folio::text, 'PENDING_ROUTE_PREP',
        p_route_date, NULL, v_route_city_id, 
        v_normalized_city, 
        v_normalized_city
    )
    ON CONFLICT (company_id, bsale_nv_id) DO NOTHING
    RETURNING id INTO v_card_id;

    IF v_card_id IS NULL THEN
        RAISE EXCEPTION 'No se pudo crear la tarjeta de preparación; ya existe una tarjeta para esta NV.';
    END IF;

    -- 10. Insertar Route Event
    INSERT INTO logistica.sales_order_preparation_route_events (
        company_id, card_id, bsale_nv_id, event_type, 
        from_route_date, to_route_date, performed_by, metadata
    ) VALUES (
        p_company_id, v_card_id, p_bsale_nv_id, 'MATERIALIZED_EXCEPTION', 
        NULL, p_route_date, p_authorized_by, 
        jsonb_build_object(
            'source', 'AUTHORIZED_EXCEPTION',
            'reason', p_reason,
            'observation', p_observation,
            'authorized_by', p_authorized_by,
            'authorized_by_name', p_authorized_by_name,
            'exception_id', v_exception_id
        )
    ) ON CONFLICT (company_id, bsale_nv_id, event_type, to_route_date) DO NOTHING;

    RETURN jsonb_build_object(
        'ok', true,
        'exception_id', v_exception_id,
        'card_id', v_card_id,
        'bsale_nv_id', p_bsale_nv_id,
        'nv_folio', v_nv.nv_folio,
        'route_date', p_route_date,
        'status', 'PENDING_ROUTE_PREP',
        'event_type', 'MATERIALIZED_EXCEPTION'
    );
END;
$$;

REVOKE ALL ON FUNCTION logistica.authorize_sales_order_route_exception(uuid, bigint, date, text, text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION logistica.authorize_sales_order_route_exception(uuid, bigint, date, text, text, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION logistica.authorize_sales_order_route_exception(uuid, bigint, date, text, text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION logistica.authorize_sales_order_route_exception(uuid, bigint, date, text, text, uuid, text) TO service_role;
