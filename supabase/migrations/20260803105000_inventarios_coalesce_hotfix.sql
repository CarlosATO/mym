-- Migration: 20260803105000_inventarios_coalesce_hotfix.sql
-- Description: Correccion real de contrato backend detectada en prueba de
--              aceptacion web. pg_catalog.coalesce(...) calificado falla en
--              runtime (function coalesce(text, unknown) does not exist) porque
--              el calificador impide la semantica especial de COALESCE con
--              search_path=pg_catalog. Se reemplaza por coalesce sin calificar
--              y se corrige bo.code inexistente en bsale_offices.
-- Author: Assistant

-- ===== create_inventory_session =====
CREATE OR REPLACE FUNCTION inventarios.create_inventory_session(
    p_company_id uuid, p_name text, p_inventory_type text, p_warehouse_id uuid,
    p_bsale_office_id integer, p_scope_mode text, p_responsible_user_id uuid,
    p_notes text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_inventory_type text; v_scope_mode text; v_name text; v_notes text;
    v_session_number integer; v_session_id uuid; v_snapshot_id uuid;
    v_participant_id uuid; v_occurred_at timestamptz;
    v_response jsonb; v_payload jsonb;
BEGIN
    v_inventory_type := pg_catalog.upper(pg_catalog.btrim(p_inventory_type));
    v_scope_mode := pg_catalog.upper(pg_catalog.btrim(p_scope_mode));
    v_name := pg_catalog.btrim(p_name);
    v_notes := pg_catalog.btrim(coalesce(p_notes, ''));
    IF p_company_id IS NULL OR v_name = '' OR pg_catalog.char_length(v_name) > 200
       OR v_inventory_type NOT IN ('GENERAL','PARTIAL','CYCLIC','CONTROL','RECOUNT')
       OR p_warehouse_id IS NULL OR p_bsale_office_id IS NULL OR p_bsale_office_id < 1
       OR v_scope_mode NOT IN ('GENERAL','PARTIAL')
       OR NOT ((v_inventory_type = 'GENERAL' AND v_scope_mode = 'GENERAL')
               OR (v_inventory_type = 'PARTIAL' AND v_scope_mode = 'PARTIAL')
               OR v_inventory_type IN ('CYCLIC','CONTROL','RECOUNT'))
       OR p_responsible_user_id IS NULL OR pg_catalog.char_length(v_notes) > 2000
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.create');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.create_inventory_session'),
        pg_catalog.hashtext(p_company_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.create','company_id',p_company_id,'name',v_name,
        'inventory_type',v_inventory_type,'warehouse_id',p_warehouse_id,
        'bsale_office_id',p_bsale_office_id,'scope_mode',v_scope_mode,
        'responsible_user_id',p_responsible_user_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.create',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM core.companies c WHERE c.id = p_company_id AND c.is_active = true) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COMPANY_ACCESS_DENIED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes acceso a la empresa solicitada.','retryable',false)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM adquisiciones.warehouses w
                   WHERE w.id = p_warehouse_id AND w.company_id = p_company_id
                     AND w.is_active = true AND w.status = 'ACTIVE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La bodega solicitada no existe o no esta activa.','retryable',false)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM integraciones.bsale_offices bo
                   WHERE bo.company_id = p_company_id AND bo.bsale_id = p_bsale_office_id::bigint) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La oficina Bsale solicitada no existe o no esta activa.','retryable',false)::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM portal.users u
                   JOIN core.user_company_access uca
                     ON uca.user_id = u.id AND uca.company_id = p_company_id AND uca.is_active = true
                   WHERE u.id = p_responsible_user_id AND u.is_active = true AND u.deleted_at IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El responsable solicitado no existe o no tiene acceso a la empresa.','retryable',false)::text;
    END IF;
    IF EXISTS (SELECT 1 FROM inventarios.sessions s
               WHERE s.company_id = p_company_id AND s.warehouse_id = p_warehouse_id
                 AND s.inventory_type = v_inventory_type AND s.status IN ('DRAFT','PREPARED')) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_DUPLICATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Ya existe una jornada configurable para la misma bodega y tipo.','retryable',false)::text;
    END IF;
    SELECT coalesce(pg_catalog.max(s.session_number), 0) + 1
    INTO v_session_number
    FROM inventarios.sessions s WHERE s.company_id = p_company_id;
    v_occurred_at := pg_catalog.now();
    INSERT INTO inventarios.sessions AS s (company_id, session_number, name, inventory_type, status,
        warehouse_id, bsale_office_id, scope_mode, responsible_user_id, notes,
        created_at, created_by, updated_at, updated_by)
    VALUES (p_company_id, v_session_number, v_name, v_inventory_type, 'DRAFT',
        p_warehouse_id, p_bsale_office_id, v_scope_mode, p_responsible_user_id,
        CASE WHEN v_notes = '' THEN NULL ELSE v_notes END,
        v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING s.id INTO v_session_id;
    INSERT INTO inventarios.operational_snapshots AS os (company_id, session_id, snapshot_version,
        completion_status, captured_at, captured_by, created_at, created_by)
    VALUES (p_company_id, v_session_id, 1, 'PENDING', v_occurred_at, v_actor_id, v_occurred_at, v_actor_id)
    RETURNING os.id INTO v_snapshot_id;
    INSERT INTO inventarios.session_participants AS sp (company_id, session_id, user_id, functional_role,
        active_from, created_at, created_by)
    VALUES (p_company_id, v_session_id, p_responsible_user_id, 'ADMINISTRATOR',
        v_occurred_at, v_occurred_at, v_actor_id)
    RETURNING sp.id INTO v_participant_id;
    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.create','entity_id',v_session_id,'state','DRAFT',
        'version',NULL::integer,'cycle_number',NULL::integer,'assignment_id',NULL::uuid,
        'event_id',NULL::uuid,'replayed',false,'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_number',v_session_number,
            'snapshot_id',v_snapshot_id,'responsible_participant_id',v_participant_id,
            'responsible_user_id',p_responsible_user_id,'completion_status','PENDING'));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_session_id, v_response);
END;
$$;

-- ===== create_inventory_session_zone =====
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
    v_priority := coalesce(p_priority, 0);
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

