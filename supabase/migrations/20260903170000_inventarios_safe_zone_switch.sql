BEGIN;

-- Las tareas pausadas no impiden iniciar otra tarea del mismo actor.
CREATE OR REPLACE FUNCTION inventarios.start_inventory_task(
    p_company_id uuid,
    p_task_id uuid,
    p_expected_version integer,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
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

    v_participant_id := inventarios.require_active_assignment_participant(
        p_company_id, v_task_session_id, v_actor_id, v_assignment_participant_id
    );

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
          AND t_active.status = 'IN_PROGRESS'
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

-- Las tareas pausadas no impiden reanudar otra tarea del mismo actor.
CREATE OR REPLACE FUNCTION inventarios.resume_inventory_task(
    p_company_id pg_catalog.uuid,
    p_task_id pg_catalog.uuid,
    p_expected_version integer,
    p_idempotency_key pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $function$
DECLARE
    v_actor_id pg_catalog.uuid;
    v_participant_id pg_catalog.uuid;
    v_operation pg_catalog.jsonb;
    v_operation_id pg_catalog.uuid;
    v_session_id pg_catalog.uuid;
    v_zone_id pg_catalog.uuid;
    v_status pg_catalog.text;
    v_version integer;
    v_cycle integer;
    v_current_assignment_id pg_catalog.uuid;
    v_assignment_id pg_catalog.uuid;
    v_assignment_user_id pg_catalog.uuid;
    v_assignment_participant_id pg_catalog.uuid;
    v_assignment_count bigint;
    v_occurred_at timestamptz;
    v_event_id pg_catalog.uuid;
    v_payload pg_catalog.jsonb;
    v_response pg_catalog.jsonb;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL OR p_expected_version IS NULL
       OR p_expected_version <= 0 OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.tasks.execute');

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.actor_operational_task'),
        pg_catalog.hashtext(v_actor_id::text)
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.resume_inventory_task'),
        pg_catalog.hashtext(p_company_id::text || ':' || v_actor_id::text)
    );

    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.resume',
        'company_id', p_company_id,
        'task_id', p_task_id,
        'expected_version', p_expected_version
    );
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id, 'inventarios.task.resume', p_idempotency_key,
        inventarios.compute_request_hash(v_payload)
    );

    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;

    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT t.session_id, t.session_zone_id, t.status, t.version, t.validation_cycle, t.current_assignment_id
    INTO v_session_id, v_zone_id, v_status, v_version, v_cycle, v_current_assignment_id
    FROM inventarios.tasks AS t
    WHERE t.company_id = p_company_id AND t.id = p_task_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    PERFORM inventarios.require_session_counting(p_company_id, v_session_id);

    IF v_status <> 'PAUSED' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_TASK_INVALID_STATE',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea no permite esta operacion en su estado actual.', 'retryable', false)::text;
    END IF;

    IF v_version <> p_expected_version THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea fue modificada por otra operacion.', 'retryable', true)::text;
    END IF;

    v_participant_id := inventarios.require_session_participant(p_company_id, v_session_id, 'COUNTER');

    SELECT pg_catalog.count(*),
           (pg_catalog.array_agg(ta.id ORDER BY ta.id))[1],
           (pg_catalog.array_agg(ta.user_id ORDER BY ta.id))[1],
           (pg_catalog.array_agg(ta.session_participant_id ORDER BY ta.id))[1]
    INTO v_assignment_count, v_assignment_id, v_assignment_user_id, v_assignment_participant_id
    FROM inventarios.task_assignments AS ta
    WHERE ta.company_id = p_company_id AND ta.session_id = v_session_id
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
       OR v_assignment_user_id IS DISTINCT FROM v_actor_id
       OR v_assignment_participant_id IS DISTINCT FROM v_participant_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ASSIGNMENT_REQUIRED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes una asignacion vigente para esta tarea.', 'retryable', false)::text;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM inventarios.tasks t_active
        JOIN inventarios.task_assignments ta_active ON ta_active.task_id = t_active.id
        WHERE ta_active.user_id = v_actor_id
          AND ta_active.released_at IS NULL
          AND t_active.status = 'IN_PROGRESS'
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
        paused_at = NULL,
        paused_by = NULL,
        active_user_id = v_actor_id,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE t.company_id = p_company_id AND t.id = p_task_id;

    INSERT INTO inventarios.task_events (
        company_id, session_id, session_zone_id, task_id,
        event_type, previous_status, next_status, actor_id, next_user_id, cycle,
        occurred_at, idempotency_key, created_by
    )
    VALUES (
        p_company_id, v_session_id, v_zone_id, p_task_id,
        'RESUMED', 'PAUSED', 'IN_PROGRESS', v_actor_id, v_actor_id, v_cycle,
        v_occurred_at, p_idempotency_key, v_actor_id
    )
    RETURNING id INTO v_event_id;

    INSERT INTO inventarios.task_state_transitions (
        company_id, session_id, session_zone_id, task_id, assignment_id,
        operation_idempotency_id, transition_type, previous_status,
        next_status, previous_version, next_version, previous_cycle, next_cycle,
        actor_id, occurred_at
    )
    VALUES (
        p_company_id, v_session_id, v_zone_id, p_task_id, v_assignment_id,
        v_operation_id, 'RESUMED', 'PAUSED', 'IN_PROGRESS', v_version, v_version + 1,
        v_cycle, v_cycle, v_actor_id, v_occurred_at
    );

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.resume',
        'entity_id', p_task_id,
        'state', 'IN_PROGRESS',
        'version', v_version + 1,
        'cycle_number', v_cycle,
        'assignment_id', v_assignment_id,
        'event_id', v_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object()
    );

    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_task_id, v_response);
