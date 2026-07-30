CREATE OR REPLACE FUNCTION inventarios.reopen_inventory_task(
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
    v_status text;
    v_version integer;
    v_previous_cycle integer;
    v_new_cycle integer;
    v_current_assignment_id uuid;
    v_assignment_count bigint;
    v_assignment_id uuid;
    v_assigned_user_id uuid;
    v_previous_validation_event_id uuid;
    v_validated_at timestamptz;
    v_validated_by uuid;
    v_event_company_id uuid;
    v_event_session_id uuid;
    v_event_session_zone_id uuid;
    v_event_task_id uuid;
    v_event_cycle integer;
    v_event_type text;
    v_event_actor_id uuid;
    v_event_occurred_at timestamptz;
    v_reason text;
    v_payload jsonb;
    v_occurred_at timestamptz;
    v_reopened_event_id uuid;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL
       OR p_task_id IS NULL
       OR p_expected_version IS NULL
       OR p_expected_version < 1
       OR p_expected_cycle IS NULL
       OR p_expected_cycle < 1
       OR p_reason IS NULL
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La solicitud no tiene el formato requerido.',
                      'retryable', false
                  )::text;
    END IF;

    v_reason := pg_catalog.btrim(p_reason);

    IF v_reason = ''
       OR pg_catalog.char_length(v_reason) < 5
       OR pg_catalog.char_length(v_reason) > 500 THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La solicitud no tiene el formato requerido.',
                      'retryable', false
                  )::text;
    END IF;

    v_actor_id := inventarios.require_permission(
        p_company_id,
        'inventarios.tasks.validate'
    );

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.reopen_inventory_task'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_task_id::text)
    );

    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.reopen',
        'company_id', p_company_id,
        'task_id', p_task_id,
        'expected_version', p_expected_version,
        'expected_cycle', p_expected_cycle,
        'reason', v_reason
    );

    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,
        'inventarios.task.reopen',
        p_idempotency_key,
        inventarios.compute_request_hash(v_payload)
    );

    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;

    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT t.session_id,
           t.session_zone_id,
           t.status,
           t.version,
           t.validation_cycle,
           t.current_assignment_id,
           t.current_validation_event_id,
           t.validated_at,
           t.validated_by
    INTO v_session_id,
         v_session_zone_id,
         v_status,
         v_version,
         v_previous_cycle,
         v_current_assignment_id,
         v_previous_validation_event_id,
         v_validated_at,
         v_validated_by
    FROM inventarios.tasks AS t
    WHERE t.company_id = p_company_id
      AND t.id = p_task_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_NOT_FOUND',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'El recurso solicitado no existe.',
                      'retryable', false
                  )::text;
    END IF;

    IF v_status <> 'COMPLETED' THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_TASK_INVALID_STATE',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La tarea no permite esta operacion en su estado actual.',
                      'retryable', false
                  )::text;
    END IF;

    IF v_version <> p_expected_version
       OR v_previous_cycle <> p_expected_cycle THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_CONCURRENT_MODIFICATION',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La tarea fue modificada por otra operacion.',
                      'retryable', true
                  )::text;
    END IF;

    PERFORM inventarios.require_session_participant(
        p_company_id,
        v_session_id,
        'SUPERVISOR'
    );

    SELECT pg_catalog.count(*),
           (pg_catalog.array_agg(ta.id ORDER BY ta.id))[1],
           (pg_catalog.array_agg(ta.user_id ORDER BY ta.id))[1]
    INTO v_assignment_count,
         v_assignment_id,
         v_assigned_user_id
    FROM inventarios.task_assignments AS ta
    WHERE ta.company_id = p_company_id
      AND ta.session_id = v_session_id
      AND ta.task_id = p_task_id
      AND ta.released_at IS NULL;

    IF v_assignment_count <> 1
       OR v_current_assignment_id IS DISTINCT FROM v_assignment_id
       OR v_assigned_user_id IS NULL THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_CONCURRENT_MODIFICATION',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'Se detecto una modificacion concurrente.',
                      'retryable', true
                  )::text;
    END IF;

    IF v_previous_validation_event_id IS NOT NULL THEN
        SELECT e.company_id,
               e.session_id,
               e.session_zone_id,
               e.task_id,
               e.cycle,
               e.event_type,
               e.actor_id,
               e.occurred_at
        INTO v_event_company_id,
             v_event_session_id,
             v_event_session_zone_id,
             v_event_task_id,
             v_event_cycle,
             v_event_type,
             v_event_actor_id,
             v_event_occurred_at
        FROM inventarios.task_events AS e
        WHERE e.id = v_previous_validation_event_id;

        IF NOT FOUND
           OR v_event_company_id IS DISTINCT FROM p_company_id
           OR v_event_session_id IS DISTINCT FROM v_session_id
           OR v_event_session_zone_id IS DISTINCT FROM v_session_zone_id
           OR v_event_task_id IS DISTINCT FROM p_task_id
           OR v_event_cycle IS DISTINCT FROM v_previous_cycle
           OR v_event_type IS DISTINCT FROM 'VALIDATED'
           OR v_event_actor_id IS NULL
           OR v_event_occurred_at IS NULL
           OR v_validated_at IS NULL
           OR v_validated_by IS NULL
           OR v_validated_at IS DISTINCT FROM v_event_occurred_at
           OR v_validated_by IS DISTINCT FROM v_event_actor_id THEN
            RAISE EXCEPTION
                USING ERRCODE = 'P0001',
                      MESSAGE = 'INV_CONCURRENT_MODIFICATION',
                      DETAIL = pg_catalog.jsonb_build_object(
                          'message', 'Se detecto una modificacion concurrente.',
                          'retryable', true
                      )::text;
        END IF;
    END IF;

    IF v_previous_cycle >= 2147483647 THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_CONCURRENT_MODIFICATION',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La tarea fue modificada por otra operacion.',
                      'retryable', true
                  )::text;
    END IF;

    v_new_cycle := v_previous_cycle + 1;
    v_occurred_at := pg_catalog.now();

    INSERT INTO inventarios.task_events AS e (
        company_id,
        session_id,
        session_zone_id,
        task_id,
        event_type,
        previous_status,
        next_status,
        actor_id,
        next_user_id,
        cycle,
        occurred_at,
        reason,
        idempotency_key,
        technical_metadata,
        created_by
    )
    VALUES (
        p_company_id,
        v_session_id,
        v_session_zone_id,
        p_task_id,
        'REOPENED',
        'COMPLETED',
        'IN_PROGRESS',
        v_actor_id,
        v_assigned_user_id,
        v_new_cycle,
        v_occurred_at,
        v_reason,
        p_idempotency_key,
        pg_catalog.jsonb_build_object(
            'previous_cycle', v_previous_cycle,
            'previous_validation_event_id', v_previous_validation_event_id,
            'reason', v_reason
        ),
        v_actor_id
    )
    RETURNING e.id INTO v_reopened_event_id;

    UPDATE inventarios.tasks AS t
    SET status = 'IN_PROGRESS',
        validation_cycle = v_new_cycle,
        current_validation_event_id = NULL,
        validated_at = NULL,
        validated_by = NULL,
        opened_at = v_occurred_at,
        paused_at = NULL,
        paused_by = NULL,
        completed_at = NULL,
        completed_by = NULL,
        active_user_id = v_assigned_user_id,
        version = t.version + 1,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE t.company_id = p_company_id
      AND t.id = p_task_id;

    INSERT INTO inventarios.task_state_transitions (
        company_id,
        session_id,
        session_zone_id,
        task_id,
        assignment_id,
        operation_idempotency_id,
        transition_type,
        previous_status,
        next_status,
        previous_version,
        next_version,
        previous_cycle,
        next_cycle,
        actor_id,
        reason,
        occurred_at
    )
    VALUES (
        p_company_id,
        v_session_id,
        v_session_zone_id,
        p_task_id,
        v_assignment_id,
        v_operation_id,
        'REOPENED',
        'COMPLETED',
        'IN_PROGRESS',
        v_version,
        v_version + 1,
        v_previous_cycle,
        v_new_cycle,
        v_actor_id,
        v_reason,
        v_occurred_at
    );

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.reopen',
        'entity_id', p_task_id,
        'state', 'IN_PROGRESS',
        'version', v_version + 1,
        'cycle_number', v_new_cycle,
        'assignment_id', v_assignment_id,
        'event_id', v_reopened_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'previous_cycle', v_previous_cycle,
            'previous_validation_event_id', v_previous_validation_event_id,
            'reason', v_reason
        )
    );

    RETURN inventarios.complete_idempotent_operation(
        p_company_id,
        v_operation_id,
        p_task_id,
        v_response
    );
END;
$$;

ALTER FUNCTION inventarios.reopen_inventory_task(uuid, uuid, integer, integer, text, uuid)
    OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.reopen_inventory_task(uuid, uuid, integer, integer, text, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
