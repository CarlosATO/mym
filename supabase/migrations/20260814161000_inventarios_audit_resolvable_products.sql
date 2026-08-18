-- =========================================================================================
-- MIGRATION: M1.5H - list_inventory_audit_resolvable_products (contrato read-only ERP)
-- =========================================================================================
-- Objetivo:
--   Exponer a la Administracion (lectura, mismo guard que list_inventory_audit_candidates)
--   los productos de una auditoria para la resolucion administrativa producto por producto.
--   Devuelve TODOS los productos de la auditoria con su estado (pending y ya resueltos),
--   para que la UI represente correctamente estados mixtos y bloquee acciones sobre
--   productos ya resueltos.
--
--   No muta nada. No forma parte del motor de resolucion: los contratos de mutacion
--   (preview_inventory_audit_product_resolution / resolve_inventory_audit_product)
--   permanecen intactos.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.list_inventory_audit_resolvable_products(
    p_company_id uuid,
    p_audit_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_audit_number integer;
    v_audit_status text;
    v_campaign_id uuid;
    v_campaign_status text;
    v_items jsonb;
BEGIN
    IF p_company_id IS NULL OR p_audit_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT a.campaign_id, a.audit_number, a.status
    INTO v_campaign_id, v_audit_number, v_audit_status
    FROM inventarios.inventory_audits a
    WHERE a.company_id = p_company_id AND a.id = p_audit_id;
    IF v_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no existe.','retryable',false)::text;
    END IF;

    SELECT c.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns c
    WHERE c.company_id = p_company_id AND c.id = v_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_product_id', ap.id,
                'bsale_variant_id', ap.bsale_variant_id,
                'product_id', ap.product_id,
                'sku', ap.sku,
                'name', ap.name,
                'product_status', ap.status,
                'scope_status', ap.scope_status
            ) ORDER BY ap.bsale_variant_id, ap.id
        )
    END
    INTO v_items
    FROM inventarios.inventory_audit_products ap
    WHERE ap.company_id = p_company_id AND ap.audit_id = p_audit_id;

    RETURN pg_catalog.jsonb_build_object(
        'company_id', p_company_id,
        'audit_id', p_audit_id,
        'audit_number', v_audit_number,
        'audit_status', v_audit_status,
        'campaign_id', v_campaign_id,
        'campaign_status', v_campaign_status,
        'total', pg_catalog.jsonb_array_length(v_items),
        'items', v_items
    );
END;
$function$;

ALTER FUNCTION inventarios.list_inventory_audit_resolvable_products(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_audit_resolvable_products(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_audit_resolvable_products(uuid, uuid)
    TO authenticated, service_role;

COMMIT;
