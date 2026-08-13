-- M3: Mobile role-agnostic. Los RPCs Mobile dejan de exigir functional_role='COUNTER'.
---- Politica: un usuario con participacion activa en la jornada y assignment vigente en la
-- zona/tarea puede operar, sin importar su rol funcional. Se conserva toda la validacion
-- contextual (participacion activa, assignment no liberado, sesion COUNTING, estados de
-- tarea, active_user_id, propiedad de conteos).
---- Funciones internas compartidas:
--   * record_inventory_count: solo la usan los wrappers mobile (submit_my_mobile_count,
--     submit_mobile_manual_match_count). Mantiene require_active_assignment_participant
--     (validacion contextual sin rol) y la participacion activa; se elimina el filtro de rol.
--   * start_inventory_task: solo la usa start_my_counting_zone (wrapper mobile). Se reemplaza
--     require_session_participant('COUNTER') por require_active_assignment_participant, que
--     valida exactamente al participante activo de la asignacion del actor (sin rol).
--   * is_mobile_evidence_path_allowed: valida que el actor sea participante activo de la
--     jornada COUNTING (cualquier rol); el path ya identifica company/session/actor.

BEGIN;
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
    v_effective_counts bigint;
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

    -- Guarda: al menos una contribucion efectiva de la tarea/zona/ciclo
    SELECT pg_catalog.count(*) INTO v_effective_counts
    FROM inventarios.count_entries ce
    WHERE ce.company_id = v_company_id
      AND ce.session_id = v_session_id
      AND ce.task_id = v_task_id
      AND ce.task_cycle = v_task_cycle
      AND ce.invalidated_at IS NULL
      AND ce.invalidated_by IS NULL
      AND ce.invalidation_reason IS NULL
      AND ce.physical_quantity = ce.available_quantity + ce.damaged_quantity
          + ce.expired_quantity + ce.blocked_quantity + ce.other_unavailable_quantity;
    IF v_effective_counts < 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_TASK_NO_EFFECTIVE_COUNTS',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Debes registrar al menos un conteo antes de cerrar la zona.', 'retryable', false)::text;
    END IF;

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
            'status', 'COMPLETED',
            'effective_count', v_effective_counts
        )
    );

    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_task_id, v_response);
END;
$function$;
CREATE OR REPLACE FUNCTION inventarios.correct_my_counting_quantity(p_zone_id uuid, p_location_id uuid, p_root_count_entry_id uuid, p_expected_current_count_entry_id uuid, p_physical_quantity numeric, p_reason text, p_idempotency_key uuid, p_device_id text, p_captured_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
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
    v_szl_id uuid;
    v_snapshot_location_id uuid;
    v_reason text;
    v_devid text;
    v_current_id uuid;
    v_prev_correction_id uuid;
    v_prev_revision integer;
    v_revision_number integer;
    v_root_inv_at timestamptz;
    v_eff_inv_at timestamptz;
    v_pid uuid; v_vid integer; v_lid uuid; v_rid uuid; v_sid uuid; v_szid uuid; v_tid uuid; v_cyc integer;
    v_participant_id uuid;
    v_aid uuid;
    v_eff_ident text; v_eff_scanned text; v_eff_recount uuid;
    v_root_counted_by uuid;
    v_current_counted_by uuid;
    v_phys numeric(14,3);
    v_avail numeric(14,3); v_dam numeric(14,3); v_exp numeric(14,3); v_blk numeric(14,3); v_oth numeric(14,3);
    v_new_avail numeric(14,3);
    v_occ timestamptz; v_cap timestamptz;
    v_repl uuid;
    v_payload jsonb; v_request_hash text;
    v_operation jsonb; v_operation_id uuid;
    v_response jsonb;
BEGIN
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_root_count_entry_id IS NULL
       OR p_expected_current_count_entry_id IS NULL
       OR p_physical_quantity IS NULL OR p_physical_quantity < 0
       OR p_reason IS NULL OR p_idempotency_key IS NULL OR p_captured_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_reason := pg_catalog.btrim(p_reason);
    IF v_reason = '' OR pg_catalog.length(v_reason) < 5 OR pg_catalog.length(v_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    IF p_device_id IS NOT NULL THEN
        v_devid := pg_catalog.btrim(p_device_id);
        IF v_devid = '' THEN v_devid := NULL; END IF;
    END IF;
    IF v_devid IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Device ID es obligatorio.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.snapshot_id, z.id, t.validation_cycle, a.id, true
    INTO v_company_id, v_task_id, v_session_id, v_snapshot_id, v_session_zone_id, v_task_cycle, v_assignment_id, v_is_authorized
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
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT szl.id, szl.snapshot_location_id
    INTO v_szl_id, v_snapshot_location_id
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = v_company_id
      AND szl.session_id = v_session_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;

    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.count.correct',
        'zone_id', p_zone_id,
        'location_id', p_location_id,
        'root_count_entry_id', p_root_count_entry_id,
        'expected_current_count_entry_id', p_expected_current_count_entry_id,
        'physical_quantity', p_physical_quantity,
        'reason', v_reason,
        'device_id', v_devid,
        'captured_at', p_captured_at
    );
    v_request_hash := inventarios.compute_request_hash(v_payload);
    v_operation := inventarios.begin_idempotent_operation(v_company_id, 'inventarios.mobile.count.correct', p_idempotency_key, v_request_hash);
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.mobile.count.correct'),
        pg_catalog.hashtext(v_company_id::text || ':' || p_root_count_entry_id::text)
    );

    -- Root: contexto, PROPIEDAD del actor, ubicacion y no invalidado
    SELECT ce.session_id, ce.snapshot_id, ce.session_zone_id, ce.task_id, ce.task_cycle,
           ce.snapshot_product_id, ce.bsale_variant_id, ce.snapshot_location_id, ce.invalidated_at,
           ce.session_participant_id, ce.counted_by
    INTO v_sid, v_szid, v_rid, v_tid, v_cyc, v_pid, v_vid, v_lid, v_root_inv_at,
         v_participant_id, v_root_counted_by
    FROM inventarios.count_entries ce
    WHERE ce.company_id = v_company_id AND ce.id = p_root_count_entry_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    IF v_tid IS DISTINCT FROM v_task_id OR v_rid IS DISTINCT FROM v_session_zone_id
       OR v_lid IS DISTINCT FROM v_snapshot_location_id OR v_sid IS DISTINCT FROM v_session_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;
    -- Propiedad individual obligatoria: solo el COUNTER que creó el conteo puede corregirlo.
    IF v_root_counted_by IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a este registro de conteo.', 'retryable', false)::text;
    END IF;
    IF v_root_inv_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_COUNT_ALREADY_INVALIDATED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El conteo ya ha sido invalidado.', 'retryable', false, 'count_entry_id', p_root_count_entry_id)::text;
    END IF;

    -- Correccion activa previa y current efectivo
    SELECT cec.id, cec.revision_number, cec.replacement_count_entry_id
    INTO v_prev_correction_id, v_prev_revision, v_current_id
    FROM inventarios.count_entry_corrections cec
    WHERE cec.company_id = v_company_id AND cec.root_count_entry_id = p_root_count_entry_id AND cec.superseded_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        v_current_id := p_root_count_entry_id;
        v_prev_correction_id := NULL;
        v_prev_revision := NULL;
    END IF;
    IF v_current_id IS DISTINCT FROM p_expected_current_count_entry_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true, 'current_count_entry_id', v_current_id)::text;
    END IF;

    -- Current efectivo: vigencia, distribucion y PROPIEDAD (debe derivar del mismo root/actor)
    SELECT ce.invalidated_at, ce.available_quantity, ce.damaged_quantity, ce.expired_quantity,
           ce.blocked_quantity, ce.other_unavailable_quantity, ce.identification_method,
           ce.scanned_code, ce.recount_request_id, ce.counted_by, ce.session_participant_id
    INTO v_eff_inv_at, v_avail, v_dam, v_exp, v_blk, v_oth, v_eff_ident,
         v_eff_scanned, v_eff_recount, v_current_counted_by, v_participant_id
    FROM inventarios.count_entries ce
    WHERE ce.company_id = v_company_id AND ce.id = v_current_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    IF v_eff_inv_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_COUNT_ALREADY_INVALIDATED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El conteo ya ha sido invalidado.', 'retryable', false, 'count_entry_id', v_current_id)::text;
    END IF;
    -- El current efectivo debe conservar la propiedad del COUNTER original.
    IF v_current_counted_by IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a este registro de conteo.', 'retryable', false)::text;
    END IF;

    IF v_dam > 0 OR v_exp > 0 OR v_blk > 0 OR v_oth > 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_COUNT_DISTRIBUTION_NOT_SIMPLE',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El conteo posee cantidades en estados que no pueden corregirse con la captura simple Mobile.', 'retryable', false)::text;
    END IF;

    v_new_avail := p_physical_quantity;
    v_phys := v_new_avail + 0 + 0 + 0 + 0;
    IF v_avail = v_new_avail AND v_dam = 0 AND v_exp = 0 AND v_blk = 0 AND v_oth = 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_COUNT_QUANTITY_MISMATCH',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Las cantidades ingresadas no son validas para esta operacion.', 'retryable', false)::text;
    END IF;

    IF v_prev_revision IS NULL THEN v_revision_number := 1; ELSE v_revision_number := v_prev_revision + 1; END IF;

    v_occ := pg_catalog.now();
    v_cap := p_captured_at;
    IF v_cap > v_occ THEN v_cap := v_occ; END IF;

    -- Replacement: conserva la propiedad del COUNTER original (counted_by/created_by = actor,
    -- quien por la guarda es el mismo COUNTER que creó el conteo) y el participante de sesion.
    INSERT INTO inventarios.count_entries (
        company_id, session_id, snapshot_id, session_zone_id, task_id, task_cycle,
        session_participant_id, counted_by, snapshot_product_id, snapshot_location_id,
        bsale_variant_id, identification_method, scanned_code, capture_source,
        offline_id, device_id, captured_at, server_received_at, synced_at, synced_by,
        physical_quantity, available_quantity, damaged_quantity, expired_quantity,
        blocked_quantity, other_unavailable_quantity, recount_request_id, created_by
    ) VALUES (
        v_company_id, v_sid, v_szid, v_rid, v_tid, v_cyc,
        v_participant_id, v_actor_id, v_pid, v_lid, v_vid,
        v_eff_ident, v_eff_scanned, 'MOBILE',
        p_idempotency_key, v_devid, v_cap, v_occ, v_occ, v_actor_id,
        v_phys, v_new_avail, 0, 0, 0, 0, v_eff_recount, v_actor_id
    ) RETURNING id INTO v_repl;

    IF v_prev_correction_id IS NOT NULL THEN
        UPDATE inventarios.count_entry_corrections SET superseded_at = v_occ
        WHERE id = v_prev_correction_id AND company_id = v_company_id AND superseded_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
                DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
        END IF;
    END IF;

    INSERT INTO inventarios.count_entry_corrections (
        company_id, session_id, task_id, snapshot_product_id, root_count_entry_id,
        previous_count_entry_id, replacement_count_entry_id, supersedes_correction_id,
        revision_number, reason, corrected_by, corrected_at
    ) VALUES (
        v_company_id, v_sid, v_tid, v_pid, p_root_count_entry_id,
        v_current_id, v_repl, v_prev_correction_id,
        v_revision_number, v_reason, v_actor_id, v_occ
    );

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.count.correct',
        'entity_id', v_repl,
        'state', NULL::text,
        'version', NULL::integer,
        'cycle_number', v_cyc,
        'assignment_id', v_assignment_id,
        'event_id', NULL::uuid,
        'replayed', false,
        'occurred_at', v_occ,
        'data', pg_catalog.jsonb_build_object(
            'root_count_entry_id', p_root_count_entry_id,
            'previous_count_entry_id', v_current_id,
            'current_count_entry_id', v_repl,
            'revision_number', v_revision_number,
            'physical_quantity', v_phys,
            'available_quantity', v_new_avail,
            'captured_at', v_cap
        )
    );
    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_repl, v_response);
