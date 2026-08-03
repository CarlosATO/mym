-- Migration: 20260803085000_inventarios_phase_04g3b_task_counting_guards.sql
-- Description: Fase 4G.3b. Guardas de sesion COUNTING en las RPCs de ejecucion
--              de tareas (start, pause, resume, complete). Helper compartido
--              require_session_counting. No cambia estados ni transiciones.
-- Author: Assistant

-- ============================================================
-- 1. HELPER: require_session_counting
--    Valida que la jornada este en COUNTING. Rechaza con
--    INV_SESSION_INVALID_STATE en cualquier otro estado.
-- ============================================================
CREATE FUNCTION inventarios.require_session_counting(
    p_company_id uuid,
    p_session_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_status text;
BEGIN
    SELECT s.status INTO v_status
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_status <> 'COUNTING' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SESSION_INVALID_STATE',
            DETAIL = pg_catalog.jsonb_build_object('message','La jornada no esta en conteo.','retryable',false,'session_status',v_status)::text;
    END IF;
END;
$$;

ALTER FUNCTION inventarios.require_session_counting(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.require_session_counting(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- 2. start_inventory_task: agrega guarda COUNTING
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.start_inventory_task(
    p_company_id uuid,
    p_task_id uuid,
    p_expected_version integer,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_actor_id uuid; v_participant_id uuid; v_operation jsonb; v_operation_id uuid;
    v_request_payload jsonb; v_request_hash text;
    v_task_session_id uuid; v_task_session_zone_id uuid; v_task_status text;
    v_task_version integer; v_task_cycle integer; v_current_assignment_id uuid;
    v_assignment_count bigint; v_assignment_id uuid; v_assignment_user_id uuid;
    v_assignment_participant_id uuid; v_event_id uuid; v_occurred_at timestamptz;
    v_response_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL OR p_expected_version IS NULL
       OR p_expected_version <= 0 OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.tasks.execute');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.start_inventory_task'),
        pg_catalog.hashtext(p_company_id::text || ':' || v_actor_id::text));
    v_request_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.start', 'company_id', p_company_id,
        'task_id', p_task_id, 'expected_version', p_expected_version);
    v_request_hash := inventarios.compute_request_hash(v_request_payload);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id, 'inventarios.task.start', p_idempotency_key, v_request_hash);
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
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
    IF v_task_status <> 'ASSIGNED' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_TASK_INVALID_STATE',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea no permite esta operacion en su estado actual.', 'retryable', false)::text;
    END IF;
    IF v_task_version <> p_expected_version THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea fue modificada por otra operacion.', 'retryable', true)::text;
    END IF;
    v_participant_id := inventarios.require_session_participant(p_company_id, v_task_session_id, 'COUNTER');
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
       OR v_assignment_user_id IS DISTINCT FROM v_actor_id
       OR v_assignment_participant_id IS DISTINCT FROM v_participant_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ASSIGNMENT_REQUIRED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes una asignacion vigente para esta tarea.', 'retryable', false)::text;
    END IF;
    v_occurred_at := pg_catalog.now();
    UPDATE inventarios.tasks AS t
    SET status = 'IN_PROGRESS', version = t.version + 1, opened_at = v_occurred_at,
        active_user_id = v_actor_id, updated_at = v_occurred_at, updated_by = v_actor_id
    WHERE t.company_id = p_company_id AND t.id = p_task_id;
    INSERT INTO inventarios.task_events (company_id, session_id, session_zone_id, task_id,
        event_type, previous_status, next_status, actor_id, next_user_id, cycle,
        occurred_at, idempotency_key, created_by)
    VALUES (p_company_id, v_task_session_id, v_task_session_zone_id, p_task_id,
        'STARTED', 'ASSIGNED', 'IN_PROGRESS', v_actor_id, v_actor_id, v_task_cycle,
        v_occurred_at, p_idempotency_key, v_actor_id)
    RETURNING id INTO v_event_id;
    INSERT INTO inventarios.task_state_transitions (company_id, session_id, session_zone_id,
        task_id, assignment_id, operation_idempotency_id, transition_type, previous_status,
        next_status, previous_version, next_version, previous_cycle, next_cycle, actor_id, occurred_at)
    VALUES (p_company_id, v_task_session_id, v_task_session_zone_id, p_task_id, v_assignment_id,
        v_operation_id, 'STARTED', 'ASSIGNED', 'IN_PROGRESS', v_task_version, v_task_version + 1,
        v_task_cycle, v_task_cycle, v_actor_id, v_occurred_at);
    v_response_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.start', 'entity_id', p_task_id,
        'state', 'IN_PROGRESS', 'version', v_task_version + 1, 'cycle_number', v_task_cycle,
        'assignment_id', v_assignment_id, 'event_id', v_event_id, 'replayed', false,
        'occurred_at', v_occurred_at, 'data', pg_catalog.jsonb_build_object());
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_task_id, v_response_payload);
END;
$$;

