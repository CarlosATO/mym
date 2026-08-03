-- Migration: 20260803083000_inventarios_phase_04g2_prepare_session.sql
-- Description: Fase 4G.2. Transicion DRAFT -> PREPARED: valida configuracion
--              completa, construye snapshot_products desde la fuente Bsale,
--              marca el snapshot COMPLETED con content_hash y congela la jornada.
-- Author: Assistant

-- ============================================================
-- 1. RPC: prepare_inventory_session
--    Permiso: inventarios.sessions.configure
--    Rol contextual: ADMINISTRATOR activo de la jornada
-- ============================================================
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
               bv.bar_code, pg_catalog.coalesce(pg_catalog.btrim(bv.description), bv.code),
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
               bv.bar_code, pg_catalog.coalesce(pg_catalog.btrim(bv.description), bv.code),
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

-- ============================================================
-- 2. OWNER, REVOKES Y GRANT
-- ============================================================
ALTER FUNCTION inventarios.prepare_inventory_session(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.prepare_inventory_session(uuid, uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.prepare_inventory_session(uuid, uuid, uuid) TO authenticated;