END;
$function$;
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
CREATE OR REPLACE FUNCTION inventarios.get_my_manual_barcode_resolution(p_zone_id uuid, p_location_id uuid, p_snapshot_product_id uuid, p_scanned_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_task_id uuid;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
    v_clean_scanned_code text;
    v_cur_bsale_variant_id integer;
    v_pending_count bigint;
    v_same_count bigint;
    v_other_count bigint;
    v_distinct_products bigint;
    v_other_proposal_id uuid;
    v_other_count_entry_id uuid;
    v_other_bsale_variant_id integer;
    v_other_sku text;
    v_other_name text;
    v_other_product_id uuid;
    v_repl_snapshot_product_id uuid;
    v_repl_in_snapshot boolean := false;
    v_conflict_variants jsonb;
BEGIN
    v_clean_scanned_code := pg_catalog.btrim(p_scanned_code);
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_snapshot_product_id IS NULL OR v_clean_scanned_code IS NULL OR v_clean_scanned_code = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
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
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT true INTO v_is_open
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id
      AND tl.status = 'OPEN';
    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    SELECT sp.bsale_variant_id INTO v_cur_bsale_variant_id
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.id = p_snapshot_product_id;
    IF v_cur_bsale_variant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_PRODUCT',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El producto no pertenece al inventario activo.', 'retryable', false)::text;
    END IF;

    -- Asociacion oficial (misma regla que submit_mobile_manual_match_count)
    IF EXISTS (
        SELECT 1 FROM integraciones.bsale_variants bv
        WHERE bv.company_id = v_company_id AND bv.state = 0 AND bv.bar_code = v_clean_scanned_code
    ) OR EXISTS (
        SELECT 1 FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id
          AND sp.barcode = v_clean_scanned_code
          AND sp.bsale_variant_id IS DISTINCT FROM v_cur_bsale_variant_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_BARCODE_ALREADY_ASSOCIATED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El código de barras ya está asociado a un producto de la maestra.', 'retryable', false)::text;
    END IF;

    -- Propuestas PENDING_REVIEW del barcode (solo count_entry origen vigente)
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE ce.bsale_variant_id IS NOT DISTINCT FROM v_cur_bsale_variant_id),
        pg_catalog.count(*) FILTER (WHERE ce.bsale_variant_id IS DISTINCT FROM v_cur_bsale_variant_id),
        pg_catalog.count(DISTINCT ce.bsale_variant_id)
    INTO v_pending_count, v_same_count, v_other_count, v_distinct_products
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
    WHERE pbp.company_id = v_company_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_clean_scanned_code
      AND ce.invalidated_at IS NULL
      AND ce.invalidated_by IS NULL
      AND ce.invalidation_reason IS NULL;

    IF v_pending_count = 0 THEN
        RETURN pg_catalog.jsonb_build_object(
            'status', 'AVAILABLE',
            'selected_product', pg_catalog.jsonb_build_object(
                'snapshot_product_id', p_snapshot_product_id,
                'bsale_variant_id', v_cur_bsale_variant_id
            ),
            'proposal', NULL::jsonb
        );
    END IF;

    -- Inconsistencia explicita (solo vigentes)
    IF v_distinct_products > 1 THEN
        SELECT pg_catalog.coalesce(pg_catalog.jsonb_agg(DISTINCT ce.bsale_variant_id), '[]'::jsonb)
        INTO v_conflict_variants
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
        WHERE pbp.company_id = v_company_id
          AND pbp.status = 'PENDING_REVIEW'
          AND pbp.scanned_code = v_clean_scanned_code
          AND ce.invalidated_at IS NULL
          AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL;

        RETURN pg_catalog.jsonb_build_object(
            'status', 'INCONSISTENT_PENDING',
            'proposal', NULL::jsonb,
            'conflicting_bsale_variant_ids', v_conflict_variants,
            'message', 'El código de barras tiene propuestas pendientes contradictorias; requiere revisión administrativa.'
        );
    END IF;

    -- Solo propuestas del mismo producto -> reutilizable (solo vigentes)
    IF v_other_count = 0 THEN
        SELECT pbp.id
        INTO v_other_proposal_id
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
        WHERE pbp.company_id = v_company_id
          AND pbp.status = 'PENDING_REVIEW'
          AND pbp.scanned_code = v_clean_scanned_code
          AND ce.bsale_variant_id IS NOT DISTINCT FROM v_cur_bsale_variant_id
          AND ce.invalidated_at IS NULL
          AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL
        ORDER BY pbp.proposed_at ASC, pbp.id ASC
        LIMIT 1;

        RETURN pg_catalog.jsonb_build_object(
            'status', 'SAME_PRODUCT_PENDING',
            'selected_product', pg_catalog.jsonb_build_object(
                'snapshot_product_id', p_snapshot_product_id,
                'bsale_variant_id', v_cur_bsale_variant_id
            ),
            'proposal', pg_catalog.jsonb_build_object('id', v_other_proposal_id)
        );
    END IF;

    -- Propuesta pendiente para OTRO producto (solo vigentes)
    SELECT pbp.id, ce.id, ce.bsale_variant_id, sp.sku, sp.name
    INTO v_other_proposal_id, v_other_count_entry_id, v_other_bsale_variant_id, v_other_sku, v_other_name
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
    JOIN inventarios.snapshot_products sp ON sp.id = ce.snapshot_product_id
    WHERE pbp.company_id = v_company_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_clean_scanned_code
      AND ce.bsale_variant_id IS DISTINCT FROM v_cur_bsale_variant_id
      AND ce.invalidated_at IS NULL
      AND ce.invalidated_by IS NULL
      AND ce.invalidation_reason IS NULL
    ORDER BY pbp.proposed_at ASC, pbp.id ASC
    LIMIT 1;

    IF v_other_proposal_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'status', 'INCONSISTENT_PENDING',
            'proposal', NULL::jsonb,
            'conflicting_bsale_variant_ids', '[]'::jsonb,
            'message', 'El código de barras tiene propuestas pendientes contradictorias; requiere revisión administrativa.'
        );
    END IF;

    -- Membresia del producto previamente propuesto en el snapshot de la ubicacion actual
    SELECT sp.id INTO v_repl_snapshot_product_id
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id
      AND sp.snapshot_id = v_snapshot_id
      AND sp.bsale_variant_id = v_other_bsale_variant_id
    ORDER BY sp.id ASC
    LIMIT 1;
    v_repl_in_snapshot := v_repl_snapshot_product_id IS NOT NULL;

    SELECT p.id INTO v_other_product_id
    FROM adquisiciones.products p
    WHERE p.company_id = v_company_id AND p.bsale_variant_id = v_other_bsale_variant_id
    ORDER BY p.updated_at DESC NULLS LAST, p.id ASC
    LIMIT 1;

    RETURN pg_catalog.jsonb_build_object(
        'status', 'OTHER_PRODUCT_PENDING',
        'proposal', pg_catalog.jsonb_build_object(
            'id', v_other_proposal_id,
            'product_id', v_other_product_id,
            'bsale_variant_id', v_other_bsale_variant_id,
            'sku', v_other_sku,
            'name', v_other_name
        ),
        'replacement_for_current_location', pg_catalog.jsonb_build_object(
            'in_snapshot', v_repl_in_snapshot,
            'snapshot_product_id', v_repl_snapshot_product_id
        )
    );
