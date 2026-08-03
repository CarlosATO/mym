-- Migration: 20260803084000_inventarios_phase_04g3a_start_session.sql
-- Description: Fase 4G.3a. Apertura formal PREPARED -> COUNTING. Asigna el
--              permiso inventarios.sessions.start a los roles y crea
--              start_inventory_session. No inicia tareas ni crea conteos.
-- Author: Assistant

-- ============================================================
-- 1. ASIGNACION DEL PERMISO inventarios.sessions.start
--    El permiso existe desde 4B.0a pero no estaba asignado a roles.
-- ============================================================
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
    ('SUPER_USUARIO', 'inventarios.sessions.start'),
    ('BODEGA', 'inventarios.sessions.start')
) AS m(role_name, perm_code)
JOIN portal.roles r ON r.name = m.role_name AND r.is_active = true
JOIN portal.permissions p ON p.code = m.perm_code AND p.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- 2. RPC: start_inventory_session
--    PREPARED -> COUNTING. Permiso inventarios.sessions.start.
--    Rol contextual: ADMINISTRATOR activo de la jornada.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.start_inventory_session(
    p_company_id uuid,
    p_session_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_session_status text; v_snapshot_status text; v_content_hash char(64);
    v_counter_count bigint; v_zone_count bigint; v_task_count bigint;
    v_task_not_assigned bigint; v_prior_count bigint;
    v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.start');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.start_inventory_session'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.start','company_id',p_company_id,
        'session_id',p_session_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.start',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT s.status, os.completion_status, os.content_hash
    INTO v_session_status, v_snapshot_status, v_content_hash
    FROM inventarios.sessions s
    JOIN inventarios.operational_snapshots os
      ON os.company_id = s.company_id AND os.session_id = s.id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE OF s, os;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status = 'COUNTING' OR v_session_status = 'UNDER_REVIEW'
       OR v_session_status = 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_ALREADY_PREPARED',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada ya fue abierta o esta en una etapa posterior.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'PREPARED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    IF v_snapshot_status <> 'COMPLETED' OR v_content_hash IS NULL OR v_content_hash = '' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot no esta completado o no tiene hash de integridad.','retryable',false)::text;
    END IF;

    PERFORM inventarios.require_session_participant(p_company_id, p_session_id, 'ADMINISTRATOR');

    -- Validacion 5-6: coherencia de participantes, zonas, tareas y asignaciones
    SELECT pg_catalog.count(*) INTO v_counter_count
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
      AND sp.functional_role = 'COUNTER'
      AND sp.active_from <= pg_catalog.now() AND sp.revoked_at IS NULL;
    IF v_counter_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene un COUNTER activo.','retryable',false,'counter_count',v_counter_count)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_zone_count
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id AND sz.is_enabled = true;
    IF v_zone_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no tiene zonas habilitadas.','retryable',false,'zone_count',0)::text;
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
            DETAIL=pg_catalog.jsonb_build_object('message','Toda tarea debe estar en estado ASSIGNED para abrir la jornada.','retryable',false,'tasks_not_assigned',v_task_not_assigned)::text;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM inventarios.tasks t
        WHERE t.company_id = p_company_id AND t.session_id = p_session_id
          AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
          AND EXISTS (
              SELECT 1 FROM inventarios.task_assignments ta
              WHERE ta.company_id = t.company_id AND ta.task_id = t.id AND ta.released_at IS NULL
          )
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Toda tarea debe tener una asignacion vigente.','retryable',false)::text;
    END IF;

    -- Validacion 7: ninguna captura de conteo previa
    SELECT pg_catalog.count(*) INTO v_prior_count
    FROM inventarios.count_entries ce
    WHERE ce.company_id = p_company_id AND ce.session_id = p_session_id;
    IF v_prior_count > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada ya tiene capturas de conteo.','retryable',false,'prior_count',v_prior_count)::text;
    END IF;

    v_occurred_at := pg_catalog.now();

    UPDATE inventarios.sessions AS s
    SET status = 'COUNTING',
        started_at = v_occurred_at,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
      AND s.status = 'PREPARED';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.start','entity_id',p_session_id,
        'state','COUNTING','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('started_at',v_occurred_at,
            'started_by',v_actor_id,'counter_count',v_counter_count,
            'zone_count',v_zone_count,'task_count',v_task_count,
            'snapshot_hash',v_content_hash));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_response);
END;
$$;

-- ============================================================
-- 3. OWNER, REVOKES Y GRANT
-- ============================================================
ALTER FUNCTION inventarios.start_inventory_session(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.start_inventory_session(uuid, uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.start_inventory_session(uuid, uuid, uuid) TO authenticated;
