-- Migration: 20260803086000_inventarios_phase_04g3c_record_counting_guard.sql
-- Description: Fase 4G.3c. Guarda de sesion COUNTING en record_inventory_count.
--              La RPC ya valida tarea IN_PROGRESS y participante COUNTER, pero no
--              validaba el estado de la jornada. Se agrega require_session_counting.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.record_inventory_count(
    p_company_id uuid,
    p_task_id uuid,
    p_expected_cycle integer,
    p_snapshot_product_id uuid,
    p_snapshot_location_id uuid,
    p_quantities jsonb,
    p_identification_method text,
    p_scanned_code text,
    p_capture_source text,
    p_offline_id uuid,
    p_device_id text,
    p_captured_at timestamptz,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_participant_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_session_id uuid;
    v_session_zone_id uuid;
    v_snapshot_id uuid;
    v_status text;
    v_cycle integer;
    v_cancelled_at timestamptz;
    v_cancelled_by uuid;
    v_current_assignment_id uuid;
    v_active_user_id uuid;
    v_assignment_id uuid;
    v_assignment_user_id uuid;
    v_bsale_variant_id integer;
    v_phys_qty numeric(14,3);
    v_avail_qty numeric(14,3);
    v_damaged_qty numeric(14,3);
    v_expired_qty numeric(14,3);
    v_blocked_qty numeric(14,3);
    v_other_qty numeric(14,3);
    v_identification_method text;
    v_scanned_code text;
    v_capture_source text;
    v_device_id text;
    v_occurred_at timestamptz;
    v_captured_at timestamptz;
    v_count_entry_id uuid;
    v_payload jsonb;
    v_response jsonb;
    v_keys text[];
    v_qty_keys text[] := ARRAY['available_quantity','blocked_quantity','damaged_quantity','expired_quantity','other_unavailable_quantity'];
    v_key text;
    v_val numeric;
    v_offline_exists bigint;
    v_count_keys integer;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL
       OR p_expected_cycle IS NULL OR p_expected_cycle < 1
       OR p_snapshot_product_id IS NULL OR p_snapshot_location_id IS NULL
       OR p_quantities IS NULL
       OR p_identification_method IS NULL
       OR p_capture_source IS NULL
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_identification_method := pg_catalog.btrim(p_identification_method);
    v_capture_source := pg_catalog.btrim(p_capture_source);
    IF v_identification_method = '' OR v_capture_source = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    IF v_capture_source NOT IN ('MOBILE', 'WEB') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    IF p_scanned_code IS NOT NULL THEN
        v_scanned_code := pg_catalog.btrim(p_scanned_code);
        IF v_scanned_code = '' THEN v_scanned_code := NULL; END IF;
    END IF;
    IF p_device_id IS NOT NULL THEN
        v_device_id := pg_catalog.btrim(p_device_id);
        IF v_device_id = '' THEN v_device_id := NULL; END IF;
    END IF;

    IF v_capture_source = 'MOBILE' THEN
        IF p_offline_id IS NULL OR v_device_id IS NULL OR p_captured_at IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
        IF p_idempotency_key IS DISTINCT FROM p_offline_id THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
    END IF;

    IF pg_catalog.jsonb_typeof(p_quantities) <> 'object' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_keys := ARRAY(SELECT pg_catalog.jsonb_object_keys(p_quantities) ORDER BY 1);
    v_count_keys := pg_catalog.array_length(v_keys, 1);
    IF v_count_keys IS DISTINCT FROM 5 OR v_keys <> v_qty_keys THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    FOREACH v_key IN ARRAY v_qty_keys LOOP
        IF pg_catalog.jsonb_typeof(p_quantities -> v_key) <> 'number' THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
        v_val := (p_quantities ->> v_key)::numeric;
        IF v_val < 0 OR v_val > 99999999999.999 THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
        CASE v_key
            WHEN 'available_quantity' THEN v_avail_qty := v_val;
            WHEN 'damaged_quantity' THEN v_damaged_qty := v_val;
            WHEN 'expired_quantity' THEN v_expired_qty := v_val;
            WHEN 'blocked_quantity' THEN v_blocked_qty := v_val;
            WHEN 'other_unavailable_quantity' THEN v_other_qty := v_val;
        END CASE;
    END LOOP;
    v_phys_qty := v_avail_qty + v_damaged_qty + v_expired_qty + v_blocked_qty + v_other_qty;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.counts.record');

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.record_inventory_count'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_idempotency_key::text)
    );

    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.count.record',
        'company_id', p_company_id,
        'task_id', p_task_id,
        'expected_cycle', p_expected_cycle,
        'snapshot_product_id', p_snapshot_product_id,
        'snapshot_location_id', p_snapshot_location_id,
        'quantities', p_quantities,
        'identification_method', v_identification_method,
        'scanned_code', v_scanned_code,
        'capture_source', v_capture_source,
        'offline_id', p_offline_id,
        'device_id', v_device_id,
        'captured_at', p_captured_at
    );

    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,
        'inventarios.count.record',
        p_idempotency_key,
        inventarios.compute_request_hash(v_payload)
    );

    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;

    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT t.session_id, t.session_zone_id, t.status, t.validation_cycle,
           t.cancelled_at, t.cancelled_by, t.current_assignment_id, t.active_user_id
    INTO v_session_id, v_session_zone_id, v_status, v_cycle,
         v_cancelled_at, v_cancelled_by, v_current_assignment_id, v_active_user_id
    FROM inventarios.tasks AS t
    WHERE t.company_id = p_company_id AND t.id = p_task_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    PERFORM inventarios.require_session_counting(p_company_id, v_session_id);

    IF v_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_TASK_INVALID_STATE',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea no permite esta operacion en su estado actual.', 'retryable', false)::text;
    END IF;

    IF v_cycle <> p_expected_cycle THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea fue modificada por otra operacion.', 'retryable', true)::text;
    END IF;

    IF v_cancelled_at IS NOT NULL OR v_cancelled_by IS NOT NULL THEN
        IF v_cancelled_at IS NULL OR v_cancelled_by IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
                DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea fue modificada por otra operacion.', 'retryable', true)::text;
        END IF;
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_TASK_ALREADY_CANCELLED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea ya fue cancelada.', 'retryable', false)::text;
    END IF;

    IF v_current_assignment_id IS NULL OR v_active_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
    END IF;

    v_participant_id := inventarios.require_session_participant(p_company_id, v_session_id, 'COUNTER');

    SELECT ta.id, ta.user_id
    INTO v_assignment_id, v_assignment_user_id
    FROM inventarios.task_assignments AS ta
    WHERE ta.company_id = p_company_id
      AND ta.session_id = v_session_id
      AND ta.task_id = p_task_id
      AND ta.id = v_current_assignment_id
      AND ta.released_at IS NULL
    FOR SHARE;

    IF NOT FOUND OR v_assignment_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
    END IF;

    IF v_assignment_user_id IS DISTINCT FROM v_actor_id
       OR v_active_user_id IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ASSIGNMENT_REQUIRED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes una asignacion vigente para esta tarea.', 'retryable', false)::text;
    END IF;

    SELECT sz.snapshot_id INTO v_snapshot_id
    FROM inventarios.session_zones AS sz
    WHERE sz.company_id = p_company_id
      AND sz.session_id = v_session_id
      AND sz.id = v_session_zone_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    SELECT sp.bsale_variant_id INTO v_bsale_variant_id
    FROM inventarios.snapshot_products AS sp
    WHERE sp.company_id = p_company_id
      AND sp.snapshot_id = v_snapshot_id
      AND sp.id = p_snapshot_product_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    PERFORM 1
    FROM inventarios.session_zone_locations AS szl
    WHERE szl.company_id = p_company_id
      AND szl.session_id = v_session_id
      AND szl.snapshot_id = v_snapshot_id
      AND szl.session_zone_id = v_session_zone_id
      AND szl.snapshot_location_id = p_snapshot_location_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    IF p_offline_id IS NOT NULL THEN
        SELECT pg_catalog.count(*) INTO v_offline_exists
        FROM inventarios.count_entries AS ce
        WHERE ce.company_id = p_company_id AND ce.offline_id = p_offline_id;
        IF v_offline_exists > 0 THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_OFFLINE_CAPTURE_CONFLICT',
                DETAIL = pg_catalog.jsonb_build_object('message', 'La captura offline ya fue registrada.', 'retryable', false)::text;
        END IF;
    END IF;

    v_occurred_at := pg_catalog.now();
    v_captured_at := pg_catalog.coalesce(p_captured_at, v_occurred_at);

    INSERT INTO inventarios.count_entries AS ce (
        company_id, session_id, snapshot_id, session_zone_id, task_id,
        task_cycle, session_participant_id, counted_by,
        snapshot_product_id, snapshot_location_id, bsale_variant_id,
        identification_method, scanned_code, capture_source,
        offline_id, device_id, captured_at, server_received_at,
        synced_at, synced_by,
        physical_quantity,
        available_quantity, damaged_quantity, expired_quantity,
        blocked_quantity, other_unavailable_quantity,
        created_by
    ) VALUES (
        p_company_id, v_session_id, v_snapshot_id, v_session_zone_id, p_task_id,
        v_cycle, v_participant_id, v_actor_id,
        p_snapshot_product_id, p_snapshot_location_id, v_bsale_variant_id,
        v_identification_method, v_scanned_code, v_capture_source,
        p_offline_id, v_device_id, v_captured_at, v_occurred_at,
        v_occurred_at, v_actor_id,
        v_phys_qty,
        v_avail_qty, v_damaged_qty, v_expired_qty,
        v_blocked_qty, v_other_qty,
        v_actor_id
    ) RETURNING ce.id INTO v_count_entry_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.count.record',
        'entity_id', v_count_entry_id,
        'state', NULL::text,
        'version', NULL::integer,
        'cycle_number', v_cycle,
        'assignment_id', v_assignment_id,
        'event_id', NULL::uuid,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'snapshot_product_id', p_snapshot_product_id,
            'snapshot_location_id', p_snapshot_location_id,
            'physical_quantity', v_phys_qty,
            'available_quantity', v_avail_qty,
            'damaged_quantity', v_damaged_qty,
            'expired_quantity', v_expired_qty,
            'blocked_quantity', v_blocked_qty,
            'other_unavailable_quantity', v_other_qty,
            'identification_method', v_identification_method,
            'scanned_code', v_scanned_code,
            'capture_source', v_capture_source,
            'offline_id', p_offline_id,
            'captured_at', v_captured_at
        )
    );

    RETURN inventarios.complete_idempotent_operation(
        p_company_id, v_operation_id, v_count_entry_id, v_response
    );
END;
$$;

ALTER FUNCTION inventarios.record_inventory_count(uuid, uuid, integer, uuid, uuid, jsonb, text, text, text, uuid, text, timestamptz, uuid)
    OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.record_inventory_count(uuid, uuid, integer, uuid, uuid, jsonb, text, text, text, uuid, text, timestamptz, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.record_inventory_count(uuid, uuid, integer, uuid, uuid, jsonb, text, text, text, uuid, text, timestamptz, uuid) TO authenticated;
