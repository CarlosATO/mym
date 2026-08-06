-- Migration: 20260806105000_inventarios_add_campaign_participant.sql
-- Description: Fase 4I.3C.7C.3E.3A. Helper interno campaign_is_prepared y
--              RPC idempotente add_inventory_campaign_participant para el
--              equipo global de una campana. No modifica tablas ni datos.
-- Author: Assistant

-- ============================================================
-- A. HELPER INTERNO: inventarios.campaign_is_prepared
-- ============================================================
-- Determina si existen senales persistidas que impidan seguir configurando
-- el equipo de la campana. Uso interno exclusivo desde RPCs autorizados:
-- no autoriza usuarios, no modifica datos y no considera campaign.status.
--
-- Decision CANCELLED: NO es senal de preparacion. El contrato vigente de
-- cancelacion de jornadas (04g5a) permite cancelar desde DRAFT
-- (s.status NOT IN ('APPROVED','EXPORTED','RECONCILED','CANCELLED')), por lo
-- que una jornada CANCELLED puede provenir de una jornada nunca preparada.
CREATE OR REPLACE FUNCTION inventarios.campaign_is_prepared(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    v_prepared boolean;
BEGIN
    v_prepared := (
        -- Senal 1: snapshot maestro de la campana en COMPLETED
        EXISTS (
            SELECT 1
            FROM inventarios.inventory_campaign_snapshots ics
            WHERE ics.company_id = p_company_id
              AND ics.campaign_id = p_campaign_id
              AND ics.completion_status = 'COMPLETED'
        )
        -- Senal 2: importacion oficial de la campana consumida, o vinculada
        -- como consumida por esa campana
        OR EXISTS (
            SELECT 1
            FROM inventarios.stock_imports si
            WHERE si.company_id = p_company_id
              AND si.status = 'CONSUMED'
              AND (si.campaign_id = p_campaign_id
                   OR si.consumed_campaign_id = p_campaign_id)
        )
        -- Senal 3: jornada de la campana en PREPARED o posterior
        OR EXISTS (
            SELECT 1
            FROM inventarios.sessions s
            WHERE s.company_id = p_company_id
              AND s.campaign_id = p_campaign_id
              AND s.status IN ('PREPARED', 'COUNTING', 'UNDER_REVIEW',
                               'APPROVED', 'EXPORTED', 'RECONCILED')
        )
    );

    RETURN v_prepared;
END;
$$;

ALTER FUNCTION inventarios.campaign_is_prepared(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.campaign_is_prepared(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- B. RPC: inventarios.add_inventory_campaign_participant
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.add_inventory_campaign_participant(
    p_company_id uuid,
    p_campaign_id uuid,
    p_user_id uuid,
    p_participant_role text,
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
    v_participant_role text;
    v_campaign_status text;
    v_participant_id uuid;
    v_occurred_at timestamptz;
    v_response jsonb;
    v_payload jsonb;
BEGIN
    v_participant_role := pg_catalog.upper(pg_catalog.btrim(p_participant_role));

    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_user_id IS NULL
       OR v_participant_role NOT IN ('COUNTER','SUPERVISOR','ADMINISTRATOR','MANAGER')
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','La solicitud no tiene el formato requerido.',
                'retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.add_inventory_campaign_participant'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_campaign_id::text));

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.campaign.participant.add','company_id',p_company_id,
        'campaign_id',p_campaign_id,'user_id',p_user_id,'participant_role',v_participant_role);

    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.campaign.participant.add',p_idempotency_key,
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

    IF NOT EXISTS (SELECT 1 FROM portal.users u
                   JOIN core.user_company_access uca
                     ON uca.user_id = u.id AND uca.company_id = p_company_id AND uca.is_active = true
                   WHERE u.id = p_user_id AND u.is_active = true AND u.deleted_at IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','El usuario no existe o no tiene acceso activo a la empresa.',
                'retryable',false)::text;
    END IF;

    IF EXISTS (SELECT 1 FROM inventarios.inventory_campaign_participants icp
               WHERE icp.company_id = p_company_id
                 AND icp.campaign_id = p_campaign_id
                 AND icp.user_id = p_user_id
                 AND icp.participant_role = v_participant_role
                 AND icp.revoked_at IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PARTICIPANT_DUPLICATE',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','El usuario ya tiene una participacion activa con ese rol.',
                'retryable',false)::text;
    END IF;

    v_occurred_at := pg_catalog.now();
    INSERT INTO inventarios.inventory_campaign_participants AS icp (
        company_id, campaign_id, user_id, participant_role,
        active_from, created_at, created_by
    )
    VALUES (
        p_company_id, p_campaign_id, p_user_id, v_participant_role,
        v_occurred_at, v_occurred_at, v_actor_id
    )
    RETURNING icp.id INTO v_participant_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.campaign.participant.add','entity_id',v_participant_id,
        'state','ACTIVE','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('campaign_id',p_campaign_id,
            'participant_id',v_participant_id,'user_id',p_user_id,
            'participant_role',v_participant_role,'active_from',v_occurred_at));

    RETURN inventarios.complete_idempotent_operation(
        p_company_id, v_operation_id, v_participant_id, v_response);
END;
$$;

ALTER FUNCTION inventarios.add_inventory_campaign_participant(uuid, uuid, uuid, text, uuid)
OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.add_inventory_campaign_participant(uuid, uuid, uuid, text, uuid)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.add_inventory_campaign_participant(uuid, uuid, uuid, text, uuid)
TO authenticated;
