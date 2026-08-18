-- Full campaign snapshot universe for the Inventory Excel export.
-- Schema affected exclusively: inventarios.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_all_products(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_rows jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');
    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;

    WITH selected_import AS (
        SELECT si.id
        FROM inventarios.stock_imports si
        WHERE si.company_id = p_company_id
          AND si.campaign_id = p_campaign_id
          AND si.status = 'VALIDATED'
          AND si.theoretical_scope = 'TOTAL_CAMPAIGN'
        ORDER BY si.validated_at DESC NULLS LAST, si.created_at DESC, si.id DESC
        LIMIT 1
    ),
    universe_ranked AS (
        SELECT r.product_id,
               r.bsale_variant_id,
               r.sku,
               r.entered_description,
               r.theoretical_quantity,
               r.unit_cost,
               r.barcode,
               pg_catalog.row_number() OVER (
                   PARTITION BY r.product_id
                   ORDER BY r.row_index ASC, r.id ASC
               ) AS product_rank
        FROM inventarios.stock_import_rows r
        JOIN selected_import si ON si.id = r.import_id
        WHERE r.company_id = p_company_id
          AND r.row_status = 'VALID'
          AND r.product_id IS NOT NULL
          AND r.bsale_variant_id IS NOT NULL
          AND r.sku IS NOT NULL
          AND pg_catalog.btrim(r.sku) <> ''
          AND r.theoretical_quantity IS NOT NULL
    ),
    universe AS (
        SELECT ur.*
        FROM universe_ranked ur
        WHERE ur.product_rank = 1
    ),
    campaign_sessions AS (
        SELECT s.id AS session_id
        FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
    ),
    campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t
        JOIN campaign_sessions cs ON cs.session_id = t.session_id
        WHERE t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ),
    physical AS (
        SELECT ce.bsale_variant_id,
               pg_catalog.sum(ce.physical_quantity) AS physical_quantity,
               pg_catalog.count(*) AS contribution_count
        FROM campaign_tasks ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(
            p_company_id, ct.session_id, ct.task_id
        ) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.company_id = p_company_id
          AND ce.bsale_variant_id IS NOT NULL
        GROUP BY ce.bsale_variant_id
    ),
    rows AS (
        SELECT u.bsale_variant_id,
               u.product_id,
               u.sku,
               coalesce(
                   NULLIF(inventarios.campaign_product_display_name(u.bsale_variant_id), ''),
                   NULLIF(pg_catalog.btrim(u.entered_description), ''),
                   u.sku
               ) AS name,
               u.theoretical_quantity,
               CASE WHEN coalesce(ph.contribution_count, 0) > 0 THEN ph.physical_quantity ELSE NULL END AS physical_quantity,
               CASE WHEN coalesce(ph.contribution_count, 0) > 0
                    THEN ph.physical_quantity - u.theoretical_quantity
                    ELSE NULL END AS difference_quantity,
               CASE WHEN coalesce(ph.contribution_count, 0) > 0 THEN 'COUNTED' ELSE 'NOT_COUNTED' END AS coverage_status,
               CASE WHEN coalesce(ph.contribution_count, 0) = 0 THEN 'SIN_CONTEO'
                    WHEN ph.physical_quantity - u.theoretical_quantity < 0 THEN 'FALTANTE'
                    WHEN ph.physical_quantity - u.theoretical_quantity > 0 THEN 'SOBRANTE'
                    ELSE 'SIN_DIFERENCIA' END AS variance_status,
               u.unit_cost,
               CASE WHEN coalesce(ph.contribution_count, 0) > 0
                    THEN (ph.physical_quantity - u.theoretical_quantity) * u.unit_cost
                    ELSE NULL END AS difference_value,
               inventarios.inventory_campaign_product_original_barcode(
                   p_company_id, p_campaign_id, u.bsale_variant_id
               ) ->> 'barcode' AS barcode,
               coalesce(ba.codes, '[]'::jsonb) AS approved_barcodes
        FROM universe u
        LEFT JOIN physical ph ON ph.bsale_variant_id = u.bsale_variant_id
        LEFT JOIN LATERAL (
            SELECT pg_catalog.jsonb_agg(pba.barcode ORDER BY pba.barcode) AS codes
            FROM inventarios.product_barcode_aliases pba
            WHERE pba.company_id = p_company_id
              AND pba.bsale_variant_id = u.bsale_variant_id
              AND pba.is_active = true
        ) ba ON true
    )
    SELECT coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'product_key', r.bsale_variant_id::text,
            'bsale_variant_id', r.bsale_variant_id,
            'product_id', r.product_id,
            'sku', r.sku,
            'name', r.name,
            'theoretical_quantity', r.theoretical_quantity,
            'physical_quantity', r.physical_quantity,
            'difference_quantity', r.difference_quantity,
            'variance_status', r.variance_status,
            'coverage_status', r.coverage_status,
            'unit_cost', r.unit_cost,
            'difference_value', r.difference_value,
            'barcode', r.barcode,
            'approved_barcodes', r.approved_barcodes
        ) ORDER BY r.sku ASC, r.bsale_variant_id ASC
    ), '[]'::jsonb)
    INTO v_rows
    FROM rows r;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'items', v_rows
    );
END;
$function$;

ALTER FUNCTION inventarios.get_inventory_campaign_all_products(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_inventory_campaign_all_products(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_all_products(uuid, uuid) TO authenticated, service_role;

COMMIT;
