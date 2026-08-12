-- =========================================================================================
-- MIGRATION: M1.5E.15 - Cambio flexible de ubicaciones y cierre definitivo de zona
-- =========================================================================================
-- Modelo:
--  - Un COUNTER tiene una sola ubicacion activa (OPEN) a la vez dentro de la zona.
--  - open_my_counting_location: abre una pendiente o REABRE una CLOSED previa suya,
--    mientras la tarea este IN_PROGRESS; rechaza si ya tiene otra OPEN.
--  - switch_my_counting_location (NUEVA): cierra la OPEN actual y abre el destino en una
--    unica operacion atomica e idempotente. Si destino == actual, devuelve estado sin cambios.
--  - get_my_counting_zone_locations: devuelve PENDING / OPEN / CLOSED + is_active por
--    ubicacion, sin stock ni diferencias.
--  - complete_my_counting_zone (NUEVA): cierra la OPEN actual (si existe) y completa la
--    tarea en la misma transaccion, manteniendo la guarda de cobertura e incidentes.
--  - complete_inventory_task se endurece: rechaza si queda una ubicacion OPEN (el wrapper
--    contextual la cierra primero en su misma transaccion).
-- Solo esquema inventarios. No toca stock, teorico, snapshot, Storage ni datos QA.

-- 1) Columnas de auditoria en task_locations
ALTER TABLE inventarios.task_locations ADD COLUMN closed_at timestamp with time zone;
ALTER TABLE inventarios.task_locations ADD COLUMN closed_by uuid;

-- 2) Ampliar tipos de evento con LOCATION_CLOSED y ZONE_COMPLETED
ALTER TABLE inventarios.task_events DROP CONSTRAINT chk_inventarios_events_type;
ALTER TABLE inventarios.task_events ADD CONSTRAINT chk_inventarios_events_type
CHECK (event_type IN ('STARTED', 'RESUMED', 'REOPENED', 'REASSIGNED', 'VALIDATED', 'INVALIDATED', 'CANCELLED', 'LOCATION_OPENED', 'COUNT_RECORDED', 'DISCOVERY_RECORDED', 'BARCODE_PROPOSED', 'LOCATION_CLOSED', 'ZONE_COMPLETED'));


