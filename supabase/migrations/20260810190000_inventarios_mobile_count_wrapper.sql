-- =========================================================================================
-- MIGRATION: M1.5B - Backend Contracts for Physical Count (Identified Products)
-- =========================================================================================

-- 1. Lookup Counting Product by Barcode
CREATE OR REPLACE FUNCTION inventarios.lookup_my_counting_product(
    p_zone_id pg_catalog.uuid,
    p_location_id pg_catalog.uuid,
    p_barcode text
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_actor_id pg_catalog.uuid;
    v_company_id pg_catalog.uuid;
    v_session_id pg_catalog.uuid;
    v_snapshot_id pg_catalog.uuid;
    v_task_id pg_catalog.uuid;
    v_task_status text;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
    v_matches pg_catalog.jsonb;
    v_match_count integer;
BEGIN
    IF p_barcode IS NULL OR pg_catalog.btrim(p_barcode) = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El código de barras es obligatorio.', 'retryable', false)::text;
    END IF;

    -- 1. Identity
    v_actor_id := inventarios.require_actor();

    -- 2. Authorization Context
    SELECT 
        z.company_id,
        t.id,
        s.id,
        s.snapshot_id,
        true
    INTO 
        v_company_id, 
        v_task_id, 
        v_session_id,
        v_snapshot_id,
        v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.functional_role = 'COUNTER'
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.status = 'IN_PROGRESS'
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;



    -- 3. Verify Location is OPEN for this task/actor
    SELECT true INTO v_is_open
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id
      AND tl.status = 'OPEN';

    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    -- 4. Lookup by exact barcode match
    SELECT 
        pg_catalog.coalesce(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'snapshot_product_id', sp.id,
                'product_id', sp.product_id,
                'sku', sp.sku,
                'barcode', sp.barcode,
                'name', sp.name
            ) ORDER BY sp.sku, sp.name, sp.id
        ), '[]'::jsonb),
        pg_catalog.count(*)
    INTO v_matches, v_match_count
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id
      AND sp.snapshot_id = v_snapshot_id
      AND sp.barcode = p_barcode;

    -- Return 0, 1, or N matches deterministically ordered
    RETURN pg_catalog.jsonb_build_object(
        'match_count', v_match_count,
        'matches', v_matches
    );
END;
$$;

ALTER FUNCTION inventarios.lookup_my_counting_product(pg_catalog.uuid, pg_catalog.uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.lookup_my_counting_product(pg_catalog.uuid, pg_catalog.uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.lookup_my_counting_product(pg_catalog.uuid, pg_catalog.uuid, text) TO authenticated;

-- 2. Submit Mobile Count Wrapper
CREATE OR REPLACE FUNCTION inventarios.submit_my_mobile_count(
    p_zone_id pg_catalog.uuid,
    p_location_id pg_catalog.uuid,
    p_snapshot_product_id pg_catalog.uuid,
    p_physical_quantity pg_catalog.numeric,
    p_identification_method text,
    p_scanned_code text,
    p_idempotency_key pg_catalog.uuid,
    p_captured_at timestamptz,
    p_device_id text
) RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_actor_id pg_catalog.uuid;
    v_company_id pg_catalog.uuid;
    v_session_id pg_catalog.uuid;
    v_snapshot_id pg_catalog.uuid;
    v_task_id pg_catalog.uuid;
    v_task_status text;
    v_task_cycle integer;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
    v_snapshot_location_id pg_catalog.uuid;
    v_quantities_payload pg_catalog.jsonb;
    v_actual_barcode text;
    v_actual_sku text;
BEGIN
    -- 0. Guardas Paramétricas Básicas
    IF p_device_id IS NULL OR pg_catalog.btrim(p_device_id) = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Device ID es obligatorio.', 'retryable', false)::text;
    END IF;

    IF p_identification_method IS NULL OR p_identification_method NOT IN ('BARCODE', 'SKU_MANUAL', 'SEARCH_MANUAL') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_IDENTIFICATION_METHOD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Método de identificación no soportado.', 'retryable', false)::text;
    END IF;

    IF p_identification_method IN ('BARCODE', 'SKU_MANUAL') AND (p_scanned_code IS NULL OR pg_catalog.btrim(p_scanned_code) = '') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El código escaneado es obligatorio para este método.', 'retryable', false)::text;
    END IF;

    -- 1. Identity
    v_actor_id := inventarios.require_actor();

    -- 2. Authorization Context
    SELECT 
        z.company_id,
        t.id,
        s.id,
        s.snapshot_id,
        t.validation_cycle,
        true
    INTO 
        v_company_id, 
        v_task_id, 
        v_session_id,
        v_snapshot_id,
        v_task_cycle,
        v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.functional_role = 'COUNTER'
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.status = 'IN_PROGRESS'
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;

    -- 3. Verify Location is OPEN for this task/actor & fetch snapshot_location_id
    SELECT true, szl.snapshot_location_id
    INTO v_is_open, v_snapshot_location_id
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id
      AND tl.status = 'OPEN';

    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    -- 4. Verify Product Consistency
    SELECT sp.barcode, sp.sku
    INTO v_actual_barcode, v_actual_sku
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id
      AND sp.snapshot_id = v_snapshot_id
      AND sp.id = p_snapshot_product_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_PRODUCT',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El producto no pertenece al inventario activo.', 'retryable', false)::text;
    END IF;

    IF p_identification_method = 'BARCODE' AND (v_actual_barcode IS NULL OR p_scanned_code <> v_actual_barcode) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_PRODUCT_IDENTITY_MISMATCH',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El barcode capturado no corresponde al producto seleccionado.', 'retryable', false)::text;
    END IF;

    IF p_identification_method = 'SKU_MANUAL' AND (v_actual_sku IS NULL OR p_scanned_code <> v_actual_sku) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_PRODUCT_IDENTITY_MISMATCH',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El SKU ingresado no corresponde al producto seleccionado.', 'retryable', false)::text;
    END IF;
    
    -- En SEARCH_MANUAL p_scanned_code puede ser null o cualquier string usado de busqueda.

    -- 5. Prepare Quantities Payload
    v_quantities_payload := pg_catalog.jsonb_build_object(
        'available_quantity', p_physical_quantity,
        'blocked_quantity', 0,
        'damaged_quantity', 0,
        'expired_quantity', 0,
        'other_unavailable_quantity', 0
    );

    -- 6. Delegate to core engine
    RETURN inventarios.record_inventory_count(
        v_company_id, 
        v_task_id, 
        v_task_cycle, 
        p_snapshot_product_id, 
        v_snapshot_location_id,
        v_quantities_payload, 
        p_identification_method, 
        p_scanned_code, 
        'MOBILE', -- capture_source hardcoded
        p_idempotency_key, -- offline_id delegating idempotency_key
        p_device_id, 
        p_captured_at, 
        p_idempotency_key -- core idempotency_key
    );
END;
$$;

ALTER FUNCTION inventarios.submit_my_mobile_count(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.numeric, text, text, pg_catalog.uuid, timestamptz, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.submit_my_mobile_count(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.numeric, text, text, pg_catalog.uuid, timestamptz, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.submit_my_mobile_count(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.numeric, text, text, pg_catalog.uuid, timestamptz, text) TO authenticated;
