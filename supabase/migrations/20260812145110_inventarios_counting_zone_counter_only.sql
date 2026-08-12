-- Migration to enforce COUNTER role for counting zones

CREATE OR REPLACE FUNCTION inventarios.assign_inventory_counting_zone(
    p_company_id uuid,
    p_campaign_id uuid,
    p_session_id uuid,
    p_campaign_participant_id uuid,
    p_zone_name text,
    p_location_ids uuid[],
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_zone_name text; v_location_ids uuid[]; v_idx integer;
    v_campaign_status text; v_session_status text; v_session_warehouse_id uuid;
    v_session_campaign_id uuid; v_snapshot_id uuid; v_campaign_user_id uuid;
    v_campaign_participant_role text;
    v_participant_id uuid; v_zone_total bigint; v_zone_enabled bigint;
    v_zone_id uuid; v_zone_code text;
    v_scope_id uuid; v_loc_active boolean; v_loc_warehouse_id uuid;
    v_loc_code text; v_loc_name text; v_loc_aisle text; v_loc_rack text;
    v_loc_level text; v_loc_position text; v_snapshot_location_id uuid;
    v_task_id uuid; v_assignment_id uuid;
    v_total bigint; v_assigned bigint; v_pending bigint; v_percent numeric;
    v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
BEGIN
    v_zone_name := pg_catalog.btrim(p_zone_name);
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_session_id IS NULL
       OR p_campaign_participant_id IS NULL OR p_idempotency_key IS NULL
       OR v_zone_name = '' OR pg_catalog.char_length(v_zone_name) > 200
       OR p_location_ids IS NULL OR pg_catalog.cardinality(p_location_ids) < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST', DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    SELECT pg_catalog.array_agg(DISTINCT l ORDER BY l) INTO v_location_ids FROM pg_catalog.unnest(p_location_ids) AS l;
    IF v_location_ids IS NULL OR pg_catalog.cardinality(v_location_ids) <> pg_catalog.cardinality(p_location_ids) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_DUPLICATE', DETAIL=pg_catalog.jsonb_build_object('message','Las ubicaciones no pueden repetirse ni estar vacias.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    PERFORM inventarios.require_active_session_participant(p_company_id, p_session_id, v_actor_id, ARRAY['ADMINISTRATOR','SUPERVISOR','MANAGER']);

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.assign_inventory_counting_zone'), pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.counting_zone.assign','company_id',p_company_id,
        'campaign_id',p_campaign_id,'session_id',p_session_id,
        'campaign_participant_id',p_campaign_participant_id,
        'zone_name',v_zone_name,'location_ids',pg_catalog.to_jsonb(v_location_ids));
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.counting_zone.assign',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','La campana solicitada no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_DRAFT', DETAIL=pg_catalog.jsonb_build_object('message','La campana no esta en DRAFT.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF inventarios.campaign_is_prepared(p_company_id, p_campaign_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ALREADY_PREPARED', DETAIL=pg_catalog.jsonb_build_object('message','La campana ya fue preparada y no admite configuracion.','retryable',false)::text;
    END IF;

    SELECT s.status, s.warehouse_id, s.campaign_id
    INTO v_session_status, v_session_warehouse_id, v_session_campaign_id
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','La jornada solicitada no existe.','retryable',false)::text;
    END IF;
    IF v_session_campaign_id IS DISTINCT FROM p_campaign_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_CAMPAIGN_MISMATCH', DETAIL=pg_catalog.jsonb_build_object('message','La jornada no pertenece a la campana.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_DRAFT', DETAIL=pg_catalog.jsonb_build_object('message','La jornada no esta en DRAFT.','retryable',false,'status',v_session_status)::text;
    END IF;
    IF v_session_warehouse_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_EXTERNAL_UNSUPPORTED', DETAIL=pg_catalog.jsonb_build_object('message','La jornada no es una bodega interna y no admite asignacion de zonas.','retryable',false)::text;
    END IF;
    SELECT os.id INTO v_snapshot_id
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_REQUIRED', DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene un snapshot vigente.','retryable',false)::text;
    END IF;

    SELECT icp.user_id, icp.participant_role
    INTO v_campaign_user_id, v_campaign_participant_role
    FROM inventarios.inventory_campaign_participants icp
    JOIN portal.users u ON u.id = icp.user_id
    JOIN core.user_company_access uca ON uca.user_id = icp.user_id AND uca.company_id = icp.company_id AND uca.is_active = true
    WHERE icp.company_id = p_company_id AND icp.campaign_id = p_campaign_id
      AND icp.id = p_campaign_participant_id
      AND icp.participant_role = 'COUNTER'
      AND icp.revoked_at IS NULL
      AND u.is_active = true AND u.deleted_at IS NULL;
    IF v_campaign_user_id IS NULL OR v_campaign_participant_role IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','No existe un participante activo para la zona.','retryable',false)::text;
    END IF;

    FOR v_idx IN 1 .. pg_catalog.cardinality(v_location_ids) LOOP
        SELECT slc.id, l.is_active, l.warehouse_id
        INTO v_scope_id, v_loc_active, v_loc_warehouse_id
        FROM inventarios.session_location_scopes slc
        JOIN logistica.locations l ON l.id = slc.location_id
        WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
          AND slc.inclusion_type = 'INCLUDED' AND slc.location_id = v_location_ids[v_idx];
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_NOT_IN_SCOPE', DETAIL=pg_catalog.jsonb_build_object('message','Una ubicacion no pertenece al alcance de la jornada.','retryable',false,'location_id',v_location_ids[v_idx])::text;
        END IF;
        IF v_loc_active IS NOT TRUE OR v_loc_warehouse_id IS DISTINCT FROM v_session_warehouse_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_INACTIVE', DETAIL=pg_catalog.jsonb_build_object('message','Una ubicacion esta inactiva o fuera del alcance de la jornada.','retryable',false,'location_id',v_location_ids[v_idx])::text;
        END IF;
        IF EXISTS (SELECT 1 FROM inventarios.session_zone_locations szl WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id AND szl.location_id = v_location_ids[v_idx]) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_ALREADY_ASSIGNED', DETAIL=pg_catalog.jsonb_build_object('message','Una ubicacion ya pertenece a una zona de la jornada.','retryable',false,'location_id',v_location_ids[v_idx])::text;
        END IF;
    END LOOP;

    v_occurred_at := pg_catalog.now();

    SELECT sp.id INTO v_participant_id
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
      AND sp.user_id = v_campaign_user_id AND sp.functional_role = v_campaign_participant_role
      AND sp.active_from <= v_occurred_at AND sp.revoked_at IS NULL;
    IF v_participant_id IS NULL THEN
        INSERT INTO inventarios.session_participants AS sp (company_id, session_id, user_id, functional_role, active_from, created_at, created_by)
        VALUES (p_company_id, p_session_id, v_campaign_user_id, v_campaign_participant_role, v_occurred_at, v_occurred_at, v_actor_id)
        RETURNING sp.id INTO v_participant_id;
    END IF;

    SELECT pg_catalog.count(*) INTO v_zone_total FROM inventarios.session_zones sz WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id;
    SELECT pg_catalog.count(*) INTO v_zone_enabled FROM inventarios.session_zones sz WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.is_enabled = true;
    v_zone_code := 'Z' || (v_zone_total + 1)::text;
    INSERT INTO inventarios.session_zones AS sz (company_id, session_id, snapshot_id, zone_code, scan_code, display_name, priority, is_enabled, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_snapshot_id, v_zone_code, v_zone_code, v_zone_name, v_zone_total::integer, true, v_occurred_at, v_actor_id)
    RETURNING sz.id INTO v_zone_id;

    FOR v_idx IN 1 .. pg_catalog.cardinality(v_location_ids) LOOP
        SELECT slc.id, l.code, l.name, l.aisle, l.rack, l.level, l.position
        INTO v_scope_id, v_loc_code, v_loc_name, v_loc_aisle, v_loc_rack, v_loc_level, v_loc_position
        FROM inventarios.session_location_scopes slc
        JOIN logistica.locations l ON l.id = slc.location_id
        WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
          AND slc.inclusion_type = 'INCLUDED' AND slc.location_id = v_location_ids[v_idx];
        SELECT sll.id INTO v_snapshot_location_id
        FROM inventarios.snapshot_locations sll
        WHERE sll.company_id = p_company_id AND sll.snapshot_id = v_snapshot_id AND sll.location_id = v_location_ids[v_idx];
        IF v_snapshot_location_id IS NULL THEN
            INSERT INTO inventarios.snapshot_locations AS sll (company_id, snapshot_id, location_id, warehouse_id, code, name, aisle, rack, level, position, is_active, created_at, created_by)
            VALUES (p_company_id, v_snapshot_id, v_location_ids[v_idx], v_session_warehouse_id, v_loc_code, v_loc_name, v_loc_aisle, v_loc_rack, v_loc_level, v_loc_position, true, v_occurred_at, v_actor_id)
            RETURNING sll.id INTO v_snapshot_location_id;
        END IF;
        INSERT INTO inventarios.session_zone_locations AS szl (company_id, session_id, snapshot_id, session_zone_id, session_location_scope_id, snapshot_location_id, location_id, created_at, created_by)
        VALUES (p_company_id, p_session_id, v_snapshot_id, v_zone_id, v_scope_id, v_snapshot_location_id, v_location_ids[v_idx], v_occurred_at, v_actor_id);
    END LOOP;

    INSERT INTO inventarios.tasks AS t (company_id, session_id, session_zone_id, task_kind, status, version, validation_cycle, creation_idempotency_key, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_zone_id, 'PRIMARY', 'ASSIGNED', 1, 1, p_idempotency_key, v_occurred_at, v_actor_id)
    RETURNING t.id INTO v_task_id;
    INSERT INTO inventarios.task_assignments AS ta (company_id, session_id, task_id, session_participant_id, user_id, assigned_at, assigned_by, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_task_id, v_participant_id, v_campaign_user_id, v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING ta.id INTO v_assignment_id;
    UPDATE inventarios.tasks AS t SET current_assignment_id = v_assignment_id, updated_at = v_occurred_at, updated_by = v_actor_id WHERE t.company_id = p_company_id AND t.id = v_task_id;

    SELECT pg_catalog.count(*) INTO v_total
    FROM inventarios.session_location_scopes slc
    JOIN logistica.locations l ON l.id = slc.location_id
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.inclusion_type = 'INCLUDED' AND slc.location_id IS NOT NULL
      AND l.is_active = true AND l.warehouse_id = v_session_warehouse_id;
    SELECT pg_catalog.count(DISTINCT szl.location_id) INTO v_assigned
    FROM inventarios.session_zone_locations szl
    JOIN inventarios.session_zones sz ON sz.company_id = szl.company_id AND sz.session_id = szl.session_id AND sz.id = szl.session_zone_id AND sz.is_enabled = true
    WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id AND szl.location_id IS NOT NULL;
    v_pending := GREATEST(v_total - v_assigned, 0);
    IF v_total > 0 THEN v_percent := pg_catalog.round(v_assigned::numeric * 100.0 / v_total::numeric, 1); ELSE v_percent := 0; END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.counting_zone.assign','entity_id',v_zone_id,
        'state','ASSIGNED','version',1::integer,'cycle_number',1::integer,
        'assignment_id',v_assignment_id,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object(
            'campaign_id',p_campaign_id,'session_id',p_session_id,
            'zone_id',v_zone_id,'zone_code',v_zone_code,'zone_name',v_zone_name,
            'session_participant_id',v_participant_id,
            'campaign_participant_id',p_campaign_participant_id,
            'user_id',v_campaign_user_id,
            'task_id',v_task_id,'task_assignment_id',v_assignment_id,
            'location_ids',pg_catalog.to_jsonb(v_location_ids),
            'location_count',pg_catalog.cardinality(v_location_ids),
            'coverage',pg_catalog.jsonb_build_object(
                'total',v_total,'assigned',v_assigned,'pending',v_pending,
                'percent',v_percent,'zone_count',v_zone_enabled + 1)));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_zone_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.assign_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid[], uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.assign_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.assign_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid[], uuid) TO authenticated;

