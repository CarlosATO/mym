-- Migration: 20260806110000_inventarios_revoke_campaign_participant.sql
-- Description: Fase 4I.3C.7C.3E.4A. RPC idempotente para revocar una sola
--              fila/rol del equipo global de una campana, con proteccion del
--              ultimo ADMINISTRATOR y bloqueo por tareas activas del mismo rol.
--              No modifica tablas, constraints ni datos.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.revoke_inventory_campaign_participant(
    p_company_id uuid,
    p_campaign_id uuid,
    p_participant_id uuid,
    p_reason text,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_reason text;
    v_campaign_status text;
    v_participant_user_id uuid;
    v_participant_role text;
    v_admin_count bigint;
    v_active_task_count bigint;
    v_occurred_at timestamptz;
    v_response jsonb;
    v_payload jsonb;
BEGIN
    v_reason := pg_catalog.btrim(p_reason);

    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_participant_id IS NULL
       OR v_reason = ''
       OR pg_catalog.char_length(v_reason) < 5
       OR pg_catalog.char_length(v_reason) > 500
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','La solicitud no tiene el formato requerido.',
                'retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.revoke_inventory_campaign_participant'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_campaign_id::text));

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.campaign.participant.revoke','company_id',p_company_id,
        'campaign_id',p_campaign_id,'participant_id',p_participant_id,'reason',v_reason);

    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.campaign.participant.revoke',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','El recurso solicitado no existe.',
                'retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_DRAFT',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','La campana no permite esta operacion en su estado actual.',
                'retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF inventarios.campaign_is_prepared(p_company_id, p_campaign_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_PREPARED',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','La campana ya presenta senales de preparacion.',
                'retryable',false)::text;
    END IF;

    SELECT icp.user_id, icp.participant_role
    INTO v_participant_user_id, v_participant_role
    FROM inventarios.inventory_campaign_participants icp
    WHERE icp.id = p_participant_id
      AND icp.company_id = p_company_id
      AND icp.campaign_id = p_campaign_id
      AND icp.revoked_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','El participante solicitado no existe o ya esta revocado.',
                'retryable',false)::text;
    END IF;

    IF v_participant_role = 'ADMINISTRATOR' THEN
        SELECT pg_catalog.count(*) INTO v_admin_count
        FROM inventarios.inventory_campaign_participants icp
        WHERE icp.company_id = p_company_id
          AND icp.campaign_id = p_campaign_id
          AND icp.participant_role = 'ADMINISTRATOR'
          AND icp.revoked_at IS NULL;
        IF v_admin_count <= 1 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_LAST_ADMINISTRATOR',
                DETAIL=pg_catalog.jsonb_build_object(
                    'message','La campana debe conservar al menos un administrador activo.',
                    'retryable',false)::text;
        END IF;
    END IF;

    -- Tareas activas del usuario con el mismo rol en jornadas de la campana.
    -- Una tarea COMPLETED no es activa (contrato vigente de jornada:
    -- solo ASSIGNED/IN_PROGRESS/PAUSED sin cancelacion ni superseded).
    SELECT pg_catalog.count(*) INTO v_active_task_count
    FROM inventarios.task_assignments ta
    JOIN inventarios.tasks t
      ON t.company_id = ta.company_id AND t.session_id = ta.session_id AND t.id = ta.task_id
    JOIN inventarios.session_participants sp
      ON sp.company_id = ta.company_id AND sp.session_id = ta.session_id AND sp.id = ta.session_participant_id
    JOIN inventarios.sessions s
      ON s.company_id = sp.company_id AND s.id = sp.session_id
    WHERE s.company_id = p_company_id
      AND s.campaign_id = p_campaign_id
      AND sp.user_id = v_participant_user_id
      AND sp.functional_role = v_participant_role
      AND sp.revoked_at IS NULL
      AND ta.released_at IS NULL
      AND t.status IN ('ASSIGNED','IN_PROGRESS','PAUSED')
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL;
    IF v_active_task_count > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_HAS_ACTIVE_TASKS',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','No se puede revocar el participante porque tiene tareas activas asignadas.',
                'retryable',false,'active_task_count',v_active_task_count)::text;
    END IF;

    v_occurred_at := pg_catalog.now();
    UPDATE inventarios.inventory_campaign_participants AS icp
    SET revoked_at = v_occurred_at,
        revoked_by = v_actor_id,
        revocation_reason = v_reason
    WHERE icp.id = p_participant_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.campaign.participant.revoke','entity_id',p_participant_id,
        'state','REVOKED','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('campaign_id',p_campaign_id,
            'participant_id',p_participant_id,'user_id',v_participant_user_id,
            'participant_role',v_participant_role,'revoked_at',v_occurred_at,
            'revocation_reason',v_reason));

    RETURN inventarios.complete_idempotent_operation(
        p_company_id, v_operation_id, p_participant_id, v_response);
END;
$$;

ALTER FUNCTION inventarios.revoke_inventory_campaign_participant(uuid, uuid, uuid, text, uuid)
OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.revoke_inventory_campaign_participant(uuid, uuid, uuid, text, uuid)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.revoke_inventory_campaign_participant(uuid, uuid, uuid, text, uuid)
TO authenticated;
