-- Migration: 20260806112000_inventarios_counting_zone_assignment.sql
-- Fase 4I.3C.7C.4B: asignacion operacional de zonas de conteo (jornadas DRAFT).

-- ============================================================
-- 1. RPC: assign_inventory_counting_zone (compuesto atomico).
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.assign_inventory_counting_zone(
    p_company_id uuid, p_campaign_id uuid, p_session_id uuid,
    p_campaign_participant_id uuid, p_zone_name text,
    p_location_ids uuid[], p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_zone_name text; v_location_ids uuid[]; v_idx integer;
    v_campaign_status text; v_session_status text; v_session_warehouse_id uuid;
    v_session_campaign_id uuid; v_snapshot_id uuid; v_campaign_user_id uuid;
    v_participant_id uuid; v_zone_total bigint; v_zone_enabled bigint; v_zone_id uuid; v_zone_code text;
    v_scope_id uuid; v_loc_active boolean; v_loc_warehouse_id uuid;
    v_loc_code text; v_loc_name text; v_loc_aisle text; v_loc_rack text;
    v_loc_level text; v_loc_position text; v_snapshot_location_id uuid;
    v_task_id uuid; v_assignment_id uuid;
    v_total bigint; v_assigned bigint; v_pending bigint; v_percent numeric;
    v_counter_assigned bigint; v_counter_total bigint; v_counter_without bigint;
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
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.zones.manage');
    PERFORM inventarios.require_permission(p_company_id, 'inventarios.participants.manage');
    PERFORM inventarios.require_permission(p_company_id, 'inventarios.tasks.assign');
    PERFORM inventarios.require_session_participant(p_company_id, p_session_id, 'ADMINISTRATOR');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.assign_inventory_counting_zone'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.counting_zone.assign','company_id',p_company_id,
        'campaign_id',p_campaign_id,'session_id',p_session_id,
        'campaign_participant_id',p_campaign_participant_id,
        'zone_name',v_zone_name,'location_ids',pg_catalog.to_jsonb(v_location_ids));
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.counting_zone.assign',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
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

    SELECT icp.user_id INTO v_campaign_user_id
    FROM inventarios.inventory_campaign_participants icp
    JOIN portal.users u ON u.id = icp.user_id
    JOIN core.user_company_access uca
      ON uca.user_id = icp.user_id AND uca.company_id = icp.company_id AND uca.is_active = true
    WHERE icp.company_id = p_company_id AND icp.campaign_id = p_campaign_id
      AND icp.id = p_campaign_participant_id
      AND icp.participant_role = 'COUNTER' AND icp.revoked_at IS NULL
      AND u.is_active = true AND u.deleted_at IS NULL;
    IF v_campaign_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COUNTER_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','No existe un participante COUNTER activo para la zona.','retryable',false)::text;
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
        IF EXISTS (SELECT 1 FROM inventarios.session_zone_locations szl
                   WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id
                     AND szl.location_id = v_location_ids[v_idx]) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_ALREADY_ASSIGNED', DETAIL=pg_catalog.jsonb_build_object('message','Una ubicacion ya pertenece a una zona de la jornada.','retryable',false,'location_id',v_location_ids[v_idx])::text;
        END IF;
    END LOOP;

    v_occurred_at := pg_catalog.now();

    SELECT sp.id INTO v_participant_id
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
      AND sp.user_id = v_campaign_user_id AND sp.functional_role = 'COUNTER'
      AND sp.active_from <= v_occurred_at AND sp.revoked_at IS NULL;
    IF v_participant_id IS NULL THEN
        INSERT INTO inventarios.session_participants AS sp (company_id, session_id, user_id,
            functional_role, active_from, created_at, created_by)
        VALUES (p_company_id, p_session_id, v_campaign_user_id, 'COUNTER',
            v_occurred_at, v_occurred_at, v_actor_id)
        RETURNING sp.id INTO v_participant_id;
    END IF;

    SELECT pg_catalog.count(*) INTO v_zone_total
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id;
    SELECT pg_catalog.count(*) INTO v_zone_enabled
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.is_enabled = true;
    v_zone_code := 'Z' || (v_zone_total + 1)::text;
    INSERT INTO inventarios.session_zones AS sz (company_id, session_id, snapshot_id,
        zone_code, scan_code, display_name, priority, is_enabled, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_snapshot_id,
        v_zone_code, v_zone_code, v_zone_name, v_zone_total::integer, true,
        v_occurred_at, v_actor_id)
    RETURNING sz.id INTO v_zone_id;

    FOR v_idx IN 1 .. pg_catalog.cardinality(v_location_ids) LOOP
        SELECT slc.id, l.code, l.name, l.aisle, l.rack, l.level, l.position
        INTO v_scope_id, v_loc_code, v_loc_name, v_loc_aisle, v_loc_rack,
             v_loc_level, v_loc_position
        FROM inventarios.session_location_scopes slc
        JOIN logistica.locations l ON l.id = slc.location_id
        WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
          AND slc.inclusion_type = 'INCLUDED' AND slc.location_id = v_location_ids[v_idx];
        SELECT sll.id INTO v_snapshot_location_id
        FROM inventarios.snapshot_locations sll
        WHERE sll.company_id = p_company_id AND sll.snapshot_id = v_snapshot_id
          AND sll.location_id = v_location_ids[v_idx];
        IF v_snapshot_location_id IS NULL THEN
            INSERT INTO inventarios.snapshot_locations AS sll (company_id, snapshot_id,
                location_id, warehouse_id, code, name, aisle, rack, level, position,
                is_active, created_at, created_by)
            VALUES (p_company_id, v_snapshot_id, v_location_ids[v_idx], v_session_warehouse_id,
                v_loc_code, v_loc_name, v_loc_aisle, v_loc_rack, v_loc_level, v_loc_position,
                true, v_occurred_at, v_actor_id)
            RETURNING sll.id INTO v_snapshot_location_id;
        END IF;
        INSERT INTO inventarios.session_zone_locations AS szl (company_id, session_id,
            snapshot_id, session_zone_id, session_location_scope_id, snapshot_location_id,
            location_id, created_at, created_by)
        VALUES (p_company_id, p_session_id, v_snapshot_id, v_zone_id, v_scope_id,
            v_snapshot_location_id, v_location_ids[v_idx], v_occurred_at, v_actor_id);
    END LOOP;

    INSERT INTO inventarios.tasks AS t (company_id, session_id, session_zone_id, task_kind,
        status, version, validation_cycle, creation_idempotency_key, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_zone_id, 'PRIMARY', 'ASSIGNED',
        1, 1, p_idempotency_key, v_occurred_at, v_actor_id)
    RETURNING t.id INTO v_task_id;
    INSERT INTO inventarios.task_assignments AS ta (company_id, session_id, task_id,
        session_participant_id, user_id, assigned_at, assigned_by, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_task_id, v_participant_id, v_campaign_user_id,
        v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING ta.id INTO v_assignment_id;
    UPDATE inventarios.tasks AS t SET current_assignment_id = v_assignment_id,
        updated_at = v_occurred_at, updated_by = v_actor_id WHERE t.company_id = p_company_id AND t.id = v_task_id;

    SELECT pg_catalog.count(*) INTO v_total
    FROM inventarios.session_location_scopes slc
    JOIN logistica.locations l ON l.id = slc.location_id
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.inclusion_type = 'INCLUDED' AND slc.location_id IS NOT NULL
      AND l.is_active = true AND l.warehouse_id = v_session_warehouse_id;
    SELECT pg_catalog.count(DISTINCT szl.location_id) INTO v_assigned
    FROM inventarios.session_zone_locations szl
    JOIN inventarios.session_zones sz
      ON sz.company_id = szl.company_id AND sz.session_id = szl.session_id
     AND sz.id = szl.session_zone_id AND sz.is_enabled = true
    WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id
      AND szl.location_id IS NOT NULL;
    v_pending := GREATEST(v_total - v_assigned, 0);
    IF v_total > 0 THEN
        v_percent := pg_catalog.round(v_assigned::numeric * 100.0 / v_total::numeric, 1);
    ELSE
        v_percent := 0;
    END IF;
    SELECT pg_catalog.count(DISTINCT ta.session_participant_id) INTO v_counter_assigned
    FROM inventarios.task_assignments ta
    WHERE ta.company_id = p_company_id AND ta.session_id = p_session_id
      AND ta.released_at IS NULL;
    SELECT pg_catalog.count(*) INTO v_counter_total
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
      AND sp.functional_role = 'COUNTER' AND sp.active_from <= v_occurred_at
      AND sp.revoked_at IS NULL;
    v_counter_without := GREATEST(v_counter_total - v_counter_assigned, 0);

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
$$;

-- ============================================================
-- 2. RPC: cancel_inventory_counting_zone (zona no iniciada).
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.cancel_inventory_counting_zone(
    p_company_id uuid, p_campaign_id uuid, p_session_id uuid,
    p_zone_id uuid, p_reason text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_reason text; v_campaign_status text; v_session_status text;
    v_session_warehouse_id uuid; v_session_campaign_id uuid;
    v_task_id uuid; v_task_status text; v_task_version integer; v_task_cycle integer;
    v_current_assignment_id uuid; v_task_opened_at timestamptz; v_task_active_user uuid;
    v_event_id uuid;
    v_total bigint; v_assigned bigint; v_pending bigint; v_percent numeric;
    v_zone_count bigint;
    v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
BEGIN
    v_reason := pg_catalog.btrim(p_reason);
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_session_id IS NULL
       OR p_zone_id IS NULL OR p_idempotency_key IS NULL
       OR v_reason = '' OR pg_catalog.char_length(v_reason) < 5
       OR pg_catalog.char_length(v_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST', DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.zones.manage');
    PERFORM inventarios.require_permission(p_company_id, 'inventarios.participants.manage');
    PERFORM inventarios.require_permission(p_company_id, 'inventarios.tasks.assign');
    PERFORM inventarios.require_session_participant(p_company_id, p_session_id, 'ADMINISTRATOR');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.cancel_inventory_counting_zone'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.counting_zone.cancel','company_id',p_company_id,
        'campaign_id',p_campaign_id,'session_id',p_session_id,
        'zone_id',p_zone_id,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.counting_zone.cancel',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
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

    IF NOT EXISTS (SELECT 1 FROM inventarios.session_zones sz
                   WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
                     AND sz.id = p_zone_id AND sz.is_enabled = true) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ZONE_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','La zona solicitada no existe o ya fue cancelada.','retryable',false)::text;
    END IF;

    SELECT t.id, t.status, t.version, t.validation_cycle, t.current_assignment_id,
           t.opened_at, t.active_user_id
    INTO v_task_id, v_task_status, v_task_version, v_task_cycle,
         v_current_assignment_id, v_task_opened_at, v_task_active_user
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id
      AND t.session_zone_id = p_zone_id AND t.task_kind = 'PRIMARY'
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','La zona no tiene una tarea vigente.','retryable',false)::text;
    END IF;
    IF v_task_status <> 'ASSIGNED' OR v_task_opened_at IS NOT NULL OR v_task_active_user IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_ALREADY_STARTED', DETAIL=pg_catalog.jsonb_build_object('message','La tarea ya inicio y no puede cancelarse.','retryable',false)::text;
    END IF;
    IF v_current_assignment_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;

    v_occurred_at := pg_catalog.now();
    UPDATE inventarios.task_assignments AS ta
    SET released_at = v_occurred_at, released_by = v_actor_id, release_reason = v_reason
    WHERE ta.company_id = p_company_id AND ta.id = v_current_assignment_id;
    INSERT INTO inventarios.task_events AS e (company_id, session_id, session_zone_id,
        task_id, event_type, actor_id, cycle, occurred_at, reason, idempotency_key,
        technical_metadata, created_by)
    VALUES (p_company_id, p_session_id, p_zone_id, v_task_id, 'CANCELLED', v_actor_id,
        v_task_cycle, v_occurred_at, v_reason, p_idempotency_key,
        pg_catalog.jsonb_build_object('operation','inventarios.counting_zone.cancel'),
        v_actor_id)
    RETURNING e.id INTO v_event_id;
    UPDATE inventarios.tasks AS t SET cancelled_at = v_occurred_at, cancelled_by = v_actor_id,
        current_assignment_id = NULL, active_user_id = NULL, version = t.version + 1,
        updated_at = v_occurred_at, updated_by = v_actor_id WHERE t.company_id = p_company_id AND t.id = v_task_id;
    DELETE FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id
      AND szl.session_zone_id = p_zone_id;
    UPDATE inventarios.session_zones AS sz
    SET is_enabled = false, updated_at = v_occurred_at, updated_by = v_actor_id
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
      AND sz.id = p_zone_id;

    SELECT pg_catalog.count(*) INTO v_total
    FROM inventarios.session_location_scopes slc
    JOIN logistica.locations l ON l.id = slc.location_id
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.inclusion_type = 'INCLUDED' AND slc.location_id IS NOT NULL
      AND l.is_active = true AND l.warehouse_id = v_session_warehouse_id;
    SELECT pg_catalog.count(DISTINCT szl.location_id) INTO v_assigned
    FROM inventarios.session_zone_locations szl
    JOIN inventarios.session_zones sz
      ON sz.company_id = szl.company_id AND sz.session_id = szl.session_id
     AND sz.id = szl.session_zone_id AND sz.is_enabled = true
    WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id
      AND szl.location_id IS NOT NULL;
    v_pending := GREATEST(v_total - v_assigned, 0);
    IF v_total > 0 THEN
        v_percent := pg_catalog.round(v_assigned::numeric * 100.0 / v_total::numeric, 1);
    ELSE
        v_percent := 0;
    END IF;
    SELECT pg_catalog.count(*) INTO v_zone_count
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.is_enabled = true;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.counting_zone.cancel','entity_id',p_zone_id,
        'state',v_task_status,'version',v_task_version + 1::integer,
        'cycle_number',v_task_cycle,'assignment_id',NULL::uuid,
        'event_id',v_event_id,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object(
            'campaign_id',p_campaign_id,'session_id',p_session_id,
            'zone_id',p_zone_id,'task_id',v_task_id,
            'task_assignment_id',v_current_assignment_id,
            'reason',v_reason,
            'coverage',pg_catalog.jsonb_build_object(
                'total',v_total,'assigned',v_assigned,'pending',v_pending,
                'percent',v_percent,'zone_count',v_zone_count)));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_zone_id, v_response);