-- ============================================================
-- 3. pause_inventory_task: agrega guarda COUNTING
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.pause_inventory_task(
    p_company_id uuid, p_task_id uuid, p_expected_version integer, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_actor_id uuid; v_participant_id uuid; v_operation jsonb; v_operation_id uuid;
    v_session_id uuid; v_zone_id uuid; v_status text; v_version integer; v_cycle integer;
    v_current_assignment_id uuid; v_assignment_id uuid; v_assignment_user_id uuid;
    v_assignment_participant_id uuid; v_assignment_count bigint; v_occurred_at timestamptz;
    v_payload jsonb; v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL OR p_expected_version IS NULL
       OR p_expected_version <= 0 OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.tasks.execute');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.pause_inventory_task'),
        pg_catalog.hashtext(p_company_id::text || ':' || v_actor_id::text));
    v_payload := pg_catalog.jsonb_build_object('operation', 'inventarios.task.pause',
        'company_id', p_company_id, 'task_id', p_task_id, 'expected_version', p_expected_version);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id, 'inventarios.task.pause', p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT t.session_id, t.session_zone_id, t.status, t.version, t.validation_cycle, t.current_assignment_id
    INTO v_session_id, v_zone_id, v_status, v_version, v_cycle, v_current_assignment_id
    FROM inventarios.tasks AS t WHERE t.company_id = p_company_id AND t.id = p_task_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_session_counting(p_company_id, v_session_id);
    IF v_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_TASK_INVALID_STATE',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea no permite esta operacion en su estado actual.', 'retryable', false)::text;
    END IF;
    IF v_version <> p_expected_version THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea fue modificada por otra operacion.', 'retryable', true)::text;
    END IF;
    v_participant_id := inventarios.require_session_participant(p_company_id, v_session_id, 'COUNTER');
    SELECT pg_catalog.count(*), (pg_catalog.array_agg(ta.id ORDER BY ta.id))[1],
           (pg_catalog.array_agg(ta.user_id ORDER BY ta.id))[1], (pg_catalog.array_agg(ta.session_participant_id ORDER BY ta.id))[1]
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
    v_occurred_at := pg_catalog.now();
    UPDATE inventarios.tasks AS t
    SET status = 'PAUSED', version = t.version + 1, paused_at = v_occurred_at,
        paused_by = v_actor_id, active_user_id = NULL,
        updated_at = v_occurred_at, updated_by = v_actor_id
    WHERE t.company_id = p_company_id AND t.id = p_task_id;
    INSERT INTO inventarios.task_state_transitions (company_id, session_id, session_zone_id,
        task_id, assignment_id, operation_idempotency_id, transition_type, previous_status,
        next_status, previous_version, next_version, previous_cycle, next_cycle, actor_id, occurred_at)
    VALUES (p_company_id, v_session_id, v_zone_id, p_task_id, v_assignment_id, v_operation_id,
        'PAUSED', 'IN_PROGRESS', 'PAUSED', v_version, v_version + 1, v_cycle, v_cycle, v_actor_id, v_occurred_at);
    v_response := pg_catalog.jsonb_build_object('operation', 'inventarios.task.pause',
        'entity_id', p_task_id, 'state', 'PAUSED', 'version', v_version + 1, 'cycle_number', v_cycle,
        'assignment_id', v_assignment_id, 'event_id', NULL::uuid, 'replayed', false,
        'occurred_at', v_occurred_at, 'data', pg_catalog.jsonb_build_object());
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_task_id, v_response);
END;
$$;

