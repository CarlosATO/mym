-- Migration: 20260803190600_inventarios_session_import_context.sql
-- Description: Fase 4I.3B. Contexto EXCEL_IMPORT de una sesion para la UI:
--              stock_source, importacion asociada, unidad y campana.
--              Aditivo: no modifica get_inventory_session_detail existente.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_import_context(
    p_company_id uuid,
    p_session_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_context jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT pg_catalog.jsonb_build_object(
        'session_id', s.id,
        'status', s.status,
        'stock_source', s.stock_source,
        'stock_import_id', s.stock_import_id,
        'inventory_site_id', s.inventory_site_id,
        'site_name', is2.name,
        'site_code', is2.code,
        'site_type', is2.site_type,
        'campaign_id', s.campaign_id,
        'campaign_name', ic.name,
        'campaign_product_scope', ic.product_scope,
        'session_location_scope', ics.location_scope,
        'import_filename', si.original_filename,
        'import_modality', si.modality,
        'import_cutoff_at', si.cutoff_at,
        'import_status', si.status
    ) INTO v_context
    FROM inventarios.sessions s
    LEFT JOIN inventarios.inventory_sites is2 ON is2.company_id = s.company_id AND is2.id = s.inventory_site_id
    LEFT JOIN inventarios.inventory_campaigns ic ON ic.company_id = s.company_id AND ic.id = s.campaign_id
    LEFT JOIN inventarios.inventory_campaign_sites ics
      ON ics.company_id = s.company_id AND ics.campaign_id = s.campaign_id AND ics.inventory_site_id = s.inventory_site_id
    LEFT JOIN inventarios.stock_imports si ON si.company_id = s.company_id AND si.id = s.stock_import_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id;

    IF v_context IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no existe.','retryable',false)::text;
    END IF;

    RETURN pg_catalog.jsonb_build_object('context', v_context);
END;
$$;

ALTER FUNCTION inventarios.get_inventory_session_import_context(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_session_import_context(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_import_context(uuid, uuid) TO authenticated;
