-- =========================================================================================
-- MIGRATION: M1.5E.4 - Autorizacion operativa para inicio de zona desde app movil
-- =========================================================================================

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

    v_actor_id := inventarios.require_company_access(p_company_id);

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

    v_participant_id := inventarios.require_session_participant(p_company_id, v_task_session_id, 'COUNTER');

    IF v_assignment_participant_id IS DISTINCT FROM v_participant_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ASSIGNMENT_REQUIRED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes una asignacion vigente para esta tarea.', 'retryable', false)::text;
    END IF;

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
