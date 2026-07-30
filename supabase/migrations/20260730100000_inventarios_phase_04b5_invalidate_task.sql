CREATE OR REPLACE FUNCTION inventarios.invalidate_inventory_task(
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
    v_idempotency_result jsonb;
    v_operation_id uuid;
    v_session_id uuid;
    v_session_zone_id uuid;
    v_status text;
    v_version integer;
    v_cycle integer;
    v_validation_event_id uuid;
    v_validated_at timestamptz;
    v_validated_by uuid;
    v_reason text;
    v_payload jsonb;
    v_occurred_at timestamptz;
    v_invalidation_event_id uuid;
    v_event_company_id uuid;
    v_event_session_id uuid;
    v_event_session_zone_id uuid;
    v_event_task_id uuid;
    v_event_cycle integer;
    v_event_type text;
    v_event_actor_id uuid;
    v_event_occurred_at timestamptz;
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
        pg_catalog.hashtext('inventarios.invalidate_inventory_task'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_task_id::text)
    );

    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.invalidate',
        'company_id', p_company_id,
        'task_id', p_task_id,
        'expected_version', p_expected_version,
        'expected_cycle', p_expected_cycle,
        'reason', v_reason
    );

    v_idempotency_result := inventarios.begin_idempotent_operation(
        p_company_id,
        'inventarios.task.invalidate',
        p_idempotency_key,
        inventarios.compute_request_hash(v_payload)
    );

    IF v_idempotency_result ->> 'mode' = 'REPLAY' THEN
        RETURN v_idempotency_result -> 'response_payload';
    END IF;

    v_operation_id := (v_idempotency_result ->> 'operation_id')::uuid;

    SELECT t.session_id,
           t.session_zone_id,
           t.status,
           t.version,
           t.validation_cycle,
           t.current_validation_event_id,
           t.validated_at,
           t.validated_by
    INTO v_session_id,
         v_session_zone_id,
         v_status,
         v_version,
         v_cycle,
         v_validation_event_id,
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

    IF v_version <> p_expected_version OR v_cycle <> p_expected_cycle THEN
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

    IF v_validation_event_id IS NULL THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_TASK_NOT_VALIDATED',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'La tarea no tiene una validacion vigente.',
                      'retryable', false
                  )::text;
    END IF;

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
    WHERE e.id = v_validation_event_id;

    IF NOT FOUND
       OR v_event_company_id IS DISTINCT FROM p_company_id
       OR v_event_session_id IS DISTINCT FROM v_session_id
       OR v_event_session_zone_id IS DISTINCT FROM v_session_zone_id
       OR v_event_task_id IS DISTINCT FROM p_task_id
       OR v_event_cycle IS DISTINCT FROM v_cycle
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

    v_occurred_at := pg_catalog.now();

    INSERT INTO inventarios.task_events AS e (
        company_id,
        session_id,
        session_zone_id,
        task_id,
        event_type,
        actor_id,
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
        'INVALIDATED',
        v_actor_id,
        v_cycle,
        v_occurred_at,
        v_reason,
        p_idempotency_key,
        pg_catalog.jsonb_build_object(
            'invalidated_validation_event_id', v_validation_event_id,
            'reason', v_reason
        ),
        v_actor_id
    )
    RETURNING e.id INTO v_invalidation_event_id;

    UPDATE inventarios.tasks AS t
    SET current_validation_event_id = NULL,
        validated_at = NULL,
        validated_by = NULL,
        version = t.version + 1,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE t.company_id = p_company_id
      AND t.id = p_task_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.invalidate',
        'entity_id', p_task_id,
        'state', 'COMPLETED',
        'version', v_version + 1,
        'cycle_number', v_cycle,
        'assignment_id', NULL::uuid,
        'event_id', v_invalidation_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'invalidated_validation_event_id', v_validation_event_id,
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

ALTER FUNCTION inventarios.invalidate_inventory_task(uuid, uuid, integer, integer, text, uuid)
    OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.invalidate_inventory_task(uuid, uuid, integer, integer, text, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