END;
$function$;

-- Serializa el cambio de zona y pausa la tarea anterior sin cerrar ubicaciones.
CREATE OR REPLACE FUNCTION inventarios.start_my_counting_zone(
    p_zone_id pg_catalog.uuid,
    p_idempotency_key pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $function$
DECLARE
    v_actor_id pg_catalog.uuid;
    v_company_id pg_catalog.uuid;
    v_task_id pg_catalog.uuid;
    v_task_version integer;
    v_task_status pg_catalog.text;
    v_task_active_user_id pg_catalog.uuid;
    v_task_cycle integer;
    v_current_assignment_id pg_catalog.uuid;
    v_is_authorized boolean := false;
    v_previous_count bigint;
    v_previous_company_id pg_catalog.uuid;
    v_previous_task_id pg_catalog.uuid;
    v_previous_version integer;
    v_occurred_at timestamptz;
BEGIN
    IF p_zone_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.actor_operational_task'),
        pg_catalog.hashtext(v_actor_id::text)
    );

    SELECT z.company_id, t.id, t.version, t.status, t.active_user_id,
           t.validation_cycle, t.current_assignment_id, true
    INTO v_company_id, v_task_id, v_task_version, v_task_status, v_task_active_user_id,
         v_task_cycle, v_current_assignment_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL
    LIMIT 1
    FOR UPDATE OF t;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona de conteo o la sesion no es valida.', 'retryable', false)::text;
    END IF;

    SELECT pg_catalog.count(DISTINCT t_previous.id),
           (pg_catalog.array_agg(DISTINCT t_previous.company_id ORDER BY t_previous.company_id))[1],
           (pg_catalog.array_agg(DISTINCT t_previous.id ORDER BY t_previous.id))[1],
           (pg_catalog.array_agg(DISTINCT t_previous.version ORDER BY t_previous.version))[1]
    INTO v_previous_count, v_previous_company_id, v_previous_task_id, v_previous_version
    FROM inventarios.tasks t_previous
    JOIN inventarios.task_assignments a_previous ON a_previous.task_id = t_previous.id
    WHERE a_previous.user_id = v_actor_id
      AND a_previous.released_at IS NULL
      AND t_previous.status = 'IN_PROGRESS'
      AND t_previous.id <> v_task_id
      AND t_previous.cancelled_at IS NULL
      AND t_previous.superseded_at IS NULL
      AND t_previous.invalidated_at IS NULL;

    IF v_previous_count > 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto mas de una tarea en progreso para el actor.', 'retryable', true)::text;
    END IF;

    IF v_previous_count = 1 AND EXISTS (
        SELECT 1
        FROM inventarios.task_locations tl
        WHERE tl.task_id = v_previous_task_id
          AND tl.status = 'OPEN'
          AND tl.opened_by = v_actor_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ZONE_SWITCH_LOCATION_OPEN',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Finaliza la ubicación abierta antes de cambiar de zona.', 'retryable', false)::text;
    END IF;

    IF v_previous_count = 1 THEN
        PERFORM inventarios.pause_inventory_task(
            v_previous_company_id,
            v_previous_task_id,
            v_previous_version,
            pg_catalog.md5(p_idempotency_key::text || ':AUTO_PAUSE:' || v_previous_task_id::text)::uuid
        );
    END IF;

    IF v_task_status = 'ASSIGNED' THEN
        RETURN inventarios.start_inventory_task(
            v_company_id, v_task_id, v_task_version, p_idempotency_key
        );
    ELSIF v_task_status = 'PAUSED' THEN
        RETURN inventarios.resume_inventory_task(
            v_company_id, v_task_id, v_task_version, p_idempotency_key
        );
    ELSIF v_task_status = 'IN_PROGRESS' AND v_task_active_user_id = v_actor_id THEN
        v_occurred_at := pg_catalog.now();
        RETURN pg_catalog.jsonb_build_object(
            'operation', 'inventarios.mobile.zone.start',
            'entity_id', v_task_id,
            'state', 'IN_PROGRESS',
            'version', v_task_version,
            'cycle_number', v_task_cycle,
            'assignment_id', v_current_assignment_id,
            'event_id', NULL,
            'replayed', false,
            'occurred_at', v_occurred_at,
            'data', pg_catalog.jsonb_build_object('changed', false)
        );
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_TASK_INVALID_STATE',
        DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea no permite esta operacion en su estado actual.', 'retryable', false)::text;
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.start_inventory_task(uuid, uuid, integer, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.resume_inventory_task(uuid, uuid, integer, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.start_my_counting_zone(uuid, uuid) TO authenticated;

COMMIT;
