-- Migration: 20260803081000_inventarios_phase_04g1b_zones_locations_tasks.sql
-- Description: Fase 4G.1b. RPCs de zonas, ubicaciones y tareas para una jornada
--              DRAFT con snapshot temprano. Todo deriva snapshot_id desde la
--              jornada. No genera eventos STARTED ni inicia tareas.
-- Author: Assistant

-- ============================================================
-- 1. RPC: create_inventory_session_zone
--    Solo DRAFT. El snapshot se obtiene de la jornada, no del cliente.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.create_inventory_session_zone(
    p_company_id uuid, p_session_id uuid, p_zone_code text, p_scan_code text,
    p_display_name text, p_priority integer, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_zone_code text; v_scan_code text; v_display_name text;
    v_session_status text; v_snapshot_id uuid; v_zone_id uuid;
    v_priority integer; v_occurred_at timestamptz;
    v_response jsonb; v_payload jsonb;
BEGIN
    v_zone_code := pg_catalog.upper(pg_catalog.btrim(p_zone_code));
    v_scan_code := pg_catalog.btrim(p_scan_code);
    v_display_name := pg_catalog.btrim(p_display_name);
    v_priority := pg_catalog.coalesce(p_priority, 0);
    IF p_company_id IS NULL OR p_session_id IS NULL
       OR v_zone_code = '' OR pg_catalog.char_length(v_zone_code) > 50
       OR v_scan_code = '' OR pg_catalog.char_length(v_scan_code) > 100
       OR v_display_name = '' OR pg_catalog.char_length(v_display_name) > 200
       OR v_priority < 0
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.zones.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.create_inventory_session_zone'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.zone.create','company_id',p_company_id,
        'session_id',p_session_id,'zone_code',v_zone_code,'scan_code',v_scan_code,
        'display_name',v_display_name,'priority',v_priority);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.zone.create',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT s.status, os.id
    INTO v_session_status, v_snapshot_id
    FROM inventarios.sessions s
    JOIN inventarios.operational_snapshots os
      ON os.company_id = s.company_id AND os.session_id = s.id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE OF s;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    IF EXISTS (SELECT 1 FROM inventarios.session_zones sz
               WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
                 AND (sz.zone_code = v_zone_code OR sz.scan_code = v_scan_code)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ZONE_DUPLICATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Ya existe una zona con el mismo codigo o scan en la jornada.','retryable',false)::text;
    END IF;
    v_occurred_at := pg_catalog.now();
    INSERT INTO inventarios.session_zones AS sz (company_id, session_id, snapshot_id,
        zone_code, scan_code, display_name, priority, is_enabled, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_snapshot_id, v_zone_code, v_scan_code,
        v_display_name, v_priority, true, v_occurred_at, v_actor_id)
    RETURNING sz.id INTO v_zone_id;
    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.zone.create','entity_id',v_zone_id,
        'state','DRAFT','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_id',p_session_id,
            'snapshot_id',v_snapshot_id,'zone_code',v_zone_code,'scan_code',v_scan_code,
            'display_name',v_display_name,'priority',v_priority,'is_enabled',true));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_zone_id, v_response);
END;
$$;

