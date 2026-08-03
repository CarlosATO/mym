-- Migration: 20260803150200_inventarios_selected_coverage_guard.sql
-- Description: Fase 4I.2H. Guarda de cobertura producto x ubicacion para sesiones
--              con productos seleccionados (product_scope=SELECTED): una tarea no
--              puede completarse si existe una combinacion pendiente. Consulta de
--              cobertura para la app movil y la web.
-- Author: Assistant

-- ============================================================
-- 1. FUNCION INTERNA: verificar cobertura de una tarea (set-based)
--    Devuelve true si TODAS las combinaciones estan revisadas.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.task_selected_coverage_ok(
    p_company_id uuid,
    p_session_id uuid,
    p_task_id uuid,
    p_session_zone_id uuid,
    p_cycle integer
)
RETURNS boolean LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_missing bigint;
    v_is_selected boolean;
BEGIN
    -- Solo aplica a sesiones con productos seleccionados
    SELECT EXISTS (
        SELECT 1
        FROM inventarios.sessions s
        JOIN inventarios.inventory_campaigns ic
          ON ic.company_id = s.company_id AND ic.id = s.campaign_id
        WHERE s.company_id = p_company_id AND s.id = p_session_id
          AND ic.product_scope = 'SELECTED'
    ) INTO v_is_selected;

    IF NOT v_is_selected THEN
        RETURN true;
    END IF;

    -- Combinaciones pendientes: producto requerido x ubicacion de la zona
    -- sin una count_entry efectiva (no invalidada) en el ciclo vigente.
    SELECT pg_catalog.count(*) INTO v_missing
    FROM (
        SELECT sps.product_id, szl.snapshot_location_id
        FROM inventarios.session_product_scopes sps
        JOIN inventarios.session_zone_locations szl
          ON szl.company_id = sps.company_id
         AND szl.session_id = sps.session_id
         AND szl.session_zone_id = p_session_zone_id
        WHERE sps.company_id = p_company_id
          AND sps.session_id = p_session_id
          AND sps.inclusion_type = 'INCLUDED'
          AND sps.product_id IS NOT NULL
        EXCEPT
        SELECT ce.snapshot_product_id, ce.snapshot_location_id
        FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id
          AND ce.session_id = p_session_id
          AND ce.task_id = p_task_id
          AND ce.task_cycle = p_cycle
          AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL
    ) missing_combos;

    RETURN v_missing = 0;
END;
$$;