END;
$function$;
CREATE OR REPLACE FUNCTION inventarios.get_my_mobile_evidence_context(p_zone_id uuid, p_location_id uuid)
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
    v_is_authorized boolean := false;
    v_is_open boolean := false;
BEGIN
    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, true
    INTO v_company_id, v_task_id, v_session_id, v_is_authorized
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
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;

    PERFORM inventarios.require_company_access(v_company_id);

    SELECT true INTO v_is_open
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id
      AND tl.status = 'OPEN';

    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'company_id', v_company_id,
        'session_id', v_session_id,
        'actor_id', v_actor_id,
        'bucket', 'inventory-evidence'
    );
END;
$function$;
CREATE OR REPLACE FUNCTION inventarios.invalidate_my_counting_record(p_zone_id uuid, p_location_id uuid, p_root_count_entry_id uuid, p_expected_current_count_entry_id uuid, p_reason text, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_session_zone_id uuid;
    v_task_id uuid;
    v_assignment_id uuid;
    v_is_authorized boolean := false;
    v_szl_id uuid;
    v_snapshot_location_id uuid;
    v_reason text;
    v_current_id uuid;
    v_active_correction_id uuid;
    v_root_inv_at timestamptz;
    v_eff_inv_at timestamptz;
    v_eff_inv_by uuid;
    v_eff_inv_rs text;
    v_sid uuid; v_rid uuid; v_tid uuid; v_cyc integer;
    v_root_counted_by uuid;
    v_current_counted_by uuid;
    v_invalidated_at timestamptz;
    v_payload jsonb; v_request_hash text;
    v_operation jsonb; v_operation_id uuid;
    v_response jsonb;
BEGIN
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_root_count_entry_id IS NULL
       OR p_expected_current_count_entry_id IS NULL
       OR p_reason IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_reason := pg_catalog.btrim(p_reason);
    IF v_reason = '' OR pg_catalog.length(v_reason) < 5 OR pg_catalog.length(v_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.id, a.id, true
    INTO v_company_id, v_task_id, v_session_id, v_session_zone_id, v_assignment_id, v_is_authorized
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
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT szl.id, szl.snapshot_location_id
    INTO v_szl_id, v_snapshot_location_id
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = v_company_id
      AND szl.session_id = v_session_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;

    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.count.invalidate',
        'zone_id', p_zone_id,
        'location_id', p_location_id,
        'root_count_entry_id', p_root_count_entry_id,
        'expected_current_count_entry_id', p_expected_current_count_entry_id,
        'reason', v_reason
    );
    v_request_hash := inventarios.compute_request_hash(v_payload);
    v_operation := inventarios.begin_idempotent_operation(v_company_id, 'inventarios.mobile.count.invalidate', p_idempotency_key, v_request_hash);
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.mobile.count.invalidate'),
        pg_catalog.hashtext(v_company_id::text || ':' || p_root_count_entry_id::text)
    );

    -- Root: contexto, PROPIEDAD del actor y no invalidado
    SELECT ce.session_id, ce.session_zone_id, ce.task_id, ce.task_cycle, ce.invalidated_at, ce.counted_by
    INTO v_sid, v_rid, v_tid, v_cyc, v_root_inv_at, v_root_counted_by
    FROM inventarios.count_entries ce
    WHERE ce.company_id = v_company_id AND ce.id = p_root_count_entry_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    IF v_tid IS DISTINCT FROM v_task_id OR v_rid IS DISTINCT FROM v_session_zone_id
       OR v_sid IS DISTINCT FROM v_session_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;
    -- Propiedad individual obligatoria: solo el COUNTER que creó el conteo puede anularlo.
    IF v_root_counted_by IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a este registro de conteo.', 'retryable', false)::text;
    END IF;
    IF v_root_inv_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_COUNT_ALREADY_INVALIDATED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El conteo ya ha sido invalidado.', 'retryable', false, 'count_entry_id', p_root_count_entry_id)::text;
    END IF;

    SELECT cec.id, cec.replacement_count_entry_id
    INTO v_active_correction_id, v_current_id
    FROM inventarios.count_entry_corrections cec
    WHERE cec.company_id = v_company_id AND cec.root_count_entry_id = p_root_count_entry_id AND cec.superseded_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        v_current_id := p_root_count_entry_id;
        v_active_correction_id := NULL;
    END IF;
    IF v_current_id IS DISTINCT FROM p_expected_current_count_entry_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true, 'current_count_entry_id', v_current_id)::text;
    END IF;

    SELECT ce.invalidated_at, ce.invalidated_by, ce.invalidation_reason, ce.counted_by
    INTO v_eff_inv_at, v_eff_inv_by, v_eff_inv_rs, v_current_counted_by
    FROM inventarios.count_entries ce WHERE ce.company_id = v_company_id AND ce.id = v_current_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;
    -- El current efectivo debe conservar la propiedad del COUNTER original.
    IF v_current_counted_by IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a este registro de conteo.', 'retryable', false)::text;
    END IF;
    IF v_eff_inv_at IS NOT NULL AND v_eff_inv_by IS NOT NULL AND v_eff_inv_rs IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_COUNT_ALREADY_INVALIDATED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'El conteo ya ha sido invalidado.', 'retryable', false, 'count_entry_id', v_current_id)::text;
    END IF;
    IF v_eff_inv_at IS NOT NULL OR v_eff_inv_by IS NOT NULL OR v_eff_inv_rs IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
    END IF;

    v_invalidated_at := pg_catalog.now();
    -- invalidated_by queda con el actor autenticado (nunca un UUID enviado por Mobile).
    UPDATE inventarios.count_entries
    SET invalidated_at = v_invalidated_at, invalidated_by = v_actor_id, invalidation_reason = v_reason
    WHERE company_id = v_company_id AND id = v_current_id
      AND invalidated_at IS NULL AND invalidated_by IS NULL AND invalidation_reason IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION',
            DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.count.invalidate',
        'entity_id', v_current_id,
        'state', NULL::text,
        'version', NULL::integer,
        'cycle_number', v_cyc,
        'assignment_id', v_assignment_id,
        'event_id', NULL::uuid,
        'replayed', false,
        'occurred_at', v_invalidated_at,
        'data', pg_catalog.jsonb_build_object(
            'root_count_entry_id', p_root_count_entry_id,
            'count_entry_id', v_current_id,
            'active_correction_id', v_active_correction_id,
            'invalidated_at', v_invalidated_at,
            'reason', v_reason
        )
    );
    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_current_id, v_response);