-- ===== prepare_inventory_session =====
CREATE OR REPLACE FUNCTION inventarios.prepare_inventory_session(
    p_company_id uuid,
    p_session_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_session_status text; v_scope_mode text; v_bsale_office_id integer;
    v_snapshot_id uuid; v_snapshot_status text;
    v_counter_count bigint; v_supervisor_count bigint; v_manager_count bigint;
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

    PERFORM inventarios.require_session_participant(p_company_id, p_session_id, 'ADMINISTRATOR');

    -- Validacion 4-6: al menos un COUNTER, SUPERVISOR y MANAGER activo
    SELECT pg_catalog.count(*) FILTER (WHERE sp.functional_role = 'COUNTER'),
           pg_catalog.count(*) FILTER (WHERE sp.functional_role = 'SUPERVISOR'),
           pg_catalog.count(*) FILTER (WHERE sp.functional_role = 'MANAGER')
    INTO v_counter_count, v_supervisor_count, v_manager_count
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
      AND sp.active_from <= pg_catalog.now() AND sp.revoked_at IS NULL;

    IF v_counter_count < 1 OR v_supervisor_count < 1 OR v_manager_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada requiere al menos un COUNTER, un SUPERVISOR y un MANAGER activos.','retryable',false,
                'counter_count',v_counter_count,'supervisor_count',v_supervisor_count,'manager_count',v_manager_count)::text;
    END IF;

    -- Validacion 7-9: zonas, ubicaciones por zona, tareas por zona
    SELECT pg_catalog.count(*)
    INTO v_zone_count
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.is_enabled = true;

    IF v_zone_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene zonas habilitadas.','retryable',false,'zone_count',0)::text;
    END IF;

    SELECT pg_catalog.count(*)
    INTO v_zone_without_location
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

    SELECT pg_catalog.count(*)
    INTO v_zone_without_task
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

    -- Validacion 10-12: tareas ASSIGNED con assignment vigente de COUNTER activo
    SELECT pg_catalog.count(*)
    INTO v_task_count
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL;

    IF v_task_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene tareas activas.','retryable',false,'task_count',0)::text;
    END IF;

    SELECT pg_catalog.count(*)
    INTO v_task_not_assigned
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.status <> 'ASSIGNED';

    IF v_task_not_assigned > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda tarea debe estar en estado ASSIGNED.','retryable',false,'tasks_not_assigned',v_task_not_assigned)::text;
    END IF;

    SELECT pg_catalog.count(*)
    INTO v_task_without_assignment
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
      AND (sp.functional_role <> 'COUNTER' OR sp.revoked_at IS NOT NULL
           OR sp.active_from > pg_catalog.now()
           OR NOT EXISTS (SELECT 1 FROM core.user_company_access uca
                          WHERE uca.user_id = sp.user_id AND uca.company_id = sp.company_id
                            AND uca.is_active = true));

    IF v_bad_assignment > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda asignacion vigente debe corresponder a un COUNTER activo.','retryable',false,'bad_assignments',v_bad_assignment)::text;
    END IF;

    -- Validacion 13-14: cobertura de ubicaciones del alcance
    SELECT pg_catalog.count(*)
    INTO v_scope_location_count
    FROM inventarios.session_location_scopes slc
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.inclusion_type = 'INCLUDED';

    IF v_scope_location_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene ubicaciones en su alcance.','retryable',false,'scope_location_count',0)::text;
    END IF;

    SELECT pg_catalog.count(*)
    INTO v_scope_location_unzoned
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

    -- Validacion 15-16: construir snapshot_products y verificar coherencia
    DELETE FROM inventarios.snapshot_stocks ss
    WHERE ss.company_id = p_company_id AND ss.snapshot_id = v_snapshot_id;
    DELETE FROM inventarios.snapshot_products sp
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id;

    IF v_scope_mode = 'PARTIAL' THEN
        SELECT pg_catalog.count(*) INTO v_variant_count
        FROM inventarios.session_product_scopes sps
        JOIN integraciones.bsale_variants bv
          ON bv.company_id = sps.company_id AND bv.bsale_id = sps.bsale_variant_id
        WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id
          AND sps.inclusion_type = 'INCLUDED'
          AND bv.state = 0
          AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> '';

        INSERT INTO inventarios.snapshot_products (company_id, snapshot_id, bsale_variant_id,
            sku, barcode, name, created_at, created_by)
        SELECT sps.company_id, v_snapshot_id, bv.bsale_id, bv.code,
               bv.bar_code, coalesce(pg_catalog.btrim(bv.description), bv.code),
               v_occurred_at, v_actor_id
        FROM inventarios.session_product_scopes sps
        JOIN integraciones.bsale_variants bv
          ON bv.company_id = sps.company_id AND bv.bsale_id = sps.bsale_variant_id
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

        INSERT INTO inventarios.snapshot_products (company_id, snapshot_id, bsale_variant_id,
            sku, barcode, name, created_at, created_by)
        SELECT bv.company_id, v_snapshot_id, bv.bsale_id, bv.code,
               bv.bar_code, coalesce(pg_catalog.btrim(bv.description), bv.code),
               v_occurred_at, v_actor_id
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
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot no pudo construirse con productos del catalogo Bsale.','retryable',false,
                'variant_count',v_variant_count)::text;
    END IF;

    INSERT INTO inventarios.snapshot_stocks (company_id, snapshot_id, snapshot_product_id,
        office_id, theoretical_quantity, source_sync_run_id, source_synced_at, created_at, created_by)
    SELECT sp.company_id, sp.snapshot_id, sp.id, v_bsale_office_id,
           bsc.quantity_available, bsc.bsale_sync_run_id, bsc.synced_at,
           v_occurred_at, v_actor_id
    FROM inventarios.snapshot_products sp
    JOIN integraciones.bsale_stock_current bsc
      ON bsc.company_id = sp.company_id AND bsc.variant_id = sp.bsale_variant_id
     AND bsc.office_id = v_bsale_office_id
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id
      AND bsc.quantity_available >= 0
    ON CONFLICT (company_id, snapshot_id, snapshot_product_id, office_id) DO NOTHING;

    -- content_hash determinista: sha256 de ids ordenados del snapshot
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                pg_catalog.string_agg(t.line, E'\n' ORDER BY t.line),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    )
    INTO v_hash
    FROM (
        SELECT 'P:' || sp.id::text AS line
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id
        UNION ALL
        SELECT 'S:' || ss.id::text
        FROM inventarios.snapshot_stocks ss
        WHERE ss.company_id = p_company_id AND ss.snapshot_id = v_snapshot_id
        UNION ALL
        SELECT 'Z:' || sz.id::text
        FROM inventarios.session_zones sz
        WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
        UNION ALL
        SELECT 'T:' || t.id::text
        FROM inventarios.tasks t
        WHERE t.company_id = p_company_id AND t.session_id = p_session_id
          AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ) AS t;

    v_occurred_at := pg_catalog.now();

    UPDATE inventarios.operational_snapshots AS os
    SET completion_status = 'COMPLETED',
        content_hash = v_hash,
        captured_at = v_occurred_at,
        captured_by = v_actor_id
    WHERE os.company_id = p_company_id AND os.id = v_snapshot_id;

    UPDATE inventarios.sessions AS s
    SET status = 'PREPARED',
        prepared_at = v_occurred_at,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
      AND s.status = 'DRAFT';
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
            'counter_count',v_counter_count,'supervisor_count',v_supervisor_count,
            'manager_count',v_manager_count));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_response);
