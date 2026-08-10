-- =========================================================================================
-- MIGRATION: M1.4A.4 - Hotfix Final: Resolver validation_cycle real desde tasks
-- =========================================================================================

CREATE OR REPLACE FUNCTION inventarios.open_my_counting_location(
    p_zone_id pg_catalog.uuid,
    p_location_id pg_catalog.uuid,
    p_idempotency_key pg_catalog.uuid
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
    v_task_id pg_catalog.uuid;
    v_task_version integer;
    v_task_status text;
    v_task_cycle integer;
    v_assignment_id pg_catalog.uuid;
    v_is_authorized boolean := false;
    v_szl_id pg_catalog.uuid;
    v_location_code text;
    v_location_name text;
    v_request_payload pg_catalog.jsonb;
    v_request_hash text;
    v_operation pg_catalog.jsonb;
    v_operation_id pg_catalog.uuid;
    v_response_payload pg_catalog.jsonb;
    v_task_locations_id pg_catalog.uuid;
    v_event_id pg_catalog.uuid;
    v_occurred_at timestamptz := pg_catalog.now();
BEGIN
    -- 1. Identificar actor real
    v_actor_id := inventarios.require_actor();

    -- 2. Validar accesos y obtener metadatos de la tarea (Participante activo, asig vigentes)
    SELECT 
        z.company_id,
        t.id,
        s.id,
        t.version,
        t.status,
        t.validation_cycle, -- FIX: La columna real en inventarios.tasks es validation_cycle, no cycle
        a.id,
        true
    INTO 
        v_company_id, 
        v_task_id, 
        v_session_id,
        v_task_version,
        v_task_status,
        v_task_cycle,
        v_assignment_id,
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
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL
    LIMIT 1;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;

    -- Solo permitir abrir ubicación si la tarea está en curso
    IF v_task_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea no se encuentra en curso.', 'retryable', false)::text;
    END IF;

    -- 3. Verify Location belongs to Zone
    SELECT szl.id, sl.code, sl.name 
    INTO v_szl_id, v_location_code, v_location_name
    FROM inventarios.session_zone_locations szl
    JOIN inventarios.snapshot_locations sl 
      ON szl.snapshot_location_id = sl.id
    WHERE szl.session_zone_id = p_zone_id 
      AND szl.location_id = p_location_id;
      
    IF NOT FOUND THEN
        -- Si la location no existe o es ajena, opaco error
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;

    -- 4. Idempotency Check
    v_request_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.open_my_counting_location',
        'actor_id', v_actor_id,
        'company_id', v_company_id,
        'zone_id', p_zone_id,
        'location_id', p_location_id
    );
    v_request_hash := inventarios.compute_request_hash(v_request_payload);
    
    v_operation := inventarios.begin_idempotent_operation(
        v_company_id, 'inventarios.open_my_counting_location', p_idempotency_key, v_request_hash
    );
    
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- 5. Insert Operational State (Protegido en última instancia por Unique Indexes)
    BEGIN
        INSERT INTO inventarios.task_locations (
            company_id, session_id, session_zone_id, task_id, session_zone_location_id, status, opened_by, opened_at
        ) VALUES (
            v_company_id, v_session_id, p_zone_id, v_task_id, v_szl_id, 'OPEN', v_actor_id, v_occurred_at
        ) RETURNING id INTO v_task_locations_id;
    EXCEPTION WHEN unique_violation THEN
        DECLARE
            v_constraint text;
        BEGIN
            GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
            IF v_constraint = 'uq_inventarios_task_locations_single_open' THEN
                RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'INV_LOCATION_ALREADY_OPEN',
                    DETAIL = pg_catalog.jsonb_build_object('message', 'Ya tienes una ubicación abierta en curso.', 'retryable', false)::text;
            ELSIF v_constraint = 'uq_inventarios_task_locations_unique_open_loc' THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
                    DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación seleccionada ya está siendo trabajada en la tarea activa.', 'retryable', false)::text;
            ELSE
                RAISE;
            END IF;
        END;
    END;

    -- 6. Audit Event (Capturando el ID)
    INSERT INTO inventarios.task_events (
        company_id, session_id, session_zone_id, task_id, event_type,
        actor_id, occurred_at, idempotency_key, created_by
    ) VALUES (
        v_company_id, v_session_id, p_zone_id, v_task_id, 'LOCATION_OPENED',
        v_actor_id, v_occurred_at, p_idempotency_key, v_actor_id
    ) RETURNING id INTO v_event_id;

    -- 7. Complete Idempotency & Response
    v_response_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.open_my_counting_location',
        'entity_id', v_task_locations_id,
        'state', 'OPEN',
        'version', COALESCE(v_task_version, 1),
        'cycle_number', COALESCE(v_task_cycle, 1),
        'assignment_id', v_assignment_id,
        'event_id', v_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'success', true,
            'task_location_id', v_task_locations_id,
            'zone_id', p_zone_id,
            'task_id', v_task_id,
            'location_id', p_location_id,
            'location_code', v_location_code,
            'location_name', v_location_name,
            'status', 'OPEN',
            'opened_at', v_occurred_at,
            'actor_id', v_actor_id
        )
    );

    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_task_locations_id, v_response_payload);
END;
$$;