END;
$function$;
CREATE OR REPLACE FUNCTION inventarios.is_mobile_evidence_path_allowed(p_object_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
BEGIN
    v_actor_id := auth.uid();

    IF v_actor_id IS NULL OR p_object_name IS NULL OR pg_catalog.btrim(p_object_name) = '' THEN
        RETURN false;
    END IF;

    IF p_object_name !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(jpg|png|webp)$' THEN
        RETURN false;
    END IF;

    BEGIN
        v_company_id := pg_catalog.split_part(p_object_name, '/', 1)::uuid;
        v_session_id := pg_catalog.split_part(p_object_name, '/', 2)::uuid;
    EXCEPTION WHEN OTHERS THEN
        RETURN false;
    END;

    IF pg_catalog.split_part(p_object_name, '/', 3)::uuid IS DISTINCT FROM v_actor_id THEN
        RETURN false;
    END IF;

    IF NOT core.has_company_access(v_actor_id, v_company_id) THEN
        RETURN false;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM inventarios.sessions s
        JOIN inventarios.session_participants sp
          ON sp.company_id = s.company_id
         AND sp.session_id = s.id
         AND sp.user_id = v_actor_id
         AND sp.active_from <= pg_catalog.now()
         AND sp.revoked_at IS NULL
        WHERE s.company_id = v_company_id
          AND s.id = v_session_id
          AND s.status = 'COUNTING'
    ) THEN
        RETURN false;
    END IF;

    RETURN true;
EXCEPTION WHEN OTHERS THEN
    RETURN false;
END;
$function$;
CREATE OR REPLACE FUNCTION inventarios.list_my_location_counts(p_zone_id uuid, p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_task_id uuid;
    v_is_authorized boolean := false;
    v_szl_id uuid;
    v_snapshot_location_id uuid;
    v_loc_status text := 'PENDING';
    v_records jsonb;
    v_zone_id uuid;
BEGIN
    IF p_zone_id IS NULL OR p_location_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, z.id, true
    INTO v_company_id, v_task_id, v_session_id, v_zone_id, v_is_authorized
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
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT szl.id, szl.snapshot_location_id
    INTO v_szl_id, v_snapshot_location_id
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = v_company_id
      AND szl.session_id = v_session_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta ubicación.', 'retryable', false)::text;
    END IF;

    SELECT CASE WHEN tl.status = 'OPEN' THEN 'OPEN' ELSE 'CLOSED' END
    INTO v_loc_status
    FROM inventarios.task_locations tl
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.session_zone_id = p_zone_id
      AND tl.session_zone_location_id = v_szl_id
      AND tl.opened_by = v_actor_id
    ORDER BY tl.opened_at DESC, tl.id DESC
    LIMIT 1;

    WITH my_roots AS (
        SELECT DISTINCT ce.id AS root_count_entry_id
        FROM inventarios.count_entries ce
        WHERE ce.company_id = v_company_id
          AND ce.session_id = v_session_id
          AND ce.task_id = v_task_id
          AND ce.session_zone_id = p_zone_id
          AND ce.snapshot_location_id = v_snapshot_location_id
          AND ce.counted_by = v_actor_id
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.count_entry_corrections cec
              WHERE cec.company_id = v_company_id AND cec.replacement_count_entry_id = ce.id
          )
    ),
    resolved AS (
        SELECT r.root_count_entry_id,
               COALESCE(
                   (SELECT cec.replacement_count_entry_id
                    FROM inventarios.count_entry_corrections cec
                    WHERE cec.company_id = v_company_id AND cec.root_count_entry_id = r.root_count_entry_id
                      AND cec.superseded_at IS NULL),
                   r.root_count_entry_id
               ) AS current_count_entry_id
        FROM my_roots r
    ),
    final_rows AS (
        SELECT res.root_count_entry_id, res.current_count_entry_id,
               ce.snapshot_product_id, ce.bsale_variant_id, ce.physical_quantity,
               ce.identification_method, ce.scanned_code, ce.captured_at,
               COALESCE((SELECT cec.revision_number FROM inventarios.count_entry_corrections cec
                         WHERE cec.company_id = v_company_id AND cec.root_count_entry_id = res.root_count_entry_id
                           AND cec.superseded_at IS NULL), 0) AS revision_number,
               sp.sku,
               COALESCE(
                   NULLIF(pg_catalog.btrim(pg_catalog.concat_ws(' - ', bp.name, bv.description)), ''),
                   sp.name
               ) AS name
        FROM resolved res
        JOIN inventarios.count_entries ce ON ce.id = res.current_count_entry_id
        LEFT JOIN inventarios.snapshot_products sp ON sp.id = ce.snapshot_product_id
        LEFT JOIN integraciones.bsale_variants bv ON bv.company_id = ce.company_id AND bv.bsale_id = ce.bsale_variant_id
        LEFT JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
        WHERE ce.invalidated_at IS NULL
          AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL
    )
    SELECT coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'root_count_entry_id', root_count_entry_id,
            'current_count_entry_id', current_count_entry_id,
            'snapshot_product_id', snapshot_product_id,
            'bsale_variant_id', bsale_variant_id,
            'sku', sku,
            'name', name,
            'physical_quantity', physical_quantity,
            'identification_method', identification_method,
            'scanned_code', scanned_code,
            'captured_at', captured_at,
            'revision_number', revision_number
        ) ORDER BY captured_at ASC, root_count_entry_id ASC
    ), '[]'::jsonb)
    INTO v_records
    FROM final_rows;

    RETURN pg_catalog.jsonb_build_object(
        'zone_id', p_zone_id,
        'location_id', p_location_id,
        'location_status', v_loc_status,
        'records', v_records
    );
