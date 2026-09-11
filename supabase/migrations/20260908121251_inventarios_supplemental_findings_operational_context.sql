-- Migration: 20260908090000_inventarios_supplemental_findings_operational_context.sql
-- Description: Contexto operacional minimo de una sesion SUPPLEMENTAL_FINDINGS
--              PREPARED. NO materializa session_product_scopes (se evita la
--              cobertura cartesiana producto x ubicacion); materializa
--              session_location_scopes y asegura la participacion activa
--              ADMINISTRATOR del SUPER_USUARIO. Reutiliza
--              inventarios.add_inventory_counting_zone_progressive para crear la
--              zona habilitada, la tarea PRIMARY ASSIGNED y la asignacion vigente
--              al mismo SUPER_USUARIO.
--
-- Reglas:
--   * solo SUPER_USUARIO con acceso a la empresa;
--   * la sesion ya debe estar PREPARED (snapshot COMPLETED + content_hash);
--   * el COUNTER de campana se resuelve (no se crea) entre los participantes
--     activos del propio actor; si no hay exactamente uno utilizable, se rechaza;
--   * NO se crean session_product_scopes: snapshot_products es el universo exacto
--     de productos permitidos y record_inventory_count valida snapshot_product_id
--     contra el snapshot de la zona;
--   * se materializan EXACTAMENTE las ubicaciones del snapshot;
--   * la relacion de ubicacion conserva el contrato:
--       snapshot_location.inventory_site_location_id -> inventory_site_locations
--       -> source_logistics_location_id -> session_location_scopes.location_id;
--   * la zona/tarea/asignacion se delegan a add_inventory_counting_zone_progressive;
--   * esta operacion NO inicia la sesion (sigue PREPARED), NO inicia tareas,
--     NO registra conteos y NO completa/aprueba la sesion;
--   * idempotente por clave; payload/contexto incompatible => rechazo sin
--     reconstruccion destructiva.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.setup_supplemental_findings_operational_context(
    p_company_id uuid,
    p_session_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_role_name text;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_response jsonb;
    v_campaign_id uuid;
    v_inventory_site_id uuid;
    v_warehouse_id uuid;
    v_session_status text;
    v_session_purpose text;
    v_campaign_status text;
    v_snapshot_id uuid;
    v_snapshot_status text;
    v_content_hash text;
    v_product_count bigint;
    v_location_count bigint;
    v_counter_participant_id uuid;
    v_counter_count bigint;
    v_admin_participant_id uuid;
    v_table_count bigint;
    v_location_ids uuid[];
    v_zone_resp jsonb;
    v_zone_id uuid;
    v_task_id uuid;
    v_assignment_id uuid;
    v_occurred_at timestamptz;
    v_scope_count bigint;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    -- ---------- Autorizacion: acceso a empresa + rol exacto SUPER_USUARIO ----------
    v_actor_id := inventarios.require_company_access(p_company_id);
    SELECT r.name INTO v_role_name
    FROM portal.users u
    JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = v_actor_id AND u.is_active = true;
    IF coalesce(v_role_name, '') <> 'SUPER_USUARIO' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo SUPER_USUARIO puede preparar el contexto operacional de la sesión de hallazgos complementarios.','retryable',false)::text;
    END IF;

    v_occurred_at := pg_catalog.now();

    -- ---------- Idempotencia ----------
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.setup_operational_context','company_id',p_company_id,
        'session_id',p_session_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.supplemental.setup_operational_context',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- ---------- Sesion (bloqueada) ----------
    SELECT s.campaign_id, s.inventory_site_id, s.warehouse_id, s.status, s.session_purpose
    INTO v_campaign_id, v_inventory_site_id, v_warehouse_id, v_session_status, v_session_purpose
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE OF s;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_purpose <> 'SUPPLEMENTAL_FINDINGS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión no es una sesión de hallazgos complementarios.','retryable',false)::text;
    END IF;
    IF v_campaign_id IS NULL OR v_inventory_site_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión no pertenece a una campaña con unidad.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'PREPARED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión debe estar PREPARED para crear su contexto operacional.','retryable',false,'status',v_session_status)::text;
    END IF;

    -- ---------- Campana IN_PROGRESS ----------
    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = v_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La campaña debe estar en IN_PROGRESS.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    -- ---------- Snapshot COMPLETED + hash ----------
    SELECT os.id, os.completion_status, os.content_hash
    INTO v_snapshot_id, v_snapshot_status, v_content_hash
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id;
    IF v_snapshot_id IS NULL OR v_snapshot_status <> 'COMPLETED' OR v_content_hash IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot operacional no está completado o no tiene hash.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_product_count
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id;
    SELECT pg_catalog.count(*) INTO v_location_count
    FROM inventarios.snapshot_locations sl
    WHERE sl.company_id = p_company_id AND sl.snapshot_id = v_snapshot_id;
    IF v_product_count < 1 OR v_location_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot no contiene productos ni ubicaciones congelados.','retryable',false)::text;
    END IF;

    -- ---------- Resolver COUNTER de campana del propio actor (no se crea) ----------
    SELECT pg_catalog.count(*) INTO v_counter_count
    FROM inventarios.inventory_campaign_participants icp
    JOIN portal.users u ON u.id = icp.user_id AND u.is_active = true AND u.deleted_at IS NULL
    JOIN core.user_company_access uca
      ON uca.user_id = icp.user_id AND uca.company_id = icp.company_id AND uca.is_active = true
    WHERE icp.company_id = p_company_id AND icp.campaign_id = v_campaign_id
      AND icp.user_id = v_actor_id
      AND icp.participant_role = 'COUNTER' AND icp.revoked_at IS NULL;
    IF v_counter_count <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El SUPER_USUARIO no tiene exactamente un rol COUNTER activo en la campaña.','retryable',false,'active_count',v_counter_count)::text;
    END IF;
    SELECT icp.id INTO v_counter_participant_id
    FROM inventarios.inventory_campaign_participants icp
    JOIN portal.users u ON u.id = icp.user_id AND u.is_active = true AND u.deleted_at IS NULL
    JOIN core.user_company_access uca
      ON uca.user_id = icp.user_id AND uca.company_id = icp.company_id AND uca.is_active = true
    WHERE icp.company_id = p_company_id AND icp.campaign_id = v_campaign_id
      AND icp.user_id = v_actor_id
      AND icp.participant_role = 'COUNTER' AND icp.revoked_at IS NULL
    LIMIT 1;

    -- ---------- Participacion administrativa de sesion (reutilizar o crear) ----------
    SELECT sp.id INTO v_admin_participant_id
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
      AND sp.user_id = v_actor_id AND sp.functional_role = 'ADMINISTRATOR'
      AND sp.active_from <= v_occurred_at AND sp.revoked_at IS NULL
    ORDER BY sp.active_from DESC, sp.id DESC
    LIMIT 1;
    IF v_admin_participant_id IS NULL THEN
        INSERT INTO inventarios.session_participants
            (company_id, session_id, user_id, functional_role, active_from, created_at, created_by)
        VALUES (p_company_id, p_session_id, v_actor_id, 'ADMINISTRATOR', v_occurred_at, v_occurred_at, v_actor_id)
        RETURNING id INTO v_admin_participant_id;
    END IF;

    -- ---------- session_location_scopes + ubicaciones de la zona ----------
    SELECT pg_catalog.array_agg(DISTINCT t.location_id) INTO v_location_ids
    FROM (
        SELECT DISTINCT isl.source_logistics_location_id AS location_id
        FROM inventarios.snapshot_locations sl
        JOIN inventarios.inventory_site_locations isl
          ON isl.company_id = sl.company_id AND isl.id = sl.inventory_site_location_id
        WHERE sl.company_id = p_company_id AND sl.snapshot_id = v_snapshot_id
          AND isl.source_logistics_location_id IS NOT NULL
    ) t;
    IF coalesce(pg_catalog.cardinality(v_location_ids), 0) < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot no contiene ubicaciones logísticas resolubles.','retryable',false)::text;
    END IF;

    INSERT INTO inventarios.session_location_scopes
        (company_id, session_id, location_id, inclusion_type, created_at, created_by)
    SELECT DISTINCT p_company_id, p_session_id, t.location_id, 'INCLUDED', v_occurred_at, v_actor_id
    FROM pg_catalog.unnest(v_location_ids) AS t(location_id)
    ON CONFLICT (company_id, session_id, location_id) DO NOTHING;

    SELECT pg_catalog.count(*) INTO v_scope_count
    FROM inventarios.session_location_scopes slc
    WHERE slc.company_id = p_company_id AND slc.session_id = p_session_id
      AND slc.inclusion_type = 'INCLUDED';

    -- ---------- Guarda de idempotencia: contexto ya configurado ----------
    -- Si la sesion ya tiene zonificada alguna de estas ubicaciones, el contexto
    -- operacional ya fue aplicado. Con clave distinta no se reconstruye: se
    -- rechaza para no duplicar zona/tarea/asignacion.
    SELECT pg_catalog.count(*) INTO v_table_count
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id
      AND szl.location_id = ANY(v_location_ids);
    IF v_table_count > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_ALREADY_CONFIGURED',
            DETAIL=pg_catalog.jsonb_build_object('message','El contexto operacional de la sesión ya está configurado.','retryable',false)::text;
    END IF;

    -- ---------- Zona + tarea + asignacion (reutiliza el RPC existente) ----------
    v_zone_resp := inventarios.add_inventory_counting_zone_progressive(
        p_company_id, v_campaign_id, p_session_id, v_counter_participant_id,
        'Hallazgos complementarios', v_location_ids, p_idempotency_key);
    v_zone_id := (v_zone_resp -> 'data' ->> 'zone_id')::uuid;
    v_task_id := (v_zone_resp -> 'data' ->> 'task_id')::uuid;
    v_assignment_id := (v_zone_resp -> 'data' ->> 'task_assignment_id')::uuid;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.setup_operational_context','entity_id',p_session_id,
        'state','PREPARED','version',1,'cycle_number',1,
        'assignment_id',v_assignment_id,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object(
            'session_id',p_session_id,'campaign_id',v_campaign_id,
            'inventory_site_id',v_inventory_site_id,'warehouse_id',v_warehouse_id,
            'snapshot_id',v_snapshot_id,'content_hash',v_content_hash,
            'administrator_participant_id',v_admin_participant_id,
            'counter_campaign_participant_id',v_counter_participant_id,
            'product_count',v_product_count,'location_count',v_location_count,
            'location_scope_count',v_scope_count,
            'zone_id',v_zone_id,'task_id',v_task_id,'task_assignment_id',v_assignment_id));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.setup_supplemental_findings_operational_context(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.setup_supplemental_findings_operational_context(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.setup_supplemental_findings_operational_context(uuid, uuid, uuid) TO authenticated, service_role;
