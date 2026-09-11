-- Migration: 20260908150000_inventarios_supplemental_findings_web_record.sql
-- Description: Registro automático WEB de los hallazgos CONSOLIDATED de un lote
--              SUPPLEMENTAL_FINDINGS PREPARED como count_entries mediante el motor
--              oficial inventarios.record_inventory_count(...).
--
-- Alcance mínimo aprobado:
--   * se reutiliza el motor oficial (start_inventory_session, start_inventory_task,
--     record_inventory_count); NO se modifica record_inventory_count;
--   * NO se hace INSERT directo en count_entries;
--   * NO se completa tarea, NO se valida, NO se aprueba sesión, NO se cierra campaña,
--     NO se cierran ubicaciones, NO se crean snapshots nuevos;
--   * la quantity del finding permanece como fuente histórica de la cantidad;
--   * solo SUPER_USUARIO; todo dentro de una única transacción (rollback total).
-- Author: Assistant

-- ============================================================================
-- 1. TRAZABILIDAD DEL COUNT_ENTRY EN EL HALLAZGO
--    La quantity del finding queda como fuente histórica de la cantidad congelada.
--    count_entry_id es único (índice UNIQUE parcial) para evitar dobles vínculos.
--    Los tres campos son coherentes con el estado del hallazgo.
-- ============================================================================
ALTER TABLE inventarios.inventory_campaign_supplemental_findings
    ADD COLUMN IF NOT EXISTS count_entry_id uuid REFERENCES inventarios.count_entries(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS count_recorded_at timestamptz,
    ADD COLUMN IF NOT EXISTS count_recorded_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT;

ALTER TABLE inventarios.inventory_campaign_supplemental_findings
    ADD CONSTRAINT chk_supplemental_findings_count_record
    CHECK (
        (count_entry_id IS NULL AND count_recorded_at IS NULL AND count_recorded_by IS NULL)
        OR (count_entry_id IS NOT NULL
            AND status = 'CONSOLIDATED'
            AND count_recorded_at IS NOT NULL
            AND count_recorded_by IS NOT NULL)
    );

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplemental_findings_count_entry
    ON inventarios.inventory_campaign_supplemental_findings (count_entry_id)
    WHERE count_entry_id IS NOT NULL;

-- ============================================================================
-- 2. DERIVACIÓN DETERMINÍSTICA DE CLAVES IDEMPOTENTES INTERNAS
--    A partir de la clave de lotes (p_idempotency_key) y un seed, se deriva un UUID
--    estable (md5) para cada llamada interna al motor. Esto garantiza trazabilidad
--    y replay seguro sin depender de gen_random_uuid() en los RPC internos.
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.supplemental_web_record_internal_key(
    p_base_key uuid,
    p_seed text
)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_hash text;
BEGIN
    v_hash := pg_catalog.md5(coalesce(p_base_key::text, '') || ':' || coalesce(p_seed, ''));
    RETURN (
        substr(v_hash, 1, 8) || '-' ||
        substr(v_hash, 9, 4) || '-' ||
        substr(v_hash, 13, 4) || '-' ||
        substr(v_hash, 17, 4) || '-' ||
        substr(v_hash, 21, 12)
    )::uuid;
END;
$function$;

ALTER FUNCTION inventarios.supplemental_web_record_internal_key(uuid, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.supplemental_web_record_internal_key(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================
-- 3. RPC PRINCIPAL: registrar los conteos WEB del lote SUPPLEMENTAL_FINDINGS
-- ============================================================================
CREATE OR REPLACE FUNCTION inventarios.record_inventory_campaign_supplemental_findings_counts(
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
    v_role_name text;
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
    v_zone_count bigint;
    v_task_count bigint;
    v_task_id uuid;
    v_task_status text;
    v_task_version integer;
    v_task_cycle integer;
    v_assignment_id uuid;
    v_assignment_user_id uuid;
    v_assignment_participant_id uuid;
    v_counter_participant_id uuid;
    v_counter_count bigint;
    v_scope_count bigint;
    v_total_consolidated bigint;
    v_pending_count bigint;
    v_resolve_ok bigint;
    v_has_active_other_task boolean;
    v_session_start_resp jsonb;
    v_task_start_resp jsonb;
    v_key_session_start uuid;
    v_key_task_start uuid;
    v_key_finding uuid;
    v_task_expected_version integer;
    v_rec_finding record;
    v_sp_id uuid;
    v_sl_id uuid;
    v_frozen_bsale_variant_id integer;
    v_frozen_product_count bigint;
    v_count_resp jsonb;
    v_count_entry_id uuid;
    v_count_entry_ok bigint;
    v_count_entry_ids uuid[] := '{}'::uuid[];
    v_physical_sum numeric(14,3) := 0;
    v_recorded_count bigint := 0;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_supplemental_session_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    -- ---------- Autorización: acceso a empresa + rol portal exacto SUPER_USUARIO ----------
    v_actor_id := inventarios.require_company_access(p_company_id);
    SELECT r.name INTO v_role_name
    FROM portal.users u
    JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = v_actor_id AND u.is_active = true AND u.deleted_at IS NULL;
    IF coalesce(v_role_name, '') <> 'SUPER_USUARIO' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo SUPER_USUARIO puede registrar los conteos de la sesión de hallazgos complementarios.','retryable',false)::text;
    END IF;

    v_occurred_at := pg_catalog.now();

    -- ---------- Idempotencia del lote (payload estable: compañía + sesión) ----------
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.supplemental.record_counts',
        'company_id', p_company_id,
        'session_id', p_supplemental_session_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id, 'inventarios.supplemental.record_counts', p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- ---------- Sesión (bloqueada) + validaciones ----------
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
    IF v_session_status <> 'PREPARED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión debe estar PREPARED para registrar los conteos de sus hallazgos.','retryable',false,'status',v_session_status)::text;
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

    -- ---------- Contexto operacional ya creado: al menos una zona habilitada ----------
    SELECT pg_catalog.count(*) INTO v_zone_count
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_supplemental_session_id AND sz.is_enabled = true;
    IF v_zone_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión no tiene contexto operacional (zonas habilitadas).','retryable',false,'enabled_zone_count',v_zone_count)::text;
    END IF;

    -- ---------- Exactamente una tarea PRIMARY activa para el lote ----------
    SELECT pg_catalog.count(*) INTO v_task_count
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_supplemental_session_id
      AND t.task_kind = 'PRIMARY'
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;
    IF v_task_count <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión debe tener exactamente una tarea PRIMARY activa.','retryable',false,'task_count',v_task_count)::text;
    END IF;

    SELECT t.id, t.status, t.version, t.validation_cycle, t.current_assignment_id
    INTO v_task_id, v_task_status, v_task_version, v_task_cycle, v_assignment_id
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_supplemental_session_id
      AND t.task_kind = 'PRIMARY'
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL
    FOR UPDATE OF t;

    IF v_task_status <> 'ASSIGNED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La tarea debe estar ASSIGNED para iniciar el registro.','retryable',false,'status',v_task_status)::text;
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

    -- ---------- Guarda: el actor no debe tener otra tarea IN_PROGRESS (no se modifica) ----------
    SELECT EXISTS (
        SELECT 1
        FROM inventarios.tasks t
        JOIN inventarios.task_assignments ta ON ta.company_id = t.company_id AND ta.task_id = t.id
        WHERE ta.user_id = v_actor_id
          AND ta.released_at IS NULL
          AND t.status = 'IN_PROGRESS'
          AND t.id <> v_task_id
          AND t.cancelled_at IS NULL AND t.superseded_at IS NULL AND t.invalidated_at IS NULL
    ) INTO v_has_active_other_task;
    IF v_has_active_other_task THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ACTOR_HAS_ACTIVE_TASK',
            DETAIL=pg_catalog.jsonb_build_object('message','Ya te encuentras trabajando en otra tarea de inventario.','retryable',false)::text;
    END IF;

    -- ---------- Hallazgos a registrar (CONSOLIDATED pendientes) ----------
    SELECT pg_catalog.count(*) INTO v_total_consolidated
    FROM inventarios.inventory_campaign_supplemental_findings f
    WHERE f.company_id = p_company_id
      AND f.supplemental_session_id = p_supplemental_session_id
      AND f.status = 'CONSOLIDATED';

    SELECT pg_catalog.count(*) INTO v_pending_count
    FROM inventarios.inventory_campaign_supplemental_findings f
    WHERE f.company_id = p_company_id
      AND f.supplemental_session_id = p_supplemental_session_id
      AND f.status = 'CONSOLIDATED'
      AND f.count_entry_id IS NULL;

    IF v_total_consolidated = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_NO_FINDINGS',
            DETAIL=pg_catalog.jsonb_build_object('message','El lote no tiene hallazgos CONSOLIDATED para registrar.','retryable',false)::text;
    END IF;
    IF v_pending_count = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_COUNTS_ALREADY_RECORDED',
            DETAIL=pg_catalog.jsonb_build_object('message','El lote ya fue registrado; no se debe volver a registrar con una nueva clave.','retryable',false)::text;
    END IF;
    IF v_pending_count <> v_total_consolidated THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_COUNTS_INCONSISTENT',
            DETAIL=pg_catalog.jsonb_build_object('message','El lote tiene una mezcla de hallazgos registrados y no registrados; no se repara automáticamente.','retryable',false,
                'consolidated_count',v_total_consolidated,'pending_count',v_pending_count)::text;
    END IF;

    -- ---------- Resolución de snapshot (producto + ubicación) por cada hallazgo ----------
    --    La identidad efectiva después de CONSOLIDATED es la congelada en el snapshot:
    --    se resuelve snapshot_product por product_id (NO por bsale_variant_id histórico).
    SELECT pg_catalog.count(*) INTO v_resolve_ok
    FROM inventarios.inventory_campaign_supplemental_findings f
    WHERE f.company_id = p_company_id
      AND f.supplemental_session_id = p_supplemental_session_id
      AND f.status = 'CONSOLIDATED'
      AND f.count_entry_id IS NULL
      AND (
          SELECT pg_catalog.count(*) FROM inventarios.snapshot_products sp
          WHERE sp.company_id = f.company_id
            AND sp.snapshot_id = f.supplemental_snapshot_id
            AND sp.product_id = f.product_id
      ) = 1
      AND EXISTS (
          SELECT 1 FROM inventarios.snapshot_locations sl
          WHERE sl.company_id = f.company_id
            AND sl.snapshot_id = f.supplemental_snapshot_id
            AND sl.inventory_site_location_id = f.inventory_site_location_id
      );
    IF v_resolve_ok <> v_pending_count THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_COUNTS_CONSISTENCY',
            DETAIL=pg_catalog.jsonb_build_object('message','No todos los hallazgos del lote resuelven producto (único) o ubicación en el snapshot congelado; no se crean snapshots aquí.','retryable',false,
                'pending_count',v_pending_count,'resolvable_count',v_resolve_ok)::text;
    END IF;

    -- ---------- Claves determinísticas internas ----------
    v_key_session_start := inventarios.supplemental_web_record_internal_key(p_idempotency_key, 'session.start');
    v_key_task_start := inventarios.supplemental_web_record_internal_key(p_idempotency_key, 'task.start');
    v_task_expected_version := v_task_version;

    -- ---------- Iniciar sesión: PREPARED -> COUNTING ----------
    v_session_start_resp := inventarios.start_inventory_session(
        p_company_id, p_supplemental_session_id, v_key_session_start);
    IF (v_session_start_resp ->> 'state') <> 'COUNTING' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','No se pudo iniciar la sesión de conteo.','retryable',false,'state',v_session_start_resp ->> 'state')::text;
    END IF;

    -- Verificar que el snapshot/contexto no cambió
    SELECT os.completion_status, os.content_hash INTO v_snapshot_status, v_content_hash
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.id = v_snapshot_id;
    IF v_snapshot_status <> 'COMPLETED' OR v_content_hash IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot ya no está completado.','retryable',false)::text;
    END IF;

    -- ---------- Iniciar tarea: ASSIGNED -> IN_PROGRESS ----------
    v_task_start_resp := inventarios.start_inventory_task(
        p_company_id, v_task_id, v_task_expected_version, v_key_task_start);
    IF (v_task_start_resp ->> 'state') <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','No se pudo iniciar la tarea de conteo.','retryable',false,'state',v_task_start_resp ->> 'state')::text;
    END IF;

    -- ---------- Registrar cada finding (motor oficial) ----------
    FOR v_rec_finding IN
        SELECT f.id AS finding_id,
               f.product_id,
               f.bsale_variant_id,
               f.inventory_site_location_id,
               f.quantity,
               f.supplemental_snapshot_id
        FROM inventarios.inventory_campaign_supplemental_findings f
        WHERE f.company_id = p_company_id
          AND f.supplemental_session_id = p_supplemental_session_id
          AND f.status = 'CONSOLIDATED'
          AND f.count_entry_id IS NULL
        ORDER BY f.id
    LOOP
        -- La identidad congelada (snapshot) es la autoritativa; se resuelve por product_id
        -- y se exige resolución única. f.bsale_variant_id histórico NO se usa aquí.
        SELECT pg_catalog.count(*) INTO v_frozen_product_count
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = p_company_id
          AND sp.snapshot_id = v_rec_finding.supplemental_snapshot_id
          AND sp.product_id = v_rec_finding.product_id;
        IF v_frozen_product_count <> 1 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_COUNTS_CONSISTENCY',
                DETAIL=pg_catalog.jsonb_build_object('message','El producto del hallazgo no resuelve a un único snapshot_product en el lote congelado.','retryable',false,
                    'finding_id',v_rec_finding.finding_id,'frozen_product_count',v_frozen_product_count)::text;
        END IF;
        SELECT sp.id, sp.bsale_variant_id
        INTO v_sp_id, v_frozen_bsale_variant_id
        FROM inventarios.snapshot_products sp
        WHERE sp.company_id = p_company_id
          AND sp.snapshot_id = v_rec_finding.supplemental_snapshot_id
          AND sp.product_id = v_rec_finding.product_id;

        SELECT sl.id INTO v_sl_id
        FROM inventarios.snapshot_locations sl
        WHERE sl.company_id = p_company_id
          AND sl.snapshot_id = v_rec_finding.supplemental_snapshot_id
          AND sl.inventory_site_location_id = v_rec_finding.inventory_site_location_id;
        IF v_sl_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_COUNTS_CONSISTENCY',
                DETAIL=pg_catalog.jsonb_build_object('message','La ubicación del hallazgo no está en el snapshot congelado.','retryable',false,
                    'finding_id',v_rec_finding.finding_id)::text;
        END IF;

        v_key_finding := inventarios.supplemental_web_record_internal_key(p_idempotency_key, v_rec_finding.finding_id::text);

        v_count_resp := inventarios.record_inventory_count(
            p_company_id, v_task_id, v_task_cycle,
            v_sp_id, v_sl_id,
            pg_catalog.jsonb_build_object(
                'available_quantity', v_rec_finding.quantity,
                'blocked_quantity', 0,
                'damaged_quantity', 0,
                'expired_quantity', 0,
                'other_unavailable_quantity', 0),
            'MANUAL', NULL, 'WEB', NULL, NULL, NULL, v_key_finding);

        v_count_entry_id := (v_count_resp ->> 'entity_id')::uuid;
        IF v_count_entry_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_COUNTS_CONSISTENCY',
                DETAIL=pg_catalog.jsonb_build_object('message','El motor de conteo no devolvió un count_entry.','retryable',false,
                    'finding_id',v_rec_finding.finding_id)::text;
        END IF;

        -- ---------- Verificar vínculo exacto del count_entry ----------
        SELECT pg_catalog.count(*) INTO v_count_entry_ok
        FROM inventarios.count_entries ce
        WHERE ce.id = v_count_entry_id
          AND ce.company_id = p_company_id
          AND ce.session_id = p_supplemental_session_id
          AND ce.task_id = v_task_id
          AND ce.snapshot_id = v_snapshot_id
          AND ce.snapshot_product_id = v_sp_id
          AND ce.snapshot_location_id = v_sl_id
          AND ce.bsale_variant_id = v_frozen_bsale_variant_id
          AND ce.capture_source = 'WEB'
          AND ce.identification_method = 'MANUAL'
          AND ce.counted_by = v_actor_id
          AND ce.session_participant_id = v_counter_participant_id
          AND ce.physical_quantity = v_rec_finding.quantity;
        IF v_count_entry_ok <> 1 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SUPPLEMENTAL_COUNTS_CONSISTENCY',
                DETAIL=pg_catalog.jsonb_build_object('message','El count_entry devuelto no corresponde exactamente al hallazgo.','retryable',false,
                    'finding_id',v_rec_finding.finding_id,'count_entry_id',v_count_entry_id)::text;
        END IF;

        -- ---------- Vincular resultado al finding ----------
        UPDATE inventarios.inventory_campaign_supplemental_findings
        SET count_entry_id = v_count_entry_id,
            count_recorded_at = v_occurred_at,
            count_recorded_by = v_actor_id,
            updated_at = v_occurred_at,
            updated_by = v_actor_id
        WHERE company_id = p_company_id AND id = v_rec_finding.finding_id;

        v_count_entry_ids := pg_catalog.array_append(v_count_entry_ids, v_count_entry_id);
        v_physical_sum := v_physical_sum + v_rec_finding.quantity;
        v_recorded_count := v_recorded_count + 1;
    END LOOP;

    -- ---------- Respuesta ----------
    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.supplemental.record_counts',
        'entity_id', p_supplemental_session_id,
        'state', 'COUNTING',
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
            'task_assignment_id', v_assignment_id,
            'recorded_count', v_recorded_count,
            'physical_quantity_sum', v_physical_sum,
            'count_entry_ids', to_jsonb(v_count_entry_ids),
            'content_hash', v_content_hash,
            'replayed', false));

    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_supplemental_session_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.record_inventory_campaign_supplemental_findings_counts(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.record_inventory_campaign_supplemental_findings_counts(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.record_inventory_campaign_supplemental_findings_counts(uuid, uuid, uuid) TO authenticated, service_role;
