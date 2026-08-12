-- =========================================================================================
-- MIGRATION: M1.5E - Autorizacion contextual y neutralidad de rol en captura movil
-- =========================================================================================

CREATE OR REPLACE FUNCTION inventarios.require_active_session_participant(
    p_company_id uuid,
    p_session_id uuid,
    p_user_id uuid,
    p_allowed_roles text[] DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_participant_id uuid;
    v_roles text[];
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ACCESS_DENIED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes acceso a esta operación.','retryable',false)::text;
    END IF;

    IF p_allowed_roles IS NOT NULL THEN
        SELECT pg_catalog.array_agg(pg_catalog.upper(pg_catalog.btrim(v)))
        INTO v_roles
        FROM pg_catalog.unnest(p_allowed_roles) AS v
        WHERE pg_catalog.btrim(v) <> '';
    END IF;

    SELECT sp.id
    INTO v_participant_id
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id
      AND sp.session_id = p_session_id
      AND sp.user_id = p_user_id
      AND sp.active_from <= pg_catalog.now()
      AND sp.revoked_at IS NULL
      AND (v_roles IS NULL OR sp.functional_role = ANY(v_roles))
    ORDER BY sp.active_from DESC, sp.id DESC
    LIMIT 1;

    IF v_participant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ACCESS_DENIED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes acceso a esta operación.','retryable',false)::text;
    END IF;

    RETURN v_participant_id;
END;
$function$;

ALTER FUNCTION inventarios.require_active_session_participant(uuid, uuid, uuid, text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.require_active_session_participant(uuid, uuid, uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.require_active_session_participant(uuid, uuid, uuid, text[]) TO authenticated;

CREATE OR REPLACE FUNCTION inventarios.require_active_assignment_participant(
    p_company_id uuid,
    p_session_id uuid,
    p_user_id uuid,
    p_session_participant_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_participant_id uuid;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_user_id IS NULL OR p_session_participant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes una asignación vigente para esta tarea.','retryable',false)::text;
    END IF;

    SELECT sp.id
    INTO v_participant_id
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id
      AND sp.session_id = p_session_id
      AND sp.id = p_session_participant_id
      AND sp.user_id = p_user_id
      AND sp.active_from <= pg_catalog.now()
      AND sp.revoked_at IS NULL;

    IF v_participant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes una asignación vigente para esta tarea.','retryable',false)::text;
    END IF;

    RETURN v_participant_id;
END;
$function$;

ALTER FUNCTION inventarios.require_active_assignment_participant(uuid, uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.require_active_assignment_participant(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.require_active_assignment_participant(uuid, uuid, uuid, uuid) TO authenticated;

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
AS $function$
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
    v_assignment_participant_id uuid;
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

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

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

    SELECT ta.id, ta.user_id, ta.session_participant_id
    INTO v_assignment_id, v_assignment_user_id, v_assignment_participant_id
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

    v_participant_id := inventarios.require_active_assignment_participant(
        p_company_id,
        v_session_id,
        v_actor_id,
        v_assignment_participant_id
    );

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
    v_captured_at := COALESCE(p_captured_at, v_occurred_at);

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
$function$;

ALTER FUNCTION inventarios.record_inventory_count(uuid, uuid, integer, uuid, uuid, jsonb, text, text, text, uuid, text, timestamptz, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.record_inventory_count(uuid, uuid, integer, uuid, uuid, jsonb, text, text, text, uuid, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.record_inventory_count(uuid, uuid, integer, uuid, uuid, jsonb, text, text, text, uuid, text, timestamptz, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION inventarios.start_inventory_task(
    p_company_id uuid,
    p_task_id uuid,
    p_expected_version integer,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_request_payload jsonb;
    v_request_hash text;
    v_task_session_id uuid;
    v_task_session_zone_id uuid;
    v_task_status text;
    v_task_version integer;
    v_task_cycle integer;
    v_current_assignment_id uuid;
    v_assignment_count bigint;
    v_assignment_id uuid;
    v_assignment_user_id uuid;
    v_assignment_participant_id uuid;
    v_participant_id uuid;
    v_event_id uuid;
    v_occurred_at timestamptz;
    v_response_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL OR p_expected_version IS NULL
       OR p_expected_version <= 0 OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.actor_operational_task'), pg_catalog.hashtext(v_actor_id::text));
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.start_inventory_task'), pg_catalog.hashtext(p_company_id::text || ':' || v_actor_id::text));

    v_request_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.start',
        'company_id', p_company_id,
        'task_id', p_task_id,
        'expected_version', p_expected_version
    );
    v_request_hash := inventarios.compute_request_hash(v_request_payload);

    v_operation := inventarios.begin_idempotent_operation(
        p_company_id, 'inventarios.task.start', p_idempotency_key, v_request_hash
    );

    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;

    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT t.session_id, t.session_zone_id, t.status, t.version, t.validation_cycle, t.current_assignment_id
    INTO v_task_session_id, v_task_session_zone_id, v_task_status, v_task_version, v_task_cycle, v_current_assignment_id
    FROM inventarios.tasks AS t
    WHERE t.company_id = p_company_id AND t.id = p_task_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    PERFORM inventarios.require_session_counting(p_company_id, v_task_session_id);

    IF v_task_version <> p_expected_version THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea fue modificada por otra operacion.', 'retryable', true)::text;
    END IF;

    SELECT pg_catalog.count(*),
           (pg_catalog.array_agg(ta.id ORDER BY ta.id))[1],
           (pg_catalog.array_agg(ta.user_id ORDER BY ta.id))[1],
           (pg_catalog.array_agg(ta.session_participant_id ORDER BY ta.id))[1]
    INTO v_assignment_count, v_assignment_id, v_assignment_user_id, v_assignment_participant_id
    FROM inventarios.task_assignments AS ta
    WHERE ta.company_id = p_company_id AND ta.session_id = v_task_session_id
      AND ta.task_id = p_task_id AND ta.released_at IS NULL;

    IF v_assignment_count = 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    IF v_assignment_count > 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
    END IF;

    IF v_current_assignment_id IS DISTINCT FROM v_assignment_id
       OR v_assignment_user_id IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ASSIGNMENT_REQUIRED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes una asignacion vigente para esta tarea.', 'retryable', false)::text;
    END IF;

    v_participant_id := inventarios.require_active_assignment_participant(
        p_company_id,
        v_task_session_id,
        v_actor_id,
        v_assignment_participant_id
    );

    IF EXISTS (
        SELECT 1
        FROM inventarios.tasks t_active
        JOIN inventarios.task_assignments ta_active ON ta_active.task_id = t_active.id
        WHERE ta_active.user_id = v_actor_id
          AND ta_active.released_at IS NULL
          AND t_active.status IN ('IN_PROGRESS', 'PAUSED')
          AND t_active.id <> p_task_id
          AND t_active.cancelled_at IS NULL
          AND t_active.superseded_at IS NULL
          AND t_active.invalidated_at IS NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACTOR_HAS_ACTIVE_TASK',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Ya te encuentras trabajando en otra tarea de inventario.', 'retryable', false)::text;
    END IF;

    v_occurred_at := pg_catalog.now();

    UPDATE inventarios.tasks AS t
    SET status = 'IN_PROGRESS',
        version = t.version + 1,
        opened_at = v_occurred_at,
        active_user_id = v_actor_id,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE t.company_id = p_company_id AND t.id = p_task_id;

    INSERT INTO inventarios.task_events (
        company_id, session_id, session_zone_id, task_id,
        event_type, previous_status, next_status, actor_id, next_user_id, cycle,
        occurred_at, idempotency_key, created_by
    ) VALUES (
        p_company_id, v_task_session_id, v_task_session_zone_id, p_task_id,
        'STARTED', 'ASSIGNED', 'IN_PROGRESS', v_actor_id, v_actor_id, v_task_cycle,
        v_occurred_at, p_idempotency_key, v_actor_id
    ) RETURNING id INTO v_event_id;

    INSERT INTO inventarios.task_state_transitions (
        company_id, session_id, session_zone_id, task_id, assignment_id,
        operation_idempotency_id, transition_type, previous_status,
        next_status, previous_version, next_version, previous_cycle, next_cycle,
        actor_id, occurred_at
    ) VALUES (
        p_company_id, v_task_session_id, v_task_session_zone_id, p_task_id, v_assignment_id,
        v_operation_id, 'STARTED', 'ASSIGNED', 'IN_PROGRESS', v_task_version, v_task_version + 1,
        v_task_cycle, v_task_cycle, v_actor_id, v_occurred_at
    );

    v_response_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.start',
        'entity_id', p_task_id,
        'state', 'IN_PROGRESS',
        'version', v_task_version + 1,
        'cycle_number', v_task_cycle,
        'assignment_id', v_assignment_id,
        'event_id', v_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('session_participant_id', v_participant_id)
    );

    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_task_id, v_response_payload);
END;
$function$;

ALTER FUNCTION inventarios.start_inventory_task(uuid, uuid, integer, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.start_inventory_task(uuid, uuid, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.start_inventory_task(uuid, uuid, integer, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION inventarios.assign_inventory_counting_zone(
    p_company_id uuid,
    p_campaign_id uuid,
    p_session_id uuid,
    p_campaign_participant_id uuid,
    p_zone_name text,
    p_location_ids uuid[],
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_zone_name text; v_location_ids uuid[]; v_idx integer;
    v_campaign_status text; v_session_status text; v_session_warehouse_id uuid;
    v_session_campaign_id uuid; v_snapshot_id uuid; v_campaign_user_id uuid;
    v_campaign_participant_role text;
    v_participant_id uuid; v_zone_total bigint; v_zone_enabled bigint;
    v_zone_id uuid; v_zone_code text;
    v_scope_id uuid; v_loc_active boolean; v_loc_warehouse_id uuid;
    v_loc_code text; v_loc_name text; v_loc_aisle text; v_loc_rack text;
    v_loc_level text; v_loc_position text; v_snapshot_location_id uuid;
    v_task_id uuid; v_assignment_id uuid;
    v_total bigint; v_assigned bigint; v_pending bigint; v_percent numeric;
    v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
BEGIN
    v_zone_name := pg_catalog.btrim(p_zone_name);
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_session_id IS NULL
       OR p_campaign_participant_id IS NULL OR p_idempotency_key IS NULL
       OR v_zone_name = '' OR pg_catalog.char_length(v_zone_name) > 200
       OR p_location_ids IS NULL OR pg_catalog.cardinality(p_location_ids) < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST', DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    SELECT pg_catalog.array_agg(DISTINCT l ORDER BY l) INTO v_location_ids FROM pg_catalog.unnest(p_location_ids) AS l;
    IF v_location_ids IS NULL OR pg_catalog.cardinality(v_location_ids) <> pg_catalog.cardinality(p_location_ids) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_DUPLICATE', DETAIL=pg_catalog.jsonb_build_object('message','Las ubicaciones no pueden repetirse ni estar vacias.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    PERFORM inventarios.require_active_session_participant(p_company_id, p_session_id, v_actor_id, ARRAY['ADMINISTRATOR','SUPERVISOR','MANAGER']);

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.assign_inventory_counting_zone'), pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.counting_zone.assign','company_id',p_company_id,
        'campaign_id',p_campaign_id,'session_id',p_session_id,
        'campaign_participant_id',p_campaign_participant_id,
        'zone_name',v_zone_name,'location_ids',pg_catalog.to_jsonb(v_location_ids));
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.counting_zone.assign',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','La campana solicitada no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_DRAFT', DETAIL=pg_catalog.jsonb_build_object('message','La campana no esta en DRAFT.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF inventarios.campaign_is_prepared(p_company_id, p_campaign_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ALREADY_PREPARED', DETAIL=pg_catalog.jsonb_build_object('message','La campana ya fue preparada y no admite configuracion.','retryable',false)::text;
    END IF;

    SELECT s.status, s.warehouse_id, s.campaign_id
    INTO v_session_status, v_session_warehouse_id, v_session_campaign_id
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','La jornada solicitada no existe.','retryable',false)::text;
    END IF;
    IF v_session_campaign_id IS DISTINCT FROM p_campaign_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_CAMPAIGN_MISMATCH', DETAIL=pg_catalog.jsonb_build_object('message','La jornada no pertenece a la campana.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_DRAFT', DETAIL=pg_catalog.jsonb_build_object('message','La jornada no esta en DRAFT.','retryable',false,'status',v_session_status)::text;
    END IF;
    IF v_session_warehouse_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_EXTERNAL_UNSUPPORTED', DETAIL=pg_catalog.jsonb_build_object('message','La jornada no es una bodega interna y no admite asignacion de zonas.','retryable',false)::text;
    END IF;
    SELECT os.id INTO v_snapshot_id
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_REQUIRED', DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene un snapshot vigente.','retryable',false)::text;
    END IF;

    SELECT icp.user_id, icp.participant_role
    INTO v_campaign_user_id, v_campaign_participant_role
    FROM inventarios.inventory_campaign_participants icp
    JOIN portal.users u ON u.id = icp.user_id
    JOIN core.user_company_access uca ON uca.user_id = icp.user_id AND uca.company_id = icp.company_id AND uca.is_active = true
    WHERE icp.company_id = p_company_id AND icp.campaign_id = p_campaign_id
      AND icp.id = p_campaign_participant_id
      AND icp.participant_role IN ('COUNTER','SUPERVISOR','ADMINISTRATOR','MANAGER')
      AND icp.revoked_at IS NULL
      AND u.is_active = true AND u.deleted_at IS NULL;
    IF v_campaign_user_id IS NULL OR v_campaign_participant_role IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','No existe un participante activo para la zona.','retryable',false)::text;
    END IF;

    FOR v_idx IN 1 .. pg_catalog.cardinality(v_location_ids) LOOP
        SELECT slc.id, l.is_active, l.warehouse_id
        INTO v_scope_id, v_loc_active, v_loc_warehouse_id
        FROM inventarios.session_location_scopes slc
        JOIN logistica.locations l ON l.id = slc.location_id
        WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
          AND slc.inclusion_type = 'INCLUDED' AND slc.location_id = v_location_ids[v_idx];
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_NOT_IN_SCOPE', DETAIL=pg_catalog.jsonb_build_object('message','Una ubicacion no pertenece al alcance de la jornada.','retryable',false,'location_id',v_location_ids[v_idx])::text;
        END IF;
        IF v_loc_active IS NOT TRUE OR v_loc_warehouse_id IS DISTINCT FROM v_session_warehouse_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_INACTIVE', DETAIL=pg_catalog.jsonb_build_object('message','Una ubicacion esta inactiva o fuera del alcance de la jornada.','retryable',false,'location_id',v_location_ids[v_idx])::text;
        END IF;
        IF EXISTS (SELECT 1 FROM inventarios.session_zone_locations szl WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id AND szl.location_id = v_location_ids[v_idx]) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_ALREADY_ASSIGNED', DETAIL=pg_catalog.jsonb_build_object('message','Una ubicacion ya pertenece a una zona de la jornada.','retryable',false,'location_id',v_location_ids[v_idx])::text;
        END IF;
    END LOOP;

    v_occurred_at := pg_catalog.now();

    SELECT sp.id INTO v_participant_id
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
      AND sp.user_id = v_campaign_user_id AND sp.functional_role = v_campaign_participant_role
      AND sp.active_from <= v_occurred_at AND sp.revoked_at IS NULL;
    IF v_participant_id IS NULL THEN
        INSERT INTO inventarios.session_participants AS sp (company_id, session_id, user_id, functional_role, active_from, created_at, created_by)
        VALUES (p_company_id, p_session_id, v_campaign_user_id, v_campaign_participant_role, v_occurred_at, v_occurred_at, v_actor_id)
        RETURNING sp.id INTO v_participant_id;
    END IF;

    SELECT pg_catalog.count(*) INTO v_zone_total FROM inventarios.session_zones sz WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id;
    SELECT pg_catalog.count(*) INTO v_zone_enabled FROM inventarios.session_zones sz WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.is_enabled = true;
    v_zone_code := 'Z' || (v_zone_total + 1)::text;
    INSERT INTO inventarios.session_zones AS sz (company_id, session_id, snapshot_id, zone_code, scan_code, display_name, priority, is_enabled, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_snapshot_id, v_zone_code, v_zone_code, v_zone_name, v_zone_total::integer, true, v_occurred_at, v_actor_id)
    RETURNING sz.id INTO v_zone_id;

    FOR v_idx IN 1 .. pg_catalog.cardinality(v_location_ids) LOOP
        SELECT slc.id, l.code, l.name, l.aisle, l.rack, l.level, l.position
        INTO v_scope_id, v_loc_code, v_loc_name, v_loc_aisle, v_loc_rack, v_loc_level, v_loc_position
        FROM inventarios.session_location_scopes slc
        JOIN logistica.locations l ON l.id = slc.location_id
        WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
          AND slc.inclusion_type = 'INCLUDED' AND slc.location_id = v_location_ids[v_idx];
        SELECT sll.id INTO v_snapshot_location_id
        FROM inventarios.snapshot_locations sll
        WHERE sll.company_id = p_company_id AND sll.snapshot_id = v_snapshot_id AND sll.location_id = v_location_ids[v_idx];
        IF v_snapshot_location_id IS NULL THEN
            INSERT INTO inventarios.snapshot_locations AS sll (company_id, snapshot_id, location_id, warehouse_id, code, name, aisle, rack, level, position, is_active, created_at, created_by)
            VALUES (p_company_id, v_snapshot_id, v_location_ids[v_idx], v_session_warehouse_id, v_loc_code, v_loc_name, v_loc_aisle, v_loc_rack, v_loc_level, v_loc_position, true, v_occurred_at, v_actor_id)
            RETURNING sll.id INTO v_snapshot_location_id;
        END IF;
        INSERT INTO inventarios.session_zone_locations AS szl (company_id, session_id, snapshot_id, session_zone_id, session_location_scope_id, snapshot_location_id, location_id, created_at, created_by)
        VALUES (p_company_id, p_session_id, v_snapshot_id, v_zone_id, v_scope_id, v_snapshot_location_id, v_location_ids[v_idx], v_occurred_at, v_actor_id);
    END LOOP;

    INSERT INTO inventarios.tasks AS t (company_id, session_id, session_zone_id, task_kind, status, version, validation_cycle, creation_idempotency_key, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_zone_id, 'PRIMARY', 'ASSIGNED', 1, 1, p_idempotency_key, v_occurred_at, v_actor_id)
    RETURNING t.id INTO v_task_id;
    INSERT INTO inventarios.task_assignments AS ta (company_id, session_id, task_id, session_participant_id, user_id, assigned_at, assigned_by, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_task_id, v_participant_id, v_campaign_user_id, v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING ta.id INTO v_assignment_id;
    UPDATE inventarios.tasks AS t SET current_assignment_id = v_assignment_id, updated_at = v_occurred_at, updated_by = v_actor_id WHERE t.company_id = p_company_id AND t.id = v_task_id;

    SELECT pg_catalog.count(*) INTO v_total
    FROM inventarios.session_location_scopes slc
    JOIN logistica.locations l ON l.id = slc.location_id
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.inclusion_type = 'INCLUDED' AND slc.location_id IS NOT NULL
      AND l.is_active = true AND l.warehouse_id = v_session_warehouse_id;
    SELECT pg_catalog.count(DISTINCT szl.location_id) INTO v_assigned
    FROM inventarios.session_zone_locations szl
    JOIN inventarios.session_zones sz ON sz.company_id = szl.company_id AND sz.session_id = szl.session_id AND sz.id = szl.session_zone_id AND sz.is_enabled = true
    WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id AND szl.location_id IS NOT NULL;
    v_pending := GREATEST(v_total - v_assigned, 0);
    IF v_total > 0 THEN v_percent := pg_catalog.round(v_assigned::numeric * 100.0 / v_total::numeric, 1); ELSE v_percent := 0; END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.counting_zone.assign','entity_id',v_zone_id,
        'state','ASSIGNED','version',1::integer,'cycle_number',1::integer,
        'assignment_id',v_assignment_id,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object(
            'campaign_id',p_campaign_id,'session_id',p_session_id,
            'zone_id',v_zone_id,'zone_code',v_zone_code,'zone_name',v_zone_name,
            'session_participant_id',v_participant_id,
            'campaign_participant_id',p_campaign_participant_id,
            'user_id',v_campaign_user_id,
            'task_id',v_task_id,'task_assignment_id',v_assignment_id,
            'location_ids',pg_catalog.to_jsonb(v_location_ids),
            'location_count',pg_catalog.cardinality(v_location_ids),
            'coverage',pg_catalog.jsonb_build_object(
                'total',v_total,'assigned',v_assigned,'pending',v_pending,
                'percent',v_percent,'zone_count',v_zone_enabled + 1)));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_zone_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.assign_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid[], uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.assign_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.assign_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid[], uuid) TO authenticated;

CREATE OR REPLACE FUNCTION inventarios.cancel_inventory_counting_zone(
    p_company_id uuid,
    p_campaign_id uuid,
    p_session_id uuid,
    p_zone_id uuid,
    p_reason text,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_reason text; v_campaign_status text; v_session_status text;
    v_session_warehouse_id uuid; v_session_campaign_id uuid;
    v_task_id uuid; v_task_status text; v_task_version integer; v_task_cycle integer;
    v_current_assignment_id uuid; v_task_opened_at timestamptz; v_task_active_user uuid;
    v_event_id uuid;
    v_total bigint; v_assigned bigint; v_pending bigint; v_percent numeric;
    v_zone_count bigint;
    v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
BEGIN
    v_reason := pg_catalog.btrim(p_reason);
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_session_id IS NULL OR p_zone_id IS NULL OR p_idempotency_key IS NULL OR v_reason = '' OR pg_catalog.char_length(v_reason) < 5 OR pg_catalog.char_length(v_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST', DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    PERFORM inventarios.require_active_session_participant(p_company_id, p_session_id, v_actor_id, ARRAY['ADMINISTRATOR','SUPERVISOR','MANAGER']);
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.cancel_inventory_counting_zone'), pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.counting_zone.cancel','company_id',p_company_id,'campaign_id',p_campaign_id,'session_id',p_session_id,'zone_id',p_zone_id,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.counting_zone.cancel',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT ic.status INTO v_campaign_status FROM inventarios.inventory_campaigns ic WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','La campana solicitada no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_DRAFT', DETAIL=pg_catalog.jsonb_build_object('message','La campana no esta en DRAFT.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF inventarios.campaign_is_prepared(p_company_id, p_campaign_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ALREADY_PREPARED', DETAIL=pg_catalog.jsonb_build_object('message','La campana ya fue preparada y no admite configuracion.','retryable',false)::text;
    END IF;

    SELECT s.status, s.warehouse_id, s.campaign_id INTO v_session_status, v_session_warehouse_id, v_session_campaign_id FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','La jornada solicitada no existe.','retryable',false)::text;
    END IF;
    IF v_session_campaign_id IS DISTINCT FROM p_campaign_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_CAMPAIGN_MISMATCH', DETAIL=pg_catalog.jsonb_build_object('message','La jornada no pertenece a la campana.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_DRAFT', DETAIL=pg_catalog.jsonb_build_object('message','La jornada no esta en DRAFT.','retryable',false,'status',v_session_status)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM inventarios.session_zones sz WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.id = p_zone_id AND sz.is_enabled = true) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ZONE_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','La zona solicitada no existe o ya fue cancelada.','retryable',false)::text;
    END IF;

    SELECT t.id, t.status, t.version, t.validation_cycle, t.current_assignment_id, t.opened_at, t.active_user_id
    INTO v_task_id, v_task_status, v_task_version, v_task_cycle, v_current_assignment_id, v_task_opened_at, v_task_active_user
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id AND t.session_zone_id = p_zone_id AND t.task_kind = 'PRIMARY' AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','La zona no tiene una tarea vigente.','retryable',false)::text;
    END IF;
    IF v_task_status <> 'ASSIGNED' OR v_task_opened_at IS NOT NULL OR v_task_active_user IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_ALREADY_STARTED', DETAIL=pg_catalog.jsonb_build_object('message','La tarea ya inicio y no puede cancelarse.','retryable',false)::text;
    END IF;
    IF v_current_assignment_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;

    v_occurred_at := pg_catalog.now();
    UPDATE inventarios.task_assignments AS ta SET released_at = v_occurred_at, released_by = v_actor_id, release_reason = v_reason WHERE ta.company_id = p_company_id AND ta.id = v_current_assignment_id;
    INSERT INTO inventarios.task_events AS e (company_id, session_id, session_zone_id, task_id, event_type, actor_id, cycle, occurred_at, reason, idempotency_key, technical_metadata, created_by)
    VALUES (p_company_id, p_session_id, p_zone_id, v_task_id, 'CANCELLED', v_actor_id, v_task_cycle, v_occurred_at, v_reason, p_idempotency_key, pg_catalog.jsonb_build_object('operation','inventarios.counting_zone.cancel'), v_actor_id)
    RETURNING e.id INTO v_event_id;
    UPDATE inventarios.tasks AS t SET cancelled_at = v_occurred_at, cancelled_by = v_actor_id, current_assignment_id = NULL, active_user_id = NULL, version = t.version + 1, updated_at = v_occurred_at, updated_by = v_actor_id WHERE t.company_id = p_company_id AND t.id = v_task_id;
    DELETE FROM inventarios.session_zone_locations szl WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id AND szl.session_zone_id = p_zone_id;
    UPDATE inventarios.session_zones AS sz SET is_enabled = false, updated_at = v_occurred_at, updated_by = v_actor_id WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.id = p_zone_id;

    SELECT pg_catalog.count(*) INTO v_total
    FROM inventarios.session_location_scopes slc
    JOIN logistica.locations l ON l.id = slc.location_id
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id AND slc.inclusion_type = 'INCLUDED' AND slc.location_id IS NOT NULL AND l.is_active = true AND l.warehouse_id = v_session_warehouse_id;
    SELECT pg_catalog.count(DISTINCT szl.location_id) INTO v_assigned
    FROM inventarios.session_zone_locations szl
    JOIN inventarios.session_zones sz ON sz.company_id = szl.company_id AND sz.session_id = szl.session_id AND sz.id = szl.session_zone_id AND sz.is_enabled = true
    WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id AND szl.location_id IS NOT NULL;
    v_pending := GREATEST(v_total - v_assigned, 0);
    IF v_total > 0 THEN v_percent := pg_catalog.round(v_assigned::numeric * 100.0 / v_total::numeric, 1); ELSE v_percent := 0; END IF;
    SELECT pg_catalog.count(*) INTO v_zone_count FROM inventarios.session_zones sz WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.is_enabled = true;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.counting_zone.cancel','entity_id',p_zone_id,
        'state',v_task_status,'version',v_task_version + 1::integer,
        'cycle_number',v_task_cycle,'assignment_id',NULL::uuid,
        'event_id',v_event_id,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object(
            'campaign_id',p_campaign_id,'session_id',p_session_id,
            'zone_id',p_zone_id,'task_id',v_task_id,
            'task_assignment_id',v_current_assignment_id,
            'reason',v_reason,
            'coverage',pg_catalog.jsonb_build_object('total',v_total,'assigned',v_assigned,'pending',v_pending,'percent',v_percent,'zone_count',v_zone_count)));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_zone_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.cancel_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.cancel_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.cancel_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION inventarios.lookup_my_counting_product(p_zone_id uuid, p_location_id uuid, p_barcode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_task_id uuid;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
    v_matches jsonb;
    v_match_count integer;
    v_clean_barcode text;
BEGIN
    v_clean_barcode := pg_catalog.btrim(p_barcode);
    IF v_clean_barcode IS NULL OR v_clean_barcode = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El código de barras es obligatorio.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.snapshot_id, true
    INTO v_company_id, v_task_id, v_session_id, v_snapshot_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.active_from <= pg_catalog.now()
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
    PERFORM inventarios.require_permission(v_company_id, 'inventarios.sessions.read');

    SELECT true INTO v_is_open
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id AND tl.task_id = v_task_id AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id AND tl.status = 'OPEN';

    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    WITH snapshot_inventory AS (
        SELECT DISTINCT ON (sp.bsale_variant_id)
            sp.bsale_variant_id, sp.id AS snapshot_product_id, sp.product_id, sp.sku, sp.barcode, sp.name
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.bsale_variant_id IS NOT NULL
        ORDER BY sp.bsale_variant_id, sp.id
    ),
    snapshot_matches AS (
        SELECT DISTINCT ON (sp.bsale_variant_id)
            sp.product_id, sp.bsale_variant_id, sp.sku, sp.barcode, sp.name, 1 AS source_rank
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.bsale_variant_id IS NOT NULL AND sp.barcode = v_clean_barcode
        ORDER BY sp.bsale_variant_id, sp.id
    ),
    master_matches AS (
        SELECT DISTINCT ON (bv.bsale_id)
            p.id AS product_id, bv.bsale_id AS bsale_variant_id, bv.code AS sku, bv.bar_code AS barcode,
            pg_catalog.concat_ws(' - ', bp.name, bv.description) AS name, 2 AS source_rank
        FROM adquisiciones.products p
        JOIN integraciones.bsale_variants bv ON bv.company_id = p.company_id AND bv.bsale_id = p.bsale_variant_id
        JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
        WHERE p.company_id = v_company_id AND p.is_active = true AND bv.state = 0 AND bp.state = 0 AND bv.bar_code = v_clean_barcode
        ORDER BY bv.bsale_id, p.updated_at DESC NULLS LAST, p.id, bv.id, bp.id
    ),
    candidate_rows AS (
        SELECT * FROM snapshot_matches UNION ALL SELECT * FROM master_matches
    ),
    candidates AS (
        SELECT DISTINCT ON (cr.bsale_variant_id)
            cr.product_id, cr.bsale_variant_id, cr.sku, cr.barcode, cr.name
        FROM candidate_rows cr
        ORDER BY cr.bsale_variant_id, cr.source_rank, cr.product_id, cr.sku, cr.barcode, cr.name
    )
    SELECT pg_catalog.coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'product_id', c.product_id,
            'bsale_variant_id', c.bsale_variant_id,
            'sku', c.sku,
            'barcode', c.barcode,
            'name', c.name,
            'snapshot_product_id', si.snapshot_product_id,
            'in_snapshot', CASE WHEN si.snapshot_product_id IS NOT NULL THEN true ELSE false END
        ) ORDER BY c.sku ASC, c.name ASC, c.bsale_variant_id ASC
    ), '[]'::jsonb), pg_catalog.count(*)
    INTO v_matches, v_match_count
    FROM candidates c
    LEFT JOIN snapshot_inventory si ON si.bsale_variant_id = c.bsale_variant_id;

    IF v_match_count = 0 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'NOT_FOUND', 'match_count', 0, 'matches', '[]'::jsonb);
    ELSIF v_match_count = 1 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'MATCHED', 'match_count', 1, 'matches', v_matches);
    ELSE
        RETURN pg_catalog.jsonb_build_object('status', 'MULTIPLE_MATCHES', 'match_count', v_match_count, 'matches', v_matches);
    END IF;
END;
$function$;

ALTER FUNCTION inventarios.lookup_my_counting_product(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.lookup_my_counting_product(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.lookup_my_counting_product(uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION inventarios.search_master_products(p_zone_id uuid, p_location_id uuid, p_query text, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_task_id uuid;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
    v_clean_query text;
    v_limit integer;
    v_results jsonb;
BEGIN
    v_clean_query := pg_catalog.btrim(p_query);
    IF v_clean_query IS NULL OR pg_catalog.length(v_clean_query) < 2 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La búsqueda debe tener al menos 2 caracteres.', 'retryable', false)::text;
    END IF;
    v_limit := COALESCE(p_limit, 20);
    v_limit := LEAST(20, GREATEST(1, v_limit));
    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.snapshot_id, true
    INTO v_company_id, v_task_id, v_session_id, v_snapshot_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id AND a.user_id = v_actor_id AND a.released_at IS NULL
      AND p.user_id = v_actor_id AND p.active_from <= pg_catalog.now() AND p.revoked_at IS NULL
      AND s.status = 'COUNTING' AND z.is_enabled = true AND t.status = 'IN_PROGRESS'
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_permission(v_company_id, 'inventarios.sessions.read');

    SELECT true INTO v_is_open
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id AND tl.task_id = v_task_id AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id AND tl.status = 'OPEN';

    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    WITH snapshot_inventory AS (
        SELECT DISTINCT ON (sp.bsale_variant_id) sp.bsale_variant_id, sp.id AS snapshot_product_id
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.bsale_variant_id IS NOT NULL
        ORDER BY sp.bsale_variant_id, sp.id
    ),
    search_raw AS (
        SELECT p.id AS product_id, bv.bsale_id AS bsale_variant_id, bv.code AS sku, bv.bar_code AS barcode,
               pg_catalog.concat_ws(' - ', bp.name, bv.description) AS name,
               CASE
                   WHEN bv.code ILIKE v_clean_query OR bv.bar_code ILIKE v_clean_query OR bv.description ILIKE v_clean_query OR bp.name ILIKE v_clean_query THEN 1
                   WHEN bv.code ILIKE v_clean_query || '%' OR bv.bar_code ILIKE v_clean_query || '%' OR bv.description ILIKE v_clean_query || '%' OR bp.name ILIKE v_clean_query || '%' THEN 2
                   WHEN bv.code ILIKE '%' || v_clean_query || '%' OR bv.bar_code ILIKE '%' || v_clean_query || '%' OR bv.description ILIKE '%' || v_clean_query || '%' OR bp.name ILIKE '%' || v_clean_query || '%' THEN 3
                   ELSE 4
               END AS match_rank,
               CASE
                   WHEN bv.code ILIKE v_clean_query THEN 1
                   WHEN bv.bar_code ILIKE v_clean_query THEN 2
                   WHEN bv.description ILIKE v_clean_query THEN 3
                   WHEN bp.name ILIKE v_clean_query THEN 4
                   WHEN bv.code ILIKE v_clean_query || '%' THEN 5
                   WHEN bv.bar_code ILIKE v_clean_query || '%' THEN 6
                   WHEN bv.description ILIKE v_clean_query || '%' THEN 7
                   WHEN bp.name ILIKE v_clean_query || '%' THEN 8
                   WHEN bv.code ILIKE '%' || v_clean_query || '%' THEN 9
                   WHEN bv.bar_code ILIKE '%' || v_clean_query || '%' THEN 10
                   WHEN bv.description ILIKE '%' || v_clean_query || '%' THEN 11
                   WHEN bp.name ILIKE '%' || v_clean_query || '%' THEN 12
                   ELSE 13
               END AS match_field_rank
        FROM adquisiciones.products p
        JOIN integraciones.bsale_variants bv ON bv.company_id = p.company_id AND bv.bsale_id = p.bsale_variant_id
        JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
        WHERE p.company_id = v_company_id AND p.is_active = true AND bv.state = 0 AND bp.state = 0
          AND (bv.code ILIKE '%' || v_clean_query || '%' OR bv.bar_code ILIKE '%' || v_clean_query || '%' OR bp.name ILIKE '%' || v_clean_query || '%' OR bv.description ILIKE '%' || v_clean_query || '%')
    ),
    search_dedup AS (
        SELECT sr.*, pg_catalog.row_number() OVER (PARTITION BY sr.bsale_variant_id ORDER BY sr.match_rank ASC, sr.match_field_rank ASC, sr.name ASC, sr.product_id ASC, sr.sku ASC, sr.barcode ASC) AS rn
        FROM search_raw sr
    ),
    search_unique AS (
        SELECT product_id, bsale_variant_id, sku, barcode, name, match_rank, match_field_rank
        FROM search_dedup WHERE rn = 1
    ),
    ranked_results AS (
        SELECT su.product_id, su.bsale_variant_id, su.sku, su.barcode, su.name, su.match_rank, su.match_field_rank,
               si.snapshot_product_id,
               CASE WHEN si.snapshot_product_id IS NOT NULL THEN true ELSE false END AS in_snapshot
        FROM search_unique su
        LEFT JOIN snapshot_inventory si ON si.bsale_variant_id = su.bsale_variant_id
        ORDER BY su.match_rank ASC, su.match_field_rank ASC, su.name ASC, su.bsale_variant_id ASC
        LIMIT v_limit
    )
    SELECT pg_catalog.coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'product_id', r.product_id,
            'bsale_variant_id', r.bsale_variant_id,
            'sku', r.sku,
            'barcode', r.barcode,
            'name', r.name,
            'snapshot_product_id', r.snapshot_product_id,
            'in_snapshot', r.in_snapshot
        ) ORDER BY r.match_rank ASC, r.match_field_rank ASC, r.name ASC, r.bsale_variant_id ASC
    ), '[]'::jsonb)
    INTO v_results
    FROM ranked_results r;

    RETURN v_results;
END;
$function$;

ALTER FUNCTION inventarios.search_master_products(uuid, uuid, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.search_master_products(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.search_master_products(uuid, uuid, text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION inventarios.submit_my_mobile_count(
    p_zone_id uuid,
    p_location_id uuid,
    p_snapshot_product_id uuid,
    p_physical_quantity numeric,
    p_identification_method text,
    p_scanned_code text,
    p_idempotency_key uuid,
    p_captured_at timestamptz,
    p_device_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_session_zone_id uuid;
    v_task_id uuid;
    v_task_cycle integer;
    v_assignment_id uuid;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
    v_snapshot_location_id uuid;
    v_quantities_payload jsonb;
    v_request_payload jsonb;
    v_request_hash text;
    v_operation jsonb;
    v_operation_id uuid;
    v_count_result jsonb;
    v_count_entry_id uuid;
    v_count_event_id uuid;
    v_count_event_key uuid;
    v_count_event_payload jsonb;
    v_actual_barcode text;
    v_actual_sku text;
    v_clean_scanned_code text;
    v_clean_device_id text;
    v_count_occurred_at timestamptz;
    v_response jsonb;
    v_replay_payload jsonb;
BEGIN
    IF p_snapshot_product_id IS NULL OR p_physical_quantity IS NULL OR p_physical_quantity < 0 OR p_idempotency_key IS NULL OR p_captured_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_clean_device_id := pg_catalog.btrim(p_device_id);
    IF v_clean_device_id IS NULL OR v_clean_device_id = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'Device ID es obligatorio.', 'retryable', false)::text;
    END IF;
    IF p_identification_method IS NULL OR p_identification_method NOT IN ('BARCODE', 'SKU_MANUAL', 'SEARCH_MANUAL') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_IDENTIFICATION_METHOD', DETAIL = pg_catalog.jsonb_build_object('message', 'Método de identificación no soportado.', 'retryable', false)::text;
    END IF;
    v_clean_scanned_code := CASE WHEN p_scanned_code IS NULL THEN NULL ELSE pg_catalog.btrim(p_scanned_code) END;
    IF p_identification_method IN ('BARCODE', 'SKU_MANUAL') AND (v_clean_scanned_code IS NULL OR v_clean_scanned_code = '') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'El código escaneado es obligatorio para este método.', 'retryable', false)::text;
    END IF;
    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, z.session_id, z.snapshot_id, z.id, t.id, t.validation_cycle, a.id, true
    INTO v_company_id, v_session_id, v_snapshot_id, v_session_zone_id, v_task_id, v_task_cycle, v_assignment_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id AND a.user_id = v_actor_id AND a.released_at IS NULL
      AND p.user_id = v_actor_id AND p.active_from <= pg_catalog.now() AND p.revoked_at IS NULL
      AND s.status = 'COUNTING' AND z.is_enabled = true AND t.status = 'IN_PROGRESS'
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_permission(v_company_id, 'inventarios.sessions.read');

    SELECT true, szl.snapshot_location_id INTO v_is_open, v_snapshot_location_id
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id AND tl.task_id = v_task_id AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id AND tl.status = 'OPEN';
    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    SELECT sp.barcode, sp.sku INTO v_actual_barcode, v_actual_sku
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.id = p_snapshot_product_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_PRODUCT', DETAIL = pg_catalog.jsonb_build_object('message', 'El producto no pertenece al inventario activo.', 'retryable', false)::text;
    END IF;
    IF p_identification_method = 'BARCODE' AND (v_actual_barcode IS NULL OR v_clean_scanned_code <> v_actual_barcode) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_PRODUCT_IDENTITY_MISMATCH', DETAIL = pg_catalog.jsonb_build_object('message', 'El barcode capturado no corresponde al producto seleccionado.', 'retryable', false)::text;
    END IF;
    IF p_identification_method = 'SKU_MANUAL' AND (v_actual_sku IS NULL OR v_clean_scanned_code <> v_actual_sku) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_PRODUCT_IDENTITY_MISMATCH', DETAIL = pg_catalog.jsonb_build_object('message', 'El SKU ingresado no corresponde al producto seleccionado.', 'retryable', false)::text;
    END IF;

    v_request_payload := pg_catalog.jsonb_build_object('operation', 'inventarios.mobile.count.submit', 'zone_id', p_zone_id, 'location_id', p_location_id, 'snapshot_product_id', p_snapshot_product_id, 'physical_quantity', p_physical_quantity, 'identification_method', p_identification_method, 'scanned_code', v_clean_scanned_code, 'captured_at', p_captured_at, 'device_id', v_clean_device_id);
    v_request_hash := inventarios.compute_request_hash(v_request_payload);
    v_operation := inventarios.begin_idempotent_operation(v_company_id, 'inventarios.mobile.count.submit', p_idempotency_key, v_request_hash);
    v_count_event_key := (pg_catalog.md5(p_idempotency_key::text || ':COUNT_RECORDED'))::uuid;
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        v_replay_payload := v_operation -> 'response_payload';
        v_count_entry_id := (v_replay_payload ->> 'entity_id')::uuid;
        v_count_event_id := (v_replay_payload -> 'data' ->> 'count_event_id')::uuid;
        IF NOT EXISTS (SELECT 1 FROM inventarios.count_entries ce WHERE ce.company_id = v_company_id AND ce.session_id = v_session_id AND ce.task_id = v_task_id AND ce.snapshot_product_id = p_snapshot_product_id AND ce.snapshot_location_id = v_snapshot_location_id AND ce.id = v_count_entry_id AND ce.offline_id = p_idempotency_key) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        SELECT te.id, te.technical_metadata INTO v_count_event_id, v_count_event_payload FROM inventarios.task_events te WHERE te.company_id = v_company_id AND te.task_id = v_task_id AND te.idempotency_key = v_count_event_key;
        IF v_count_event_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM inventarios.task_events te WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.session_zone_id = v_session_zone_id AND te.task_id = v_task_id AND te.id = v_count_event_id AND te.event_type = 'COUNT_RECORDED' AND te.idempotency_key = v_count_event_key AND te.technical_metadata ->> 'count_entry_id' = v_count_entry_id::text AND te.technical_metadata ->> 'snapshot_product_id' = p_snapshot_product_id::text) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_IDEMPOTENCY_CONFLICT', DETAIL = pg_catalog.jsonb_build_object('message', 'La clave de idempotencia ya fue usada con una solicitud distinta.', 'retryable', false)::text;
        END IF;
        RETURN v_replay_payload;
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    v_quantities_payload := pg_catalog.jsonb_build_object('available_quantity', p_physical_quantity, 'blocked_quantity', 0, 'damaged_quantity', 0, 'expired_quantity', 0, 'other_unavailable_quantity', 0);
    v_count_result := inventarios.record_inventory_count(v_company_id, v_task_id, v_task_cycle, p_snapshot_product_id, v_snapshot_location_id, v_quantities_payload, p_identification_method, v_clean_scanned_code, 'MOBILE', p_idempotency_key, v_clean_device_id, p_captured_at, p_idempotency_key);
    v_count_entry_id := (v_count_result ->> 'entity_id')::uuid;
    v_count_occurred_at := COALESCE((v_count_result ->> 'occurred_at')::timestamptz, pg_catalog.now());
    INSERT INTO inventarios.task_events (company_id, session_id, session_zone_id, task_id, event_type, previous_status, next_status, actor_id, cycle, occurred_at, idempotency_key, source, technical_metadata, created_at, created_by)
    VALUES (v_company_id, v_session_id, v_session_zone_id, v_task_id, 'COUNT_RECORDED', 'IN_PROGRESS', 'IN_PROGRESS', v_actor_id, v_task_cycle, v_count_occurred_at, v_count_event_key, 'ANDROID', pg_catalog.jsonb_build_object('count_entry_id', v_count_entry_id, 'snapshot_product_id', p_snapshot_product_id), v_count_occurred_at, v_actor_id)
    ON CONFLICT (company_id, idempotency_key) DO NOTHING;
    SELECT te.id, te.technical_metadata INTO v_count_event_id, v_count_event_payload FROM inventarios.task_events te WHERE te.company_id = v_company_id AND te.task_id = v_task_id AND te.idempotency_key = v_count_event_key;
    IF v_count_event_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM inventarios.task_events te WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.session_zone_id = v_session_zone_id AND te.task_id = v_task_id AND te.id = v_count_event_id AND te.event_type = 'COUNT_RECORDED' AND te.idempotency_key = v_count_event_key AND te.technical_metadata ->> 'count_entry_id' = v_count_entry_id::text AND te.technical_metadata ->> 'snapshot_product_id' = p_snapshot_product_id::text) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_IDEMPOTENCY_CONFLICT', DETAIL = pg_catalog.jsonb_build_object('message', 'La clave de idempotencia ya fue usada con una solicitud distinta.', 'retryable', false)::text;
    END IF;
    v_response := pg_catalog.jsonb_build_object('operation', 'inventarios.mobile.count.submit', 'entity_id', v_count_entry_id, 'state', NULL::text, 'version', NULL::integer, 'cycle_number', v_task_cycle, 'assignment_id', v_assignment_id, 'event_id', v_count_event_id, 'replayed', false, 'occurred_at', v_count_occurred_at, 'data', COALESCE(v_count_result -> 'data', '{}'::jsonb) || pg_catalog.jsonb_build_object('count_event_id', v_count_event_id));
    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_count_entry_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.submit_my_mobile_count(uuid, uuid, uuid, numeric, text, text, uuid, timestamptz, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.submit_my_mobile_count(uuid, uuid, uuid, numeric, text, text, uuid, timestamptz, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.submit_my_mobile_count(uuid, uuid, uuid, numeric, text, text, uuid, timestamptz, text) TO authenticated;

CREATE OR REPLACE FUNCTION inventarios.submit_mobile_discovery_count(
    p_zone_id uuid,
    p_location_id uuid,
    p_bsale_variant_id integer,
    p_physical_quantity numeric,
    p_scanned_code text,
    p_evidence_storage_path text,
    p_evidence_mime_type text,
    p_evidence_file_size bigint,
    p_evidence_sha256 text,
    p_idempotency_key uuid,
    p_captured_at timestamptz,
    p_device_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_task_id uuid;
    v_session_id uuid;
    v_session_zone_id uuid;
    v_snapshot_id uuid;
    v_task_cycle integer;
    v_assignment_id uuid;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
    v_snapshot_location_id uuid;
    v_snapshot_product_id uuid;
    v_master_product_id uuid;
    v_master_sku text;
    v_master_barcode text;
    v_master_name text;
    v_clean_scanned_code text;
    v_clean_storage_path text;
    v_clean_mime_type text;
    v_clean_sha256 text;
    v_clean_device_id text;
    v_extension text;
    v_expected_storage_path text;
    v_storage_meta jsonb;
    v_request_payload jsonb;
    v_request_hash text;
    v_operation jsonb;
    v_operation_id uuid;
    v_count_result jsonb;
    v_count_entry_id uuid;
    v_count_event_id uuid;
    v_count_idempotency_key uuid;
    v_count_event_key uuid;
    v_proposal_id uuid;
    v_evidence_id uuid;
    v_discovery_event_id uuid;
    v_discovery_event_key uuid;
    v_response jsonb;
    v_occurred_at timestamptz;
    v_captured_at timestamptz;
    v_replay_payload jsonb;
BEGIN
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_bsale_variant_id IS NULL OR p_physical_quantity IS NULL OR p_physical_quantity < 0 OR p_idempotency_key IS NULL OR p_captured_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_clean_scanned_code := pg_catalog.btrim(p_scanned_code);
    v_clean_storage_path := pg_catalog.btrim(p_evidence_storage_path);
    v_clean_mime_type := pg_catalog.btrim(p_evidence_mime_type);
    v_clean_sha256 := pg_catalog.btrim(p_evidence_sha256);
    v_clean_device_id := pg_catalog.btrim(p_device_id);
    IF v_clean_scanned_code IS NULL OR v_clean_scanned_code = '' OR v_clean_storage_path IS NULL OR v_clean_storage_path = '' OR v_clean_mime_type IS NULL OR v_clean_mime_type = '' OR v_clean_sha256 IS NULL OR v_clean_sha256 = '' OR v_clean_device_id IS NULL OR v_clean_device_id = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    IF p_evidence_file_size IS NULL OR p_evidence_file_size < 1 OR p_evidence_file_size > 10485760 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    IF v_clean_sha256 !~ '^[0-9A-Fa-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    CASE v_clean_mime_type
        WHEN 'image/jpeg' THEN v_extension := '.jpg';
        WHEN 'image/png' THEN v_extension := '.png';
        WHEN 'image/webp' THEN v_extension := '.webp';
        ELSE
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END CASE;
    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.snapshot_id, z.id, t.validation_cycle, a.id, true
    INTO v_company_id, v_task_id, v_session_id, v_snapshot_id, v_session_zone_id, v_task_cycle, v_assignment_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id AND a.user_id = v_actor_id AND a.released_at IS NULL
      AND p.user_id = v_actor_id AND p.active_from <= pg_catalog.now() AND p.revoked_at IS NULL
      AND s.status = 'COUNTING' AND z.is_enabled = true AND t.status = 'IN_PROGRESS'
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;
    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_permission(v_company_id, 'inventarios.sessions.read');

    SELECT true, szl.snapshot_location_id INTO v_is_open, v_snapshot_location_id
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id AND tl.task_id = v_task_id AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id AND tl.status = 'OPEN';
    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    v_expected_storage_path := v_company_id::text || '/' || v_session_id::text || '/' || v_actor_id::text || '/' || p_idempotency_key::text || v_extension;
    v_count_idempotency_key := (pg_catalog.md5(p_idempotency_key::text || ':COUNT'))::uuid;
    v_count_event_key := (pg_catalog.md5(v_count_idempotency_key::text || ':COUNT_RECORDED'))::uuid;
    v_discovery_event_key := (pg_catalog.md5(p_idempotency_key::text || ':DISCOVERY_RECORDED'))::uuid;
    IF v_clean_storage_path <> v_expected_storage_path THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    SELECT p.id, bv.code, bv.bar_code, pg_catalog.concat_ws(' - ', bp.name, bv.description)
    INTO v_master_product_id, v_master_sku, v_master_barcode, v_master_name
    FROM adquisiciones.products p
    JOIN integraciones.bsale_variants bv ON bv.company_id = p.company_id AND bv.bsale_id = p.bsale_variant_id
    JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
    WHERE p.company_id = v_company_id AND p.is_active = true AND bv.state = 0 AND bp.state = 0 AND bv.bsale_id = p_bsale_variant_id AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> ''
    ORDER BY p.updated_at DESC NULLS LAST, p.id, bv.id, bp.id LIMIT 1;
    IF v_master_sku IS NULL OR v_master_name IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_PRODUCT', DETAIL = pg_catalog.jsonb_build_object('message', 'El producto no pertenece al inventario activo.', 'retryable', false)::text;
    END IF;

    v_request_payload := pg_catalog.jsonb_build_object('operation', 'inventarios.mobile.discovery.submit', 'zone_id', p_zone_id, 'location_id', p_location_id, 'bsale_variant_id', p_bsale_variant_id, 'physical_quantity', p_physical_quantity, 'scanned_code', v_clean_scanned_code, 'evidence_storage_path', v_clean_storage_path, 'evidence_mime_type', v_clean_mime_type, 'evidence_file_size', p_evidence_file_size, 'evidence_sha256', v_clean_sha256, 'captured_at', p_captured_at, 'device_id', v_clean_device_id);
    v_request_hash := inventarios.compute_request_hash(v_request_payload);
    v_operation := inventarios.begin_idempotent_operation(v_company_id, 'inventarios.mobile.discovery.submit', p_idempotency_key, v_request_hash);
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        v_replay_payload := v_operation -> 'response_payload';
        v_count_entry_id := (v_replay_payload ->> 'entity_id')::uuid;
        v_count_event_id := (v_replay_payload -> 'data' ->> 'count_event_id')::uuid;
        v_snapshot_product_id := (v_replay_payload -> 'data' ->> 'snapshot_product_id')::uuid;
        v_proposal_id := (v_replay_payload -> 'data' ->> 'proposal_id')::uuid;
        v_evidence_id := (v_replay_payload -> 'data' ->> 'evidence_file_id')::uuid;
        v_discovery_event_id := (v_replay_payload -> 'data' ->> 'discovery_event_id')::uuid;
        IF NOT EXISTS (SELECT 1 FROM inventarios.snapshot_products sp WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.id = v_snapshot_product_id AND sp.bsale_variant_id = p_bsale_variant_id) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM inventarios.count_entries ce WHERE ce.company_id = v_company_id AND ce.session_id = v_session_id AND ce.task_id = v_task_id AND ce.snapshot_location_id = v_snapshot_location_id AND ce.snapshot_product_id = v_snapshot_product_id AND ce.id = v_count_entry_id AND ce.offline_id = v_count_idempotency_key) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM inventarios.product_barcode_proposals pbp WHERE pbp.company_id = v_company_id AND pbp.session_id = v_session_id AND pbp.id = v_proposal_id AND pbp.count_entry_id = v_count_entry_id) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM inventarios.evidence_files ef WHERE ef.company_id = v_company_id AND ef.session_id = v_session_id AND ef.id = v_evidence_id AND ef.proposal_id = v_proposal_id AND ef.storage_bucket = 'inventory-evidence' AND ef.storage_path = v_expected_storage_path) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM inventarios.task_events te WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.session_zone_id = v_session_zone_id AND te.task_id = v_task_id AND te.id = v_count_event_id AND te.event_type = 'COUNT_RECORDED' AND te.idempotency_key = v_count_event_key AND te.technical_metadata ->> 'count_entry_id' = v_count_entry_id::text AND te.technical_metadata ->> 'snapshot_product_id' = v_snapshot_product_id::text) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM inventarios.task_events te WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.task_id = v_task_id AND te.id = v_discovery_event_id AND te.event_type = 'DISCOVERY_RECORDED' AND te.idempotency_key = v_discovery_event_key AND te.technical_metadata ->> 'count_entry_id' = v_count_entry_id::text AND te.technical_metadata ->> 'proposal_id' = v_proposal_id::text AND te.technical_metadata ->> 'evidence_id' = v_evidence_id::text) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        RETURN v_replay_payload;
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    v_occurred_at := pg_catalog.now();
    v_captured_at := p_captured_at;
    IF v_captured_at > v_occurred_at THEN v_captured_at := v_occurred_at; END IF;
    SELECT so.metadata INTO v_storage_meta FROM storage.objects so WHERE so.bucket_id = 'inventory-evidence' AND so.name = v_expected_storage_path AND so.owner = v_actor_id;
    IF v_storage_meta IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text; END IF;
    IF COALESCE((v_storage_meta ->> 'size')::bigint, 0) <> p_evidence_file_size OR p_evidence_file_size < 1 OR p_evidence_file_size > 10485760 THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text; END IF;
    IF COALESCE(v_storage_meta ->> 'mimetype', '') <> v_clean_mime_type THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text; END IF;
    IF EXISTS (SELECT 1 FROM inventarios.evidence_files ef WHERE ef.storage_bucket = 'inventory-evidence' AND ef.storage_path = v_expected_storage_path) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text; END IF;
    INSERT INTO inventarios.snapshot_products (company_id, snapshot_id, product_id, bsale_variant_id, sku, barcode, name, product_metadata, created_by)
    VALUES (v_company_id, v_snapshot_id, v_master_product_id, p_bsale_variant_id, v_master_sku, v_master_barcode, v_master_name, NULL::jsonb, v_actor_id)
    ON CONFLICT (company_id, snapshot_id, bsale_variant_id) DO NOTHING;
    SELECT sp.id INTO v_snapshot_product_id FROM inventarios.snapshot_products sp WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.bsale_variant_id = p_bsale_variant_id ORDER BY sp.id LIMIT 1;
    IF v_snapshot_product_id IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text; END IF;
    v_count_result := inventarios.submit_my_mobile_count(p_zone_id, p_location_id, v_snapshot_product_id, p_physical_quantity, 'SEARCH_MANUAL', v_clean_scanned_code, v_count_idempotency_key, v_captured_at, v_clean_device_id);
    v_count_entry_id := (v_count_result ->> 'entity_id')::uuid;
    v_count_event_id := (v_count_result -> 'data' ->> 'count_event_id')::uuid;
    INSERT INTO inventarios.product_barcode_proposals (company_id, session_id, count_entry_id, scanned_code, status, proposed_by, proposed_at, created_by, updated_by)
    VALUES (v_company_id, v_session_id, v_count_entry_id, v_clean_scanned_code, 'PENDING_REVIEW', v_actor_id, v_captured_at, v_actor_id, v_actor_id) RETURNING id INTO v_proposal_id;
    INSERT INTO inventarios.evidence_files (company_id, session_id, proposal_id, storage_bucket, storage_path, original_name, mime_type, file_size_bytes, sha256, captured_by, captured_at, uploaded_by, uploaded_at, device_id, offline_idempotency_key, source, sync_status, created_by, updated_by)
    VALUES (v_company_id, v_session_id, v_proposal_id, 'inventory-evidence', v_expected_storage_path, p_idempotency_key::text || v_extension, v_clean_mime_type, p_evidence_file_size, v_clean_sha256, v_actor_id, v_captured_at, v_actor_id, v_occurred_at, v_clean_device_id, p_idempotency_key, 'ANDROID', 'PENDING', v_actor_id, v_actor_id) RETURNING id INTO v_evidence_id;
    IF v_count_event_id IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text; END IF;
    INSERT INTO inventarios.task_events (company_id, session_id, session_zone_id, task_id, event_type, previous_status, next_status, actor_id, cycle, occurred_at, idempotency_key, source, technical_metadata, created_at, created_by)
    VALUES (v_company_id, v_session_id, v_session_zone_id, v_task_id, 'DISCOVERY_RECORDED', 'IN_PROGRESS', 'IN_PROGRESS', v_actor_id, v_task_cycle, v_occurred_at, v_discovery_event_key, 'ANDROID', pg_catalog.jsonb_build_object('count_entry_id', v_count_entry_id, 'proposal_id', v_proposal_id, 'evidence_id', v_evidence_id), v_occurred_at, v_actor_id)
    RETURNING id INTO v_discovery_event_id;
    v_response := pg_catalog.jsonb_build_object('operation', 'inventarios.mobile.discovery.submit', 'entity_id', v_count_entry_id, 'state', 'IN_PROGRESS', 'version', NULL::integer, 'cycle_number', v_task_cycle, 'assignment_id', v_assignment_id, 'event_id', v_discovery_event_id, 'replayed', false, 'occurred_at', v_occurred_at, 'data', pg_catalog.jsonb_build_object('snapshot_product_id', v_snapshot_product_id, 'count_entry_id', v_count_entry_id, 'count_event_id', v_count_event_id, 'proposal_id', v_proposal_id, 'evidence_file_id', v_evidence_id, 'discovery_event_id', v_discovery_event_id, 'bsale_variant_id', p_bsale_variant_id, 'storage_bucket', 'inventory-evidence', 'storage_path', v_expected_storage_path));
    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_count_entry_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.submit_mobile_discovery_count(uuid, uuid, integer, numeric, text, text, text, bigint, text, uuid, timestamptz, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.submit_mobile_discovery_count(uuid, uuid, integer, numeric, text, text, text, bigint, text, uuid, timestamptz, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.submit_mobile_discovery_count(uuid, uuid, integer, numeric, text, text, text, bigint, text, uuid, timestamptz, text) TO authenticated;
