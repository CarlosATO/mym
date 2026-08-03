-- Migration: 20260803098000_inventarios_harden_last_admin.sql
-- Description: Fase 4H.2F2. Protege el ultimo ADMINISTRATOR activo de una jornada
--              contra revocacion. Redefine revoke_inventory_session_participant.
--              Conserva las demas reglas (DRAFT, tareas activas, idempotencia).
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.revoke_inventory_session_participant(
    p_company_id uuid, p_session_id uuid, p_user_id uuid,
    p_reason text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_reason text; v_session_status text; v_participant_id uuid;
    v_participant_role text; v_active_task_count bigint;
    v_other_admin_count bigint; v_occurred_at timestamptz;
    v_response jsonb; v_payload jsonb;
BEGIN
    v_reason := pg_catalog.btrim(p_reason);
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_user_id IS NULL
       OR v_reason = '' OR pg_catalog.char_length(v_reason) < 5 OR pg_catalog.char_length(v_reason) > 500
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.participants.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.revoke_inventory_session_participant'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.participant.revoke','company_id',p_company_id,
        'session_id',p_session_id,'user_id',p_user_id,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.participant.revoke',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT s.status INTO v_session_status
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    SELECT sp.id, sp.functional_role INTO v_participant_id, v_participant_role
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
      AND sp.user_id = p_user_id AND sp.revoked_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El participante solicitado no existe o ya esta revocado.','retryable',false)::text;
    END IF;
    IF v_participant_role = 'ADMINISTRATOR' THEN
        SELECT pg_catalog.count(*) INTO v_other_admin_count
        FROM inventarios.session_participants sp
        WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id
          AND sp.functional_role = 'ADMINISTRATOR'
          AND sp.revoked_at IS NULL
          AND sp.id <> v_participant_id;
        IF v_other_admin_count < 1 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_LAST_ADMINISTRATOR',
                DETAIL=pg_catalog.jsonb_build_object('message','No se puede revocar al ultimo administrador de la jornada.','retryable',false)::text;
        END IF;
    END IF;
    SELECT pg_catalog.count(*) INTO v_active_task_count
    FROM inventarios.task_assignments ta
    JOIN inventarios.tasks t
      ON t.company_id = ta.company_id AND t.session_id = ta.session_id AND t.id = ta.task_id
    WHERE ta.company_id = p_company_id AND ta.session_id = p_session_id
      AND ta.session_participant_id = v_participant_id AND ta.released_at IS NULL
      AND t.status IN ('ASSIGNED','IN_PROGRESS','PAUSED')
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL;
    IF v_active_task_count > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_HAS_ACTIVE_TASKS',
            DETAIL=pg_catalog.jsonb_build_object('message','No se puede revocar el participante porque tiene tareas activas asignadas.','retryable',false,'active_task_count',v_active_task_count)::text;
    END IF;
    v_occurred_at := pg_catalog.now();
    UPDATE inventarios.session_participants AS sp
    SET revoked_at = v_occurred_at, revoked_by = v_actor_id, revocation_reason = v_reason
    WHERE sp.id = v_participant_id;
    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.participant.revoke','entity_id',v_participant_id,
        'state','REVOKED','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_id',p_session_id,'user_id',p_user_id,
            'revoked_at',v_occurred_at,'reason',v_reason));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_participant_id, v_response);
END;
$$;

ALTER FUNCTION inventarios.revoke_inventory_session_participant(uuid, uuid, uuid, text, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.revoke_inventory_session_participant(uuid, uuid, uuid, text, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.revoke_inventory_session_participant(uuid, uuid, uuid, text, uuid) TO authenticated;