END;
$function$;
CREATE OR REPLACE FUNCTION inventarios.lookup_my_counting_product(p_zone_id uuid, p_location_id uuid, p_barcode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
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
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;

    PERFORM inventarios.require_company_access(v_company_id);

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
    SELECT coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'product_id', c.product_id,
            'bsale_variant_id', c.bsale_variant_id,
            'sku', c.sku,
            'barcode', c.barcode,
            'name', mm.name,
            'snapshot_product_id', si.snapshot_product_id,
            'in_snapshot', CASE WHEN si.snapshot_product_id IS NOT NULL THEN true ELSE false END
        ) ORDER BY c.sku ASC, c.name ASC, c.bsale_variant_id ASC
    ), '[]'::jsonb), pg_catalog.count(*)
    INTO v_matches, v_match_count
    FROM candidates c
    LEFT JOIN master_matches mm ON mm.bsale_variant_id = c.bsale_variant_id
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
CREATE OR REPLACE FUNCTION inventarios.record_inventory_count(p_company_id uuid, p_task_id uuid, p_expected_cycle integer, p_snapshot_product_id uuid, p_snapshot_location_id uuid, p_quantities jsonb, p_identification_method text, p_scanned_code text, p_capture_source text, p_offline_id uuid, p_device_id text, p_captured_at timestamp with time zone, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
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

    v_actor_id := inventarios.require_company_access(p_company_id);

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

    IF NOT EXISTS (
        SELECT 1
        FROM inventarios.session_participants AS sp
        WHERE sp.company_id = p_company_id
          AND sp.session_id = v_session_id
          AND sp.id = v_participant_id
          AND sp.user_id = v_actor_id
          AND sp.active_from <= pg_catalog.now()
          AND sp.revoked_at IS NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;

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
CREATE OR REPLACE FUNCTION inventarios.resolve_my_scanned_barcode(p_zone_id uuid, p_location_id uuid, p_barcode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_task_id uuid;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
    v_clean_barcode text;
    v_lookup jsonb;
    v_lookup_status text;
    v_pending_count bigint;
    v_distinct_products bigint;
    v_ref_proposal_id uuid;
    v_ref_bsale_variant_id integer;
    v_ref_sku text;
    v_ref_name text;
    v_ref_product_id uuid;
    v_repl_snapshot_product_id uuid;
    v_conflict_variants jsonb;
BEGIN
    v_clean_barcode := pg_catalog.btrim(p_barcode);
    IF p_zone_id IS NULL OR p_location_id IS NULL OR v_clean_barcode IS NULL OR v_clean_barcode = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
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
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT true INTO v_is_open
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id
      AND tl.status = 'OPEN';
    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    -- 1) Asociacion oficial: prioridad absoluta; semantica certificada del lookup.
    v_lookup := inventarios.lookup_my_counting_product(p_zone_id, p_location_id, v_clean_barcode);
    v_lookup_status := v_lookup ->> 'status';
    IF v_lookup_status IS NOT NULL AND v_lookup_status <> 'NOT_FOUND' THEN
        RETURN v_lookup;
    END IF;

    -- 2..5) Sin asociacion oficial: propuestas PENDING_REVIEW del barcode con count_entry
    -- origen vigente (no invalidado). Las propuestas de capturas anuladas no participan.
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(DISTINCT ce.bsale_variant_id)
    INTO v_pending_count, v_distinct_products
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
    WHERE pbp.company_id = v_company_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_clean_barcode
      AND ce.invalidated_at IS NULL
      AND ce.invalidated_by IS NULL
      AND ce.invalidation_reason IS NULL;

    IF v_pending_count = 0 THEN
        RETURN pg_catalog.jsonb_build_object('status', 'UNKNOWN', 'proposal', NULL::jsonb);
    END IF;

    -- 4) Contradiccion: propuestas para mas de un producto (solo vigentes)
    IF v_distinct_products > 1 THEN
        SELECT pg_catalog.coalesce(pg_catalog.jsonb_agg(DISTINCT ce.bsale_variant_id ORDER BY ce.bsale_variant_id), '[]'::jsonb)
        INTO v_conflict_variants
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
        WHERE pbp.company_id = v_company_id
          AND pbp.status = 'PENDING_REVIEW'
          AND pbp.scanned_code = v_clean_barcode
          AND ce.invalidated_at IS NULL
          AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL;

        RETURN pg_catalog.jsonb_build_object(
            'status', 'INCONSISTENT_PENDING',
            'proposal', NULL::jsonb,
            'conflicting_bsale_variant_ids', v_conflict_variants
        );
    END IF;

    -- 3) Propuesta unica y coherente: referencia determinista (la mas antigua vigente)
    SELECT pbp.id, ce.bsale_variant_id, sp.sku, sp.name
    INTO v_ref_proposal_id, v_ref_bsale_variant_id, v_ref_sku, v_ref_name
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
    JOIN inventarios.snapshot_products sp ON sp.id = ce.snapshot_product_id
    WHERE pbp.company_id = v_company_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_clean_barcode
      AND ce.invalidated_at IS NULL
      AND ce.invalidated_by IS NULL
      AND ce.invalidation_reason IS NULL
    ORDER BY pbp.proposed_at ASC, pbp.id ASC
    LIMIT 1;

    IF v_ref_proposal_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('status', 'UNKNOWN', 'proposal', NULL::jsonb);
    END IF;

    -- Membresia del producto propuesto en el snapshot de la zona/ubicacion actual
    SELECT sp.id INTO v_repl_snapshot_product_id
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id
      AND sp.snapshot_id = v_snapshot_id
      AND sp.bsale_variant_id = v_ref_bsale_variant_id
    ORDER BY sp.id ASC
    LIMIT 1;

    SELECT p.id INTO v_ref_product_id
    FROM adquisiciones.products p
    WHERE p.company_id = v_company_id AND p.bsale_variant_id = v_ref_bsale_variant_id
    ORDER BY p.updated_at DESC NULLS LAST, p.id ASC
    LIMIT 1;

    IF v_repl_snapshot_product_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'status', 'PENDING_REVIEW',
            'proposal', pg_catalog.jsonb_build_object(
                'id', v_ref_proposal_id,
                'product_id', v_ref_product_id,
                'bsale_variant_id', v_ref_bsale_variant_id,
                'sku', v_ref_sku,
                'name', v_ref_name
            ),
            'replacement_for_current_location', pg_catalog.jsonb_build_object(
                'in_snapshot', false,
                'snapshot_product_id', NULL::uuid
            ),
            'blocked', true
        );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'status', 'PENDING_REVIEW',
        'proposal', pg_catalog.jsonb_build_object(
            'id', v_ref_proposal_id,
            'product_id', v_ref_product_id,
            'bsale_variant_id', v_ref_bsale_variant_id,
            'sku', v_ref_sku,
            'name', v_ref_name
        ),
        'replacement_for_current_location', pg_catalog.jsonb_build_object(
            'in_snapshot', true,
            'snapshot_product_id', v_repl_snapshot_product_id
        )
    );