END;
$$;
ALTER FUNCTION inventarios.prepare_inventory_session(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.prepare_inventory_session(uuid, uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.prepare_inventory_session(uuid, uuid, uuid) TO authenticated;

-- ===== record_inventory_count =====
CREATE OR REPLACE FUNCTION inventarios.record_inventory_count(
    p_company_id uuid,
    p_task_id uuid,
    p_expected_cycle integer,
    p_snapshot_product_id uuid,
    p_snapshot_location_id uuid,
    p_quantities jsonb,
    p_identification_method text,
    p_scanned_code text,
    p_capture_source text,
    p_offline_id uuid,
    p_device_id text,
    p_captured_at timestamptz,
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

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.counts.record');

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

    v_participant_id := inventarios.require_session_participant(p_company_id, v_session_id, 'COUNTER');

    SELECT ta.id, ta.user_id
    INTO v_assignment_id, v_assignment_user_id
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
    v_captured_at := coalesce(p_captured_at, v_occurred_at);

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
$$;

-- ===== get_effective_task_contributions =====
CREATE OR REPLACE FUNCTION inventarios.get_effective_task_contributions(
    p_company_id uuid,
    p_session_id uuid,
    p_task_id uuid
)
RETURNS TABLE (
    contribution_count_entry_id uuid,
    contribution_source text,
    root_count_entry_id uuid,
    recount_request_id uuid,
    recount_decision_id uuid,
    company_id uuid,
    session_id uuid,
    snapshot_id uuid,
    session_zone_id uuid,
    snapshot_location_id uuid,
    snapshot_product_id uuid,
    task_id uuid,
    task_cycle integer
)
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_cancelled_at timestamptz;
    v_cancelled_by uuid;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_task_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    PERFORM 1 FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
        DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    SELECT t.cancelled_at, t.cancelled_by INTO v_cancelled_at, v_cancelled_by
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.session_id = p_session_id AND t.id = p_task_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
        DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF (v_cancelled_at IS NULL AND v_cancelled_by IS NOT NULL)
       OR (v_cancelled_at IS NOT NULL AND v_cancelled_by IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
    END IF;
    IF v_cancelled_at IS NOT NULL AND v_cancelled_by IS NOT NULL THEN
        RETURN;
    END IF;
    RETURN QUERY
    WITH task_info AS (
        SELECT t.validation_cycle FROM inventarios.tasks t
        WHERE t.id = p_task_id
    ),
    normal_counts AS (
        SELECT ec.effective_count_entry_id, 'NORMAL'::text AS source,
               ec.root_count_entry_id, ec.recount_request_id,
               NULL::uuid AS recount_decision_id,
               ec.company_id, ec.session_id, ec.snapshot_id, ec.session_zone_id,
               ec.snapshot_location_id, ec.snapshot_product_id,
               ec.task_id, ec.task_cycle
        FROM inventarios.get_effective_count_entries(p_company_id, p_session_id, p_task_id, NULL) ec
        JOIN task_info ti ON ec.task_cycle = ti.validation_cycle
    ),
    recount_scopes AS (
        SELECT rd.recount_request_id, rd.recount_decision_id,
               rd.selected_count_entry_id, rd.selected_root_count_entry_id,
               rd.session_zone_id, rd.snapshot_product_id,
               rd.source_task_id, rd.task_cycle,
               rd.session_id, rd.snapshot_id, rd.snapshot_location_id
        FROM inventarios.get_applicable_recount_decisions(p_company_id, p_session_id, p_task_id) rd
    ),
    replaced_scopes AS (
        SELECT DISTINCT rs.session_zone_id, rs.snapshot_product_id, rs.task_cycle
        FROM recount_scopes rs
    ),
    filtered_normal AS (
        SELECT nc.* FROM normal_counts nc
        WHERE NOT EXISTS (
            SELECT 1 FROM replaced_scopes rs
            WHERE rs.session_zone_id = nc.session_zone_id
              AND rs.snapshot_product_id = nc.snapshot_product_id
              AND rs.task_cycle = nc.task_cycle
        )
    ),
    recount_contributions AS (
        SELECT rs.selected_count_entry_id AS contribution_count_entry_id,
               'RECOUNT'::text AS source,
               rs.selected_root_count_entry_id AS root_count_entry_id,
               rs.recount_request_id, rs.recount_decision_id,
               p_company_id, rs.session_id, rs.snapshot_id, rs.session_zone_id,
               rs.snapshot_location_id, rs.snapshot_product_id,
               rs.source_task_id AS task_id, rs.task_cycle
        FROM recount_scopes rs
    ),
    combined AS (
        SELECT * FROM filtered_normal
        UNION ALL
        SELECT * FROM recount_contributions
    )
    SELECT c.contribution_count_entry_id, c.source, c.root_count_entry_id,
           c.recount_request_id, c.recount_decision_id,
           c.company_id, c.session_id, c.snapshot_id, c.session_zone_id,
           c.snapshot_location_id, c.snapshot_product_id,
           c.task_id, c.task_cycle
    FROM combined c
    WHERE EXISTS (
        SELECT 1 FROM inventarios.count_entries ce WHERE ce.id = c.contribution_count_entry_id
          AND ce.company_id = p_company_id
          AND ce.physical_quantity = ce.available_quantity + ce.damaged_quantity + ce.expired_quantity + ce.blocked_quantity + ce.other_unavailable_quantity
          AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
    )
    ORDER BY c.task_cycle, c.session_zone_id, c.snapshot_product_id, c.source, c.root_count_entry_id, c.contribution_count_entry_id;
END;
$$;

-- ===== get_inventory_session_catalogs =====
CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_catalogs(
    p_company_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_warehouses jsonb;
    v_offices jsonb;
    v_locations jsonb;
    v_users jsonb;
    v_roles jsonb;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', w.id, 'code', w.code, 'name', w.name,
                'warehouse_type', w.warehouse_type, 'is_default', w.is_default
            )
            ORDER BY w.code
        )
    END
    INTO v_warehouses
    FROM adquisiciones.warehouses w
    WHERE w.company_id = p_company_id AND w.is_active = true AND w.status = 'ACTIVE';

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'bsale_id', bo.bsale_id, 'name', bo.name, 'code', bo.bsale_id::text
            )
            ORDER BY bo.name
        )
    END
    INTO v_offices
    FROM integraciones.bsale_offices bo
    WHERE bo.company_id = p_company_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', l.id, 'warehouse_id', l.warehouse_id, 'code', l.code,
                'name', l.name, 'aisle', l.aisle, 'rack', l.rack,
                'level', l.level, 'position', l.position
            )
            ORDER BY l.code
        )
    END
    INTO v_locations
    FROM logistica.locations l
    WHERE l.company_id = p_company_id AND l.is_active = true;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', u.id, 'email', u.email, 'nombre', u.nombre, 'apellido', u.apellido
            )
            ORDER BY u.nombre, u.apellido
        )
    END
    INTO v_users
    FROM portal.users u
    JOIN core.user_company_access uca
      ON uca.user_id = u.id AND uca.company_id = p_company_id AND uca.is_active = true
    WHERE u.is_active = true AND u.deleted_at IS NULL;

    v_roles := '["COUNTER","SUPERVISOR","ADMINISTRATOR","MANAGER"]'::jsonb;

    RETURN pg_catalog.jsonb_build_object(
        'warehouses', v_warehouses,
        'offices', v_offices,
        'locations', v_locations,
        'users', v_users,
        'functional_roles', v_roles
    );
