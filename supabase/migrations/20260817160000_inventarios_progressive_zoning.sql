-- Progressive zoning for open inventory sessions.
-- Scope remains the complete declared universe. Zone membership is operational
-- configuration and may grow while the session is PREPARED or COUNTING.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.prepare_inventory_session(
    p_company_id uuid,
    p_session_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_session_status text; v_scope_mode text; v_bsale_office_id integer;
    v_warehouse_id uuid; v_snapshot_id uuid; v_snapshot_status text;
    v_counter_count bigint; v_supervisor_count bigint; v_manager_count bigint;
    v_administrator_count bigint; v_zone_count bigint; v_task_count bigint;
    v_zone_without_location bigint; v_zone_without_task bigint;
    v_task_not_assigned bigint; v_task_without_assignment bigint;
    v_bad_assignment bigint; v_scope_location_count bigint;
    v_duplicate_location bigint; v_product_count bigint; v_variant_count bigint;
    v_hash text; v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
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
    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.session.prepare',
        'company_id',p_company_id,'session_id',p_session_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.prepare',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT s.status, s.scope_mode, s.bsale_office_id, s.warehouse_id,
           os.id, os.completion_status
    INTO v_session_status, v_scope_mode, v_bsale_office_id, v_warehouse_id,
         v_snapshot_id, v_snapshot_status
    FROM inventarios.sessions s
    JOIN inventarios.operational_snapshots os
      ON os.company_id = s.company_id AND os.session_id = s.id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE OF s, os;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status IN ('PREPARED','COUNTING','UNDER_REVIEW','APPROVED') THEN
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
          AND sp.functional_role IN ('ADMINISTRATOR','SUPERVISOR','MANAGER')
          AND sp.active_from <= pg_catalog.now() AND sp.revoked_at IS NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_INACTIVE',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes una participacion operacional activa en la jornada.','retryable',false)::text;
    END IF;

    SELECT count(*) FILTER (WHERE functional_role='COUNTER'),
           count(*) FILTER (WHERE functional_role='SUPERVISOR'),
           count(*) FILTER (WHERE functional_role='MANAGER'),
           count(*) FILTER (WHERE functional_role='ADMINISTRATOR')
    INTO v_counter_count, v_supervisor_count, v_manager_count, v_administrator_count
    FROM inventarios.session_participants
    WHERE company_id = p_company_id AND session_id = p_session_id
      AND active_from <= pg_catalog.now() AND revoked_at IS NULL;
    IF v_counter_count < 1 OR (v_administrator_count < 1 AND v_supervisor_count < 1 AND v_manager_count < 1) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada requiere al menos un COUNTER y un responsable operacional activos.','retryable',false,
                'counter_count',v_counter_count,'administrator_count',v_administrator_count,
                'supervisor_count',v_supervisor_count,'manager_count',v_manager_count)::text;
    END IF;

    SELECT count(*) INTO v_zone_count
    FROM inventarios.session_zones
    WHERE company_id = p_company_id AND session_id = p_session_id AND is_enabled;
    IF v_zone_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene zonas habilitadas.','retryable',false,'zone_count',0)::text;
    END IF;

    SELECT count(*) INTO v_zone_without_location
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.is_enabled
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.session_zone_locations szl
          WHERE szl.company_id = sz.company_id AND szl.session_id = sz.session_id
            AND szl.session_zone_id = sz.id);
    IF v_zone_without_location > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda zona debe tener al menos una ubicacion.','retryable',false,'zones_without_location',v_zone_without_location)::text;
    END IF;

    SELECT count(*) INTO v_zone_without_task
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.is_enabled
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.tasks t
          WHERE t.company_id = sz.company_id AND t.session_id = sz.session_id
            AND t.session_zone_id = sz.id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL);
    IF v_zone_without_task > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda zona debe tener al menos una tarea.','retryable',false,'zones_without_task',v_zone_without_task)::text;
    END IF;

    SELECT count(*) INTO v_task_count
    FROM inventarios.tasks
    WHERE company_id = p_company_id AND session_id = p_session_id
      AND cancelled_at IS NULL AND superseded_at IS NULL;
    IF v_task_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene tareas activas.','retryable',false,'task_count',0)::text;
    END IF;
    SELECT count(*) INTO v_task_not_assigned
    FROM inventarios.tasks
    WHERE company_id = p_company_id AND session_id = p_session_id
      AND cancelled_at IS NULL AND superseded_at IS NULL AND status <> 'ASSIGNED';
    IF v_task_not_assigned > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda tarea debe estar en estado ASSIGNED.','retryable',false,'tasks_not_assigned',v_task_not_assigned)::text;
    END IF;
    SELECT count(*) INTO v_task_without_assignment
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.task_assignments ta
          WHERE ta.company_id=t.company_id AND ta.task_id=t.id AND ta.released_at IS NULL);
    IF v_task_without_assignment > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda tarea debe tener una asignacion vigente.','retryable',false,'tasks_without_assignment',v_task_without_assignment)::text;
    END IF;
    SELECT count(*) INTO v_bad_assignment
    FROM inventarios.task_assignments ta
    JOIN inventarios.tasks t ON t.company_id=ta.company_id AND t.session_id=ta.session_id AND t.id=ta.task_id
    JOIN inventarios.session_participants sp ON sp.company_id=ta.company_id AND sp.session_id=ta.session_id AND sp.id=ta.session_participant_id
    WHERE ta.company_id=p_company_id AND ta.session_id=p_session_id AND ta.released_at IS NULL
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
      AND (sp.functional_role <> 'COUNTER' OR sp.revoked_at IS NOT NULL OR sp.active_from > pg_catalog.now()
           OR NOT EXISTS (SELECT 1 FROM core.user_company_access uca WHERE uca.user_id=sp.user_id AND uca.company_id=sp.company_id AND uca.is_active));
    IF v_bad_assignment > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda asignacion vigente debe corresponder a un participante operacional activo.','retryable',false,'bad_assignments',v_bad_assignment)::text;
    END IF;

    SELECT count(*) INTO v_scope_location_count
    FROM inventarios.session_location_scopes
    WHERE company_id=p_company_id AND session_id=p_session_id AND inclusion_type='INCLUDED';
    IF v_scope_location_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene ubicaciones en su alcance.','retryable',false,'scope_location_count',0)::text;
    END IF;
    SELECT count(*) - count(DISTINCT location_id) INTO v_duplicate_location
    FROM inventarios.session_zone_locations
    WHERE company_id=p_company_id AND session_id=p_session_id;
    IF v_duplicate_location > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Existen ubicaciones duplicadas en la jornada.','retryable',false,'duplicate_locations',v_duplicate_location)::text;
    END IF;

    -- Freeze the complete physical universe before the session becomes PREPARED.
    INSERT INTO inventarios.snapshot_locations (
        company_id, snapshot_id, location_id, warehouse_id, code, name, aisle, rack, level, position,
        is_active, created_at, created_by)
    SELECT slc.company_id, v_snapshot_id, l.id, l.warehouse_id, l.code, l.name, l.aisle, l.rack,
           l.level, l.position, l.is_active, v_occurred_at, v_actor_id
    FROM inventarios.session_location_scopes slc
    JOIN logistica.locations l ON l.id=slc.location_id
    WHERE slc.company_id=p_company_id AND slc.session_id=p_session_id
      AND slc.inclusion_type='INCLUDED' AND l.warehouse_id=v_warehouse_id
    ON CONFLICT (company_id, snapshot_id, location_id) DO NOTHING;

    DELETE FROM inventarios.snapshot_stocks WHERE company_id=p_company_id AND snapshot_id=v_snapshot_id;
    DELETE FROM inventarios.snapshot_products WHERE company_id=p_company_id AND snapshot_id=v_snapshot_id;
    IF v_scope_mode = 'PARTIAL' THEN
        SELECT count(*) INTO v_variant_count
        FROM inventarios.session_product_scopes sps
        JOIN integraciones.bsale_variants bv ON bv.company_id=sps.company_id AND bv.bsale_id=sps.bsale_variant_id
        WHERE sps.company_id=p_company_id AND sps.session_id=p_session_id AND sps.inclusion_type='INCLUDED'
          AND bv.state=0 AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code)<>'';
        INSERT INTO inventarios.snapshot_products (company_id,snapshot_id,bsale_variant_id,sku,barcode,name,created_at,created_by)
        SELECT sps.company_id,v_snapshot_id,bv.bsale_id,bv.code,bv.bar_code,coalesce(pg_catalog.btrim(bv.description),bv.code),v_occurred_at,v_actor_id
        FROM inventarios.session_product_scopes sps
        JOIN integraciones.bsale_variants bv ON bv.company_id=sps.company_id AND bv.bsale_id=sps.bsale_variant_id
        WHERE sps.company_id=p_company_id AND sps.session_id=p_session_id AND sps.inclusion_type='INCLUDED'
          AND bv.state=0 AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code)<>''
        ON CONFLICT (company_id,snapshot_id,bsale_variant_id) DO NOTHING;
    ELSE
        SELECT count(*) INTO v_variant_count FROM integraciones.bsale_variants bv
        WHERE bv.company_id=p_company_id AND bv.state=0 AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code)<>'';
        INSERT INTO inventarios.snapshot_products (company_id,snapshot_id,bsale_variant_id,sku,barcode,name,created_at,created_by)
        SELECT bv.company_id,v_snapshot_id,bv.bsale_id,bv.code,bv.bar_code,coalesce(pg_catalog.btrim(bv.description),bv.code),v_occurred_at,v_actor_id
        FROM integraciones.bsale_variants bv
        WHERE bv.company_id=p_company_id AND bv.state=0 AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code)<>''
        ON CONFLICT (company_id,snapshot_id,bsale_variant_id) DO NOTHING;
    END IF;
    SELECT count(*) INTO v_product_count FROM inventarios.snapshot_products
    WHERE company_id=p_company_id AND snapshot_id=v_snapshot_id;
    IF v_product_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot no pudo construirse con productos del catalogo Bsale.','retryable',false,'variant_count',v_variant_count)::text;
    END IF;
    INSERT INTO inventarios.snapshot_stocks (company_id,snapshot_id,snapshot_product_id,office_id,theoretical_quantity,source_sync_run_id,source_synced_at,created_at,created_by)
    SELECT sp.company_id,sp.snapshot_id,sp.id,v_bsale_office_id,bsc.quantity_available,bsc.bsale_sync_run_id,bsc.synced_at,v_occurred_at,v_actor_id
    FROM inventarios.snapshot_products sp
    JOIN integraciones.bsale_stock_current bsc ON bsc.company_id=sp.company_id AND bsc.variant_id=sp.bsale_variant_id AND bsc.office_id=v_bsale_office_id
    WHERE sp.company_id=p_company_id AND sp.snapshot_id=v_snapshot_id AND bsc.quantity_available>=0
    ON CONFLICT (company_id,snapshot_id,snapshot_product_id,office_id) DO NOTHING;

    -- Configuration is intentionally excluded. The snapshot fingerprint covers only
    -- the frozen product, stock, and physical-location universe.
    SELECT pg_catalog.encode(extensions.digest(pg_catalog.convert_to(pg_catalog.string_agg(t.line,E'\n' ORDER BY t.line),'UTF8'),'sha256'),'hex')
    INTO v_hash
    FROM (
        SELECT 'P:'||sp.id::text AS line FROM inventarios.snapshot_products sp WHERE sp.company_id=p_company_id AND sp.snapshot_id=v_snapshot_id
        UNION ALL SELECT 'S:'||ss.id::text FROM inventarios.snapshot_stocks ss WHERE ss.company_id=p_company_id AND ss.snapshot_id=v_snapshot_id
        UNION ALL SELECT 'L:'||sl.id::text FROM inventarios.snapshot_locations sl WHERE sl.company_id=p_company_id AND sl.snapshot_id=v_snapshot_id
    ) t;
    UPDATE inventarios.operational_snapshots SET completion_status='COMPLETED',content_hash=v_hash,captured_at=v_occurred_at,captured_by=v_actor_id
    WHERE company_id=p_company_id AND id=v_snapshot_id;
    UPDATE inventarios.sessions SET status='PREPARED',prepared_at=v_occurred_at,updated_at=v_occurred_at,updated_by=v_actor_id
    WHERE company_id=p_company_id AND id=p_session_id AND status='DRAFT';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    v_response := pg_catalog.jsonb_build_object('operation','inventarios.session.prepare','entity_id',p_session_id,
        'state','PREPARED','version',NULL::integer,'cycle_number',NULL::integer,'assignment_id',NULL::uuid,
        'event_id',NULL::uuid,'replayed',false,'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('snapshot_id',v_snapshot_id,'completion_status','COMPLETED',
            'content_hash',v_hash,'prepared_at',v_occurred_at,'product_count',v_product_count,
            'variant_count',v_variant_count,'zone_count',v_zone_count,'task_count',v_task_count,
            'scope_location_count',v_scope_location_count,'counter_count',v_counter_count));
    RETURN inventarios.complete_idempotent_operation(p_company_id,v_operation_id,p_session_id,v_response);
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.add_inventory_counting_zone_progressive(
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
    v_actor_id uuid; v_campaign_status text; v_session_status text; v_session_campaign_id uuid;
    v_warehouse_id uuid; v_snapshot_id uuid; v_snapshot_status text;
    v_user_id uuid; v_role text; v_participant_id uuid; v_scope_id uuid;
    v_zone_id uuid; v_zone_code text; v_zone_total bigint; v_zone_enabled bigint;
    v_task_id uuid; v_assignment_id uuid; v_snapshot_location_id uuid; v_idx integer;
    v_zone_name text := pg_catalog.btrim(p_zone_name); v_occurred_at timestamptz := pg_catalog.now();
    v_operation jsonb; v_operation_id uuid; v_payload jsonb; v_response jsonb;
    v_location_ids uuid[];
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_session_id IS NULL OR p_campaign_participant_id IS NULL
       OR p_idempotency_key IS NULL OR v_zone_name IS NULL OR v_zone_name='' OR pg_catalog.char_length(v_zone_name)>200
       OR p_location_ids IS NULL OR pg_catalog.cardinality(p_location_ids)<1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    SELECT pg_catalog.array_agg(DISTINCT x ORDER BY x) INTO v_location_ids FROM pg_catalog.unnest(p_location_ids) x;
    IF pg_catalog.cardinality(v_location_ids) <> pg_catalog.cardinality(p_location_ids) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_DUPLICATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Las ubicaciones no pueden repetirse ni estar vacias.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id,'inventarios.sessions.read');
    PERFORM inventarios.require_active_session_participant(p_company_id,p_session_id,v_actor_id,ARRAY['ADMINISTRATOR','SUPERVISOR','MANAGER']);
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.add_inventory_counting_zone_progressive'),pg_catalog.hashtext(p_company_id::text||':'||p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.counting_zone.add_progressive','company_id',p_company_id,'campaign_id',p_campaign_id,'session_id',p_session_id,'campaign_participant_id',p_campaign_participant_id,'zone_name',v_zone_name,'location_ids',v_location_ids);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.counting_zone.add_progressive',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation->>'mode'='REPLAY' THEN RETURN v_operation->'response_payload'; END IF;
    v_operation_id := (v_operation->>'operation_id')::uuid;

    SELECT status INTO v_campaign_status FROM inventarios.inventory_campaigns WHERE company_id=p_company_id AND id=p_campaign_id FOR UPDATE;
    IF v_campaign_status IS NULL OR v_campaign_status NOT IN ('DRAFT','IN_PROGRESS') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_OPEN',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario ya no admite nuevas zonas.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    SELECT status, campaign_id, warehouse_id INTO v_session_status,v_session_campaign_id,v_warehouse_id
    FROM inventarios.sessions WHERE company_id=p_company_id AND id=p_session_id FOR UPDATE;
    IF NOT FOUND OR v_session_campaign_id IS DISTINCT FROM p_campaign_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_CAMPAIGN_MISMATCH',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no pertenece al inventario.','retryable',false)::text;
    END IF;
    IF v_session_status NOT IN ('PREPARED','COUNTING') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_OPEN',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no admite nuevas zonas en su estado actual.','retryable',false,'status',v_session_status)::text;
    END IF;
    SELECT id, completion_status INTO v_snapshot_id,v_snapshot_status FROM inventarios.operational_snapshots
    WHERE company_id=p_company_id AND session_id=p_session_id;
    IF v_snapshot_status <> 'COMPLETED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot no esta completado.','retryable',false)::text;
    END IF;
    SELECT icp.user_id,icp.participant_role INTO v_user_id,v_role
    FROM inventarios.inventory_campaign_participants icp
    JOIN portal.users u ON u.id=icp.user_id
    JOIN core.user_company_access uca ON uca.user_id=icp.user_id AND uca.company_id=icp.company_id AND uca.is_active
    WHERE icp.company_id=p_company_id AND icp.campaign_id=p_campaign_id AND icp.id=p_campaign_participant_id
      AND icp.participant_role='COUNTER' AND icp.revoked_at IS NULL AND u.is_active AND u.deleted_at IS NULL;
    IF v_user_id IS NULL OR v_role <> 'COUNTER' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El responsable seleccionado no tiene un rol de Contador activo.','retryable',false)::text;
    END IF;
    FOR v_idx IN 1..pg_catalog.cardinality(v_location_ids) LOOP
        SELECT slc.id INTO v_scope_id FROM inventarios.session_location_scopes slc
        JOIN logistica.locations l ON l.id=slc.location_id
        WHERE slc.company_id=p_company_id AND slc.session_id=p_session_id AND slc.location_id=v_location_ids[v_idx]
          AND slc.inclusion_type='INCLUDED' AND l.is_active AND l.warehouse_id=v_warehouse_id;
        IF v_scope_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_NOT_IN_SCOPE',
                DETAIL=pg_catalog.jsonb_build_object('message','Una ubicacion no pertenece al alcance activo de la jornada.','retryable',false,'location_id',v_location_ids[v_idx])::text;
        END IF;
        IF EXISTS (SELECT 1 FROM inventarios.session_zone_locations WHERE company_id=p_company_id AND session_id=p_session_id AND location_id=v_location_ids[v_idx]) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_ALREADY_ASSIGNED',
                DETAIL=pg_catalog.jsonb_build_object('message','Una de las ubicaciones ya pertenece a una zona.','retryable',false,'location_id',v_location_ids[v_idx])::text;
        END IF;
        SELECT id INTO v_snapshot_location_id FROM inventarios.snapshot_locations
        WHERE company_id=p_company_id AND snapshot_id=v_snapshot_id AND location_id=v_location_ids[v_idx];
        IF v_snapshot_location_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_LOCATION_MISSING',
                DETAIL=pg_catalog.jsonb_build_object('message','La ubicacion no existe en el snapshot fisico congelado.','retryable',false,'location_id',v_location_ids[v_idx])::text;
        END IF;
    END LOOP;
    SELECT id INTO v_participant_id FROM inventarios.session_participants
    WHERE company_id=p_company_id AND session_id=p_session_id AND user_id=v_user_id AND functional_role='COUNTER'
      AND active_from<=v_occurred_at AND revoked_at IS NULL;
    IF v_participant_id IS NULL THEN
        INSERT INTO inventarios.session_participants(company_id,session_id,user_id,functional_role,active_from,created_at,created_by)
        VALUES(p_company_id,p_session_id,v_user_id,'COUNTER',v_occurred_at,v_occurred_at,v_actor_id) RETURNING id INTO v_participant_id;
    END IF;
    SELECT count(*) INTO v_zone_total FROM inventarios.session_zones WHERE company_id=p_company_id AND session_id=p_session_id;
    SELECT count(*) INTO v_zone_enabled FROM inventarios.session_zones WHERE company_id=p_company_id AND session_id=p_session_id AND is_enabled;
    v_zone_code := 'Z'||(v_zone_total+1)::text;
    INSERT INTO inventarios.session_zones(company_id,session_id,snapshot_id,zone_code,scan_code,display_name,priority,is_enabled,created_at,created_by)
    VALUES(p_company_id,p_session_id,v_snapshot_id,v_zone_code,v_zone_code,v_zone_name,v_zone_total::integer,true,v_occurred_at,v_actor_id)
    RETURNING id INTO v_zone_id;
    FOR v_idx IN 1..pg_catalog.cardinality(v_location_ids) LOOP
        SELECT id INTO v_scope_id FROM inventarios.session_location_scopes WHERE company_id=p_company_id AND session_id=p_session_id AND location_id=v_location_ids[v_idx];
        SELECT id INTO v_snapshot_location_id FROM inventarios.snapshot_locations WHERE company_id=p_company_id AND snapshot_id=v_snapshot_id AND location_id=v_location_ids[v_idx];
        INSERT INTO inventarios.session_zone_locations(company_id,session_id,snapshot_id,session_zone_id,session_location_scope_id,snapshot_location_id,location_id,created_at,created_by)
        VALUES(p_company_id,p_session_id,v_snapshot_id,v_zone_id,v_scope_id,v_snapshot_location_id,v_location_ids[v_idx],v_occurred_at,v_actor_id);
    END LOOP;
    INSERT INTO inventarios.tasks(company_id,session_id,session_zone_id,task_kind,status,version,validation_cycle,creation_idempotency_key,created_at,created_by)
    VALUES(p_company_id,p_session_id,v_zone_id,'PRIMARY','ASSIGNED',1,1,p_idempotency_key,v_occurred_at,v_actor_id) RETURNING id INTO v_task_id;
    INSERT INTO inventarios.task_assignments(company_id,session_id,task_id,session_participant_id,user_id,assigned_at,assigned_by,created_at,created_by)
    VALUES(p_company_id,p_session_id,v_task_id,v_participant_id,v_user_id,v_occurred_at,v_actor_id,v_occurred_at,v_actor_id) RETURNING id INTO v_assignment_id;
    UPDATE inventarios.tasks SET current_assignment_id=v_assignment_id,updated_at=v_occurred_at,updated_by=v_actor_id WHERE company_id=p_company_id AND id=v_task_id;
    v_response := pg_catalog.jsonb_build_object('operation','inventarios.counting_zone.add_progressive','entity_id',v_zone_id,'state','ASSIGNED','version',1,'cycle_number',1,'assignment_id',v_assignment_id,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_occurred_at,'data',pg_catalog.jsonb_build_object('session_id',p_session_id,'zone_id',v_zone_id,'zone_code',v_zone_code,'zone_name',v_zone_name,'session_participant_id',v_participant_id,'campaign_participant_id',p_campaign_participant_id,'user_id',v_user_id,'task_id',v_task_id,'task_assignment_id',v_assignment_id,'location_ids',v_location_ids,'location_count',pg_catalog.cardinality(v_location_ids),'snapshot_id',v_snapshot_id));
    RETURN inventarios.complete_idempotent_operation(p_company_id,v_operation_id,v_zone_id,v_response);
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios._guard_session_scope_coverage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE v_unzoned bigint; v_unvisited bigint;
BEGIN
    IF NEW.status IN ('UNDER_REVIEW','APPROVED') AND OLD.status IS DISTINCT FROM NEW.status THEN
        SELECT count(*) INTO v_unzoned
        FROM inventarios.session_location_scopes slc
        WHERE slc.company_id=NEW.company_id AND slc.session_id=NEW.id AND slc.inclusion_type='INCLUDED'
          AND NOT EXISTS (SELECT 1 FROM inventarios.session_zone_locations szl WHERE szl.company_id=slc.company_id AND szl.session_id=slc.session_id AND szl.location_id=slc.location_id);
        IF v_unzoned > 0 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SCOPE_INCOMPLETE',
                DETAIL=pg_catalog.jsonb_build_object('message','La seccion aun tiene ubicaciones del alcance sin zonificar.','retryable',false,'unzoned_locations',v_unzoned)::text;
        END IF;
        SELECT count(*) INTO v_unvisited
        FROM inventarios.session_zone_locations szl
        WHERE szl.company_id=NEW.company_id AND szl.session_id=NEW.id
          AND NOT EXISTS (SELECT 1 FROM inventarios.task_locations tl WHERE tl.company_id=szl.company_id AND tl.session_id=szl.session_id AND tl.session_zone_location_id=szl.id);
        IF v_unvisited > 0 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_COVERAGE_INCOMPLETE',
                DETAIL=pg_catalog.jsonb_build_object('message','La seccion aun tiene ubicaciones zonificadas sin visitar.','retryable',false,'unvisited_locations',v_unvisited)::text;
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION inventarios.prepare_inventory_session(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.add_inventory_counting_zone_progressive(uuid,uuid,uuid,uuid,text,uuid[],uuid) OWNER TO postgres;
ALTER FUNCTION inventarios._guard_session_scope_coverage() OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.add_inventory_counting_zone_progressive(uuid,uuid,uuid,uuid,text,uuid[],uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.add_inventory_counting_zone_progressive(uuid,uuid,uuid,uuid,text,uuid[],uuid) TO authenticated;
REVOKE ALL ON FUNCTION inventarios._guard_session_scope_coverage() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_inventarios_session_scope_coverage ON inventarios.sessions;
CREATE CONSTRAINT TRIGGER trg_inventarios_session_scope_coverage
AFTER UPDATE OF status ON inventarios.sessions
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION inventarios._guard_session_scope_coverage();

COMMIT;