-- 3) open_my_counting_location: abrir pendiente o reabrir CLOSED propia
CREATE OR REPLACE FUNCTION inventarios.open_my_counting_location(p_zone_id uuid, p_location_id uuid, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, t.version, t.status, t.validation_cycle, a.id, true
    INTO v_company_id, v_task_id, v_session_id, v_task_version, v_task_status, v_task_cycle, v_assignment_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now()
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    IF v_task_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea no se encuentra en curso.', 'retryable', false)::text;
    END IF;

    SELECT szl.id, sl.code, sl.name
    INTO v_szl_id, v_location_code, v_location_name
    FROM inventarios.session_zone_locations szl
    JOIN inventarios.snapshot_locations sl ON sl.id = szl.snapshot_location_id
    WHERE szl.session_zone_id = p_zone_id AND szl.location_id = p_location_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;

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

    -- Rechazar si el actor ya tiene OTRA ubicacion OPEN (sin cerrar nada; Mobile usa switch)
    IF EXISTS (
        SELECT 1
        FROM inventarios.task_locations tl
        WHERE tl.company_id = v_company_id
          AND tl.task_id = v_task_id
          AND tl.opened_by = v_actor_id
          AND tl.status = 'OPEN'
          AND tl.session_zone_location_id IS DISTINCT FROM v_szl_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'INV_LOCATION_ALREADY_OPEN',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Ya tienes una ubicación abierta en curso.', 'retryable', false)::text;
    END IF;

    -- Reabrir CLOSED previa del actor (si existe) o insertar nueva OPEN
    BEGIN
        SELECT tl.id INTO v_task_locations_id
        FROM inventarios.task_locations tl
        WHERE tl.company_id = v_company_id
          AND tl.task_id = v_task_id
          AND tl.session_zone_location_id = v_szl_id
          AND tl.status = 'CLOSED'
          AND tl.opened_by = v_actor_id
        ORDER BY tl.opened_at DESC, tl.id DESC
        LIMIT 1;

        IF v_task_locations_id IS NOT NULL THEN
            UPDATE inventarios.task_locations tl
            SET status = 'OPEN',
                opened_at = v_occurred_at,
                opened_by = v_actor_id,
                closed_at = NULL,
                closed_by = NULL
            WHERE tl.id = v_task_locations_id;
        ELSE
            INSERT INTO inventarios.task_locations (
                company_id, session_id, session_zone_id, task_id, session_zone_location_id,
                status, opened_by, opened_at
            ) VALUES (
                v_company_id, v_session_id, p_zone_id, v_task_id, v_szl_id,
                'OPEN', v_actor_id, v_occurred_at
            ) RETURNING id INTO v_task_locations_id;
        END IF;
    EXCEPTION WHEN unique_violation THEN
        DECLARE v_constraint text;
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

    INSERT INTO inventarios.task_events (
        company_id, session_id, session_zone_id, task_id, event_type,
        actor_id, occurred_at, idempotency_key, created_by
    ) VALUES (
        v_company_id, v_session_id, p_zone_id, v_task_id, 'LOCATION_OPENED',
        v_actor_id, v_occurred_at, p_idempotency_key, v_actor_id
    ) ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id INTO v_event_id;

    IF v_event_id IS NULL THEN
        SELECT te.id INTO v_event_id
        FROM inventarios.task_events te
        WHERE te.company_id = v_company_id AND te.task_id = v_task_id
          AND te.event_type = 'LOCATION_OPENED' AND te.idempotency_key = p_idempotency_key;
    END IF;

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
$function$;

ALTER FUNCTION inventarios.open_my_counting_location(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.open_my_counting_location(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.open_my_counting_location(uuid, uuid, uuid) TO authenticated;


-- 4) switch_my_counting_location: cambio atomico e idempotente
CREATE OR REPLACE FUNCTION inventarios.switch_my_counting_location(p_zone_id uuid, p_target_location_id uuid, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_task_id uuid;
    v_task_version integer;
    v_task_cycle integer;
    v_assignment_id uuid;
    v_is_authorized boolean := false;
    v_cur_szl_id uuid;
    v_cur_tl_id uuid;
    v_cur_code text;
    v_cur_name text;
    v_tgt_szl_id uuid;
    v_tgt_tl_id uuid;
    v_tgt_code text;
    v_tgt_name text;
    v_request_payload jsonb;
    v_request_hash text;
    v_operation jsonb;
    v_operation_id uuid;
    v_close_event_id uuid;
    v_open_event_id uuid;
    v_occurred_at timestamptz := pg_catalog.now();
    v_same boolean := false;
    v_reopened boolean := false;
    v_response jsonb;
BEGIN
    IF p_zone_id IS NULL OR p_target_location_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, t.version, t.validation_cycle, a.id, true
    INTO v_company_id, v_task_id, v_session_id, v_task_version, v_task_cycle, v_assignment_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now()
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    -- Ubicacion OPEN actual del actor en esta tarea (maximo 1 por indice unico)
    SELECT tl.id, szl.id, sl.code, sl.name
    INTO v_cur_tl_id, v_cur_szl_id, v_cur_code, v_cur_name
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    JOIN inventarios.snapshot_locations sl ON sl.id = szl.snapshot_location_id
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.opened_by = v_actor_id
      AND tl.status = 'OPEN'
    LIMIT 1;

    -- Validar destino pertenece a la zona/tarea
    SELECT szl.id, sl.code, sl.name
    INTO v_tgt_szl_id, v_tgt_code, v_tgt_name
    FROM inventarios.session_zone_locations szl
    JOIN inventarios.snapshot_locations sl ON sl.id = szl.snapshot_location_id
    WHERE szl.session_zone_id = p_zone_id AND szl.location_id = p_target_location_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;

    v_same := v_cur_tl_id IS NOT NULL AND v_tgt_szl_id IS NOT DISTINCT FROM v_cur_szl_id;

    v_request_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.switch_my_counting_location',
        'zone_id', p_zone_id,
        'target_location_id', p_target_location_id,
        'actor_id', v_actor_id
    );
    v_request_hash := inventarios.compute_request_hash(v_request_payload);
    v_operation := inventarios.begin_idempotent_operation(
        v_company_id, 'inventarios.switch_my_counting_location', p_idempotency_key, v_request_hash
    );
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    IF v_same THEN
        -- Destino == ubicacion actual: sin cambios, idempotente
        v_response := pg_catalog.jsonb_build_object(
            'operation', 'inventarios.switch_my_counting_location',
            'entity_id', v_cur_tl_id,
            'state', 'OPEN',
            'version', v_task_version,
            'cycle_number', v_task_cycle,
            'assignment_id', v_assignment_id,
            'event_id', NULL::uuid,
            'replayed', false,
            'occurred_at', v_occurred_at,
            'data', pg_catalog.jsonb_build_object(
                'changed', false,
                'previous_location_id', p_target_location_id,
                'target_location_id', p_target_location_id,
                'target_task_location_id', v_cur_tl_id,
                'status', 'OPEN',
                'actor_id', v_actor_id
            )
        );
        RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_cur_tl_id, v_response);
    END IF;

    -- Si no hay OPEN actual, el cambio es equivalente a abrir el destino
    IF v_cur_tl_id IS NOT NULL THEN
        UPDATE inventarios.task_locations tl
        SET status = 'CLOSED', closed_at = v_occurred_at, closed_by = v_actor_id
        WHERE tl.id = v_cur_tl_id AND tl.status = 'OPEN';
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
                DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
        END IF;
        INSERT INTO inventarios.task_events (
            company_id, session_id, session_zone_id, task_id, event_type,
            actor_id, cycle, occurred_at, idempotency_key, source, technical_metadata, created_at, created_by
        ) VALUES (
            v_company_id, v_session_id, p_zone_id, v_task_id, 'LOCATION_CLOSED',
            v_actor_id, v_task_cycle, v_occurred_at,
            (pg_catalog.md5(p_idempotency_key::text || ':LOCATION_CLOSED'))::uuid,
            'ANDROID',
            pg_catalog.jsonb_build_object('task_location_id', v_cur_tl_id, 'location_id', (SELECT location_id FROM inventarios.session_zone_locations WHERE id = v_cur_szl_id), 'zone_id', p_zone_id),
            v_occurred_at, v_actor_id
        ) ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING id INTO v_close_event_id;
    END IF;

    -- Abrir destino: reabrir CLOSED previa del actor o insertar nueva OPEN
    BEGIN
        SELECT tl.id INTO v_tgt_tl_id
        FROM inventarios.task_locations tl
        WHERE tl.company_id = v_company_id
          AND tl.task_id = v_task_id
          AND tl.session_zone_location_id = v_tgt_szl_id
          AND tl.status = 'CLOSED'
          AND tl.opened_by = v_actor_id
        ORDER BY tl.opened_at DESC, tl.id DESC
        LIMIT 1;

        IF v_tgt_tl_id IS NOT NULL THEN
            v_reopened := true;
            UPDATE inventarios.task_locations tl
            SET status = 'OPEN', opened_at = v_occurred_at, opened_by = v_actor_id, closed_at = NULL, closed_by = NULL
            WHERE tl.id = v_tgt_tl_id;
        ELSE
            INSERT INTO inventarios.task_locations (
                company_id, session_id, session_zone_id, task_id, session_zone_location_id,
                status, opened_by, opened_at
            ) VALUES (
                v_company_id, v_session_id, p_zone_id, v_task_id, v_tgt_szl_id,
                'OPEN', v_actor_id, v_occurred_at
            ) RETURNING id INTO v_tgt_tl_id;
        END IF;
    EXCEPTION WHEN unique_violation THEN
        DECLARE v_constraint text;
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

    INSERT INTO inventarios.task_events (
        company_id, session_id, session_zone_id, task_id, event_type,
        actor_id, cycle, occurred_at, idempotency_key, source, technical_metadata, created_at, created_by
    ) VALUES (
        v_company_id, v_session_id, p_zone_id, v_task_id, 'LOCATION_OPENED',
        v_actor_id, v_task_cycle, v_occurred_at,
        (pg_catalog.md5(p_idempotency_key::text || ':LOCATION_OPENED'))::uuid,
        'ANDROID',
        pg_catalog.jsonb_build_object('task_location_id', v_tgt_tl_id, 'location_id', p_target_location_id, 'zone_id', p_zone_id, 'reopened', v_reopened),
        v_occurred_at, v_actor_id
    ) ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id INTO v_open_event_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.switch_my_counting_location',
        'entity_id', v_tgt_tl_id,
        'state', 'OPEN',
        'version', v_task_version,
        'cycle_number', v_task_cycle,
        'assignment_id', v_assignment_id,
        'event_id', v_open_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'changed', true,
            'previous_location_id', CASE WHEN v_cur_tl_id IS NOT NULL THEN (SELECT location_id FROM inventarios.session_zone_locations WHERE id = v_cur_szl_id) ELSE NULL END,
            'previous_task_location_id', v_cur_tl_id,
            'previous_status', CASE WHEN v_cur_tl_id IS NOT NULL THEN 'CLOSED' ELSE NULL END,
            'target_location_id', p_target_location_id,
            'target_task_location_id', v_tgt_tl_id,
            'target_status', 'OPEN',
            'reopened', v_reopened,
            'actor_id', v_actor_id
        )
    );

    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_tgt_tl_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.switch_my_counting_location(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.switch_my_counting_location(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.switch_my_counting_location(uuid, uuid, uuid) TO authenticated;


-- 5) get_my_counting_zone_locations: PENDING / OPEN / CLOSED + is_active
CREATE OR REPLACE FUNCTION inventarios.get_my_counting_zone_locations(p_zone_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id pg_catalog.uuid;
    v_zone_data pg_catalog.jsonb;
    v_task_id pg_catalog.uuid;
    v_locations_array pg_catalog.jsonb;
    v_location_count pg_catalog.int4;
    v_is_authorized pg_catalog.bool;
BEGIN
    v_actor_id := inventarios.require_actor();

    SELECT true INTO v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now()
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona de conteo.', 'retryable', false)::text;
    END IF;

    SELECT pg_catalog.jsonb_build_object(
        'zone_id', z.id,
        'zone_name', z.display_name,
        'zone_code', z.zone_code,
        'task_id', t.id,
        'task_status', t.status,
        'inventory_name', c.name,
        'site_name', st.name
    ), t.id
    INTO v_zone_data, v_task_id
    FROM inventarios.session_zones z
    JOIN inventarios.tasks t ON t.session_zone_id = z.id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.inventory_campaigns c ON c.id = s.campaign_id
    JOIN inventarios.inventory_sites st ON st.id = s.inventory_site_id
    JOIN inventarios.task_assignments a ON a.task_id = t.id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL
    LIMIT 1;

    WITH locs AS (
        SELECT
            sl.location_id,
            sl.code AS location_code,
            sl.name AS location_name,
            tl.id AS task_location_id,
            tl.status AS raw_status,
            tl.opened_at,
            CASE
                WHEN tl.status = 'OPEN' THEN 'OPEN'
                WHEN tl.status = 'CLOSED' THEN 'CLOSED'
                ELSE 'PENDING'
            END AS location_status,
            (tl.status = 'OPEN') AS is_active,
            pg_catalog.row_number() over (order by sl.code asc, sl.name asc) AS sort_order
        FROM inventarios.session_zone_locations szl
        JOIN inventarios.snapshot_locations sl ON sl.id = szl.snapshot_location_id
        LEFT JOIN LATERAL (
            SELECT tl2.id, tl2.status, tl2.opened_at
            FROM inventarios.task_locations tl2
            WHERE tl2.task_id = v_task_id
              AND tl2.session_zone_location_id = szl.id
            ORDER BY tl2.opened_at DESC NULLS LAST, tl2.id DESC
            LIMIT 1
        ) tl ON true
        WHERE szl.session_zone_id = p_zone_id
    )
    SELECT
        COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'location_id', location_id,
                'location_code', location_code,
                'location_name', location_name,
                'sort_order', sort_order,
                'task_location_id', task_location_id,
                'location_status', location_status,
                'is_active', is_active,
                'opened_at', opened_at
            )
        ), '[]'::pg_catalog.jsonb),
        COUNT(*)
    INTO v_locations_array, v_location_count
    FROM locs;

    RETURN pg_catalog.jsonb_build_object(
        'zone', v_zone_data,
        'location_count', v_location_count,
        'locations', v_locations_array
    );
