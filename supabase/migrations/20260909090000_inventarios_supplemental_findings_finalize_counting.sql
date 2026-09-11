-- Migration: 20260909090000_inventarios_supplemental_findings_finalize_counting.sql
-- Description: Cierre operativo de una sesión SUPPLEMENTAL_FINDINGS que ya tiene
--              todos sus hallazgos CONSOLIDATED registrados como count_entries WEB.
--
-- Alcance mínimo aprobado:
--   * SOLO SUPER_USUARIO con acceso a la empresa;
--   * valida el contexto (campaña IN_PROGRESS, sesión COUNTING, snapshot COMPLETED
--     + content_hash, una única tarea PRIMARY activa IN_PROGRESS, asignación y
--     COUNTER del actor, session_product_scopes = 0);
--   * exige que TODOS los hallazgos CONSOLIDATED del lote estén vinculados a su
--     count_entry vigente (INV_SUPPLEMENTAL_COUNTS_INCOMPLETE si falta alguno);
--   * cierra CADA ubicación real de session_zone_locations usando el contrato
--     oficial (open_my_counting_location + complete_my_counting_location /
--     resolve_my_counting_location_empty). NUNCA OPENED_BY_MISTAKE;
--   * completa la tarea con inventarios.complete_inventory_task (pasa
--     task_selected_coverage_ok, sin inventar session_product_scopes);
--   * lleva la sesión a UNDER_REVIEW con inventarios.close_inventory_session;
--   * NO valida la tarea (guardas de validación exigen un SUPERVISOR que no forma
--     parte de este bloque y close_inventory_session ya deja la sesión en
--     UNDER_REVIEW sin requerirla), NO aprueba la sesión, NO crea official_versions,
--     NO genera reconciliación y NO cierra la campaña;
--   * idempotente por p_idempotency_key con claves internas determinísticas
--     (supplemental_web_record_internal_key). No se usa gen_random_uuid().
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.finalize_inventory_campaign_supplemental_findings_counting(
    p_company_id uuid,
    p_supplemental_session_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_occurred_at timestamptz;
    v_campaign_id uuid;
    v_inventory_site_id uuid;
    v_snapshot_id uuid;
    v_snapshot_status text;
    v_content_hash text;
    v_session_status text;
    v_session_purpose text;
    v_campaign_status text;
    v_task_count bigint;
    v_task_id uuid;
    v_task_status text;
    v_task_version integer;
    v_task_cycle integer;
    v_task_session_zone_id uuid;
    v_assignment_id uuid;
    v_assignment_user_id uuid;
    v_assignment_participant_id uuid;
    v_counter_count bigint;
    v_counter_participant_id uuid;
    v_scope_count bigint;
    v_findings_total bigint;
    v_findings_recorded bigint;
    v_findings_valid bigint;
    v_loc_count bigint;
    v_closed_loc_count bigint := 0;
    v_ce_count bigint;
    v_phys_sum numeric(14,3) := 0;
    v_task_status_final text;
    v_session_status_final text;
    v_loc record;
    v_has_effective boolean;
    v_key_location_open uuid;
    v_key_location_close uuid;
    v_key_task_complete uuid;
    v_key_session_review uuid;
    v_open_resp jsonb;
    v_close_resp jsonb;
    v_task_resp jsonb;
    v_session_resp jsonb;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_supplemental_session_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_supplemental_findings_super_user(p_company_id);
    v_occurred_at := pg_catalog.now();

    -- ---------- Idempotencia del lote ----------
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.finalize_counting',
        'company_id', p_company_id,
        'session_id', p_supplemental_session_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id, 'inventarios.supplemental.finalize_counting', p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- ---------- Sesión (bloqueada) ----------
    SELECT s.status, s.session_purpose, s.campaign_id, s.inventory_site_id
    INTO v_session_status, v_session_purpose, v_campaign_id, v_inventory_site_id
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_supplemental_session_id
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
    IF v_session_status <> 'COUNTING' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión debe estar COUNTING para cerrar el conteo.','retryable',false,'status',v_session_status)::text;
    END IF;

    -- ---------- Campaña IN_PROGRESS ----------
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

    -- ---------- Snapshot COMPLETED + content_hash ----------
    SELECT os.id, os.completion_status, os.content_hash
    INTO v_snapshot_id, v_snapshot_status, v_content_hash
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_supplemental_session_id;
    IF v_snapshot_id IS NULL OR v_snapshot_status <> 'COMPLETED' OR v_content_hash IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot operacional no está completado o no tiene hash de integridad.','retryable',false)::text;
    END IF;

    -- ---------- Exactamente una tarea PRIMARY activa ----------
    SELECT pg_catalog.count(*) INTO v_task_count
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_supplemental_session_id
      AND t.task_kind = 'PRIMARY'
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;
    IF v_task_count <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión debe tener exactamente una tarea PRIMARY activa.','retryable',false,'task_count',v_task_count)::text;
    END IF;

    SELECT t.id, t.status, t.version, t.validation_cycle, t.session_zone_id, t.current_assignment_id
    INTO v_task_id, v_task_status, v_task_version, v_task_cycle, v_task_session_zone_id, v_assignment_id
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_supplemental_session_id
      AND t.task_kind = 'PRIMARY'
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL
    FOR UPDATE OF t;

    IF v_task_session_zone_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La tarea no tiene zona asociada.','retryable',false)::text;
    END IF;
    IF v_task_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La tarea debe estar IN_PROGRESS para cerrar el conteo.','retryable',false,'status',v_task_status)::text;
    END IF;
    IF v_assignment_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','La tarea no tiene una asignación vigente.','retryable',false)::text;
    END IF;

    -- ---------- La asignación vigente pertenece al actor ----------
    SELECT ta.user_id, ta.session_participant_id
    INTO v_assignment_user_id, v_assignment_participant_id
    FROM inventarios.task_assignments ta
    WHERE ta.company_id = p_company_id
      AND ta.session_id = p_supplemental_session_id
      AND ta.task_id = v_task_id
      AND ta.id = v_assignment_id
      AND ta.released_at IS NULL;
    IF NOT FOUND OR v_assignment_user_id IS NULL OR v_assignment_user_id IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes una asignación vigente para esta tarea.','retryable',false)::text;
    END IF;

    -- ---------- El actor tiene un session participant COUNTER activo ----------
    SELECT pg_catalog.count(*) INTO v_counter_count
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_supplemental_session_id
      AND sp.user_id = v_actor_id AND sp.functional_role = 'COUNTER'
      AND sp.active_from <= v_occurred_at AND sp.revoked_at IS NULL;
    IF v_counter_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión no tiene un COUNTER activo del actor.','retryable',false,'counter_count',v_counter_count)::text;
    END IF;
    SELECT sp.id INTO v_counter_participant_id
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_supplemental_session_id
      AND sp.user_id = v_actor_id AND sp.functional_role = 'COUNTER'
      AND sp.active_from <= v_occurred_at AND sp.revoked_at IS NULL
    ORDER BY sp.id LIMIT 1;

    -- ---------- session_product_scopes = 0 ----------
    SELECT pg_catalog.count(*) INTO v_scope_count
    FROM inventarios.session_product_scopes slc
    WHERE slc.company_id = p_company_id AND slc.session_id = p_supplemental_session_id;
    IF v_scope_count <> 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión no debe tener session_product_scopes materializados.','retryable',false,'product_scope_count',v_scope_count)::text;
    END IF;

    -- ---------- PRECONDICIÓN: todos los hallazgos CONSOLIDATED contados ----------
    SELECT pg_catalog.count(*) INTO v_findings_total
    FROM inventarios.inventory_campaign_supplemental_findings f
    WHERE f.company_id = p_company_id
      AND f.supplemental_session_id = p_supplemental_session_id
      AND f.status = 'CONSOLIDATED';

    IF v_findings_total = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_COUNTS_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El lote no tiene hallazgos CONSOLIDATED para cerrar.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_findings_recorded
    FROM inventarios.inventory_campaign_supplemental_findings f
    WHERE f.company_id = p_company_id
      AND f.supplemental_session_id = p_supplemental_session_id
      AND f.status = 'CONSOLIDATED'
      AND f.count_entry_id IS NOT NULL
      AND f.count_recorded_at IS NOT NULL
      AND f.count_recorded_by IS NOT NULL;
    IF v_findings_recorded <> v_findings_total THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_COUNTS_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El lote tiene hallazgos CONSOLIDATED sin registrar; no se completa parcialmente.','retryable',false,
                'consolidated_count',v_findings_total,'recorded_count',v_findings_recorded)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_findings_valid
    FROM inventarios.inventory_campaign_supplemental_findings f
    JOIN inventarios.count_entries ce ON ce.id = f.count_entry_id
    WHERE f.company_id = p_company_id
      AND f.supplemental_session_id = p_supplemental_session_id
      AND f.status = 'CONSOLIDATED'
      AND ce.company_id = f.company_id
      AND ce.session_id = p_supplemental_session_id
      AND ce.task_id = v_task_id
      AND ce.snapshot_id = v_snapshot_id
      AND ce.invalidated_at IS NULL
      AND ce.invalidated_by IS NULL
      AND ce.invalidation_reason IS NULL
      AND ce.physical_quantity = f.quantity;
    IF v_findings_valid <> v_findings_total THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_COUNTS_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','No todos los count_entries vinculados permanecen vigentes.','retryable',false,
                'consolidated_count',v_findings_total,'valid_count',v_findings_valid)::text;
    END IF;

    -- ---------- Ubicaciones reales del lote ----------
    SELECT pg_catalog.count(*) INTO v_loc_count
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id
      AND szl.session_id = p_supplemental_session_id
      AND szl.session_zone_id = v_task_session_zone_id;
    IF v_loc_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El lote no tiene ubicaciones asignadas para cerrar.','retryable',false,'location_count',v_loc_count)::text;
    END IF;

    FOR v_loc IN
        SELECT szl.id AS szl_id, szl.location_id, szl.snapshot_location_id
        FROM inventarios.session_zone_locations szl
        WHERE szl.company_id = p_company_id
          AND szl.session_id = p_supplemental_session_id
          AND szl.session_zone_id = v_task_session_zone_id
        ORDER BY szl.id
    LOOP
        SELECT EXISTS (
            SELECT 1
            FROM inventarios.count_entries ce
            WHERE ce.company_id = p_company_id
              AND ce.session_id = p_supplemental_session_id
              AND ce.task_id = v_task_id
              AND ce.task_cycle = v_task_cycle
              AND ce.snapshot_location_id = v_loc.snapshot_location_id
              AND ce.invalidated_at IS NULL
              AND ce.invalidated_by IS NULL
              AND ce.invalidation_reason IS NULL
              AND ce.physical_quantity = ce.available_quantity + ce.damaged_quantity
                  + ce.expired_quantity + ce.blocked_quantity + ce.other_unavailable_quantity
        ) INTO v_has_effective;

        v_key_location_open := inventarios.supplemental_web_record_internal_key(
            p_idempotency_key, 'location.open:' || v_loc.szl_id::text);
        v_open_resp := inventarios.open_my_counting_location(
            v_task_session_zone_id, v_loc.location_id, v_key_location_open);
        IF (v_open_resp ->> 'state') <> 'OPEN' THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_NOT_OPEN',
                DETAIL=pg_catalog.jsonb_build_object('message','No se pudo abrir la ubicación del lote.','retryable',false,
                    'szl_id',v_loc.szl_id,'state',v_open_resp ->> 'state')::text;
        END IF;

        v_key_location_close := inventarios.supplemental_web_record_internal_key(
            p_idempotency_key, 'location.close:' || v_loc.szl_id::text);
        IF v_has_effective THEN
            v_close_resp := inventarios.complete_my_counting_location(
                v_task_session_zone_id, v_loc.location_id, v_key_location_close);
        ELSE
            v_close_resp := inventarios.resolve_my_counting_location_empty(
                v_task_session_zone_id, v_loc.location_id, v_key_location_close);
        END IF;
        IF (v_close_resp ->> 'state') <> 'CLOSED'
           OR (v_close_resp -> 'data' ->> 'resolution_status') IS DISTINCT FROM (
               CASE WHEN v_has_effective THEN 'COUNTED' ELSE 'EMPTY_REVIEWED' END) THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_RESOLUTION_INVALID',
                DETAIL=pg_catalog.jsonb_build_object('message','La ubicación no quedó cerrada con la resolución esperada.','retryable',false,
                    'szl_id',v_loc.szl_id,'state',v_close_resp ->> 'state',
                    'resolution_status',v_close_resp -> 'data' ->> 'resolution_status')::text;
        END IF;

        v_closed_loc_count := v_closed_loc_count + 1;
    END LOOP;

    -- ---------- Completar tarea ----------
    v_key_task_complete := inventarios.supplemental_web_record_internal_key(p_idempotency_key, 'task.complete');
    v_task_resp := inventarios.complete_inventory_task(
        p_company_id, v_task_id, v_task_version, v_key_task_complete);
    IF (v_task_resp ->> 'state') <> 'COMPLETED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','No se pudo completar la tarea del lote.','retryable',false,'state',v_task_resp ->> 'state')::text;
    END IF;

    -- ---------- Avanzar sesión a revisión (UNDER_REVIEW) ----------
    v_key_session_review := inventarios.supplemental_web_record_internal_key(p_idempotency_key, 'session.review');
    v_session_resp := inventarios.close_inventory_session(
        p_company_id, p_supplemental_session_id, v_key_session_review);
    IF (v_session_resp ->> 'state') <> 'UNDER_REVIEW' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','No se pudo llevar la sesión a revisión.','retryable',false,'state',v_session_resp ->> 'state')::text;
    END IF;

    -- ---------- Estado final ----------
    SELECT status INTO v_session_status_final
    FROM inventarios.sessions
    WHERE company_id = p_company_id AND id = p_supplemental_session_id;
    SELECT status INTO v_task_status_final
    FROM inventarios.tasks
    WHERE company_id = p_company_id AND id = v_task_id;

    SELECT pg_catalog.count(*), coalesce(pg_catalog.sum(physical_quantity), 0)
    INTO v_ce_count, v_phys_sum
    FROM inventarios.count_entries
    WHERE company_id = p_company_id AND session_id = p_supplemental_session_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.supplemental.finalize_counting',
        'entity_id', p_supplemental_session_id,
        'state', v_session_status_final,
        'version', 1,
        'cycle_number', v_task_cycle,
        'assignment_id', v_assignment_id,
        'event_id', NULL::uuid,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'supplemental_session_id', p_supplemental_session_id,
            'supplemental_snapshot_id', v_snapshot_id,
            'task_id', v_task_id,
            'closed_location_count', v_closed_loc_count,
            'count_entry_count', v_ce_count,
            'physical_quantity_sum', v_phys_sum,
            'task_status', v_task_status_final,
            'content_hash', v_content_hash,
            'replayed', false));

    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_supplemental_session_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.finalize_inventory_campaign_supplemental_findings_counting(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.finalize_inventory_campaign_supplemental_findings_counting(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.finalize_inventory_campaign_supplemental_findings_counting(uuid, uuid, uuid) TO authenticated, service_role;
