CREATE OR REPLACE FUNCTION inventarios.cancel_inventory_task(
    p_company_id uuid,
    p_task_id uuid,
    p_expected_version integer,
    p_expected_cycle integer,
    p_reason text,
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
    v_operation jsonb;
    v_operation_id uuid;
    v_session_id uuid;
    v_session_zone_id uuid;
    v_task_status text;
    v_task_version integer;
    v_task_cycle integer;
    v_current_assignment_id uuid;
    v_active_user_id uuid;
    v_cancelled_at timestamptz;
    v_cancelled_by uuid;
    v_session_status text;
    v_active_role_count bigint;
    v_historical_role_count bigint;
    v_previous_assignment_id uuid;
    v_previous_user_id uuid;
    v_reason text;
    v_payload jsonb;
    v_occurred_at timestamptz;
    v_event_id uuid;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL
       OR p_expected_version IS NULL OR p_expected_version < 1
       OR p_expected_cycle IS NULL OR p_expected_cycle < 1
       OR p_reason IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_reason := pg_catalog.btrim(p_reason);
    IF v_reason = '' OR pg_catalog.char_length(v_reason) < 5 OR pg_catalog.char_length(v_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.tasks.cancel');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.cancel_inventory_task'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_task_id::text)
    );

    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.cancel',
        'company_id', p_company_id,
        'task_id', p_task_id,
        'expected_version', p_expected_version,
        'expected_cycle', p_expected_cycle,
        'reason', v_reason
    );
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,
        'inventarios.task.cancel',
        p_idempotency_key,
        inventarios.compute_request_hash(v_payload)
    );
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT t.session_id, t.session_zone_id, t.status, t.version, t.validation_cycle,
           t.current_assignment_id, t.active_user_id, t.cancelled_at, t.cancelled_by
    INTO v_session_id, v_session_zone_id, v_task_status, v_task_version, v_task_cycle,
         v_current_assignment_id, v_active_user_id, v_cancelled_at, v_cancelled_by
    FROM inventarios.tasks AS t
    WHERE t.company_id = p_company_id AND t.id = p_task_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    IF v_cancelled_at IS NOT NULL OR v_cancelled_by IS NOT NULL THEN
        IF v_cancelled_at IS NULL OR v_cancelled_by IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
                DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea fue modificada por otra operacion.', 'retryable', true)::text;
        END IF;
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_TASK_ALREADY_CANCELLED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea ya fue cancelada.', 'retryable', false)::text;
    END IF;
    IF v_task_status NOT IN ('ASSIGNED', 'PAUSED') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_TASK_INVALID_STATE',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea no permite esta operacion en su estado actual.', 'retryable', false)::text;
    END IF;
    IF v_task_version <> p_expected_version OR v_task_cycle <> p_expected_cycle OR v_active_user_id IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea fue modificada por otra operacion.', 'retryable', true)::text;
    END IF;

    SELECT s.status INTO v_session_status
    FROM inventarios.sessions AS s
    WHERE s.company_id = p_company_id AND s.id = v_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    IF v_session_status NOT IN ('DRAFT', 'PREPARED', 'COUNTING', 'UNDER_REVIEW') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SESSION_INVALID_STATE',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La jornada no permite operaciones de participantes.', 'retryable', false)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_active_role_count
    FROM inventarios.session_participants AS sp
    WHERE sp.company_id = p_company_id AND sp.session_id = v_session_id
      AND sp.user_id = v_actor_id
      AND sp.functional_role IN ('SUPERVISOR', 'ADMINISTRATOR')
      AND sp.active_from <= pg_catalog.now() AND sp.revoked_at IS NULL;
    IF v_active_role_count = 0 THEN
        SELECT pg_catalog.count(*) INTO v_historical_role_count
        FROM inventarios.session_participants AS sp
        WHERE sp.company_id = p_company_id AND sp.session_id = v_session_id
          AND sp.user_id = v_actor_id
          AND sp.functional_role IN ('SUPERVISOR', 'ADMINISTRATOR');
        IF v_historical_role_count = 0 THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
                DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_PARTICIPANT_INACTIVE',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes una participacion activa en la jornada.', 'retryable', false)::text;
    END IF;

    IF v_current_assignment_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
    END IF;
    SELECT ta.id, ta.user_id INTO v_previous_assignment_id, v_previous_user_id
    FROM inventarios.task_assignments AS ta
    WHERE ta.company_id = p_company_id AND ta.session_id = v_session_id
      AND ta.task_id = p_task_id AND ta.id = v_current_assignment_id
      AND ta.released_at IS NULL
    FOR UPDATE;
    IF NOT FOUND OR v_previous_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
    END IF;

    v_occurred_at := pg_catalog.now();
    UPDATE inventarios.task_assignments AS ta
    SET released_at = v_occurred_at, released_by = v_actor_id, release_reason = v_reason
    WHERE ta.company_id = p_company_id AND ta.id = v_previous_assignment_id;

    INSERT INTO inventarios.task_events AS e (
        company_id, session_id, session_zone_id, task_id, event_type, actor_id,
        previous_user_id, cycle, occurred_at, reason, idempotency_key,
        technical_metadata, created_by
    ) VALUES (
        p_company_id, v_session_id, v_session_zone_id, p_task_id, 'CANCELLED', v_actor_id,
        v_previous_user_id, v_task_cycle, v_occurred_at, v_reason, p_idempotency_key,
        pg_catalog.jsonb_build_object(
            'previous_assignment_id', v_previous_assignment_id,
            'previous_user_id', v_previous_user_id
        ),
        v_actor_id
    ) RETURNING e.id INTO v_event_id;

    UPDATE inventarios.tasks AS t
    SET cancelled_at = v_occurred_at,
        cancelled_by = v_actor_id,
        current_assignment_id = NULL,
        active_user_id = NULL,
        version = t.version + 1,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE t.company_id = p_company_id AND t.id = p_task_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.cancel',
        'entity_id', p_task_id,
        'state', v_task_status,
        'version', v_task_version + 1,
        'cycle_number', v_task_cycle,
        'assignment_id', NULL::uuid,
        'event_id', v_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'previous_assignment_id', v_previous_assignment_id,
            'previous_user_id', v_previous_user_id,
            'reason', v_reason
        )
    );
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_task_id, v_response);
END;
$$;

ALTER FUNCTION inventarios.cancel_inventory_task(uuid, uuid, integer, integer, text, uuid)
    OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.cancel_inventory_task(uuid, uuid, integer, integer, text, uuid)
FROM PUBLIC, anon, authenticated, service_role;
