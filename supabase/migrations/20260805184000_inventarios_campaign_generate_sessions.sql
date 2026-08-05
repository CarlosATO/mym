-- Migration: 20260805184000_inventarios_campaign_generate_sessions.sql
-- Description: Fase 4I.3C.5A. Genera jornadas DRAFT por unidad de una campana
--              a partir de una importacion de stock ya VALIDATED.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.generate_inventory_campaign_sessions(
    p_company_id uuid,
    p_campaign_id uuid,
    p_stock_import_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_now timestamptz := pg_catalog.now();
    v_campaign_status text;
    v_import_campaign_id uuid;
    v_import_status text;
    v_import_consumed_campaign_id uuid;
    v_campaign_site record;
    v_existing_session_id uuid;
    v_created_session_id uuid;
    v_session_result jsonb;
    v_session_ids jsonb := '[]'::jsonb;
    v_total_units integer := 0;
    v_created_sessions integer := 0;
    v_existing_sessions integer := 0;
    v_pending_sessions integer := 0;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_stock_import_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.create');

    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.generate_inventory_campaign_sessions',
        'company_id', p_company_id,
        'campaign_id', p_campaign_id,
        'stock_import_id', p_stock_import_id,
        'idempotency_key', p_idempotency_key
    );
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,
        'inventarios.generate_inventory_campaign_sessions',
        p_idempotency_key,
        inventarios.compute_request_hash(v_payload)
    );
    IF v_operation ->> 'mode' = 'REPLAY' THEN
        RETURN v_operation -> 'response_payload';
    END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT ic.status
      INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id
      AND ic.id = p_campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no esta en DRAFT.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    SELECT si.campaign_id, si.status, si.consumed_campaign_id
      INTO v_import_campaign_id, v_import_status, v_import_consumed_campaign_id
    FROM inventarios.stock_imports si
    WHERE si.company_id = p_company_id
      AND si.id = p_stock_import_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no existe.','retryable',false)::text;
    END IF;
    IF v_import_campaign_id IS DISTINCT FROM p_campaign_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no pertenece a la campana solicitada.','retryable',false)::text;
    END IF;
    IF v_import_status <> 'VALIDATED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no esta validada.','retryable',false,'status',v_import_status)::text;
    END IF;
    IF v_import_consumed_campaign_id IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_CONSUMED',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion ya fue consumida.','retryable',false)::text;
    END IF;

    FOR v_campaign_site IN
        SELECT ics.id,
               ics.inventory_site_id,
               ics.location_scope,
               ics.display_order,
               is2.name AS site_name
        FROM inventarios.inventory_campaign_sites ics
        JOIN inventarios.inventory_sites is2
          ON is2.company_id = ics.company_id AND is2.id = ics.inventory_site_id
        WHERE ics.company_id = p_company_id
          AND ics.campaign_id = p_campaign_id
        ORDER BY ics.display_order, ics.id
        FOR UPDATE OF ics
    LOOP
        v_total_units := v_total_units + 1;
        v_existing_session_id := NULL;

        SELECT s.id
          INTO v_existing_session_id
        FROM inventarios.sessions s
        WHERE s.company_id = p_company_id
          AND s.campaign_id = p_campaign_id
          AND s.inventory_site_id = v_campaign_site.inventory_site_id
        LIMIT 1;

        IF v_existing_session_id IS NOT NULL THEN
            v_existing_sessions := v_existing_sessions + 1;
            v_session_ids := v_session_ids || pg_catalog.jsonb_build_array(v_existing_session_id);
            CONTINUE;
        END IF;

        v_session_result := NULL;
        v_session_result := inventarios.create_inventory_session_from_campaign_site(
            p_company_id,
            v_campaign_site.id,
            v_actor_id,
            pg_catalog.gen_random_uuid()
        );
        v_created_session_id := NULL;
        IF pg_catalog.jsonb_typeof(v_session_result) = 'object' AND (v_session_result ->> 'entity_id') IS NOT NULL THEN
            v_created_session_id := (v_session_result ->> 'entity_id')::uuid;
        END IF;
        IF v_created_session_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                DETAIL=pg_catalog.jsonb_build_object('message','No se pudo generar una jornada para la unidad solicitada.','retryable',false)::text;
        END IF;

        v_created_sessions := v_created_sessions + 1;
        v_session_ids := v_session_ids || pg_catalog.jsonb_build_array(v_created_session_id);
    END LOOP;

    v_pending_sessions := GREATEST(v_total_units - v_created_sessions - v_existing_sessions, 0);

    RETURN inventarios.complete_idempotent_operation(
        p_company_id,
        v_operation_id,
        p_campaign_id,
        pg_catalog.jsonb_build_object(
            'operation', 'inventarios.generate_inventory_campaign_sessions',
            'entity_id', p_campaign_id,
            'state', 'GENERATED',
            'version', NULL::integer,
            'cycle_number', NULL::integer,
            'assignment_id', NULL::uuid,
            'event_id', NULL::uuid,
            'replayed', false,
            'occurred_at', v_now,
            'data', pg_catalog.jsonb_build_object(
                'campaign_id', p_campaign_id,
                'stock_import_id', p_stock_import_id,
                'total_units', v_total_units,
                'sessions_created', v_created_sessions,
                'sessions_existing', v_existing_sessions,
                'sessions_pending', v_pending_sessions,
                'session_ids', COALESCE(v_session_ids, '[]'::jsonb)
            )
        )
    );
END;
$$;

ALTER FUNCTION inventarios.generate_inventory_campaign_sessions(uuid, uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.generate_inventory_campaign_sessions(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.generate_inventory_campaign_sessions(uuid, uuid, uuid, uuid) TO authenticated;