END;
$$;

-- ===== get_inventory_session_setup =====
CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_setup(
    p_company_id uuid,
    p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_session jsonb;
    v_snapshot jsonb;
    v_participants jsonb;
    v_zones jsonb;
    v_tasks jsonb;
    v_product_scope jsonb;
    v_indicators jsonb;
    v_zone_count bigint;
    v_location_count bigint;
    v_task_count bigint;
    v_snapshot_status text;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT pg_catalog.jsonb_build_object(
        'id', s.id,
        'company_id', s.company_id,
        'session_number', s.session_number,
        'name', s.name,
        'inventory_type', s.inventory_type,
        'status', s.status,
        'warehouse_id', s.warehouse_id,
        'bsale_office_id', s.bsale_office_id,
        'scope_mode', s.scope_mode,
        'responsible_user_id', s.responsible_user_id,
        'notes', s.notes,
        'prepared_at', s.prepared_at,
        'started_at', s.started_at,
        'created_at', s.created_at,
        'created_by', s.created_by,
        'updated_at', s.updated_at,
        'updated_by', s.updated_by
    )
    INTO v_session
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id;

    IF v_session IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.jsonb_build_object(
        'id', os.id,
        'session_id', os.session_id,
        'snapshot_version', os.snapshot_version,
        'completion_status', os.completion_status,
        'bsale_sync_run_id', os.bsale_sync_run_id,
        'captured_at', os.captured_at,
        'captured_by', os.captured_by,
        'content_hash', os.content_hash,
        'created_at', os.created_at,
        'created_by', os.created_by
    )
    INTO v_snapshot
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', sp.id,
            'user_id', sp.user_id,
            'functional_role', sp.functional_role,
            'active_from', sp.active_from,
            'created_at', sp.created_at,
            'created_by', sp.created_by
        )
        ORDER BY sp.functional_role, sp.user_id
    )
    INTO v_participants
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id
      AND sp.session_id = p_session_id
      AND sp.revoked_at IS NULL;

    SELECT pg_catalog.count(*)
    INTO v_zone_count
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id;

    SELECT pg_catalog.count(*)
    INTO v_location_count
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id;

    SELECT pg_catalog.count(*)
    INTO v_task_count
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', sz.id,
            'zone_code', sz.zone_code,
            'scan_code', sz.scan_code,
            'display_name', sz.display_name,
            'priority', sz.priority,
            'is_enabled', sz.is_enabled,
            'created_at', sz.created_at,
            'created_by', sz.created_by,
            'locations', (
                SELECT CASE
                    WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                    ELSE pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                            'location_id', szl.location_id,
                            'snapshot_location_id', szl.snapshot_location_id,
                            'code', sll.code,
                            'name', sll.name,
                            'aisle', sll.aisle,
                            'rack', sll.rack,
                            'level', sll.level,
                            'position', sll.position,
                            'is_active', sll.is_active
                        )
                        ORDER BY sll.code
                    )
                END
                FROM inventarios.session_zone_locations szl
                JOIN inventarios.snapshot_locations sll
                  ON sll.company_id = szl.company_id
                 AND sll.snapshot_id = szl.snapshot_id
                 AND sll.location_id = szl.location_id
                WHERE szl.company_id = sz.company_id
                  AND szl.session_id = sz.session_id
                  AND szl.session_zone_id = sz.id
            )
        )
        ORDER BY sz.priority, sz.zone_code
    )
    INTO v_zones
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', t.id,
            'session_zone_id', t.session_zone_id,
            'task_kind', t.task_kind,
            'status', t.status,
            'version', t.version,
            'validation_cycle', t.validation_cycle,
            'current_assignment_id', t.current_assignment_id,
            'created_at', t.created_at,
            'created_by', t.created_by,
            'assignment', CASE
                WHEN ta.id IS NULL THEN NULL
                ELSE pg_catalog.jsonb_build_object(
                    'assignment_id', ta.id,
                    'user_id', ta.user_id,
                    'session_participant_id', ta.session_participant_id,
                    'functional_role', sp.functional_role,
                    'assigned_at', ta.assigned_at,
                    'assigned_by', ta.assigned_by
                )
            END
        )
        ORDER BY t.created_at
    )
    INTO v_tasks
    FROM inventarios.tasks t
    LEFT JOIN inventarios.task_assignments ta
      ON ta.company_id = t.company_id AND ta.task_id = t.id AND ta.released_at IS NULL
    LEFT JOIN inventarios.session_participants sp
      ON sp.company_id = ta.company_id
     AND sp.session_id = ta.session_id
     AND sp.id = ta.session_participant_id
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'bsale_variant_id', sps.bsale_variant_id,
            'sku', bv.code,
            'barcode', bv.bar_code,
            'name', coalesce(pg_catalog.btrim(bv.description), bv.code)
        )
        ORDER BY bv.code
    )
    INTO v_product_scope
    FROM inventarios.session_product_scopes sps
    JOIN integraciones.bsale_variants bv
      ON bv.company_id = sps.company_id AND bv.bsale_id = sps.bsale_variant_id
    WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id
      AND sps.inclusion_type = 'INCLUDED';

    v_snapshot_status := v_snapshot ->> 'completion_status';

    v_indicators := pg_catalog.jsonb_build_object(
        'snapshot_pending', coalesce(v_snapshot_status, 'PENDING') = 'PENDING',
        'has_responsible', (v_session ->> 'responsible_user_id') IS NOT NULL,
        'active_participant_count', pg_catalog.jsonb_array_length(CASE WHEN v_participants IS NULL THEN '[]'::jsonb ELSE v_participants END),
        'zone_count', v_zone_count,
        'location_count', v_location_count,
        'task_count', v_task_count,
        'product_scope_count', pg_catalog.jsonb_array_length(CASE WHEN v_product_scope IS NULL THEN '[]'::jsonb ELSE v_product_scope END),
        'zones_without_locations', (
            SELECT pg_catalog.count(*) FROM inventarios.session_zones sz
            WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
              AND NOT EXISTS (
                  SELECT 1 FROM inventarios.session_zone_locations szl
                  WHERE szl.company_id = sz.company_id
                    AND szl.session_id = sz.session_id
                    AND szl.session_zone_id = sz.id
              )
        ),
        'zones_without_tasks', (
            SELECT pg_catalog.count(*) FROM inventarios.session_zones sz
            WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
              AND NOT EXISTS (
                  SELECT 1 FROM inventarios.tasks t
                  WHERE t.company_id = sz.company_id
                    AND t.session_id = sz.session_id
                    AND t.session_zone_id = sz.id
                    AND t.cancelled_at IS NULL
                    AND t.superseded_at IS NULL
              )
        ),
        'ready_to_prepare', (
            v_zone_count > 0
            AND v_location_count > 0
            AND v_task_count > 0
            AND v_zone_count = v_location_count
        )
    );

    RETURN pg_catalog.jsonb_build_object(
        'session', v_session,
        'snapshot', v_snapshot,
        'participants', CASE WHEN v_participants IS NULL THEN '[]'::jsonb ELSE v_participants END,
        'zones', CASE WHEN v_zones IS NULL THEN '[]'::jsonb ELSE v_zones END,
        'tasks', CASE WHEN v_tasks IS NULL THEN '[]'::jsonb ELSE v_tasks END,
        'product_scope', CASE WHEN v_product_scope IS NULL THEN '[]'::jsonb ELSE v_product_scope END,
        'indicators', v_indicators
    );