CREATE OR REPLACE FUNCTION inventarios.prepare_inventory_session(
    p_company_id uuid,
    p_session_id uuid,
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
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_session_status text; v_scope_mode text; v_bsale_office_id integer;
    v_snapshot_id uuid; v_snapshot_status text;
    v_counter_count bigint; v_supervisor_count bigint; v_manager_count bigint;
    v_administrator_count bigint;
    v_zone_count bigint; v_location_count bigint; v_task_count bigint;
    v_zone_without_location bigint; v_zone_without_task bigint;
    v_task_not_assigned bigint; v_task_without_assignment bigint;
    v_bad_assignment bigint; v_scope_location_count bigint;
    v_scope_location_unzoned bigint; v_duplicate_location bigint;
    v_product_count bigint; v_variant_count bigint;
    v_hash text; v_occurred_at timestamptz;
    v_response jsonb; v_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_occurred_at := pg_catalog.now();
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.configure');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.prepare_inventory_session'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.prepare','company_id',p_company_id,
        'session_id',p_session_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.prepare',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT s.status, s.scope_mode, s.bsale_office_id, os.id, os.completion_status
    INTO v_session_status, v_scope_mode, v_bsale_office_id, v_snapshot_id, v_snapshot_status
    FROM inventarios.sessions s
    JOIN inventarios.operational_snapshots os
      ON os.company_id = s.company_id AND os.session_id = s.id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE OF s, os;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status = 'PREPARED' OR v_session_status = 'COUNTING'
       OR v_session_status = 'UNDER_REVIEW' OR v_session_status = 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_ALREADY_PREPARED',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada ya fue preparada o esta en una etapa posterior.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    IF v_snapshot_status <> 'PENDING' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot no esta en estado pendiente.','retryable',false)::text;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM inventarios.session_participants sp
        WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
          AND sp.user_id = v_actor_id
          AND sp.functional_role IN ('ADMINISTRATOR', 'SUPERVISOR', 'MANAGER')
          AND sp.active_from <= pg_catalog.now() AND sp.revoked_at IS NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_INACTIVE',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes una participacion operacional activa en la jornada.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.count(*) FILTER (WHERE sp.functional_role = 'COUNTER'),
           pg_catalog.count(*) FILTER (WHERE sp.functional_role = 'SUPERVISOR'),
           pg_catalog.count(*) FILTER (WHERE sp.functional_role = 'MANAGER'),
           pg_catalog.count(*) FILTER (WHERE sp.functional_role = 'ADMINISTRATOR')
    INTO v_counter_count, v_supervisor_count, v_manager_count, v_administrator_count
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
      AND sp.active_from <= pg_catalog.now() AND sp.revoked_at IS NULL;

    IF v_counter_count < 1
       OR (v_administrator_count < 1 AND v_supervisor_count < 1 AND v_manager_count < 1) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada requiere al menos un COUNTER y un responsable operacional (ADMINISTRATOR, SUPERVISOR o MANAGER) activos.','retryable',false,
                'counter_count',v_counter_count,'administrator_count',v_administrator_count,
                'supervisor_count',v_supervisor_count,'manager_count',v_manager_count)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_zone_count
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.is_enabled = true;
    IF v_zone_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene zonas habilitadas.','retryable',false,'zone_count',0)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_zone_without_location
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.is_enabled = true
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.session_zone_locations szl
          WHERE szl.company_id = sz.company_id AND szl.session_id = sz.session_id
            AND szl.session_zone_id = sz.id
      );
    IF v_zone_without_location > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda zona debe tener al menos una ubicacion.','retryable',false,'zones_without_location',v_zone_without_location)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_zone_without_task
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.is_enabled = true
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.tasks t
          WHERE t.company_id = sz.company_id AND t.session_id = sz.session_id
            AND t.session_zone_id = sz.id
            AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
      );
    IF v_zone_without_task > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda zona debe tener al menos una tarea.','retryable',false,'zones_without_task',v_zone_without_task)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_task_count
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL;
    IF v_task_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene tareas activas.','retryable',false,'task_count',0)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_task_not_assigned
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.status <> 'ASSIGNED';
    IF v_task_not_assigned > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda tarea debe estar en estado ASSIGNED.','retryable',false,'tasks_not_assigned',v_task_not_assigned)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_task_without_assignment
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.task_assignments ta
          WHERE ta.company_id = t.company_id AND ta.task_id = t.id AND ta.released_at IS NULL
      );
    IF v_task_without_assignment > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda tarea debe tener una asignacion vigente.','retryable',false,'tasks_without_assignment',v_task_without_assignment)::text;
    END IF;

    SELECT pg_catalog.count(*)
    INTO v_bad_assignment
    FROM inventarios.task_assignments ta
    JOIN inventarios.tasks t
      ON t.company_id = ta.company_id AND t.session_id = ta.session_id AND t.id = ta.task_id
    JOIN inventarios.session_participants sp
      ON sp.company_id = ta.company_id AND sp.session_id = ta.session_id
     AND sp.id = ta.session_participant_id
    WHERE ta.company_id = p_company_id AND ta.session_id = p_session_id
      AND ta.released_at IS NULL
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
      AND (
        sp.functional_role <> 'COUNTER'
        OR sp.revoked_at IS NOT NULL
        OR sp.active_from > pg_catalog.now()
        OR NOT EXISTS (
            SELECT 1 FROM core.user_company_access uca
            WHERE uca.user_id = sp.user_id AND uca.company_id = sp.company_id
              AND uca.is_active = true
        )
      );

    IF v_bad_assignment > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda asignacion vigente debe corresponder a un participante operacional activo.','retryable',false,'bad_assignments',v_bad_assignment)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_scope_location_count
    FROM inventarios.session_location_scopes slc
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.inclusion_type = 'INCLUDED';
    IF v_scope_location_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene ubicaciones en su alcance.','retryable',false,'scope_location_count',0)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_scope_location_unzoned
    FROM inventarios.session_location_scopes slc
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.inclusion_type = 'INCLUDED'
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.session_zone_locations szl
          WHERE szl.company_id = slc.company_id AND szl.session_id = slc.session_id
            AND szl.location_id = slc.location_id
      );
    IF v_scope_location_unzoned > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda ubicacion del alcance debe pertenecer a exactamente una zona.','retryable',false,'scope_locations_unzoned',v_scope_location_unzoned)::text;
    END IF;

    SELECT pg_catalog.count(*) - pg_catalog.count(DISTINCT szl.location_id)
    INTO v_duplicate_location
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id;
    IF v_duplicate_location > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Existen ubicaciones duplicadas en la jornada.','retryable',false,'duplicate_locations',v_duplicate_location)::text;
    END IF;

    DELETE FROM inventarios.snapshot_stocks ss WHERE ss.company_id = p_company_id AND ss.snapshot_id = v_snapshot_id;
    DELETE FROM inventarios.snapshot_products sp WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id;

    IF v_scope_mode = 'PARTIAL' THEN
        SELECT pg_catalog.count(*) INTO v_variant_count
        FROM inventarios.session_product_scopes sps
        JOIN integraciones.bsale_variants bv ON bv.company_id = sps.company_id AND bv.bsale_id = sps.bsale_variant_id
        WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id
          AND sps.inclusion_type = 'INCLUDED'
          AND bv.state = 0
          AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> '';

        INSERT INTO inventarios.snapshot_products (company_id, snapshot_id, bsale_variant_id, sku, barcode, name, created_at, created_by)
        SELECT sps.company_id, v_snapshot_id, bv.bsale_id, bv.code, bv.bar_code, coalesce(pg_catalog.btrim(bv.description), bv.code), v_occurred_at, v_actor_id
        FROM inventarios.session_product_scopes sps
        JOIN integraciones.bsale_variants bv ON bv.company_id = sps.company_id AND bv.bsale_id = sps.bsale_variant_id
        WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id
          AND sps.inclusion_type = 'INCLUDED'
          AND bv.state = 0
          AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> ''
        ON CONFLICT (company_id, snapshot_id, bsale_variant_id) DO NOTHING;
    ELSE
        SELECT pg_catalog.count(*) INTO v_variant_count
        FROM integraciones.bsale_variants bv
        WHERE bv.company_id = p_company_id AND bv.state = 0
          AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> '';

        INSERT INTO inventarios.snapshot_products (company_id, snapshot_id, bsale_variant_id, sku, barcode, name, created_at, created_by)
        SELECT bv.company_id, v_snapshot_id, bv.bsale_id, bv.code, bv.bar_code, coalesce(pg_catalog.btrim(bv.description), bv.code), v_occurred_at, v_actor_id
        FROM integraciones.bsale_variants bv
        WHERE bv.company_id = p_company_id AND bv.state = 0
          AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> ''
        ON CONFLICT (company_id, snapshot_id, bsale_variant_id) DO NOTHING;
    END IF;

    SELECT pg_catalog.count(*) INTO v_product_count
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id;
    IF v_product_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot no pudo construirse con productos del catalogo Bsale.','retryable',false,'variant_count',v_variant_count)::text;
    END IF;

    INSERT INTO inventarios.snapshot_stocks (company_id, snapshot_id, snapshot_product_id, office_id, theoretical_quantity, source_sync_run_id, source_synced_at, created_at, created_by)
    SELECT sp.company_id, sp.snapshot_id, sp.id, v_bsale_office_id, bsc.quantity_available, bsc.bsale_sync_run_id, bsc.synced_at, v_occurred_at, v_actor_id
    FROM inventarios.snapshot_products sp
    JOIN integraciones.bsale_stock_current bsc ON bsc.company_id = sp.company_id AND bsc.variant_id = sp.bsale_variant_id AND bsc.office_id = v_bsale_office_id
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id AND bsc.quantity_available >= 0
    ON CONFLICT (company_id, snapshot_id, snapshot_product_id, office_id) DO NOTHING;

    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                pg_catalog.string_agg(t.line, E'\n' ORDER BY t.line),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    ) INTO v_hash
    FROM (
        SELECT 'P:' || sp.id::text AS line FROM inventarios.snapshot_products sp WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id
        UNION ALL
        SELECT 'S:' || ss.id::text FROM inventarios.snapshot_stocks ss WHERE ss.company_id = p_company_id AND ss.snapshot_id = v_snapshot_id
        UNION ALL
        SELECT 'Z:' || sz.id::text FROM inventarios.session_zones sz WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
        UNION ALL
        SELECT 'T:' || t.id::text FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.session_id = p_session_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ) AS t;

    UPDATE inventarios.operational_snapshots AS os
    SET completion_status = 'COMPLETED', content_hash = v_hash, captured_at = v_occurred_at, captured_by = v_actor_id
    WHERE os.company_id = p_company_id AND os.id = v_snapshot_id;

    UPDATE inventarios.sessions AS s
    SET status = 'PREPARED', prepared_at = v_occurred_at, updated_at = v_occurred_at, updated_by = v_actor_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id AND s.status = 'DRAFT';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.prepare','entity_id',p_session_id,
        'state','PREPARED','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('snapshot_id',v_snapshot_id,
            'completion_status','COMPLETED','content_hash',v_hash,
            'prepared_at',v_occurred_at,'prepared_by',v_actor_id,
            'product_count',v_product_count,'variant_count',v_variant_count,
            'zone_count',v_zone_count,'task_count',v_task_count,
            'counter_count',v_counter_count,'administrator_count',v_administrator_count,
            'supervisor_count',v_supervisor_count,'manager_count',v_manager_count));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_response);
END;
$$;

ALTER FUNCTION inventarios.prepare_inventory_session(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.prepare_inventory_session(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.prepare_inventory_session(uuid, uuid, uuid) TO authenticated;