-- ============================================================
-- 2. GUARDA EN complete_inventory_task
--    (se inserta la validacion; la funcion se redefine completa)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.complete_inventory_task(
    p_company_id uuid, p_task_id uuid, p_expected_version integer, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    a uuid; p uuid; o jsonb; oi uuid; s uuid; z uuid; st text; v integer; c integer; ca uuid;
    ac bigint; ai uuid; au uuid; ap uuid; at timestamptz; payload jsonb; response jsonb;
    v_missing_count bigint;
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

    -- GUARDA DE COBERTURA: productos seleccionados x ubicaciones de la zona
    IF NOT inventarios.task_selected_coverage_ok(p_company_id, s, p_task_id, z, c) THEN
        SELECT pg_catalog.count(*) INTO v_missing_count
        FROM (
            SELECT sps.product_id, szl.snapshot_location_id
            FROM inventarios.session_product_scopes sps
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
$$;

-- ============================================================
-- 3. RPC DE CONSULTA DE COBERTURA
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_task_coverage(
    p_company_id uuid,
    p_task_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_session_id uuid;
    v_session_zone_id uuid;
    v_cycle integer;
    v_is_selected boolean;
    v_required bigint;
    v_reviewed bigint;
    v_pending bigint;
    v_required_products bigint;
    v_required_locations bigint;
    v_required_rows jsonb;
    v_reviewed_rows jsonb;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.tasks.read');

    SELECT t.session_id, t.session_zone_id, t.validation_cycle
    INTO v_session_id, v_session_zone_id, v_cycle
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.id = p_task_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La tarea no existe.','retryable',false)::text;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM inventarios.sessions s
        JOIN inventarios.inventory_campaigns ic
          ON ic.company_id = s.company_id AND ic.id = s.campaign_id
        WHERE s.company_id = p_company_id AND s.id = v_session_id
          AND ic.product_scope = 'SELECTED'
    ) INTO v_is_selected;

    IF NOT v_is_selected THEN
        RETURN pg_catalog.jsonb_build_object(
            'is_selected', false,
            'required', 0, 'reviewed', 0, 'pending', 0, 'progress', 100,
            'required_products', 0, 'required_locations', 0,
            'required_rows', '[]'::jsonb, 'reviewed_rows', '[]'::jsonb
        );
    END IF;

    SELECT pg_catalog.count(*) INTO v_required_products
    FROM inventarios.session_product_scopes sps
    WHERE sps.company_id = p_company_id AND sps.session_id = v_session_id
      AND sps.inclusion_type = 'INCLUDED' AND sps.product_id IS NOT NULL;

    SELECT pg_catalog.count(*) INTO v_required_locations
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id AND szl.session_id = v_session_id
      AND szl.session_zone_id = v_session_zone_id;

    SELECT pg_catalog.count(*) INTO v_required
    FROM (
        SELECT sps.product_id, szl.snapshot_location_id
        FROM inventarios.session_product_scopes sps
        JOIN inventarios.session_zone_locations szl
          ON szl.company_id = sps.company_id
         AND szl.session_id = sps.session_id
         AND szl.session_zone_id = v_session_zone_id
        WHERE sps.company_id = p_company_id
          AND sps.session_id = v_session_id
          AND sps.inclusion_type = 'INCLUDED'
          AND sps.product_id IS NOT NULL
    ) required_combos;

    SELECT pg_catalog.count(*) INTO v_reviewed
    FROM (
        SELECT DISTINCT ce.snapshot_product_id, ce.snapshot_location_id
        FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id
          AND ce.session_id = v_session_id
          AND ce.task_id = p_task_id
          AND ce.task_cycle = v_cycle
          AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL
    ) reviewed_combos;

    v_pending := CASE WHEN v_required > v_reviewed THEN v_required - v_reviewed ELSE 0 END;

    RETURN pg_catalog.jsonb_build_object(
        'is_selected', v_is_selected,
        'required', v_required, 'reviewed', v_reviewed, 'pending', v_pending,
        'progress', CASE WHEN v_required = 0 THEN 100 ELSE
            pg_catalog.round((v_reviewed::numeric / v_required::numeric) * 100, 1) END,
        'required_products', v_required_products,
        'required_locations', v_required_locations,
        'required_rows', '[]'::jsonb,
        'reviewed_rows', '[]'::jsonb
    );
END;
$$;

-- ============================================================
-- 4. INDICES PARA LA GUARDA
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_inventarios_product_scopes_session_included
    ON inventarios.session_product_scopes (company_id, session_id, inclusion_type, product_id)
    WHERE inclusion_type = 'INCLUDED';

CREATE INDEX IF NOT EXISTS idx_inventarios_zone_locations_session_zone
    ON inventarios.session_zone_locations (company_id, session_id, session_zone_id, snapshot_location_id);

CREATE INDEX IF NOT EXISTS idx_inventarios_counts_task_cycle_active
    ON inventarios.count_entries (company_id, session_id, task_id, task_cycle, snapshot_product_id, snapshot_location_id)
    WHERE invalidated_at IS NULL AND invalidated_by IS NULL AND invalidation_reason IS NULL;

-- ============================================================
-- 5. GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.task_selected_coverage_ok(uuid, uuid, uuid, uuid, integer) OWNER TO postgres;
ALTER FUNCTION inventarios.complete_inventory_task(uuid, uuid, integer, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.get_task_coverage(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.task_selected_coverage_ok(uuid, uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.complete_inventory_task(uuid, uuid, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_task_coverage(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.task_selected_coverage_ok(uuid, uuid, uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.complete_inventory_task(uuid, uuid, integer, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_task_coverage(uuid, uuid) TO authenticated;