END;
$$;

-- ============================================================
-- 3. RPC: list_inventory_session_scopes (fuente oficial del alcance).
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_inventory_session_scopes(
    p_company_id uuid, p_session_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_session_warehouse_id uuid; v_locations jsonb;
    v_total bigint; v_assigned bigint; v_pending bigint;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST', DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT s.warehouse_id INTO v_session_warehouse_id
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','La jornada solicitada no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_total
    FROM inventarios.session_location_scopes slc
    JOIN logistica.locations l ON l.id = slc.location_id
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.inclusion_type = 'INCLUDED' AND slc.location_id IS NOT NULL
      AND l.is_active = true AND l.warehouse_id = v_session_warehouse_id;
    SELECT pg_catalog.count(DISTINCT szl.location_id) INTO v_assigned
    FROM inventarios.session_zone_locations szl
    JOIN inventarios.session_zones sz
      ON sz.company_id = szl.company_id AND sz.session_id = szl.session_id
     AND sz.id = szl.session_zone_id AND sz.is_enabled = true
    WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id
      AND szl.location_id IS NOT NULL;
    v_pending := GREATEST(v_total - v_assigned, 0);

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'location_id', l.id,
            'code', l.code,
            'name', l.name,
            'aisle', l.aisle,
            'rack', l.rack,
            'level', l.level,
            'position', l.position,
            'is_active', l.is_active,
            'warehouse_id', l.warehouse_id,
            'assigned_zone_id', sz.id,
            'assigned_zone_name', sz.display_name
        )
        ORDER BY l.code
    )
    INTO v_locations
    FROM inventarios.session_location_scopes slc
    JOIN logistica.locations l ON l.id = slc.location_id
    LEFT JOIN inventarios.session_zone_locations szl
      ON szl.company_id = slc.company_id AND szl.session_id = slc.session_id
     AND szl.location_id = slc.location_id
    LEFT JOIN inventarios.session_zones sz
      ON sz.company_id = szl.company_id AND sz.session_id = szl.session_id
     AND sz.id = szl.session_zone_id AND sz.is_enabled = true
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.inclusion_type = 'INCLUDED' AND slc.location_id IS NOT NULL
      AND l.is_active = true AND l.warehouse_id = v_session_warehouse_id;

    RETURN pg_catalog.jsonb_build_object(
        'session_id', p_session_id,
        'warehouse_id', v_session_warehouse_id,
        'total_locations', v_total,
        'assigned_locations', v_assigned,
        'pending_locations', v_pending,
        'locations', CASE WHEN v_locations IS NULL THEN '[]'::jsonb ELSE v_locations END);
END;
$$;

-- ============================================================
-- 4. OWNER, REVOKES Y GRANTS.
-- ============================================================
ALTER FUNCTION inventarios.assign_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid[], uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.cancel_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.list_inventory_session_scopes(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.assign_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.cancel_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.list_inventory_session_scopes(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.assign_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.cancel_inventory_counting_zone(uuid, uuid, uuid, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_session_scopes(uuid, uuid) TO authenticated;
