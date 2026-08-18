-- Administrative read contract for reviewing an active audit from ERP.
-- This is read-only and exposes the audit snapshot plus Mobile progress.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_audit_detail(
    p_company_id uuid,
    p_campaign_id uuid,
    p_audit_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_audit jsonb;
    v_products jsonb;
    v_product_count bigint;
    v_location_count bigint;
    v_counted_location_count bigint;
BEGIN
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT pg_catalog.jsonb_build_object(
        'audit_id', a.id,
        'audit_number', a.audit_number,
        'campaign_id', a.campaign_id,
        'status', a.status,
        'assigned_user_id', a.assigned_user_id,
        'auditor_name', u.nombre,
        'created_at', a.created_at,
        'started_at', a.started_at,
        'submitted_at', a.submitted_at
    )
    INTO v_audit
    FROM inventarios.inventory_audits a
    JOIN portal.users u ON u.id = a.assigned_user_id
    WHERE a.company_id = p_company_id
      AND a.campaign_id = p_campaign_id
      AND a.id = p_audit_id;

    IF v_audit IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no existe en este inventario.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_product_count
    FROM inventarios.inventory_audit_products ap
    WHERE ap.company_id = p_company_id AND ap.audit_id = p_audit_id;

    SELECT pg_catalog.count(*) INTO v_location_count
    FROM inventarios.inventory_audit_locations al
    WHERE al.company_id = p_company_id AND al.audit_id = p_audit_id;

    SELECT pg_catalog.count(*) INTO v_counted_location_count
    FROM inventarios.inventory_audit_results ar
    WHERE ar.company_id = p_company_id AND ar.audit_id = p_audit_id;

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_product_id', ap.id,
                'bsale_variant_id', ap.bsale_variant_id,
                'sku', ap.sku,
                'name', ap.name,
                'status', ap.status,
                'scope_status', ap.scope_status,
                'variance_status', ap.variance_status,
                'theoretical_quantity', ap.theoretical_quantity,
                'physical_quantity', ap.physical_quantity,
                'difference_quantity', ap.difference_quantity,
                'difference_value', ap.difference_value,
                'counted_location_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_results ar2 WHERE ar2.company_id=ap.company_id AND ar2.audit_product_id=ap.id),
                'location_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_locations al2 WHERE al2.company_id=ap.company_id AND al2.audit_product_id=ap.id),
                'locations', (SELECT coalesce(pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                        'audit_location_id', al.id,
                        'location_code', al.location_code,
                        'location_name', al.location_name,
                        'status', CASE WHEN ar.id IS NULL THEN 'PENDING' ELSE 'COUNTED' END,
                        'physical_quantity', ar.physical_quantity,
                        'captured_at', ar.captured_at
                    ) ORDER BY al.location_code
                ), '[]'::jsonb)
                FROM inventarios.inventory_audit_locations al
                LEFT JOIN inventarios.inventory_audit_results ar
                  ON ar.company_id=al.company_id AND ar.audit_location_id=al.id
                WHERE al.company_id=ap.company_id AND al.audit_product_id=ap.id)
            ) ORDER BY ap.bsale_variant_id
        )
    END
    INTO v_products
    FROM inventarios.inventory_audit_products ap
    WHERE ap.company_id = p_company_id AND ap.audit_id = p_audit_id;

    RETURN pg_catalog.jsonb_build_object(
        'audit', v_audit,
        'product_count', v_product_count,
        'location_count', v_location_count,
        'counted_location_count', v_counted_location_count,
        'pending_location_count', greatest(v_location_count - v_counted_location_count, 0),
        'products', coalesce(v_products, '[]'::jsonb)
    );
END;
$function$;

ALTER FUNCTION inventarios.get_inventory_audit_detail(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_inventory_audit_detail(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_audit_detail(uuid,uuid,uuid) TO authenticated;

COMMIT;
