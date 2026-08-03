-- Migration: 20260803100000_inventarios_reassign_draft_admin.sql
-- Description: Fase 4H.2F5. Ajuste minimo de rol contextual en
--              reassign_inventory_task: en jornada DRAFT el actor configurador
--              debe ser ADMINISTRATOR activo; en estados operativos se conserva
--              SUPERVISOR. No amplia permisos generales.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.reassign_inventory_task(
    p_company_id uuid,
    p_task_id uuid,
    p_expected_version integer,
    p_expected_cycle integer,
    p_new_user_id uuid,
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
    v_status text;
    v_session_status text;
    v_version integer;
    v_cycle integer;
    v_current_assignment_id uuid;
    v_previous_assignment_count bigint;
    v_previous_assignment_id uuid;
    v_previous_user_id uuid;
    v_new_participant_count bigint;
    v_new_participant_id uuid;
    v_new_assignment_id uuid;
    v_reason text;
    v_payload jsonb;
    v_occurred_at timestamptz;
    v_event_id uuid;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL
       OR p_task_id IS NULL
       OR p_expected_version IS NULL
       OR p_expected_version < 1
       OR p_expected_cycle IS NULL
       OR p_expected_cycle < 1
       OR p_new_user_id IS NULL
       OR p_reason IS NULL
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_reason := pg_catalog.btrim(p_reason);
    IF v_reason = ''
       OR pg_catalog.char_length(v_reason) < 5
       OR pg_catalog.char_length(v_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.tasks.assign');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.reassign_inventory_task'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_task_id::text));

    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.reassign',
        'company_id', p_company_id,
        'task_id', p_task_id,
        'expected_version', p_expected_version,
        'expected_cycle', p_expected_cycle,
        'new_user_id', p_new_user_id,
        'reason', v_reason);

    v_operation := inventarios.begin_idempotent_operation(
        p_company_id, 'inventarios.task.reassign', p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT t.session_id, t.session_zone_id, t.status, t.version, t.validation_cycle,
           t.current_assignment_id
    INTO v_session_id, v_session_zone_id, v_status, v_version, v_cycle, v_current_assignment_id
    FROM inventarios.tasks AS t
    WHERE t.company_id = p_company_id AND t.id = p_task_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    IF v_status NOT IN ('ASSIGNED', 'IN_PROGRESS', 'PAUSED') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_TASK_INVALID_STATE',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea no permite esta operacion en su estado actual.', 'retryable', false)::text;
    END IF;

    IF v_version <> p_expected_version OR v_cycle <> p_expected_cycle THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea fue modificada por otra operacion.', 'retryable', true)::text;
    END IF;

    -- Rol contextual segun estado: DRAFT -> ADMINISTRATOR configurador;
    -- estados operativos -> SUPERVISOR (regla vigente).
    SELECT s.status INTO v_session_status
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = v_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    IF v_session_status = 'DRAFT' THEN
        PERFORM inventarios.require_session_participant(p_company_id, v_session_id, 'ADMINISTRATOR');
    ELSE
        PERFORM inventarios.require_session_participant(p_company_id, v_session_id, 'SUPERVISOR');
    END IF;

    SELECT pg_catalog.count(*),
           (pg_catalog.array_agg(x.id ORDER BY x.id))[1],
           (pg_catalog.array_agg(x.user_id ORDER BY x.id))[1]
    INTO v_previous_assignment_count, v_previous_assignment_id, v_previous_user_id
    FROM (
        SELECT ta.id, ta.user_id
        FROM inventarios.task_assignments AS ta
        WHERE ta.company_id = p_company_id
          AND ta.session_id = v_session_id
          AND ta.task_id = p_task_id
          AND ta.released_at IS NULL
        FOR UPDATE
    ) AS x;

    IF v_previous_assignment_count <> 1
       OR v_current_assignment_id IS DISTINCT FROM v_previous_assignment_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
    END IF;

    SELECT pg_catalog.count(*),
           (pg_catalog.array_agg(sp.id ORDER BY sp.id))[1]
    INTO v_new_participant_count, v_new_participant_id
    FROM inventarios.session_participants AS sp
    JOIN portal.users AS u ON u.id = sp.user_id
    JOIN core.user_company_access AS uca
      ON uca.user_id = sp.user_id AND uca.company_id = sp.company_id AND uca.is_active = true
    WHERE sp.company_id = p_company_id
      AND sp.session_id = v_session_id
      AND sp.user_id = p_new_user_id
      AND sp.functional_role = 'COUNTER'
      AND sp.active_from <= pg_catalog.now()
      AND sp.revoked_at IS NULL
      AND u.is_active = true
      AND u.deleted_at IS NULL;

    IF v_new_participant_count <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    IF p_new_user_id = v_previous_user_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_TASK_ALREADY_ASSIGNED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea ya esta asignada al usuario indicado.', 'retryable', false)::text;
    END IF;

    v_occurred_at := pg_catalog.now();

    UPDATE inventarios.task_assignments AS ta
    SET released_at = v_occurred_at, released_by = v_actor_id, release_reason = v_reason
    WHERE ta.company_id = p_company_id AND ta.id = v_previous_assignment_id;

    INSERT INTO inventarios.task_assignments AS ta (
        company_id, session_id, task_id, session_participant_id, user_id,
        assigned_at, assigned_by, created_by)
    VALUES (p_company_id, v_session_id, p_task_id, v_new_participant_id, p_new_user_id,
        v_occurred_at, v_actor_id, v_actor_id)
    RETURNING ta.id INTO v_new_assignment_id;

    INSERT INTO inventarios.task_events AS e (
        company_id, session_id, session_zone_id, task_id, event_type, actor_id,
        previous_user_id, next_user_id, cycle, occurred_at, reason, idempotency_key,
        technical_metadata, created_by)
    VALUES (p_company_id, v_session_id, v_session_zone_id, p_task_id, 'REASSIGNED',
        v_actor_id, v_previous_user_id, p_new_user_id, v_cycle, v_occurred_at, v_reason,
        p_idempotency_key,
        pg_catalog.jsonb_build_object(
            'previous_assignment_id', v_previous_assignment_id,
            'previous_user_id', v_previous_user_id,
            'new_assignment_id', v_new_assignment_id,
            'new_user_id', p_new_user_id,
            'reason', v_reason),
        v_actor_id)
    RETURNING e.id INTO v_event_id;

    UPDATE inventarios.tasks AS t
    SET current_assignment_id = v_new_assignment_id,
        active_user_id = CASE WHEN v_status = 'IN_PROGRESS' THEN p_new_user_id ELSE NULL END,
        version = t.version + 1,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE t.company_id = p_company_id AND t.id = p_task_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.reassign',
        'entity_id', p_task_id,
        'state', v_status,
        'version', v_version + 1,
        'cycle_number', v_cycle,
        'assignment_id', v_new_assignment_id,
        'event_id', v_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'previous_assignment_id', v_previous_assignment_id,
            'previous_user_id', v_previous_user_id,
            'new_user_id', p_new_user_id,
            'reason', v_reason));

    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_task_id, v_response);
END;
$$;

ALTER FUNCTION inventarios.reassign_inventory_task(uuid, uuid, integer, integer, uuid, text, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.reassign_inventory_task(uuid, uuid, integer, integer, uuid, text, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.reassign_inventory_task(uuid, uuid, integer, integer, uuid, text, uuid) TO authenticated;