-- ============================================================
-- 4. resume_inventory_task: agrega guarda COUNTING
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.resume_inventory_task(
    p_company_id uuid, p_task_id uuid, p_expected_version integer, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_actor_id uuid; v_participant_id uuid; v_operation jsonb; v_operation_id uuid;
    v_session_id uuid; v_zone_id uuid; v_status text; v_version integer; v_cycle integer;
    v_current_assignment_id uuid; v_assignment_id uuid; v_assignment_user_id uuid;
    v_assignment_participant_id uuid; v_assignment_count bigint; v_occurred_at timestamptz;
    v_event_id uuid; v_payload jsonb; v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL OR p_expected_version IS NULL
       OR p_expected_version <= 0 OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.tasks.execute');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.resume_inventory_task'),
        pg_catalog.hashtext(p_company_id::text || ':' || v_actor_id::text));
    v_payload := pg_catalog.jsonb_build_object('operation', 'inventarios.task.resume',
        'company_id', p_company_id, 'task_id', p_task_id, 'expected_version', p_expected_version);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id, 'inventarios.task.resume', p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT t.session_id, t.session_zone_id, t.status, t.version, t.validation_cycle, t.current_assignment_id
    INTO v_session_id, v_zone_id, v_status, v_version, v_cycle, v_current_assignment_id
    FROM inventarios.tasks AS t WHERE t.company_id = p_company_id AND t.id = p_task_id FOR UPDATE;
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
    SELECT pg_catalog.count(*), (pg_catalog.array_agg(ta.id ORDER BY ta.id))[1],
           (pg_catalog.array_agg(ta.user_id ORDER BY ta.id))[1], (pg_catalog.array_agg(ta.session_participant_id ORDER BY ta.id))[1]
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
    v_occurred_at := pg_catalog.now();
    UPDATE inventarios.tasks AS t
    SET status = 'IN_PROGRESS', version = t.version + 1, paused_at = NULL, paused_by = NULL,
        active_user_id = v_actor_id, updated_at = v_occurred_at, updated_by = v_actor_id
    WHERE t.company_id = p_company_id AND t.id = p_task_id;
    INSERT INTO inventarios.task_events (company_id, session_id, session_zone_id, task_id,
        event_type, previous_status, next_status, actor_id, next_user_id, cycle,
        occurred_at, idempotency_key, created_by)
    VALUES (p_company_id, v_session_id, v_zone_id, p_task_id, 'RESUMED', 'PAUSED', 'IN_PROGRESS',
        v_actor_id, v_actor_id, v_cycle, v_occurred_at, p_idempotency_key, v_actor_id)
    RETURNING id INTO v_event_id;
    INSERT INTO inventarios.task_state_transitions (company_id, session_id, session_zone_id,
        task_id, assignment_id, operation_idempotency_id, transition_type, previous_status,
        next_status, previous_version, next_version, previous_cycle, next_cycle, actor_id, occurred_at)
    VALUES (p_company_id, v_session_id, v_zone_id, p_task_id, v_assignment_id, v_operation_id,
        'RESUMED', 'PAUSED', 'IN_PROGRESS', v_version, v_version + 1, v_cycle, v_cycle, v_actor_id, v_occurred_at);
    v_response := pg_catalog.jsonb_build_object('operation', 'inventarios.task.resume',
        'entity_id', p_task_id, 'state', 'IN_PROGRESS', 'version', v_version + 1, 'cycle_number', v_cycle,
        'assignment_id', v_assignment_id, 'event_id', v_event_id, 'replayed', false,
        'occurred_at', v_occurred_at, 'data', pg_catalog.jsonb_build_object());
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_task_id, v_response);
END;
$$;