END;
$function$;

ALTER FUNCTION inventarios.get_my_counting_zone_locations(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_my_counting_zone_locations(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_my_counting_zone_locations(uuid) TO authenticated;


-- 6) complete_my_counting_zone: cierra OPEN actual y completa la tarea (COUNTER contextual)
CREATE OR REPLACE FUNCTION inventarios.complete_my_counting_zone(p_zone_id uuid, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_task_id uuid;
    v_task_version integer;
    v_task_cycle integer;
    v_assignment_id uuid;
    v_is_authorized boolean := false;
    v_cur_tl_id uuid;
    v_cur_szl_id uuid;
    v_cur_code text;
    v_cur_name text;
    v_event_id uuid;
    v_zone_event_id uuid;
    v_occurred_at timestamptz := pg_catalog.now();
    v_missing_count bigint;
    v_blocking bigint;
    v_request_payload jsonb;
    v_request_hash text;
    v_operation jsonb;
    v_operation_id uuid;
    v_response jsonb;
    v_tasks_updated integer;
BEGIN
    IF p_zone_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, t.version, t.validation_cycle, a.id, true
    INTO v_company_id, v_task_id, v_session_id, v_task_version, v_task_cycle, v_assignment_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now()
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);
    PERFORM inventarios.require_session_counting(v_company_id, v_session_id);

    v_request_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.complete_my_counting_zone',
        'zone_id', p_zone_id,
        'actor_id', v_actor_id
    );
    v_request_hash := inventarios.compute_request_hash(v_request_payload);
    v_operation := inventarios.begin_idempotent_operation(
        v_company_id, 'inventarios.complete_my_counting_zone', p_idempotency_key, v_request_hash
    );
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- Cerrar ubicacion OPEN actual del actor (si existe)
    SELECT tl.id, szl.id, sl.code, sl.name
    INTO v_cur_tl_id, v_cur_szl_id, v_cur_code, v_cur_name
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    JOIN inventarios.snapshot_locations sl ON sl.id = szl.snapshot_location_id
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.opened_by = v_actor_id
      AND tl.status = 'OPEN'
    LIMIT 1;

    IF v_cur_tl_id IS NOT NULL THEN
        UPDATE inventarios.task_locations tl
        SET status = 'CLOSED', closed_at = v_occurred_at, closed_by = v_actor_id
        WHERE tl.id = v_cur_tl_id AND tl.status = 'OPEN';
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
                DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
        END IF;
        INSERT INTO inventarios.task_events (
            company_id, session_id, session_zone_id, task_id, event_type,
            actor_id, cycle, occurred_at, idempotency_key, source, technical_metadata, created_at, created_by
        ) VALUES (
            v_company_id, v_session_id, p_zone_id, v_task_id, 'LOCATION_CLOSED',
            v_actor_id, v_task_cycle, v_occurred_at,
            (pg_catalog.md5(p_idempotency_key::text || ':ZONE_LOCATION_CLOSED'))::uuid,
            'ANDROID',
            pg_catalog.jsonb_build_object('task_location_id', v_cur_tl_id, 'location_id', (SELECT location_id FROM inventarios.session_zone_locations WHERE id = v_cur_szl_id), 'zone_id', p_zone_id, 'reason', 'ZONE_COMPLETION'),
            v_occurred_at, v_actor_id
        ) ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING id INTO v_event_id;
    END IF;

    -- Guarda de cobertura (misma fuente que complete_inventory_task)
    IF NOT inventarios.task_selected_coverage_ok(v_company_id, v_session_id, v_task_id, p_zone_id, v_task_cycle) THEN
        SELECT pg_catalog.count(*) INTO v_missing_count
        FROM (
            SELECT sp.id AS snapshot_product_id, szl.snapshot_location_id
            FROM inventarios.session_product_scopes sps
            JOIN inventarios.snapshot_products sp
              ON sp.company_id = sps.company_id
             AND sp.product_id = sps.product_id
             AND sp.snapshot_id = (
                 SELECT os.id FROM inventarios.operational_snapshots os
                 WHERE os.company_id = sps.company_id AND os.session_id = sps.session_id
                 ORDER BY os.snapshot_version DESC LIMIT 1
             )
            JOIN inventarios.session_zone_locations szl
              ON szl.company_id = sps.company_id
             AND szl.session_id = sps.session_id
             AND szl.session_zone_id = p_zone_id
            WHERE sps.company_id = v_company_id
              AND sps.session_id = v_session_id
              AND sps.inclusion_type = 'INCLUDED'
              AND sps.product_id IS NOT NULL
            EXCEPT
            SELECT ce.snapshot_product_id, ce.snapshot_location_id
            FROM inventarios.count_entries ce
            WHERE ce.company_id = v_company_id
              AND ce.session_id = v_session_id
              AND ce.task_id = v_task_id
              AND ce.task_cycle = v_task_cycle
              AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL
              AND ce.invalidation_reason IS NULL
        ) missing_combos;

        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SELECTED_PRODUCT_LOCATION_NOT_REVIEWED',
            DETAIL = pg_catalog.jsonb_build_object(
                'message', 'Existen productos seleccionados sin revisar en esta ubicacion.',
                'missing_count', v_missing_count, 'retryable', false)::text;
    END IF;

    -- Incidentes bloqueantes
    SELECT pg_catalog.count(*) INTO v_blocking
    FROM inventarios.incidents i
    WHERE i.company_id = v_company_id AND i.task_id = v_task_id
      AND i.is_blocking = true AND i.status IN ('OPEN', 'UNDER_REVIEW');
    IF v_blocking > 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_TASK_BLOCKING_INCIDENTS',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La tarea posee incidentes bloqueantes pendientes.', 'retryable', false, 'blocking_incident_count', v_blocking)::text;
    END IF;

    UPDATE inventarios.tasks t
    SET status = 'COMPLETED',
        version = t.version + 1,
        completed_at = v_occurred_at,
        completed_by = v_actor_id,
        active_user_id = NULL,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE t.company_id = v_company_id AND t.id = v_task_id
      AND t.status = 'IN_PROGRESS'
      AND t.version = v_task_version;
    GET DIAGNOSTICS v_tasks_updated = ROW_COUNT;
    IF v_tasks_updated <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
    END IF;

    INSERT INTO inventarios.task_state_transitions (
        company_id, session_id, session_zone_id, task_id, assignment_id,
        operation_idempotency_id, transition_type, previous_status,
        next_status, previous_version, next_version, previous_cycle, next_cycle,
        actor_id, occurred_at
    ) VALUES (
        v_company_id, v_session_id, p_zone_id, v_task_id, v_assignment_id,
        v_operation_id, 'COMPLETED', 'IN_PROGRESS', 'COMPLETED',
        v_task_version, v_task_version + 1, v_task_cycle, v_task_cycle,
        v_actor_id, v_occurred_at
    );

    INSERT INTO inventarios.task_events (
        company_id, session_id, session_zone_id, task_id, event_type,
        actor_id, cycle, occurred_at, idempotency_key, source, technical_metadata, created_at, created_by
    ) VALUES (
        v_company_id, v_session_id, p_zone_id, v_task_id, 'ZONE_COMPLETED',
        v_actor_id, v_task_cycle, v_occurred_at,
        (pg_catalog.md5(p_idempotency_key::text || ':ZONE_COMPLETED'))::uuid,
        'ANDROID',
        pg_catalog.jsonb_build_object('task_id', v_task_id, 'zone_id', p_zone_id, 'closed_location_id', v_cur_tl_id),
        v_occurred_at, v_actor_id
    ) ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id INTO v_zone_event_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.complete_my_counting_zone',
        'entity_id', v_task_id,
        'state', 'COMPLETED',
        'version', v_task_version + 1,
        'cycle_number', v_task_cycle,
        'assignment_id', v_assignment_id,
        'event_id', v_zone_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'zone_id', p_zone_id,
            'closed_location_id', v_cur_tl_id,
            'location_closed_event_id', v_event_id,
            'zone_completed_event_id', v_zone_event_id,
            'status', 'COMPLETED'
        )
    );

    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_task_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.complete_my_counting_zone(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.complete_my_counting_zone(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.complete_my_counting_zone(uuid, uuid) TO authenticated;


-- 7) Endurecer complete_inventory_task: rechazar si queda ubicacion OPEN
CREATE OR REPLACE FUNCTION inventarios.complete_inventory_task(p_company_id uuid, p_task_id uuid, p_expected_version integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    a uuid; p uuid; o jsonb; oi uuid; s uuid; z uuid; st text; v integer; c integer; ca uuid;
    ac bigint; ai uuid; au uuid; ap uuid; at timestamptz; payload jsonb; response jsonb;
    v_missing_count bigint;
    v_open_locations bigint;
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

    -- GUARDA NUEVA: no completar dejando ubicaciones OPEN (el wrapper contextual las cierra antes)
    SELECT pg_catalog.count(*) INTO v_open_locations
    FROM inventarios.task_locations tl
    WHERE tl.company_id = p_company_id AND tl.task_id = p_task_id AND tl.status = 'OPEN';
    IF v_open_locations > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_STILL_OPEN',
            DETAIL=pg_catalog.jsonb_build_object('message','Existen ubicaciones abiertas; ciérralas antes de completar la zona.','open_locations',v_open_locations,'retryable',false)::text;
    END IF;

    -- GUARDA DE COBERTURA (misma fuente que get_task_coverage)
    IF NOT inventarios.task_selected_coverage_ok(p_company_id, s, p_task_id, z, c) THEN
        SELECT pg_catalog.count(*) INTO v_missing_count
        FROM (
            SELECT sp.id AS snapshot_product_id, szl.snapshot_location_id
            FROM inventarios.session_product_scopes sps
            JOIN inventarios.snapshot_products sp
              ON sp.company_id = sps.company_id
             AND sp.product_id = sps.product_id
             AND sp.snapshot_id = (
                 SELECT os.id FROM inventarios.operational_snapshots os
                 WHERE os.company_id = sps.company_id AND os.session_id = sps.session_id
                 ORDER BY os.snapshot_version DESC LIMIT 1
             )
            JOIN inventarios.session_zone_locations szl
              ON szl.company_id = sps.company_id
             AND szl.session_id = sps.session_id
             AND szl.session_zone_id = z
            WHERE sps.company_id = p_company_id
              AND sps.session_id = s
              AND sps.inclusion_type = 'INCLUDED'
              AND sps.product_id IS NOT NULL
            EXCEPT
            SELECT ce.snapshot_product_id, ce.snapshot_location_id
            FROM inventarios.count_entries ce
            WHERE ce.company_id = p_company_id
              AND ce.session_id = s
              AND ce.task_id = p_task_id
              AND ce.task_cycle = c
              AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL
              AND ce.invalidation_reason IS NULL
        ) missing_combos;

        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SELECTED_PRODUCT_LOCATION_NOT_REVIEWED',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','Existen productos seleccionados sin revisar en esta ubicacion.',
                'missing_count', v_missing_count, 'retryable', false)::text;
    END IF;

    at := pg_catalog.now();
    UPDATE inventarios.tasks t SET status='COMPLETED',version=t.version+1,completed_at=at,completed_by=a,active_user_id=NULL,updated_at=at,updated_by=a WHERE t.company_id=p_company_id AND t.id=p_task_id;
    INSERT INTO inventarios.task_state_transitions(company_id,session_id,session_zone_id,task_id,assignment_id,operation_idempotency_id,transition_type,previous_status,next_status,previous_version,next_version,previous_cycle,next_cycle,actor_id,occurred_at)
    VALUES(p_company_id,s,z,p_task_id,ai,oi,'COMPLETED','IN_PROGRESS','COMPLETED',v,v+1,c,c,a,at);
    response := pg_catalog.jsonb_build_object('operation','inventarios.task.complete','entity_id',p_task_id,'state','COMPLETED','version',v+1,'cycle_number',c,'assignment_id',ai,'event_id',NULL::uuid,'replayed',false,'occurred_at',at,'data',pg_catalog.jsonb_build_object());
    RETURN inventarios.complete_idempotent_operation(p_company_id,oi,p_task_id,response);
END;
$function$;

ALTER FUNCTION inventarios.complete_inventory_task(uuid, uuid, integer, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.complete_inventory_task(uuid, uuid, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.complete_inventory_task(uuid, uuid, integer, uuid) TO authenticated;