END;
$$;
ALTER FUNCTION inventarios.get_inventory_session_setup(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_session_setup(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_setup(uuid, uuid) TO authenticated;

-- ===== search_inventory_variants =====
CREATE OR REPLACE FUNCTION inventarios.search_inventory_variants(
    p_company_id uuid,
    p_search text,
    p_page integer,
    p_page_size integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_search text;
    v_page integer; v_page_size integer; v_offset integer;
    v_total bigint; v_rows jsonb;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    v_search := pg_catalog.btrim(coalesce(p_search, ''));
    v_page := coalesce(p_page, 1);
    v_page_size := coalesce(p_page_size, 25);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 25; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    SELECT pg_catalog.count(*) INTO v_total
    FROM integraciones.bsale_variants bv
    WHERE bv.company_id = p_company_id AND bv.state = 0
      AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> ''
      AND (v_search = '' OR bv.code ILIKE '%' || v_search || '%'
           OR coalesce(bv.description, '') ILIKE '%' || v_search || '%'
           OR coalesce(bv.bar_code, '') ILIKE '%' || v_search || '%');

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'bsale_variant_id', bv.bsale_id,
                'sku', bv.code,
                'barcode', bv.bar_code,
                'name', coalesce(pg_catalog.btrim(bv.description), bv.code)
            )
            ORDER BY bv.code
        )
    END
    INTO v_rows
    FROM (
        SELECT bv.bsale_id, bv.code, bv.bar_code, bv.description
        FROM integraciones.bsale_variants bv
        WHERE bv.company_id = p_company_id AND bv.state = 0
          AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> ''
          AND (v_search = '' OR bv.code ILIKE '%' || v_search || '%'
               OR coalesce(bv.description, '') ILIKE '%' || v_search || '%'
               OR coalesce(bv.bar_code, '') ILIKE '%' || v_search || '%')
        ORDER BY bv.code
        LIMIT v_page_size OFFSET v_offset
    ) bv;

    RETURN pg_catalog.jsonb_build_object(
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'has_more', v_offset + pg_catalog.jsonb_array_length(CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END) < v_total,
        'variants', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END
    );
END;
$$;

-- ===== get_inventory_session_product_scope =====
CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_product_scope(
    p_company_id uuid,
    p_session_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_scope jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'bsale_variant_id', sps.bsale_variant_id,
                'sku', bv.code,
                'barcode', bv.bar_code,
                'name', coalesce(pg_catalog.btrim(bv.description), bv.code),
                'inclusion_type', sps.inclusion_type,
                'created_at', sps.created_at
            )
            ORDER BY bv.code
        )
    END
    INTO v_scope
    FROM inventarios.session_product_scopes sps
    JOIN integraciones.bsale_variants bv
      ON bv.company_id = sps.company_id AND bv.bsale_id = sps.bsale_variant_id
    WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id
      AND sps.inclusion_type = 'INCLUDED';

    RETURN pg_catalog.jsonb_build_object(
        'session_id', p_session_id,
        'bsale_variant_ids', (
            SELECT CASE
                WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                ELSE pg_catalog.jsonb_agg(sps.bsale_variant_id ORDER BY sps.bsale_variant_id)
            END
            FROM inventarios.session_product_scopes sps
            WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id
              AND sps.inclusion_type = 'INCLUDED'
        ),
        'products', v_scope
    );
END;
$$;