-- ============================================================
-- 2. RPC: add_inventory_zone_location
--    Solo DRAFT. Deriva snapshot_id de la jornada y crea o reutiliza
--    session_location_scope y snapshot_location segun el modelo.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.add_inventory_zone_location(
    p_company_id uuid, p_session_id uuid, p_session_zone_id uuid,
    p_location_id uuid, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_session_status text; v_snapshot_id uuid;
    v_location_company uuid; v_location_active boolean;
    v_location_warehouse_id uuid; v_location_code text; v_location_name text;
    v_location_aisle text; v_location_rack text; v_location_level text;
    v_location_position text; v_location_is_active boolean;
    v_scope_id uuid; v_snapshot_location_id uuid;
    v_zone_location_id uuid; v_occurred_at timestamptz;
    v_response jsonb; v_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_session_zone_id IS NULL
       OR p_location_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.zones.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.add_inventory_zone_location'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.zone.location.add','company_id',p_company_id,
        'session_id',p_session_id,'session_zone_id',p_session_zone_id,
        'location_id',p_location_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.zone.location.add',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT s.status, os.id
    INTO v_session_status, v_snapshot_id
    FROM inventarios.sessions s
    JOIN inventarios.operational_snapshots os
      ON os.company_id = s.company_id AND os.session_id = s.id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE OF s;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM inventarios.session_zones sz
                   WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
                     AND sz.id = p_session_zone_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La zona solicitada no existe en la jornada.','retryable',false)::text;
    END IF;
    SELECT l.company_id, l.is_active, l.warehouse_id, l.code, l.name,
           l.aisle, l.rack, l.level, l.position, l.is_active
    INTO v_location_company, v_location_active, v_location_warehouse_id, v_location_code,
         v_location_name, v_location_aisle, v_location_rack, v_location_level,
         v_location_position, v_location_is_active
    FROM logistica.locations l
    WHERE l.id = p_location_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La ubicacion solicitada no existe.','retryable',false)::text;
    END IF;
    IF v_location_company IS DISTINCT FROM p_company_id OR v_location_is_active IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La ubicacion no pertenece a la empresa o no esta activa.','retryable',false)::text;
    END IF;
    IF EXISTS (SELECT 1 FROM inventarios.session_zone_locations szl
               WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id
                 AND szl.location_id = p_location_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_DUPLICATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La ubicacion ya pertenece a la jornada.','retryable',false)::text;
    END IF;
    v_occurred_at := pg_catalog.now();
    SELECT slc.id INTO v_scope_id
    FROM inventarios.session_location_scopes slc
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.location_id = p_location_id;
    IF v_scope_id IS NULL THEN
        INSERT INTO inventarios.session_location_scopes AS slc (company_id, session_id,
            location_id, inclusion_type, created_at, created_by)
        VALUES (p_company_id, p_session_id, p_location_id, 'INCLUDED',
            v_occurred_at, v_actor_id)
        RETURNING slc.id INTO v_scope_id;
    END IF;
    SELECT sll.id INTO v_snapshot_location_id
    FROM inventarios.snapshot_locations sll
    WHERE sll.company_id = p_company_id AND sll.snapshot_id = v_snapshot_id
      AND sll.location_id = p_location_id;
    IF v_snapshot_location_id IS NULL THEN
        INSERT INTO inventarios.snapshot_locations AS sll (company_id, snapshot_id,
            location_id, warehouse_id, code, name, aisle, rack, level, position,
            is_active, created_at, created_by)
        VALUES (p_company_id, v_snapshot_id, p_location_id, v_location_warehouse_id,
            v_location_code, v_location_name, v_location_aisle, v_location_rack,
            v_location_level, v_location_position, v_location_is_active,
            v_occurred_at, v_actor_id)
        RETURNING sll.id INTO v_snapshot_location_id;
    END IF;
    INSERT INTO inventarios.session_zone_locations AS szl (company_id, session_id,
        snapshot_id, session_zone_id, session_location_scope_id, snapshot_location_id,
        location_id, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_snapshot_id, p_session_zone_id, v_scope_id,
        v_snapshot_location_id, p_location_id, v_occurred_at, v_actor_id)
    RETURNING szl.id INTO v_zone_location_id;
    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.zone.location.add','entity_id',v_zone_location_id,
        'state','DRAFT','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_id',p_session_id,
            'session_zone_id',p_session_zone_id,'location_id',p_location_id,
            'snapshot_id',v_snapshot_id,'session_location_scope_id',v_scope_id,
            'snapshot_location_id',v_snapshot_location_id));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_zone_location_id, v_response);
END;
$$;