END;
$function$;
CREATE OR REPLACE FUNCTION inventarios.search_master_products(p_zone_id uuid, p_location_id uuid, p_query text, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
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
      AND p.user_id = v_actor_id
      AND p.active_from <= pg_catalog.now() AND p.revoked_at IS NULL
      AND s.status = 'COUNTING' AND z.is_enabled = true AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

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

    -- Maestra global de la empresa: todos los productos activos (fuente oficial),
    -- sin excluir por estado del espejo Bsale ni por snapshot.
    WITH snapshot_inventory AS (
        SELECT DISTINCT ON (sp.bsale_variant_id) sp.bsale_variant_id, sp.id AS snapshot_product_id
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.bsale_variant_id IS NOT NULL
        ORDER BY sp.bsale_variant_id, sp.id
    ),
    master_rows AS (
        SELECT
            p.id AS product_id,
            p.bsale_variant_id AS bsale_variant_id,
            p.sku AS sku,
            p.barcode AS barcode,
            coalesce(NULLIF(pg_catalog.btrim(p.description), ''), NULLIF(pg_catalog.btrim(p.short_description), '')) AS name,
            CASE
                WHEN p.sku ILIKE v_clean_query OR p.description ILIKE v_clean_query OR p.short_description ILIKE v_clean_query OR p.barcode ILIKE v_clean_query THEN 1
                WHEN p.sku ILIKE v_clean_query || '%' OR p.description ILIKE v_clean_query || '%' OR p.short_description ILIKE v_clean_query || '%' OR p.barcode ILIKE v_clean_query || '%' THEN 2
                ELSE 3
            END AS match_rank,
            CASE
                WHEN p.sku ILIKE v_clean_query THEN 1
                WHEN p.description ILIKE v_clean_query THEN 2
                WHEN p.short_description ILIKE v_clean_query THEN 3
                WHEN p.barcode ILIKE v_clean_query THEN 4
                WHEN p.sku ILIKE v_clean_query || '%' THEN 5
                WHEN p.description ILIKE v_clean_query || '%' THEN 6
                WHEN p.short_description ILIKE v_clean_query || '%' THEN 7
                WHEN p.barcode ILIKE v_clean_query || '%' THEN 8
                WHEN p.sku ILIKE '%' || v_clean_query || '%' THEN 9
                WHEN p.description ILIKE '%' || v_clean_query || '%' THEN 10
                WHEN p.short_description ILIKE '%' || v_clean_query || '%' THEN 11
                WHEN p.barcode ILIKE '%' || v_clean_query || '%' THEN 12
                ELSE 13
            END AS match_field_rank
        FROM adquisiciones.products p
        WHERE p.company_id = v_company_id AND p.is_active = true
          AND (
              p.sku ILIKE '%' || v_clean_query || '%'
              OR p.description ILIKE '%' || v_clean_query || '%'
              OR p.short_description ILIKE '%' || v_clean_query || '%'
              OR p.barcode ILIKE '%' || v_clean_query || '%'
          )
    ),
    search_dedup AS (
        SELECT mr.*, pg_catalog.row_number() OVER (
            PARTITION BY mr.product_id
            ORDER BY mr.match_rank ASC, mr.match_field_rank ASC, mr.name ASC, mr.product_id ASC
        ) AS rn
        FROM master_rows mr
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
        ORDER BY su.match_rank ASC, su.match_field_rank ASC, su.name ASC, su.product_id ASC
        LIMIT v_limit
    )
    SELECT coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'product_id', r.product_id,
            'bsale_variant_id', r.bsale_variant_id,
            'sku', r.sku,
            'barcode', r.barcode,
            'name', r.name,
            'snapshot_product_id', r.snapshot_product_id,
            'in_snapshot', r.in_snapshot
        ) ORDER BY r.match_rank ASC, r.match_field_rank ASC, r.name ASC, r.product_id ASC
    ), '[]'::jsonb)
    INTO v_results
    FROM ranked_results r;

    RETURN v_results;
