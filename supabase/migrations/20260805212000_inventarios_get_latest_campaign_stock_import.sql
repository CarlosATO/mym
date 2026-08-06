-- Migration: 20260805212000_inventarios_get_latest_campaign_stock_import.sql
-- Description: Fase 4I.3C.6B.2D. RPC de referencia para localizar la importacion
--              vigente (mas reciente) de una campana por company_id + campaign_id.
--              Solo lectura: no crea, actualiza ni consume importaciones.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.get_latest_campaign_stock_import_ref(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_import_id uuid;
    v_status text;
    v_created_at timestamptz;
    v_campaign_found uuid;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.read');

    -- Fail-closed por compania: la campana debe pertenecer a p_company_id.
    SELECT ic.id INTO v_campaign_found
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no existe.','retryable',false)::text;
    END IF;

    -- Intento mas reciente de la campana, sin filtrar por estado:
    -- la pantalla debe poder recuperar tambien REJECTED, DRAFT o el estado real.
    SELECT si.id, si.status, si.created_at
    INTO v_import_id, v_status, v_created_at
    FROM inventarios.stock_imports si
    WHERE si.company_id = p_company_id
      AND si.campaign_id = p_campaign_id
      AND si.theoretical_scope IS NOT NULL
    ORDER BY si.created_at DESC, si.id DESC
    LIMIT 1;

    IF v_import_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'operation', 'inventarios.get_latest_campaign_stock_import_ref',
            'entity_id', NULL::uuid,
            'state', 'NOT_FOUND',
            'version', NULL::integer,
            'cycle_number', NULL::integer,
            'assignment_id', NULL::uuid,
            'event_id', NULL::uuid,
            'replayed', false,
            'occurred_at', NULL::timestamptz,
            'data', pg_catalog.jsonb_build_object(
                'import_id', NULL::uuid,
                'status', NULL::text,
                'created_at', NULL::timestamptz
            )
        );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'operation', 'inventarios.get_latest_campaign_stock_import_ref',
        'entity_id', v_import_id,
        'state', v_status,
        'version', NULL::integer,
        'cycle_number', NULL::integer,
        'assignment_id', NULL::uuid,
        'event_id', NULL::uuid,
        'replayed', false,
        'occurred_at', v_created_at,
        'data', pg_catalog.jsonb_build_object(
            'import_id', v_import_id,
            'status', v_status,
            'created_at', v_created_at
        )
    );
END;
$$;

ALTER FUNCTION inventarios.get_latest_campaign_stock_import_ref(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_latest_campaign_stock_import_ref(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_latest_campaign_stock_import_ref(uuid, uuid) TO authenticated;