-- ===== set_inventory_session_product_scope =====
CREATE OR REPLACE FUNCTION inventarios.set_inventory_session_product_scope(
    p_company_id uuid,
    p_session_id uuid,
    p_bsale_variant_ids integer[],
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_session_status text; v_scope_mode text;
    v_variant_count bigint; v_distinct_count bigint;
    v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_bsale_variant_ids IS NULL
       OR pg_catalog.array_length(p_bsale_variant_ids, 1) IS NULL
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.configure');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.set_inventory_session_product_scope'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.product_scope.set','company_id',p_company_id,
        'session_id',p_session_id,'bsale_variant_ids',p_bsale_variant_ids);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.product_scope.set',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT s.status, s.scope_mode
    INTO v_session_status, v_scope_mode
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    IF v_scope_mode <> 'PARTIAL' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El alcance de productos solo aplica a jornadas parciales.','retryable',false,'scope_mode',v_scope_mode)::text;
    END IF;

    SELECT pg_catalog.count(DISTINCT v), pg_catalog.count(*)
    INTO v_distinct_count, v_variant_count
    FROM pg_catalog.unnest(p_bsale_variant_ids) AS v;

    IF v_distinct_count <> v_variant_count THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La lista contiene variantes duplicadas.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_variant_count
    FROM pg_catalog.unnest(p_bsale_variant_ids) AS v
    JOIN integraciones.bsale_variants bv
      ON bv.company_id = p_company_id AND bv.bsale_id = v
    WHERE bv.state = 0 AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> '';

    IF v_variant_count <> pg_catalog.array_length(p_bsale_variant_ids, 1) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Algunas variantes no existen o no estan activas en la empresa.','retryable',false)::text;
    END IF;

    v_occurred_at := pg_catalog.now();

    DELETE FROM inventarios.session_product_scopes sps
    WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id;

    INSERT INTO inventarios.session_product_scopes (company_id, session_id, bsale_variant_id,
        inclusion_type, created_at, created_by)
    SELECT p_company_id, p_session_id, v, 'INCLUDED', v_occurred_at, v_actor_id
    FROM pg_catalog.unnest(p_bsale_variant_ids) AS v
    ORDER BY v;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.product_scope.set','entity_id',p_session_id,
        'state','DRAFT','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('bsale_variant_ids',p_bsale_variant_ids,
            'variant_count',pg_catalog.array_length(p_bsale_variant_ids, 1),
            'replaced',true));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_response);
END;
$$;

-- ===== get_inventory_session_results =====
CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_results(
    p_company_id uuid,
    p_session_id uuid,
    p_search text,
    p_difference_type text,
    p_page integer,
    p_page_size integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_search text;
    v_diff_type text;
    v_page integer; v_page_size integer; v_offset integer;
    v_session jsonb;
    v_version jsonb;
    v_total bigint;
    v_items jsonb;
    v_missing bigint;
    v_surplus bigint;
    v_no_diff bigint;
    v_product_count bigint;
    v_abs_diff numeric;
    v_office_id integer;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    v_search := pg_catalog.btrim(coalesce(p_search, ''));
    v_diff_type := pg_catalog.upper(pg_catalog.btrim(coalesce(p_difference_type, '')));
    v_page := coalesce(p_page, 1);
    v_page_size := coalesce(p_page_size, 50);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 50; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    SELECT s.bsale_office_id INTO v_office_id
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.jsonb_build_object(
        'id', s.id, 'session_number', s.session_number, 'name', s.name,
        'inventory_type', s.inventory_type, 'status', s.status,
        'scope_mode', s.scope_mode, 'warehouse_name', w.name,
        'responsible_user_id', s.responsible_user_id,
        'responsible_name', inventarios.user_display_name(s.responsible_user_id),
        'approved_at', s.approved_at, 'approved_by_name', inventarios.user_display_name(s.approved_by),
        'exported_at', s.exported_at, 'reconciled_at', s.reconciled_at,
        'cancelled_at', s.cancelled_at, 'cancelled_by_name', inventarios.user_display_name(s.cancelled_by),
        'cancellation_reason', s.cancellation_reason,
        'created_at', s.created_at
    )
    INTO v_session
    FROM inventarios.sessions s
    LEFT JOIN adquisiciones.warehouses w ON w.id = s.warehouse_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id;

    SELECT pg_catalog.jsonb_build_object(
        'version_number', ov.version_number,
        'task_count', ov.task_count,
        'contribution_count', ov.contribution_count,
        'normal_contribution_count', ov.normal_contribution_count,
        'recount_contribution_count', ov.recount_contribution_count,
        'item_count', ov.item_count,
        'approved_at', ov.approved_at,
        'approved_by_name', inventarios.user_display_name(ov.approved_by)
    )
    INTO v_version
    FROM inventarios.official_versions ov
    WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
    ORDER BY (ov.superseded_at IS NULL) DESC, ov.version_number DESC
    LIMIT 1;

    -- Resumen de diferencias
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE (coalesce(ss.theoretical_quantity, 0) - ovi.physical_quantity) = 0),
        pg_catalog.count(*) FILTER (WHERE (coalesce(ss.theoretical_quantity, 0) - ovi.physical_quantity) > 0),
        pg_catalog.count(*) FILTER (WHERE (coalesce(ss.theoretical_quantity, 0) - ovi.physical_quantity) < 0),
        pg_catalog.sum(pg_catalog.abs(coalesce(ss.theoretical_quantity, 0) - ovi.physical_quantity))
    INTO v_product_count, v_no_diff, v_missing, v_surplus, v_abs_diff
    FROM inventarios.official_version_items ovi
    JOIN inventarios.snapshot_products sp ON sp.company_id = ovi.company_id
      AND sp.snapshot_id = ovi.snapshot_id AND sp.id = ovi.snapshot_product_id
    LEFT JOIN inventarios.snapshot_stocks ss ON ss.company_id = ovi.company_id
      AND ss.snapshot_id = ovi.snapshot_id AND ss.snapshot_product_id = ovi.snapshot_product_id
      AND ss.office_id = v_office_id
    WHERE ovi.company_id = p_company_id AND ovi.session_id = p_session_id
      AND ovi.official_version_id = (SELECT ov.id FROM inventarios.official_versions ov
          WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
          ORDER BY (ov.superseded_at IS NULL) DESC, ov.version_number DESC LIMIT 1);

    SELECT pg_catalog.count(*) INTO v_total
    FROM inventarios.official_version_items ovi
    JOIN inventarios.snapshot_products sp ON sp.company_id = ovi.company_id
      AND sp.snapshot_id = ovi.snapshot_id AND sp.id = ovi.snapshot_product_id
    LEFT JOIN inventarios.snapshot_stocks ss ON ss.company_id = ovi.company_id
      AND ss.snapshot_id = ovi.snapshot_id AND ss.snapshot_product_id = ovi.snapshot_product_id
      AND ss.office_id = v_office_id
    WHERE ovi.company_id = p_company_id AND ovi.session_id = p_session_id
      AND ovi.official_version_id = (SELECT ov.id FROM inventarios.official_versions ov
          WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
          ORDER BY (ov.superseded_at IS NULL) DESC, ov.version_number DESC LIMIT 1)
      AND (v_search = '' OR sp.sku ILIKE '%' || v_search || '%' OR sp.name ILIKE '%' || v_search || '%')
      AND (v_diff_type = '' OR
           (v_diff_type = 'FALTANTE' AND coalesce(ss.theoretical_quantity,0) - ovi.physical_quantity > 0)
           OR (v_diff_type = 'SOBRANTE' AND coalesce(ss.theoretical_quantity,0) - ovi.physical_quantity < 0)
           OR (v_diff_type = 'SIN_DIFERENCIA' AND coalesce(ss.theoretical_quantity,0) - ovi.physical_quantity = 0));

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'sku', x.sku,
                'product', x.name,
                'barcode', x.bar_code,
                'theoretical', coalesce(x.theoretical, 0),
                'physical', x.physical_quantity,
                'difference', coalesce(x.theoretical,0) - x.physical_quantity,
                'difference_type', CASE
                    WHEN coalesce(x.theoretical,0) - x.physical_quantity > 0 THEN 'FALTANTE'
                    WHEN coalesce(x.theoretical,0) - x.physical_quantity < 0 THEN 'SOBRANTE'
                    ELSE 'SIN_DIFERENCIA'
                END,
                'provenance', CASE WHEN x.recount_contribution_count > 0 THEN 'RECUENTO' ELSE 'NORMAL' END
            )
            ORDER BY x.sku
        )
    END
    INTO v_items
    FROM (
        SELECT ovi.snapshot_product_id, ovi.physical_quantity, ovi.recount_contribution_count,
               ovi.snapshot_id, sp2.sku, sp2.name, sp2.barcode,
               (SELECT ss2.theoretical_quantity FROM inventarios.snapshot_stocks ss2
                WHERE ss2.company_id = ovi.company_id AND ss2.snapshot_id = ovi.snapshot_id
                  AND ss2.snapshot_product_id = ovi.snapshot_product_id AND ss2.office_id = v_office_id) AS theoretical
        FROM inventarios.official_version_items ovi
        JOIN inventarios.snapshot_products sp2
          ON sp2.company_id = ovi.company_id AND sp2.snapshot_id = ovi.snapshot_id
          AND sp2.id = ovi.snapshot_product_id
        WHERE ovi.company_id = p_company_id AND ovi.session_id = p_session_id
          AND ovi.official_version_id = (SELECT ov.id FROM inventarios.official_versions ov
              WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
              ORDER BY (ov.superseded_at IS NULL) DESC, ov.version_number DESC LIMIT 1)
    ) x
    WHERE (v_search = '' OR x.sku ILIKE '%' || v_search || '%' OR x.name ILIKE '%' || v_search || '%')
      AND (v_diff_type = '' OR
           (v_diff_type = 'FALTANTE' AND coalesce(x.theoretical,0) - x.physical_quantity > 0)
           OR (v_diff_type = 'SOBRANTE' AND coalesce(x.theoretical,0) - x.physical_quantity < 0)
           OR (v_diff_type = 'SIN_DIFERENCIA' AND coalesce(x.theoretical,0) - x.physical_quantity = 0))
    LIMIT v_page_size OFFSET v_offset;

    RETURN pg_catalog.jsonb_build_object(
        'session', v_session,
        'official_version', v_version,
        'summary', pg_catalog.jsonb_build_object(
            'product_count', v_product_count,
            'no_difference', v_no_diff,
            'missing', v_missing,
            'surplus', v_surplus,
            'absolute_difference_total', coalesce(v_abs_diff, 0)
        ),
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'has_more', v_offset + pg_catalog.jsonb_array_length(CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END) < v_total,
        'items', CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END
    );