END;
$function$;
CREATE OR REPLACE FUNCTION inventarios.start_inventory_task(p_company_id uuid, p_task_id uuid, p_expected_version integer, p_idempotency_key uuid)
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
CREATE OR REPLACE FUNCTION inventarios.submit_mobile_manual_match_count(p_zone_id uuid, p_location_id uuid, p_snapshot_product_id uuid, p_physical_quantity numeric, p_scanned_code text, p_idempotency_key uuid, p_captured_at timestamp with time zone, p_device_id text, p_evidence_storage_path text, p_evidence_mime_type text, p_evidence_file_size bigint, p_evidence_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
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
    v_snapshot_bsale_variant_id integer;
    v_clean_scanned_code text;
    v_clean_device_id text;
    v_clean_storage_path text;
    v_clean_mime_type text;
    v_clean_sha256 text;
    v_has_evidence boolean := false;
    v_extension text;
    v_expected_storage_path text;
    v_storage_meta jsonb;
    v_count_idempotency_key uuid;
    v_count_event_key uuid;
    v_proposal_event_key uuid;
    v_proposal_reuse_event_key uuid;
    v_proposal_count bigint;
    v_conflict_count bigint;
    v_reuse_proposal_id uuid;
    v_reuse_original_count_entry_id uuid;
    v_proposal_reused boolean := false;
    v_quantities_payload jsonb;
    v_count_result jsonb;
    v_count_entry_id uuid;
    v_count_occurred_at timestamptz;
    v_count_event_id uuid;
    v_proposal_id uuid;
    v_proposal_event_id uuid;
    v_proposal_reuse_event_id uuid;
    v_evidence_id uuid;
    v_occurred_at timestamptz;
    v_captured_at timestamptz;
    v_request_payload jsonb;
    v_request_hash text;
    v_operation jsonb;
    v_operation_id uuid;
    v_replay_payload jsonb;
    v_response jsonb;
    v_proposal_reused_flag boolean := false;
BEGIN
    IF p_snapshot_product_id IS NULL OR p_physical_quantity IS NULL OR p_physical_quantity < 0 OR p_idempotency_key IS NULL OR p_captured_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    v_clean_scanned_code := pg_catalog.btrim(p_scanned_code);
    v_clean_device_id := pg_catalog.btrim(p_device_id);
    IF v_clean_scanned_code IS NULL OR v_clean_scanned_code = '' OR v_clean_device_id IS NULL OR v_clean_device_id = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;

    v_clean_storage_path := pg_catalog.btrim(p_evidence_storage_path);
    v_clean_mime_type := pg_catalog.btrim(p_evidence_mime_type);
    v_clean_sha256 := pg_catalog.btrim(p_evidence_sha256);
    v_has_evidence := v_clean_storage_path IS NOT NULL OR v_clean_mime_type IS NOT NULL OR p_evidence_file_size IS NOT NULL OR v_clean_sha256 IS NOT NULL;
    IF v_has_evidence AND (v_clean_storage_path IS NULL OR v_clean_mime_type IS NULL OR p_evidence_file_size IS NULL OR v_clean_sha256 IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
    END IF;
    IF v_has_evidence THEN
        IF p_evidence_file_size < 4096 OR p_evidence_file_size > 10485760 OR v_clean_sha256 !~ '^[0-9A-Fa-f]{64}$' THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La fotografía de evidencia no es válida o está incompleta.', 'retryable', false)::text;
        END IF;
        CASE v_clean_mime_type
            WHEN 'image/jpeg' THEN v_extension := '.jpg';
            WHEN 'image/png' THEN v_extension := '.png';
            WHEN 'image/webp' THEN v_extension := '.webp';
            ELSE
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END CASE;
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
      AND p.user_id = v_actor_id
      AND p.active_from <= pg_catalog.now() AND p.revoked_at IS NULL
      AND s.status = 'COUNTING' AND z.is_enabled = true AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    SELECT true, szl.snapshot_location_id INTO v_is_open, v_snapshot_location_id
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id AND tl.task_id = v_task_id AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id AND tl.status = 'OPEN';
    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    SELECT sp.bsale_variant_id INTO v_snapshot_bsale_variant_id
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id AND sp.id = p_snapshot_product_id;
    IF v_snapshot_bsale_variant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_PRODUCT', DETAIL = pg_catalog.jsonb_build_object('message', 'El producto no pertenece al inventario activo.', 'retryable', false)::text;
    END IF;

    -- Revalidacion: el scanned_code NO debe estar asociado oficialmente en la maestra
    IF EXISTS (
        SELECT 1 FROM integraciones.bsale_variants bv
        WHERE bv.company_id = v_company_id AND bv.state = 0 AND bv.bar_code = v_clean_scanned_code
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_BARCODE_ALREADY_ASSOCIATED', DETAIL = pg_catalog.jsonb_build_object('message', 'El código de barras ya está asociado a un producto de la maestra.', 'retryable', false)::text;
    END IF;

    -- Revalidacion: el barcode no debe corresponder a OTRO producto del snapshot (por variante maestra)
    IF EXISTS (
        SELECT 1 FROM inventarios.snapshot_products sp
        WHERE sp.company_id = v_company_id AND sp.snapshot_id = v_snapshot_id
          AND sp.barcode = v_clean_scanned_code
          AND sp.bsale_variant_id IS DISTINCT FROM v_snapshot_bsale_variant_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_BARCODE_ALREADY_ASSOCIATED', DETAIL = pg_catalog.jsonb_build_object('message', 'El código de barras ya está asociado a un producto de la maestra.', 'retryable', false)::text;
    END IF;

    v_count_idempotency_key := (pg_catalog.md5(p_idempotency_key::text || ':COUNT'))::uuid;
    v_count_event_key := (pg_catalog.md5(v_count_idempotency_key::text || ':COUNT_RECORDED'))::uuid;
    v_proposal_event_key := (pg_catalog.md5(p_idempotency_key::text || ':BARCODE_PROPOSED'))::uuid;
    v_proposal_reuse_event_key := (pg_catalog.md5(p_idempotency_key::text || ':BARCODE_PROPOSAL_REUSED'))::uuid;

    v_request_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.manual_match.submit',
        'zone_id', p_zone_id,
        'location_id', p_location_id,
        'snapshot_product_id', p_snapshot_product_id,
        'physical_quantity', p_physical_quantity,
        'scanned_code', v_clean_scanned_code,
        'captured_at', p_captured_at,
        'device_id', v_clean_device_id,
        'has_evidence', v_has_evidence
    );
    v_request_hash := inventarios.compute_request_hash(v_request_payload);
    v_operation := inventarios.begin_idempotent_operation(v_company_id, 'inventarios.mobile.manual_match.submit', p_idempotency_key, v_request_hash);

    IF v_operation ->> 'mode' = 'REPLAY' THEN
        v_replay_payload := v_operation -> 'response_payload';
        v_count_entry_id := (v_replay_payload ->> 'entity_id')::uuid;
        v_count_event_id := (v_replay_payload -> 'data' ->> 'count_event_id')::uuid;
        v_proposal_id := (v_replay_payload -> 'data' ->> 'proposal_id')::uuid;
        v_proposal_event_id := (v_replay_payload -> 'data' ->> 'barcode_proposed_event_id')::uuid;
        v_proposal_reuse_event_id := (v_replay_payload -> 'data' ->> 'barcode_proposal_reused_event_id')::uuid;
        v_evidence_id := (v_replay_payload -> 'data' ->> 'evidence_file_id')::uuid;
        v_proposal_reused_flag := COALESCE((v_replay_payload -> 'data' ->> 'proposal_reused')::boolean, false);
        IF NOT EXISTS (
            SELECT 1 FROM inventarios.count_entries ce
            WHERE ce.company_id = v_company_id AND ce.session_id = v_session_id AND ce.task_id = v_task_id
              AND ce.snapshot_product_id = p_snapshot_product_id AND ce.snapshot_location_id = v_snapshot_location_id
              AND ce.id = v_count_entry_id AND ce.offline_id = v_count_idempotency_key
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM inventarios.product_barcode_proposals pbp
            WHERE pbp.company_id = v_company_id
              AND pbp.id = v_proposal_id
              AND pbp.status = 'PENDING_REVIEW'
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM inventarios.task_events te
            WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.session_zone_id = v_session_zone_id
              AND te.task_id = v_task_id AND te.id = v_count_event_id
              AND te.event_type = 'COUNT_RECORDED' AND te.idempotency_key = v_count_event_key
              AND te.technical_metadata ->> 'count_entry_id' = v_count_entry_id::text
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF NOT v_proposal_reused_flag AND NOT EXISTS (
            SELECT 1 FROM inventarios.task_events te
            WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.session_zone_id = v_session_zone_id
              AND te.task_id = v_task_id AND te.id = v_proposal_event_id
              AND te.event_type = 'BARCODE_PROPOSED' AND te.idempotency_key = v_proposal_event_key
              AND te.technical_metadata ->> 'proposal_id' = v_proposal_id::text
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF v_proposal_reused_flag AND NOT EXISTS (
            SELECT 1 FROM inventarios.task_events te
            WHERE te.company_id = v_company_id AND te.session_id = v_session_id AND te.session_zone_id = v_session_zone_id
              AND te.task_id = v_task_id AND te.id = v_proposal_reuse_event_id
              AND te.event_type = 'BARCODE_PROPOSAL_REUSED' AND te.idempotency_key = v_proposal_reuse_event_key
              AND te.technical_metadata ->> 'proposal_id' = v_proposal_id::text
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        RETURN v_replay_payload;
    END IF;

    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    v_occurred_at := pg_catalog.now();
    IF p_captured_at > v_occurred_at THEN v_captured_at := v_occurred_at; ELSE v_captured_at := p_captured_at; END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.manual_match_barcode'),
        pg_catalog.hashtext(v_company_id::text || ':' || v_clean_scanned_code)
    );

    -- Propuestas PENDING_REVIEW del barcode (solo count_entry origen vigente)
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE ce.bsale_variant_id IS DISTINCT FROM v_snapshot_bsale_variant_id),
        (pg_catalog.array_agg(pbp.id ORDER BY pbp.proposed_at ASC, pbp.id ASC)
            FILTER (WHERE ce.bsale_variant_id IS NOT DISTINCT FROM v_snapshot_bsale_variant_id))[1]
    INTO v_proposal_count, v_conflict_count, v_reuse_proposal_id
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
    WHERE pbp.company_id = v_company_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_clean_scanned_code
      AND ce.invalidated_at IS NULL
      AND ce.invalidated_by IS NULL
      AND ce.invalidation_reason IS NULL;

    IF v_conflict_count > 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_BARCODE_ALREADY_PROPOSED', DETAIL = pg_catalog.jsonb_build_object('message', 'El código de barras ya fue propuesto para otro producto y está pendiente de revisión.', 'retryable', false)::text;
    END IF;

    IF v_proposal_count > 0 THEN
        v_proposal_reused := true;
        v_proposal_id := v_reuse_proposal_id;
        SELECT ce.id INTO v_reuse_original_count_entry_id
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
        WHERE pbp.id = v_proposal_id
          AND ce.invalidated_at IS NULL
          AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL;
        IF v_reuse_original_count_entry_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CONCURRENT_MODIFICATION', DETAIL = pg_catalog.jsonb_build_object('message', 'Se detecto una modificacion concurrente.', 'retryable', true)::text;
        END IF;
    END IF;

    IF v_has_evidence THEN
        v_expected_storage_path := v_company_id::text || '/' || v_session_id::text || '/' || v_actor_id::text || '/' || p_idempotency_key::text || v_extension;
        IF v_clean_storage_path <> v_expected_storage_path THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
        SELECT so.metadata INTO v_storage_meta FROM storage.objects so
        WHERE so.bucket_id = 'inventory-evidence' AND so.name = v_expected_storage_path AND so.owner = v_actor_id;
        IF v_storage_meta IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
        END IF;
        IF COALESCE((v_storage_meta ->> 'size')::bigint, 0) <> p_evidence_file_size
           OR COALESCE(v_storage_meta ->> 'mimetype', '') <> v_clean_mime_type THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
        IF EXISTS (
            SELECT 1 FROM inventarios.evidence_files ef
            WHERE ef.storage_bucket = 'inventory-evidence' AND ef.storage_path = v_expected_storage_path
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD', DETAIL = pg_catalog.jsonb_build_object('message', 'La solicitud no tiene el formato requerido.', 'retryable', false)::text;
        END IF;
    END IF;

    v_quantities_payload := pg_catalog.jsonb_build_object(
        'available_quantity', p_physical_quantity,
        'blocked_quantity', 0,
        'damaged_quantity', 0,
        'expired_quantity', 0,
        'other_unavailable_quantity', 0
    );

    v_count_result := inventarios.record_inventory_count(
        v_company_id,
        v_task_id,
        v_task_cycle,
        p_snapshot_product_id,
        v_snapshot_location_id,
        v_quantities_payload,
        'SEARCH_MANUAL',
        v_clean_scanned_code,
        'MOBILE',
        v_count_idempotency_key,
        v_clean_device_id,
        v_captured_at,
        v_count_idempotency_key
    );
    v_count_entry_id := (v_count_result ->> 'entity_id')::uuid;
    v_count_occurred_at := COALESCE((v_count_result ->> 'occurred_at')::timestamptz, v_occurred_at);

    IF NOT v_proposal_reused THEN
        INSERT INTO inventarios.product_barcode_proposals (
            company_id, session_id, count_entry_id, scanned_code, status,
            proposed_by, proposed_at, created_by, updated_by
        ) VALUES (
            v_company_id, v_session_id, v_count_entry_id, v_clean_scanned_code, 'PENDING_REVIEW',
            v_actor_id, v_count_occurred_at, v_actor_id, v_actor_id
        ) RETURNING id INTO v_proposal_id;
    END IF;

    INSERT INTO inventarios.task_events (
        company_id, session_id, session_zone_id, task_id, event_type,
        previous_status, next_status, actor_id, cycle, occurred_at,
        idempotency_key, source, technical_metadata, created_at, created_by
    ) VALUES (
        v_company_id, v_session_id, v_session_zone_id, v_task_id, 'COUNT_RECORDED',
        'IN_PROGRESS', 'IN_PROGRESS', v_actor_id, v_task_cycle, v_count_occurred_at,
        v_count_event_key, 'ANDROID',
        pg_catalog.jsonb_build_object('count_entry_id', v_count_entry_id, 'snapshot_product_id', p_snapshot_product_id),
        v_count_occurred_at, v_actor_id
    ) ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

    IF v_proposal_reused THEN
        INSERT INTO inventarios.task_events (
            company_id, session_id, session_zone_id, task_id, event_type,
            previous_status, next_status, actor_id, cycle, occurred_at,
            idempotency_key, source, technical_metadata, created_at, created_by
        ) VALUES (
            v_company_id, v_session_id, v_session_zone_id, v_task_id, 'BARCODE_PROPOSAL_REUSED',
            'IN_PROGRESS', 'IN_PROGRESS', v_actor_id, v_task_cycle, v_count_occurred_at,
            v_proposal_reuse_event_key, 'ANDROID',
            pg_catalog.jsonb_build_object(
                'proposal_id', v_proposal_id,
                'original_count_entry_id', v_reuse_original_count_entry_id,
                'count_entry_id', v_count_entry_id,
                'scanned_code', v_clean_scanned_code,
                'snapshot_product_id', p_snapshot_product_id
            ),
            v_count_occurred_at, v_actor_id
        ) ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING id INTO v_proposal_reuse_event_id;
    ELSE
        INSERT INTO inventarios.task_events (
            company_id, session_id, session_zone_id, task_id, event_type,
            previous_status, next_status, actor_id, cycle, occurred_at,
            idempotency_key, source, technical_metadata, created_at, created_by
        ) VALUES (
            v_company_id, v_session_id, v_session_zone_id, v_task_id, 'BARCODE_PROPOSED',
            'IN_PROGRESS', 'IN_PROGRESS', v_actor_id, v_task_cycle, v_count_occurred_at,
            v_proposal_event_key, 'ANDROID',
            pg_catalog.jsonb_build_object('proposal_id', v_proposal_id, 'count_entry_id', v_count_entry_id, 'scanned_code', v_clean_scanned_code, 'snapshot_product_id', p_snapshot_product_id),
            v_count_occurred_at, v_actor_id
        ) ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING id INTO v_proposal_event_id;
    END IF;

    SELECT te.id INTO v_count_event_id
    FROM inventarios.task_events te
    WHERE te.company_id = v_company_id AND te.task_id = v_task_id AND te.idempotency_key = v_count_event_key;

    IF v_count_event_id IS NULL
       OR (v_proposal_reused AND v_proposal_reuse_event_id IS NULL)
       OR (NOT v_proposal_reused AND v_proposal_event_id IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND', DETAIL = pg_catalog.jsonb_build_object('message', 'El recurso solicitado no existe.', 'retryable', false)::text;
    END IF;

    IF v_has_evidence THEN
        INSERT INTO inventarios.evidence_files (
            company_id, session_id, count_entry_id, storage_bucket, storage_path,
            original_name, mime_type, file_size_bytes, sha256,
            captured_by, captured_at, uploaded_by, uploaded_at,
            device_id, offline_idempotency_key, source, sync_status,
            created_by, updated_by
        ) VALUES (
            v_company_id, v_session_id, v_count_entry_id, 'inventory-evidence', v_expected_storage_path,
            p_idempotency_key::text || v_extension, v_clean_mime_type, p_evidence_file_size, v_clean_sha256,
            v_actor_id, v_captured_at, v_actor_id, v_occurred_at,
            v_clean_device_id, p_idempotency_key, 'ANDROID', 'PENDING',
            v_actor_id, v_actor_id
        ) RETURNING id INTO v_evidence_id;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.mobile.manual_match.submit',
        'entity_id', v_count_entry_id,
        'state', 'IN_PROGRESS',
        'version', NULL::integer,
        'cycle_number', v_task_cycle,
        'assignment_id', v_assignment_id,
        'event_id', COALESCE(v_proposal_event_id, v_proposal_reuse_event_id),
        'replayed', false,
        'occurred_at', v_count_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'snapshot_product_id', p_snapshot_product_id,
            'count_entry_id', v_count_entry_id,
            'count_event_id', v_count_event_id,
            'proposal_id', v_proposal_id,
            'barcode_proposed_event_id', v_proposal_event_id,
            'barcode_proposal_reused_event_id', v_proposal_reuse_event_id,
            'proposal_reused', v_proposal_reused,
            'evidence_file_id', v_evidence_id,
            'scanned_code', v_clean_scanned_code,
            'status', 'PENDING_REVIEW'
        )
    );

    RETURN inventarios.complete_idempotent_operation(v_company_id, v_operation_id, v_count_entry_id, v_response);
END;
$function$;
CREATE OR REPLACE FUNCTION inventarios.submit_my_mobile_count(p_zone_id uuid, p_location_id uuid, p_snapshot_product_id uuid, p_physical_quantity numeric, p_identification_method text, p_scanned_code text, p_idempotency_key uuid, p_captured_at timestamp with time zone, p_device_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
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
      AND p.user_id = v_actor_id
      AND p.active_from <= pg_catalog.now() AND p.revoked_at IS NULL
      AND s.status = 'COUNTING' AND z.is_enabled = true AND t.status = 'IN_PROGRESS'
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED', DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

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
    ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
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
COMMIT;
