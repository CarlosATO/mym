-- Migration: 20260804100000_inventarios_campaign_detail.sql
-- Description: Hotfix 4I.3B.1. Consulta canonica de detalle de campana para
--              la navegacion administrativa: campana, unidades materializadas
--              (campaign_sites) con su conteo de ubicaciones y alcance, y la
--              sesion asociada por unidad (nullable), sin consultar tablas
--              desde el cliente.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_detail(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_campaign jsonb;
    v_sites jsonb;
    v_products jsonb;
    v_site_count bigint;
    v_session_count bigint;
    v_sessions_pending bigint;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT pg_catalog.jsonb_build_object(
        'id', ic.id,
        'name', ic.name,
        'campaign_type', ic.campaign_type,
        'status', ic.status,
        'site_scope', ic.site_scope,
        'product_scope', ic.product_scope,
        'planned_at', ic.planned_at,
        'created_at', ic.created_at
    )
    INTO v_campaign
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_site_count
    FROM inventarios.inventory_campaign_sites ics
    WHERE ics.company_id = p_company_id AND ics.campaign_id = p_campaign_id;

    SELECT pg_catalog.count(*) INTO v_session_count
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id;

    SELECT pg_catalog.count(*) INTO v_sessions_pending
    FROM inventarios.inventory_campaign_sites ics
    WHERE ics.company_id = p_company_id AND ics.campaign_id = p_campaign_id
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.sessions s
          WHERE s.company_id = ics.company_id
            AND s.campaign_id = ics.campaign_id
            AND s.inventory_site_id = ics.inventory_site_id
      );

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'campaign_site_id', ics.id,
            'site_id', ics.inventory_site_id,
            'site_name', is2.name,
            'site_code', is2.code,
            'site_type', is2.site_type,
            'is_required', ics.is_required,
            'display_order', ics.display_order,
            'location_scope', ics.location_scope,
            'location_count', CASE
                WHEN ics.location_scope = 'SELECTED' THEN (
                    SELECT pg_catalog.count(*) FROM inventarios.inventory_campaign_site_locations icl
                    WHERE icl.company_id = ics.company_id AND icl.campaign_site_id = ics.id
                )
                ELSE (
                    SELECT pg_catalog.count(*) FROM inventarios.inventory_site_locations isl
                    WHERE isl.company_id = is2.company_id
                      AND isl.inventory_site_id = is2.id
                      AND isl.is_active = true
                )
            END,
            'session_id', v_session.id,
            'session_number', v_session.session_number,
            'session_status', v_session.status,
            'stock_source', v_session.stock_source,
            'stock_import_id', v_session.stock_import_id,
            'import_status', si.status,
            'import_filename', si.original_filename
        ) ORDER BY ics.display_order
    )
    INTO v_sites
    FROM inventarios.inventory_campaign_sites ics
    JOIN inventarios.inventory_sites is2
      ON is2.company_id = ics.company_id AND is2.id = ics.inventory_site_id
    LEFT JOIN LATERAL (
        SELECT s.id, s.session_number, s.status, s.stock_source, s.stock_import_id
        FROM inventarios.sessions s
        WHERE s.company_id = ics.company_id
          AND s.campaign_id = ics.campaign_id
          AND s.inventory_site_id = ics.inventory_site_id
        ORDER BY s.created_at DESC
        LIMIT 1
    ) v_session ON true
    LEFT JOIN inventarios.stock_imports si
      ON si.company_id = p_company_id AND si.id = v_session.stock_import_id
    WHERE ics.company_id = p_company_id AND ics.campaign_id = p_campaign_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'product_id', icp.product_id,
                'sku', icp.sku,
                'display_order', icp.display_order
            ) ORDER BY icp.display_order
        )
    END
    INTO v_products
    FROM inventarios.inventory_campaign_products icp
    WHERE icp.company_id = p_company_id AND icp.campaign_id = p_campaign_id;

    RETURN pg_catalog.jsonb_build_object(
        'campaign', v_campaign,
        'site_count', v_site_count,
        'session_count', v_session_count,
        'sessions_pending', v_sessions_pending,
        'sites', CASE WHEN v_sites IS NULL THEN '[]'::jsonb ELSE v_sites END,
        'products', CASE WHEN v_products IS NULL THEN '[]'::jsonb ELSE v_products END
    );
END;
$$;

ALTER FUNCTION inventarios.get_inventory_campaign_detail(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_campaign_detail(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_detail(uuid, uuid) TO authenticated;