END;
$$;
ALTER FUNCTION inventarios.get_inventory_session_results(uuid, uuid, text, text, integer, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_session_results(uuid, uuid, text, text, integer, integer)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_results(uuid, uuid, text, text, integer, integer) TO authenticated;

-- ===== list_inventory_result_sessions =====
CREATE OR REPLACE FUNCTION inventarios.list_inventory_result_sessions(
    p_company_id uuid,
    p_statuses text[],
    p_search text,
    p_page integer,
    p_page_size integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_statuses text[];
    v_search text;
    v_page integer; v_page_size integer;
    v_offset integer; v_total bigint;
    v_rows jsonb;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    v_statuses := coalesce(p_statuses, ARRAY['APPROVED','EXPORTED','RECONCILED','CANCELLED']::text[]);
    v_search := pg_catalog.btrim(coalesce(p_search, ''));
    v_page := coalesce(p_page, 1);
    v_page_size := coalesce(p_page_size, 100);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 100; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    SELECT pg_catalog.count(*) INTO v_total
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id
      AND s.status = ANY(v_statuses)
      AND (v_search = '' OR s.name ILIKE '%' || v_search || '%'
           OR s.session_number::text LIKE '%' || v_search || '%');

    SELECT pg_catalog.jsonb_agg(row_data ORDER BY row_data ->> 'created_at' DESC)
    INTO v_rows
    FROM (
        SELECT pg_catalog.jsonb_build_object(
            'id', s.id,
            'session_number', s.session_number,
            'name', s.name,
            'inventory_type', s.inventory_type,
            'status', s.status,
            'scope_mode', s.scope_mode,
            'warehouse_id', s.warehouse_id,
            'warehouse_name', w.name,
            'bsale_office_id', s.bsale_office_id,
            'responsible_user_id', s.responsible_user_id,
            'responsible_name', inventarios.user_display_name(s.responsible_user_id),
            'approved_at', s.approved_at,
            'approved_by_name', inventarios.user_display_name(s.approved_by),
            'exported_at', s.exported_at,
            'reconciled_at', s.reconciled_at,
            'cancelled_at', s.cancelled_at,
            'cancelled_by_name', inventarios.user_display_name(s.cancelled_by),
            'cancellation_reason', s.cancellation_reason,
            'created_at', s.created_at,
            'task_count', (
                SELECT pg_catalog.count(*) FROM inventarios.tasks t
                WHERE t.company_id = s.company_id AND t.session_id = s.id
                  AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
            )
        ) AS row_data
        FROM inventarios.sessions s
        LEFT JOIN adquisiciones.warehouses w
          ON w.id = s.warehouse_id
        WHERE s.company_id = p_company_id
          AND s.status = ANY(v_statuses)
          AND (v_search = '' OR s.name ILIKE '%' || v_search || '%'
               OR s.session_number::text LIKE '%' || v_search || '%')
        ORDER BY s.created_at DESC
        LIMIT v_page_size OFFSET v_offset
    ) AS r;

    RETURN pg_catalog.jsonb_build_object(
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'has_more', v_offset + pg_catalog.jsonb_array_length(CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END) < v_total,
        'sessions', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END
    );
END;
$$;
ALTER FUNCTION inventarios.list_inventory_result_sessions(uuid, text[], text, integer, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.list_inventory_result_sessions(uuid, text[], text, integer, integer)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_result_sessions(uuid, text[], text, integer, integer) TO authenticated;

-- ===== get_inventory_dashboard_summary =====
CREATE OR REPLACE FUNCTION inventarios.get_inventory_dashboard_summary(
    p_company_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_kpis jsonb;
    v_attention jsonb;
    v_alerts jsonb;
    v_active_count bigint;
    v_counting_count bigint;
    v_review_count bigint;
    v_blocking_count bigint;
    v_avg_progress numeric;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT
        pg_catalog.count(*) FILTER (WHERE s.status IN ('PREPARED','COUNTING')),
        pg_catalog.count(*) FILTER (WHERE s.status = 'COUNTING'),
        pg_catalog.count(*) FILTER (WHERE s.status = 'UNDER_REVIEW')
    INTO v_active_count, v_counting_count, v_review_count
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id;

    SELECT pg_catalog.count(*) INTO v_blocking_count
    FROM inventarios.incidents i
    WHERE i.company_id = p_company_id
      AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW');

    SELECT coalesce(pg_catalog.avg(x.progress), 0)
    INTO v_avg_progress
    FROM (
        SELECT CASE
            WHEN t.total > 0 THEN
                pg_catalog.round((t.completed::numeric / t.total::numeric) * 100, 1)
            ELSE 0
        END AS progress
        FROM inventarios.sessions s
        CROSS JOIN LATERAL (
            SELECT
                pg_catalog.count(*) AS total,
                pg_catalog.count(*) FILTER (WHERE st.status = 'COMPLETED') AS completed
            FROM inventarios.tasks st
            WHERE st.company_id = s.company_id AND st.session_id = s.id
              AND st.cancelled_at IS NULL AND st.superseded_at IS NULL
        ) t
        WHERE s.company_id = p_company_id AND s.status = 'COUNTING'
    ) x;

    v_kpis := pg_catalog.jsonb_build_object(
        'active_count', v_active_count,
        'counting_count', v_counting_count,
        'review_count', v_review_count,
        'blocking_count', v_blocking_count,
        'average_progress', v_avg_progress
    );

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', sess.id,
                'session_number', sess.session_number,
                'name', sess.name,
                'status', sess.status,
                'inventory_type', sess.inventory_type,
                'scope_mode', sess.scope_mode,
                'warehouse_name', w.name,
                'responsible_name', inventarios.user_display_name(sess.responsible_user_id),
                'task_count', sess.task_count,
                'task_completed_count', sess.task_completed_count,
                'blocking_incident_count', (
                    SELECT pg_catalog.count(*) FROM inventarios.incidents i
                    WHERE i.company_id = sess.company_id AND i.session_id = sess.id
                      AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW')
                ),
                'created_at', sess.created_at
            )
            ORDER BY
                CASE sess.status WHEN 'UNDER_REVIEW' THEN 1 WHEN 'COUNTING' THEN 2 ELSE 3 END,
                sess.created_at DESC
        )
    END
    INTO v_attention
    FROM (
        SELECT sess.*,
               (SELECT pg_catalog.count(*) FROM inventarios.tasks t
                WHERE t.company_id = sess.company_id AND t.session_id = sess.id
                  AND t.cancelled_at IS NULL AND t.superseded_at IS NULL) AS task_count,
               (SELECT pg_catalog.count(*) FROM inventarios.tasks t
                WHERE t.company_id = sess.company_id AND t.session_id = sess.id
                  AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
                  AND t.status = 'COMPLETED') AS task_completed_count
        FROM inventarios.sessions sess
        WHERE sess.company_id = p_company_id
          AND sess.status IN ('PREPARED','COUNTING','UNDER_REVIEW')
    ) sess
    LEFT JOIN adquisiciones.warehouses w ON w.id = sess.warehouse_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', i.id,
                'session_id', i.session_id,
                'session_number', s.session_number,
                'session_name', s.name,
                'category_code', i.category_code,
                'severity', i.severity,
                'status', i.status,
                'is_blocking', i.is_blocking,
                'affected_quantity', i.affected_quantity,
                'description', i.description,
                'reported_by_name', inventarios.user_display_name(i.reported_by),
                'reported_at', i.reported_at
            )
            ORDER BY i.reported_at DESC
        )
    END
    INTO v_alerts
    FROM (
        SELECT i.id, i.session_id, i.category_code, i.severity, i.status,
               i.is_blocking, i.affected_quantity, i.description, i.reported_by, i.reported_at
        FROM inventarios.incidents i
        JOIN inventarios.sessions s ON s.company_id = i.company_id AND s.id = i.session_id
        WHERE i.company_id = p_company_id
          AND s.status IN ('PREPARED','COUNTING','UNDER_REVIEW')
          AND i.status IN ('OPEN','UNDER_REVIEW')
        ORDER BY i.reported_at DESC
        LIMIT 8
    ) i
    JOIN inventarios.sessions s ON s.company_id = p_company_id AND s.id = i.session_id;

    RETURN pg_catalog.jsonb_build_object(
        'kpis', v_kpis,
        'attention_sessions', CASE WHEN v_attention IS NULL THEN '[]'::jsonb ELSE v_attention END,
        'recent_alerts', CASE WHEN v_alerts IS NULL THEN '[]'::jsonb ELSE v_alerts END
    );
END;
$$;
ALTER FUNCTION inventarios.get_inventory_dashboard_summary(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_dashboard_summary(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_dashboard_summary(uuid) TO authenticated;
