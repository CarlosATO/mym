-- Migration: 20260803130200_inventarios_update_site_coalesce_fix.sql
-- Description: Fase 4I.2F. Corrige pg_catalog.coalesce en update_inventory_site.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.update_inventory_site(
    p_company_id uuid,
    p_site_id uuid,
    p_name text,
    p_is_active boolean,
    p_inventory_enabled boolean
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_name text;
    v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    v_name := pg_catalog.btrim(coalesce(p_name, ''));
    IF p_company_id IS NULL OR p_site_id IS NULL OR v_name = '' OR pg_catalog.char_length(v_name) > 200 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sites.manage');
    v_occurred_at := pg_catalog.now();

    UPDATE inventarios.inventory_sites
    SET name = v_name,
        is_active = coalesce(p_is_active, is_active),
        inventory_enabled = coalesce(p_inventory_enabled, inventory_enabled),
        include_in_general = CASE
            WHEN coalesce(p_inventory_enabled, inventory_enabled) = false THEN false
            ELSE include_in_general
        END,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_site_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad inventariable no existe.','retryable',false)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_site_id, 'state', 'UPDATED', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('site_id', p_site_id)
    );
    RETURN v_response;
END;
$$;

ALTER FUNCTION inventarios.update_inventory_site(uuid, uuid, text, boolean, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.update_inventory_site(uuid, uuid, text, boolean, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.update_inventory_site(uuid, uuid, text, boolean, boolean) TO authenticated;