-- ============================================================
-- 3. RPC: create_inventory_task
--    Solo DRAFT. Valida zona/snapshot de la misma jornada y participante
--    COUNTER activo. Crea task ASSIGNED y assignment vigente. No STARTED.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.create_inventory_task(
    p_company_id uuid, p_session_id uuid, p_session_zone_id uuid,
    p_counter_user_id uuid, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_session_status text; v_snapshot_id uuid;
    v_zone_snapshot_id uuid; v_participant_id uuid;
    v_task_id uuid; v_assignment_id uuid;
    v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_session_zone_id IS NULL
       OR p_counter_user_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.tasks.assign');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.create_inventory_task'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.task.create','company_id',p_company_id,
        'session_id',p_session_id,'session_zone_id',p_session_zone_id,
        'counter_user_id',p_counter_user_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.task.create',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT s.status, os.id
    INTO v_session_status, v_snapshot_id
    FROM inventarios.sessions s
    JOIN inventarios.operational_snapshots os
      ON os.company_id = s.company_id AND os.session_id = s.id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE OF s;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    SELECT sz.snapshot_id INTO v_zone_snapshot_id
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
      AND sz.id = p_session_zone_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La zona solicitada no existe en la jornada.','retryable',false)::text;
    END IF;
    IF v_zone_snapshot_id IS DISTINCT FROM v_snapshot_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La zona no pertenece al snapshot de la jornada.','retryable',false)::text;
    END IF;
    SELECT sp.id INTO v_participant_id
    FROM inventarios.session_participants sp
    JOIN portal.users u ON u.id = sp.user_id
    JOIN core.user_company_access uca
      ON uca.user_id = sp.user_id AND uca.company_id = sp.company_id AND uca.is_active = true
    WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
      AND sp.user_id = p_counter_user_id AND sp.functional_role = 'COUNTER'
      AND sp.active_from <= pg_catalog.now() AND sp.revoked_at IS NULL
      AND u.is_active = true AND u.deleted_at IS NULL;
    IF v_participant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','No existe un participante COUNTER activo para la zona.','retryable',false)::text;
    END IF;
    v_occurred_at := pg_catalog.now();
    INSERT INTO inventarios.tasks AS t (company_id, session_id, session_zone_id, task_kind,
        status, version, validation_cycle, creation_idempotency_key, created_at, created_by)
    VALUES (p_company_id, p_session_id, p_session_zone_id, 'PRIMARY', 'ASSIGNED',
        1, 0, p_idempotency_key, v_occurred_at, v_actor_id)
    RETURNING t.id INTO v_task_id;
    INSERT INTO inventarios.task_assignments AS ta (company_id, session_id, task_id,
        session_participant_id, user_id, assigned_at, assigned_by, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_task_id, v_participant_id, p_counter_user_id,
        v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING ta.id INTO v_assignment_id;
    UPDATE inventarios.tasks AS t
    SET current_assignment_id = v_assignment_id,
        updated_at = v_occurred_at, updated_by = v_actor_id
    WHERE t.company_id = p_company_id AND t.id = v_task_id;
    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.task.create','entity_id',v_task_id,
        'state','ASSIGNED','version',1,'cycle_number',NULL::integer,
        'assignment_id',v_assignment_id,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_id',p_session_id,
            'session_zone_id',p_session_zone_id,'counter_user_id',p_counter_user_id,
            'task_kind','PRIMARY','status','ASSIGNED','validation_cycle',0,
            'started',false));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_task_id, v_response);
END;
$$;

-- ============================================================
-- 4. OWNER Y REVOKES
-- ============================================================
ALTER FUNCTION inventarios.create_inventory_session_zone(uuid, uuid, text, text, text, integer, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.add_inventory_zone_location(uuid, uuid, uuid, uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.create_inventory_task(uuid, uuid, uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.create_inventory_session_zone(uuid, uuid, text, text, text, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.add_inventory_zone_location(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.create_inventory_task(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
