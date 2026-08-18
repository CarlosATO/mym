-- =========================================================================================
-- MIGRATION: M1.5G fix - Recrea list_my_inventory_audit_progress
-- (el conteo top-level pending_locations usaba count(*) total en vez de pendientes;
--  ahora pending = ubicaciones sin resultado y counted = ubicaciones con resultado).
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.list_my_inventory_audit_progress(
    p_company_id uuid,
    p_audit_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_status text;
    v_assigned_user_id uuid;
    v_audit_number integer;
    v_campaign_id uuid;
    v_campaign_name text;
    v_products jsonb;
    v_pending bigint;
    v_counted bigint;
BEGIN
    IF p_company_id IS NULL OR p_audit_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT a.status, a.assigned_user_id, a.audit_number, a.campaign_id, ic.name
    INTO v_status, v_assigned_user_id, v_audit_number, v_campaign_id, v_campaign_name
    FROM inventarios.inventory_audits a
    JOIN inventarios.inventory_campaigns ic ON ic.company_id = a.company_id AND ic.id = a.campaign_id
    WHERE a.company_id = p_company_id AND a.id = p_audit_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no existe.','retryable',false)::text;
    END IF;
    IF v_assigned_user_id IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_NOT_ASSIGNED',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no está asignada a este usuario.','retryable',false)::text;
    END IF;

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_product_id', ap.id,
                'bsale_variant_id', ap.bsale_variant_id,
                'sku', ap.sku,
                'name', ap.name,
                'barcode', ap.barcode,
                'scope_status', ap.scope_status,
                'pending_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_locations l2 WHERE l2.company_id = ap.company_id AND l2.audit_id = ap.audit_id AND l2.audit_product_id = ap.id
                                  AND NOT EXISTS (SELECT 1 FROM inventarios.inventory_audit_results r2 WHERE r2.company_id = ap.company_id AND r2.audit_product_id = ap.id AND r2.audit_location_id = l2.id)),
                'counted_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_results r2 WHERE r2.company_id = ap.company_id AND r2.audit_id = ap.audit_id AND r2.audit_product_id = ap.id),
                'locations', (SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                                ELSE pg_catalog.jsonb_agg(
                                    pg_catalog.jsonb_build_object(
                                        'audit_location_id', l.id,
                                        'location_code', l.location_code,
                                        'location_name', l.location_name,
                                        'status', CASE WHEN r.id IS NULL THEN 'PENDING' ELSE 'COUNTED' END,
                                        'physical_quantity', r.physical_quantity,
                                        'captured_at', r.captured_at
                                    ) ORDER BY l.location_code
                                )
                              END
                              FROM inventarios.inventory_audit_locations l
                              LEFT JOIN inventarios.inventory_audit_results r
                                ON r.company_id = l.company_id AND r.audit_product_id = l.audit_product_id AND r.audit_location_id = l.id
                              WHERE l.company_id = ap.company_id AND l.audit_id = ap.audit_id AND l.audit_product_id = ap.id)
            ) ORDER BY ap.bsale_variant_id
        )
    END
    INTO v_products
    FROM inventarios.inventory_audit_products ap
    WHERE ap.company_id = p_company_id AND ap.audit_id = p_audit_id
      AND ap.scope_status = 'LOCATIONS_RESOLVED';

    SELECT pg_catalog.count(*) FILTER (WHERE r.id IS NULL),
           pg_catalog.count(*) FILTER (WHERE r.id IS NOT NULL)
    INTO v_pending, v_counted
    FROM inventarios.inventory_audit_locations l
    LEFT JOIN inventarios.inventory_audit_results r
      ON r.company_id = l.company_id AND r.audit_product_id = l.audit_product_id AND r.audit_location_id = l.id
    WHERE l.company_id = p_company_id AND l.audit_id = p_audit_id
      AND EXISTS (SELECT 1 FROM inventarios.inventory_audit_products ap2
                  WHERE ap2.company_id = l.company_id AND ap2.id = l.audit_product_id
                    AND ap2.scope_status = 'LOCATIONS_RESOLVED');

    RETURN pg_catalog.jsonb_build_object(
        'audit_id', p_audit_id,
        'audit_number', v_audit_number,
        'status', v_status,
        'campaign_id', v_campaign_id,
        'campaign_name', v_campaign_name,
        'pending_locations', v_pending,
        'counted_locations', v_counted,
        'products', coalesce(v_products, '[]'::jsonb)
    );
END;
$function$;

ALTER FUNCTION inventarios.list_my_inventory_audit_progress(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_my_inventory_audit_progress(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_my_inventory_audit_progress(uuid, uuid) TO authenticated;

COMMIT;
