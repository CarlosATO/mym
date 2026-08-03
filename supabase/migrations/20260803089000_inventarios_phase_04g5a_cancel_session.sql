-- Migration: 20260803089000_inventarios_phase_04g5a_cancel_session.sql
-- Description: Fase 4G.5a. Cancelacion de jornadas de inventario antes de
--              APPROVED. Preserva snapshot, conteos, incidentes y evidencia;
--              cancela tareas activas y recuentos pendientes sin eliminar filas.
-- Author: Assistant

-- ============================================================
-- 1. PERMISO NUEVO: inventarios.sessions.cancel
-- ============================================================
INSERT INTO portal.permissions (code, name, module_id)
SELECT 'inventarios.sessions.cancel', 'Cancelar jornadas de inventario', module.id
FROM portal.modules module
WHERE module.code = 'inventarios'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name, module_id = EXCLUDED.module_id;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
    ('SUPER_USUARIO', 'inventarios.sessions.cancel'),
    ('BODEGA', 'inventarios.sessions.cancel')
) AS m(role_name, perm_code)
JOIN portal.roles r ON r.name = m.role_name AND r.is_active = true
JOIN portal.permissions p ON p.code = m.perm_code AND p.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- 2. RPC: cancel_inventory_session
--    Permiso inventarios.sessions.cancel.
--    Rol contextual: ADMINISTRATOR activo de la jornada.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.cancel_inventory_session(
    p_company_id uuid,
    p_session_id uuid,
    p_reason text,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_reason text; v_session_status text;
    v_cancelled_at timestamptz;
    v_task_row record; v_assignment_row record; v_recount_row record;
    v_response jsonb; v_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_reason IS NULL
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_reason := pg_catalog.btrim(p_reason);
    IF v_reason = '' OR pg_catalog.char_length(v_reason) < 5 OR pg_catalog.char_length(v_reason) > 1000 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.cancel');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.cancel_inventory_session'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.cancel','company_id',p_company_id,
        'session_id',p_session_id,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.cancel',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT s.status INTO v_session_status
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status = 'APPROVED' OR v_session_status = 'EXPORTED'
       OR v_session_status = 'RECONCILED' OR v_session_status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no es cancelable en su estado actual.','retryable',false,'session_status',v_session_status)::text;
    END IF;
    IF v_session_status NOT IN ('DRAFT','PREPARED','COUNTING','UNDER_REVIEW') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false,'session_status',v_session_status)::text;
    END IF;

    PERFORM inventarios.require_session_participant(p_company_id, p_session_id, 'ADMINISTRATOR');

    v_cancelled_at := pg_catalog.now();

    -- 4-6. Cancelar tareas ASSIGNED, IN_PROGRESS o PAUSED:
    --      crear task_event CANCELLED, liberar assignments vigentes, marcar CANCELLED.
    --      task_state_transitions NO admite CANCELLED (CHECK 04b0d2), por lo que
    --      solo se inserta en task_events, replicando cancel_inventory_task.
    FOR v_task_row IN
        SELECT t.id, t.session_zone_id, t.status, t.version, t.validation_cycle,
               t.current_assignment_id, t.active_user_id
        FROM inventarios.tasks t
        WHERE t.company_id = p_company_id AND t.session_id = p_session_id
          AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
          AND t.status IN ('ASSIGNED','IN_PROGRESS','PAUSED')
        ORDER BY t.id
        FOR UPDATE
    LOOP
        FOR v_assignment_row IN
            SELECT ta.id, ta.user_id
            FROM inventarios.task_assignments ta
            WHERE ta.company_id = p_company_id AND ta.session_id = p_session_id
              AND ta.task_id = v_task_row.id AND ta.released_at IS NULL
            ORDER BY ta.id
            FOR UPDATE
        LOOP
            UPDATE inventarios.task_assignments ta
            SET released_at = v_cancelled_at, released_by = v_actor_id,
                release_reason = v_reason
            WHERE ta.company_id = p_company_id AND ta.id = v_assignment_row.id;
        END LOOP;

        INSERT INTO inventarios.task_events (company_id, session_id, session_zone_id,
            task_id, event_type, actor_id, previous_user_id, next_user_id, cycle,
            occurred_at, reason, idempotency_key, technical_metadata, created_by)
        VALUES (p_company_id, p_session_id, v_task_row.session_zone_id, v_task_row.id,
            'CANCELLED', v_actor_id, v_task_row.active_user_id, NULL::uuid,
            v_task_row.validation_cycle, v_cancelled_at, v_reason, p_idempotency_key,
            pg_catalog.jsonb_build_object('session_cancelled', true,
                'previous_assignment_id', v_task_row.current_assignment_id,
                'previous_user_id', v_task_row.active_user_id),
            v_actor_id);

        UPDATE inventarios.tasks t
        SET cancelled_at = v_cancelled_at, cancelled_by = v_actor_id,
            current_assignment_id = NULL, active_user_id = NULL,
            version = t.version + 1, updated_at = v_cancelled_at, updated_by = v_actor_id
        WHERE t.company_id = p_company_id AND t.id = v_task_row.id
          AND t.status = v_task_row.status
          AND t.version = v_task_row.version;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
        END IF;
    END LOOP;

    -- 7. Cancelar recuentos REQUESTED, ASSIGNED o IN_PROGRESS sin decisiones.
    FOR v_recount_row IN
        SELECT rr.id, rr.status, rr.cycle_number
        FROM inventarios.recount_requests rr
        WHERE rr.company_id = p_company_id AND rr.session_id = p_session_id
          AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS')
          AND rr.cancelled_at IS NULL AND rr.cancelled_by IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.recount_decisions rd
              WHERE rd.company_id = rr.company_id AND rd.recount_request_id = rr.id
          )
        ORDER BY rr.id
        FOR UPDATE
    LOOP
        UPDATE inventarios.recount_requests rr
        SET status = 'CANCELLED', cancelled_at = v_cancelled_at,
            cancelled_by = v_actor_id, cancellation_reason = v_reason,
            updated_at = v_cancelled_at, updated_by = v_actor_id
        WHERE rr.company_id = p_company_id AND rr.id = v_recount_row.id
          AND rr.status = v_recount_row.status
          AND rr.cancelled_at IS NULL AND rr.cancelled_by IS NULL
          AND rr.completed_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
                DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
        END IF;
    END LOOP;

    -- 11-12. Cambiar sesion a CANCELLED con campos fisicos de cancelacion.
    UPDATE inventarios.sessions s
    SET status = 'CANCELLED', cancelled_at = v_cancelled_at,
        cancelled_by = v_actor_id, cancellation_reason = v_reason,
        updated_at = v_cancelled_at, updated_by = v_actor_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id
      AND s.status NOT IN ('APPROVED','EXPORTED','RECONCILED','CANCELLED');
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.cancel','entity_id',p_session_id,
        'state','CANCELLED','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_cancelled_at,
        'data',pg_catalog.jsonb_build_object('cancelled_at',v_cancelled_at,
            'cancelled_by',v_actor_id,'reason',v_reason,
            'preserved_snapshot',true,'preserved_counts',true,
            'preserved_incidents',true));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_response);
END;
$$;

-- ============================================================
-- 3. OWNER, REVOKES Y GRANT
-- ============================================================
ALTER FUNCTION inventarios.cancel_inventory_session(uuid, uuid, text, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.cancel_inventory_session(uuid, uuid, text, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.cancel_inventory_session(uuid, uuid, text, uuid) TO authenticated;
