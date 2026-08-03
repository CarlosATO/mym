-- Migration: 20260803087000_inventarios_phase_04g4a_close_session.sql
-- Description: Fase 4G.4a. Cierre formal del conteo COUNTING -> UNDER_REVIEW.
--              Permiso sessions.close, helper require_session_review y RPC
--              close_inventory_session. No valida tareas ni crea version oficial.
-- Author: Assistant

-- ============================================================
-- 1. PERMISO NUEVO: inventarios.sessions.close
-- ============================================================
INSERT INTO portal.permissions (code, name, module_id)
SELECT 'inventarios.sessions.close', 'Cerrar jornadas de inventario', module.id
FROM portal.modules module
WHERE module.code = 'inventarios'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name, module_id = EXCLUDED.module_id;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
    ('SUPER_USUARIO', 'inventarios.sessions.close'),
    ('BODEGA', 'inventarios.sessions.close')
) AS m(role_name, perm_code)
JOIN portal.roles r ON r.name = m.role_name AND r.is_active = true
JOIN portal.permissions p ON p.code = m.perm_code AND p.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- 2. HELPER: require_session_review
--    Valida que la jornada este en UNDER_REVIEW.
-- ============================================================
CREATE FUNCTION inventarios.require_session_review(
    p_company_id uuid,
    p_session_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_status text;
BEGIN
    SELECT s.status INTO v_status
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND',
            DETAIL = pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_status <> 'UNDER_REVIEW' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SESSION_INVALID_STATE',
            DETAIL = pg_catalog.jsonb_build_object('message','La jornada no esta en revision.','retryable',false,'session_status',v_status)::text;
    END IF;
END;
$$;

ALTER FUNCTION inventarios.require_session_review(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.require_session_review(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- 3. RPC: close_inventory_session
--    COUNTING -> UNDER_REVIEW. Permiso inventarios.sessions.close.
--    Rol contextual: ADMINISTRATOR activo de la jornada.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.close_inventory_session(
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
    v_task_not_final bigint; v_task_without_contribution bigint;
    v_inconsistent_assignment bigint; v_blocking_incident bigint;
    v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
    v_contrib_count bigint;
    v_task_row record;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.close');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.close_inventory_session'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.close','company_id',p_company_id,
        'session_id',p_session_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.close',p_idempotency_key,
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
    IF v_session_status = 'UNDER_REVIEW' OR v_session_status = 'APPROVED'
       OR v_session_status = 'EXPORTED' OR v_session_status = 'RECONCILED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_ALREADY_PREPARED',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada ya esta cerrada o en una etapa posterior.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'COUNTING' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    IF v_snapshot_status <> 'COMPLETED' OR v_content_hash IS NULL OR v_content_hash = '' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SNAPSHOT_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','El snapshot no esta completado o no tiene hash de integridad.','retryable',false)::text;
    END IF;

    PERFORM inventarios.require_session_participant(p_company_id, p_session_id, 'ADMINISTRATOR');

    -- Validacion 3-4: todas las tareas operativas en estado final permitido
    SELECT pg_catalog.count(*) INTO v_task_not_final
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
      AND t.status NOT IN ('COMPLETED');
    IF v_task_not_final > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_TASKS_NOT_COMPLETED',
            DETAIL=pg_catalog.jsonb_build_object('message','Existen tareas sin completar.','retryable',false,'tasks_not_completed',v_task_not_final)::text;
    END IF;

    -- Validacion 5: ninguna asignacion activa inconsistente
    SELECT pg_catalog.count(*) INTO v_inconsistent_assignment
    FROM inventarios.task_assignments ta
    WHERE ta.company_id = p_company_id AND ta.session_id = p_session_id
      AND ta.released_at IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.session_participants sp
          WHERE sp.company_id = ta.company_id AND sp.session_id = ta.session_id
            AND sp.id = ta.session_participant_id
            AND sp.revoked_at IS NULL
      );
    IF v_inconsistent_assignment > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_SETUP_INCOMPLETE',
            DETAIL=pg_catalog.jsonb_build_object('message','Existen asignaciones vigentes con participantes revocados.','retryable',false,'inconsistent_assignments',v_inconsistent_assignment)::text;
    END IF;

    -- Validacion 6: cobertura de conteo coherente con el alcance real.
    -- El modelo no define una matriz producto x ubicacion; el criterio minimo
    -- contractual es: toda tarea operativa COMPLETED con al menos una
    -- contribucion efectiva (via get_effective_task_contributions).
    v_task_without_contribution := 0;
    FOR v_task_row IN
        SELECT t.id FROM inventarios.tasks t
        WHERE t.company_id = p_company_id AND t.session_id = p_session_id
          AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
          AND t.status = 'COMPLETED'
    LOOP
        SELECT pg_catalog.count(*) INTO v_contrib_count
        FROM inventarios.get_effective_task_contributions(p_company_id, p_session_id, v_task_row.id) g;
        IF v_contrib_count < 1 THEN
            v_task_without_contribution := v_task_without_contribution + 1;
        END IF;
    END LOOP;
    IF v_task_without_contribution > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_TASKS_WITHOUT_CONTRIBUTION',
            DETAIL=pg_catalog.jsonb_build_object('message','Existen tareas completadas sin contribucion efectiva.','retryable',false,'tasks_without_contribution',v_task_without_contribution)::text;
    END IF;

    -- Validacion 7: ausencia de incidencias bloqueantes sin resolver
    SELECT pg_catalog.count(*) INTO v_blocking_incident
    FROM inventarios.incidents i
    WHERE i.company_id = p_company_id AND i.session_id = p_session_id
      AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW');
    IF v_blocking_incident > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_BLOCKING_INCIDENTS',
            DETAIL=pg_catalog.jsonb_build_object('message','Existen incidentes bloqueantes pendientes.','retryable',false,'blocking_incident_count',v_blocking_incident)::text;
    END IF;

    v_occurred_at := pg_catalog.now();

    UPDATE inventarios.sessions AS s
    SET status = 'UNDER_REVIEW',
        reviewed_at = v_occurred_at,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
      AND s.status = 'COUNTING';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.close','entity_id',p_session_id,
        'state','UNDER_REVIEW','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('reviewed_at',v_occurred_at,
            'reviewed_by',v_actor_id,'tasks_not_completed',v_task_not_final,
            'tasks_without_contribution',v_task_without_contribution,
            'blocking_incident_count',v_blocking_incident));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_response);
END;
$$;

-- ============================================================
-- 4. OWNER, REVOKES Y GRANT
-- ============================================================
ALTER FUNCTION inventarios.close_inventory_session(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.close_inventory_session(uuid, uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.close_inventory_session(uuid, uuid, uuid) TO authenticated;
