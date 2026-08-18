-- UNRESOLVED_RECOUNT siempre conserva BLOCKED; la antiguedad Bsale no
-- convierte un producto no transferible en STALE.

CREATE OR REPLACE FUNCTION inventarios.list_inventory_stock_reconciliation_products(
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
    bsale_synced_at timestamptz
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
               WHEN r.location_resolution_status <> 'RESOLVED' THEN 'BLOCKED'
               WHEN r.reconciliation_status <> 'APPLIED'
                AND r.bsale_sync_run_id IS NOT NULL
                AND latest.id IS NOT NULL
                AND r.bsale_sync_run_id IS DISTINCT FROM latest.id
               THEN 'STALE'
               ELSE r.reconciliation_status
           END,
           r.bsale_sync_run_id,
           latest.id,
           r.bsale_synced_at
    FROM inventarios.inventory_stock_reconciliations r
    LEFT JOIN LATERAL (
        SELECT sr.id
        FROM integraciones.bsale_sync_runs sr
        WHERE sr.company_id = r.company_id AND sr.status = 'COMPLETED'
        ORDER BY sr.completed_at DESC NULLS LAST, sr.started_at DESC NULLS LAST, sr.id DESC
        LIMIT 1
    ) latest ON true
    WHERE r.company_id = p_company_id
      AND r.official_version_id = p_official_version_id
    ORDER BY r.bsale_variant_id, r.id;
END;
$function$;

ALTER FUNCTION inventarios.list_inventory_stock_reconciliation_products(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_stock_reconciliation_products(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_stock_reconciliation_products(uuid, uuid) TO authenticated, service_role;
