-- Expone el estado terminal de aplicacion en el detalle y resumen existentes.

DROP FUNCTION IF EXISTS inventarios.list_inventory_stock_reconciliation_products(uuid, uuid);

CREATE FUNCTION inventarios.list_inventory_stock_reconciliation_products(
    p_company_id uuid,
    p_official_version_id uuid
)
RETURNS TABLE (
    id uuid,
    official_version_id uuid,
    official_version_item_id uuid,
    snapshot_product_id uuid,
    bsale_variant_id integer,
    inventory_physical_quantity numeric,
    bsale_quantity numeric,
    difference_quantity numeric,
    mapping_status text,
    location_resolution_status text,
    reconciliation_status text,
    stored_bsale_sync_run_id uuid,
    latest_bsale_sync_run_id uuid,
    bsale_synced_at timestamptz,
    logistics_applicability_status text,
    logistics_application_status text,
    logistics_block_reasons text[],
    logistics_scope_location_count integer,
    logistics_explicit_location_count integer,
    logistics_positive_stock_location_count integer,
    logistics_unrepresented_stock_location_count integer,
    logistics_missing_official_location_count integer
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
BEGIN
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    RETURN QUERY
    SELECT r.id,
           r.official_version_id,
           r.official_version_item_id,
           r.snapshot_product_id,
           r.bsale_variant_id,
           r.inventory_physical_quantity,
           r.bsale_quantity,
           r.difference_quantity,
           r.mapping_status,
           r.location_resolution_status,
           CASE
               WHEN r.reconciliation_status <> 'APPLIED'
                AND r.bsale_sync_run_id IS NOT NULL
                AND latest.id IS NOT NULL
                AND r.bsale_sync_run_id IS DISTINCT FROM latest.id
               THEN 'STALE'
               ELSE r.reconciliation_status
           END,
           r.bsale_sync_run_id,
           latest.id,
           r.bsale_synced_at,
           app.status,
           r.logistics_application_status,
           app.reasons,
           app.scope_location_count,
           app.explicit_location_count,
           app.positive_stock_location_count,
           app.unrepresented_stock_location_count,
           app.missing_official_location_count
    FROM inventarios.inventory_stock_reconciliations r
    LEFT JOIN LATERAL (
        SELECT sr.id
        FROM integraciones.bsale_sync_runs sr
        WHERE sr.company_id = r.company_id AND sr.status = 'COMPLETED'
        ORDER BY sr.completed_at DESC NULLS LAST, sr.started_at DESC NULLS LAST, sr.id DESC
        LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
        SELECT
            (x->>'status')::text AS status,
            ARRAY(SELECT jsonb_array_elements_text(coalesce(x->'block_reasons', '[]'::jsonb))) AS reasons,
            (x->>'scope_location_count')::integer AS scope_location_count,
            (x->>'explicit_location_count')::integer AS explicit_location_count,
            (x->>'positive_stock_location_count')::integer AS positive_stock_location_count,
            (x->>'unrepresented_stock_location_count')::integer AS unrepresented_stock_location_count,
            (x->>'missing_official_location_count')::integer AS missing_official_location_count
        FROM (SELECT inventarios.compute_inventory_logistics_v1_applicability(r.id) AS x) computed
    ) app ON true
    WHERE r.company_id = p_company_id
      AND r.official_version_id = p_official_version_id
    ORDER BY r.bsale_variant_id, r.id;
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_stock_reconciliation_summary(
    p_company_id uuid,
    p_official_version_id uuid
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
    v_product_count bigint;
    v_pending_count bigint;
    v_ready_count bigint;
    v_mismatch_count bigint;
    v_blocked_count bigint;
    v_stale_count bigint;
    v_applied_count bigint;
    v_logistics_ready_count bigint;
    v_logistics_blocked_count bigint;
    v_application_applied_count bigint;
BEGIN
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    SELECT count(*),
           count(*) FILTER (WHERE p.reconciliation_status = 'PENDING'),
           count(*) FILTER (WHERE p.reconciliation_status = 'READY'),
           count(*) FILTER (WHERE p.reconciliation_status = 'MISMATCH'),
           count(*) FILTER (WHERE p.reconciliation_status = 'BLOCKED'),
           count(*) FILTER (WHERE p.reconciliation_status = 'STALE'),
           count(*) FILTER (WHERE p.reconciliation_status = 'APPLIED'),
           count(*) FILTER (WHERE p.logistics_applicability_status = 'READY'),
           count(*) FILTER (WHERE p.logistics_applicability_status = 'BLOCKED'),
           count(*) FILTER (WHERE p.logistics_application_status = 'APPLIED')
    INTO v_product_count, v_pending_count, v_ready_count, v_mismatch_count,
         v_blocked_count, v_stale_count, v_applied_count,
         v_logistics_ready_count, v_logistics_blocked_count,
         v_application_applied_count
    FROM inventarios.list_inventory_stock_reconciliation_products(
        p_company_id, p_official_version_id
    ) p;

    RETURN jsonb_build_object(
        'official_version_id', p_official_version_id,
        'product_count', v_product_count,
        'pending_count', v_pending_count,
        'ready_count', v_ready_count,
        'mismatch_count', v_mismatch_count,
        'blocked_count', v_blocked_count,
        'stale_count', v_stale_count,
        'applied_count', v_applied_count,
        'logistics_ready_count', v_logistics_ready_count,
        'logistics_blocked_count', v_logistics_blocked_count,
        'logistics_application_applied_count', v_application_applied_count,
        'read_by', v_actor_id,
        'read_at', now()
    );
END;
$function$;

ALTER FUNCTION inventarios.list_inventory_stock_reconciliation_products(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.get_inventory_stock_reconciliation_summary(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_stock_reconciliation_products(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION inventarios.get_inventory_stock_reconciliation_summary(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_stock_reconciliation_products(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_stock_reconciliation_summary(uuid, uuid) TO authenticated, service_role;