-- ============================================================
-- 5. complete_inventory_task: agrega guarda COUNTING
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.complete_inventory_task(
    p_company_id uuid, p_task_id uuid, p_expected_version integer, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    a uuid; p uuid; o jsonb; oi uuid; s uuid; z uuid; st text; v integer; c integer; ca uuid;
    ac bigint; ai uuid; au uuid; ap uuid; at timestamptz; payload jsonb; response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL OR p_expected_version IS NULL OR p_expected_version <= 0 OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    a := inventarios.require_permission(p_company_id, 'inventarios.tasks.execute');
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.complete_inventory_task'), pg_catalog.hashtext(p_company_id::text || ':' || a::text));
    payload := pg_catalog.jsonb_build_object('operation','inventarios.task.complete','company_id',p_company_id,'task_id',p_task_id,'expected_version',p_expected_version);
    o := inventarios.begin_idempotent_operation(p_company_id,'inventarios.task.complete',p_idempotency_key,inventarios.compute_request_hash(payload));
    IF o ->> 'mode' = 'REPLAY' THEN RETURN o -> 'response_payload'; END IF;
    oi := (o ->> 'operation_id')::uuid;
    SELECT t.session_id,t.session_zone_id,t.status,t.version,t.validation_cycle,t.current_assignment_id INTO s,z,st,v,c,ca FROM inventarios.tasks t WHERE t.company_id=p_company_id AND t.id=p_task_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    PERFORM inventarios.require_session_counting(p_company_id, s);
    IF st <> 'IN_PROGRESS' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE', DETAIL=pg_catalog.jsonb_build_object('message','La tarea no permite esta operacion en su estado actual.','retryable',false)::text; END IF;
    IF v <> p_expected_version THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=pg_catalog.jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text; END IF;
    p := inventarios.require_session_participant(p_company_id,s,'COUNTER');
    SELECT pg_catalog.count(*),(pg_catalog.array_agg(ta.id ORDER BY ta.id))[1],(pg_catalog.array_agg(ta.user_id ORDER BY ta.id))[1],(pg_catalog.array_agg(ta.session_participant_id ORDER BY ta.id))[1] INTO ac,ai,au,ap FROM inventarios.task_assignments ta WHERE ta.company_id=p_company_id AND ta.session_id=s AND ta.task_id=p_task_id AND ta.released_at IS NULL;
    IF ac=0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF ac>1 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    IF ca IS DISTINCT FROM ai OR au IS DISTINCT FROM a OR ap IS DISTINCT FROM p THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED', DETAIL=pg_catalog.jsonb_build_object('message','No tienes una asignacion vigente para esta tarea.','retryable',false)::text; END IF;
    at := pg_catalog.now();
    UPDATE inventarios.tasks t SET status='COMPLETED',version=t.version+1,completed_at=at,completed_by=a,active_user_id=NULL,updated_at=at,updated_by=a WHERE t.company_id=p_company_id AND t.id=p_task_id;
    INSERT INTO inventarios.task_state_transitions(company_id,session_id,session_zone_id,task_id,assignment_id,operation_idempotency_id,transition_type,previous_status,next_status,previous_version,next_version,previous_cycle,next_cycle,actor_id,occurred_at)
    VALUES(p_company_id,s,z,p_task_id,ai,oi,'COMPLETED','IN_PROGRESS','COMPLETED',v,v+1,c,c,a,at);
    response := pg_catalog.jsonb_build_object('operation','inventarios.task.complete','entity_id',p_task_id,'state','COMPLETED','version',v+1,'cycle_number',c,'assignment_id',ai,'event_id',NULL::uuid,'replayed',false,'occurred_at',at,'data',pg_catalog.jsonb_build_object());
    RETURN inventarios.complete_idempotent_operation(p_company_id,oi,p_task_id,response);
END;
$$;

-- ============================================================
-- 6. OWNER Y REVOKES DE LAS FUNCIONES REESCRITAS
-- ============================================================
ALTER FUNCTION inventarios.start_inventory_task(uuid,uuid,integer,uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.pause_inventory_task(uuid,uuid,integer,uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.resume_inventory_task(uuid,uuid,integer,uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.complete_inventory_task(uuid,uuid,integer,uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.start_inventory_task(uuid,uuid,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.pause_inventory_task(uuid,uuid,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.resume_inventory_task(uuid,uuid,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.complete_inventory_task(uuid,uuid,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.start_inventory_task(uuid,uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.pause_inventory_task(uuid,uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.resume_inventory_task(uuid,uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.complete_inventory_task(uuid,uuid,integer,uuid) TO authenticated;
