-- Explicit read model for the complete campaign snapshot universe.
-- Schema affected exclusively: inventarios.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaign_variances(
    p_company_id uuid,
    p_campaign_id uuid,
    p_search text DEFAULT NULL,
    p_variance_status text DEFAULT NULL,
    p_coverage_status text DEFAULT NULL,
    p_page integer DEFAULT 1,
    p_page_size integer DEFAULT 50,
    p_sort_by text DEFAULT NULL,
    p_sort_direction text DEFAULT 'ASC'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_search text := btrim(coalesce(p_search, ''));
    v_var_status text := upper(btrim(coalesce(p_variance_status, '')));
    v_cov_status text := upper(btrim(coalesce(p_coverage_status, '')));
    v_sort_by text := upper(btrim(coalesce(p_sort_by, '')));
    v_sort_dir text := upper(btrim(coalesce(p_sort_direction, 'ASC')));
    v_page integer := greatest(coalesce(p_page, 1), 1);
    v_page_size integer := least(greatest(coalesce(p_page_size, 50), 1), 100);
    v_offset integer;
    v_total bigint;
    v_is_final boolean;
    v_items jsonb;
    v_prod_total bigint;
    v_prod_faltante bigint;
    v_prod_sobrante bigint;
    v_prod_sin_dif bigint;
    v_prod_out_snap bigint;
    v_prod_counted bigint;
    v_sum_theo numeric;
    v_sum_phys numeric;
    v_units_faltante numeric;
    v_units_sobrante numeric;
    v_net_val numeric;
    v_abs_val numeric;
BEGIN
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');
    IF v_sort_by NOT IN ('', 'SKU', 'NAME', 'THEORETICAL', 'PHYSICAL', 'DIFFERENCE', 'VARIANCE_STATUS', 'COVERAGE_STATUS', 'UNIT_COST', 'DIFFERENCE_VALUE') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD';
    END IF;
    IF v_sort_dir NOT IN ('ASC', 'DESC') THEN v_sort_dir := 'ASC'; END IF;
    v_offset := (v_page - 1) * v_page_size;

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NOT_FOUND';
    END IF;
    SELECT count(*) = 0 INTO v_is_final
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND s.status IN ('DRAFT', 'PREPARED', 'COUNTING', 'UNDER_REVIEW');

    WITH campaign_sessions AS (
        SELECT s.id AS session_id FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
    ),
    campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id FROM inventarios.tasks t
        JOIN campaign_sessions cs ON cs.session_id = t.session_id
        WHERE t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ),
    physical AS (
        SELECT ce.bsale_variant_id, sum(ce.physical_quantity) AS physical_quantity,
               count(*) AS contribution_count
        FROM campaign_tasks ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.company_id = p_company_id AND ce.bsale_variant_id IS NOT NULL
        GROUP BY ce.bsale_variant_id
    ),
    universe_ranked AS (
        SELECT r.product_id, r.bsale_variant_id, r.sku, r.entered_description,
               r.theoretical_quantity, r.unit_cost,
               row_number() OVER (PARTITION BY r.product_id ORDER BY r.row_index, r.id) AS product_rank
        FROM inventarios.stock_import_rows r
        JOIN inventarios.stock_imports si ON si.id = r.import_id
        WHERE si.company_id = p_company_id AND si.campaign_id = p_campaign_id
          AND si.status = 'VALIDATED' AND si.theoretical_scope = 'TOTAL_CAMPAIGN'
          AND r.company_id = p_company_id AND r.row_status = 'VALID'
          AND r.product_id IS NOT NULL AND r.bsale_variant_id IS NOT NULL
          AND r.sku IS NOT NULL AND btrim(r.sku) <> '' AND r.theoretical_quantity IS NOT NULL
    ),
    theoretical AS (
        SELECT product_id, bsale_variant_id, sku,
               coalesce(nullif(btrim(entered_description), ''), sku) AS name,
               theoretical_quantity, unit_cost
        FROM universe_ranked WHERE product_rank = 1
    ),
    base AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku, t.name, true AS in_theoretical_stock,
               t.theoretical_quantity, t.unit_cost
        FROM theoretical t
        UNION ALL
        SELECT ph.bsale_variant_id, sp.product_id, sp.sku,
               coalesce(nullif(inventarios.campaign_product_display_name(ph.bsale_variant_id), ''), sp.name),
               false, 0::numeric, NULL::numeric
        FROM physical ph
        LEFT JOIN LATERAL (
            SELECT sp.product_id, sp.sku, sp.name FROM inventarios.snapshot_products sp
            WHERE sp.company_id = p_company_id AND sp.bsale_variant_id = ph.bsale_variant_id
            ORDER BY sp.sku NULLS LAST LIMIT 1
        ) sp ON true
        WHERE NOT EXISTS (SELECT 1 FROM theoretical t WHERE t.bsale_variant_id = ph.bsale_variant_id)
    ),
    computed AS (
        SELECT b.*, ph.physical_quantity, coalesce(ph.contribution_count, 0) AS contribution_count,
               (ph.bsale_variant_id IS NOT NULL) AS in_any_snapshot,
               CASE WHEN ph.contribution_count > 0 THEN ph.physical_quantity - b.theoretical_quantity END AS difference_quantity,
               CASE WHEN NOT b.in_theoretical_stock THEN 'OUT_OF_SNAPSHOT'
                    WHEN ph.contribution_count > 0 THEN 'COUNTED' ELSE 'NOT_COUNTED' END AS coverage_status,
               CASE WHEN ph.contribution_count IS NULL THEN 'SIN_CONTEO'
                    WHEN ph.physical_quantity - b.theoretical_quantity < 0 THEN 'FALTANTE'
                    WHEN ph.physical_quantity - b.theoretical_quantity > 0 THEN 'SOBRANTE'
                    ELSE 'SIN_DIFERENCIA' END AS variance_status
        FROM base b LEFT JOIN physical ph ON ph.bsale_variant_id = b.bsale_variant_id
    ),
    filtered AS (
        SELECT c.* FROM computed c
        WHERE (v_search = '' OR c.sku ILIKE '%' || v_search || '%' OR c.name ILIKE '%' || v_search || '%')
          AND (v_var_status = '' OR c.variance_status = v_var_status)
          AND (v_cov_status = '' OR c.coverage_status = v_cov_status)
    )
    SELECT count(*) INTO v_total FROM filtered;

    WITH campaign_sessions AS (
        SELECT s.id AS session_id FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
    ), campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id FROM inventarios.tasks t
        JOIN campaign_sessions cs ON cs.session_id = t.session_id
        WHERE t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ), physical AS (
        SELECT ce.bsale_variant_id, sum(ce.physical_quantity) AS physical_quantity, count(*) AS contribution_count
        FROM campaign_tasks ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.company_id = p_company_id AND ce.bsale_variant_id IS NOT NULL
        GROUP BY ce.bsale_variant_id
    ), universe_ranked AS (
        SELECT r.*, row_number() OVER (PARTITION BY r.product_id ORDER BY r.row_index, r.id) AS product_rank
        FROM inventarios.stock_import_rows r JOIN inventarios.stock_imports si ON si.id = r.import_id
        WHERE si.company_id = p_company_id AND si.campaign_id = p_campaign_id AND si.status = 'VALIDATED'
          AND si.theoretical_scope = 'TOTAL_CAMPAIGN' AND r.company_id = p_company_id AND r.row_status = 'VALID'
          AND r.product_id IS NOT NULL AND r.bsale_variant_id IS NOT NULL AND r.sku IS NOT NULL
          AND btrim(r.sku) <> '' AND r.theoretical_quantity IS NOT NULL
    ), theoretical AS (
        SELECT product_id, bsale_variant_id, sku, coalesce(nullif(btrim(entered_description), ''), sku) AS name, theoretical_quantity, unit_cost
        FROM universe_ranked WHERE product_rank = 1
    ), base AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku, t.name, true AS in_theoretical_stock, t.theoretical_quantity, t.unit_cost FROM theoretical t
        UNION ALL
        SELECT ph.bsale_variant_id, sp.product_id, sp.sku, coalesce(nullif(inventarios.campaign_product_display_name(ph.bsale_variant_id), ''), sp.name), false, 0::numeric, NULL::numeric
        FROM physical ph LEFT JOIN LATERAL (SELECT sp.product_id, sp.sku, sp.name FROM inventarios.snapshot_products sp WHERE sp.company_id = p_company_id AND sp.bsale_variant_id = ph.bsale_variant_id ORDER BY sp.sku NULLS LAST LIMIT 1) sp ON true
        WHERE NOT EXISTS (SELECT 1 FROM theoretical t WHERE t.bsale_variant_id = ph.bsale_variant_id)
    ), computed AS (
        SELECT b.*, ph.physical_quantity, coalesce(ph.contribution_count, 0) AS contribution_count,
               CASE WHEN ph.contribution_count > 0 THEN ph.physical_quantity - b.theoretical_quantity END AS difference_quantity,
               CASE WHEN NOT b.in_theoretical_stock THEN 'OUT_OF_SNAPSHOT' WHEN ph.contribution_count > 0 THEN 'COUNTED' ELSE 'NOT_COUNTED' END AS coverage_status,
               CASE WHEN ph.contribution_count IS NULL THEN 'SIN_CONTEO' WHEN ph.physical_quantity - b.theoretical_quantity < 0 THEN 'FALTANTE' WHEN ph.physical_quantity - b.theoretical_quantity > 0 THEN 'SOBRANTE' ELSE 'SIN_DIFERENCIA' END AS variance_status
        FROM base b LEFT JOIN physical ph ON ph.bsale_variant_id = b.bsale_variant_id
    )
    SELECT count(*), count(*) FILTER (WHERE variance_status = 'FALTANTE'), count(*) FILTER (WHERE variance_status = 'SOBRANTE'),
           count(*) FILTER (WHERE variance_status = 'SIN_DIFERENCIA'), count(*) FILTER (WHERE coverage_status = 'OUT_OF_SNAPSHOT'),
           count(*) FILTER (WHERE contribution_count > 0), coalesce(sum(theoretical_quantity), 0), coalesce(sum(physical_quantity), 0),
           coalesce(sum(CASE WHEN variance_status = 'FALTANTE' THEN abs(difference_quantity) ELSE 0 END), 0),
           coalesce(sum(CASE WHEN variance_status = 'SOBRANTE' THEN difference_quantity ELSE 0 END), 0),
           coalesce(sum(coalesce(difference_quantity, 0) * coalesce(unit_cost, 0)), 0),
           coalesce(sum(abs(coalesce(difference_quantity, 0) * coalesce(unit_cost, 0))), 0)
    INTO v_prod_total, v_prod_faltante, v_prod_sobrante, v_prod_sin_dif, v_prod_out_snap, v_prod_counted,
         v_sum_theo, v_sum_phys, v_units_faltante, v_units_sobrante, v_net_val, v_abs_val
    FROM computed;

    WITH campaign_sessions AS (
        SELECT s.id AS session_id FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
    ), campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id FROM inventarios.tasks t JOIN campaign_sessions cs ON cs.session_id = t.session_id WHERE t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ), physical AS (
        SELECT ce.bsale_variant_id, sum(ce.physical_quantity) AS physical_quantity, count(*) AS contribution_count
        FROM campaign_tasks ct CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id WHERE ce.company_id = p_company_id AND ce.bsale_variant_id IS NOT NULL GROUP BY ce.bsale_variant_id
    ), universe_ranked AS (
        SELECT r.*, row_number() OVER (PARTITION BY r.product_id ORDER BY r.row_index, r.id) AS product_rank
        FROM inventarios.stock_import_rows r JOIN inventarios.stock_imports si ON si.id = r.import_id
        WHERE si.company_id = p_company_id AND si.campaign_id = p_campaign_id AND si.status = 'VALIDATED' AND si.theoretical_scope = 'TOTAL_CAMPAIGN' AND r.company_id = p_company_id AND r.row_status = 'VALID' AND r.product_id IS NOT NULL AND r.bsale_variant_id IS NOT NULL AND r.sku IS NOT NULL AND btrim(r.sku) <> '' AND r.theoretical_quantity IS NOT NULL
    ), theoretical AS (
        SELECT product_id, bsale_variant_id, sku, coalesce(nullif(btrim(entered_description), ''), sku) AS name, theoretical_quantity, unit_cost FROM universe_ranked WHERE product_rank = 1
    ), base AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku, t.name, true AS in_theoretical_stock, t.theoretical_quantity, t.unit_cost FROM theoretical t
        UNION ALL SELECT ph.bsale_variant_id, sp.product_id, sp.sku, coalesce(nullif(inventarios.campaign_product_display_name(ph.bsale_variant_id), ''), sp.name), false, 0::numeric, NULL::numeric FROM physical ph LEFT JOIN LATERAL (SELECT sp.product_id, sp.sku, sp.name FROM inventarios.snapshot_products sp WHERE sp.company_id = p_company_id AND sp.bsale_variant_id = ph.bsale_variant_id ORDER BY sp.sku NULLS LAST LIMIT 1) sp ON true WHERE NOT EXISTS (SELECT 1 FROM theoretical t WHERE t.bsale_variant_id = ph.bsale_variant_id)
    ), computed AS (
        SELECT b.*, ph.physical_quantity, coalesce(ph.contribution_count, 0) AS contribution_count, CASE WHEN ph.contribution_count > 0 THEN ph.physical_quantity - b.theoretical_quantity END AS difference_quantity, CASE WHEN NOT b.in_theoretical_stock THEN 'OUT_OF_SNAPSHOT' WHEN ph.contribution_count > 0 THEN 'COUNTED' ELSE 'NOT_COUNTED' END AS coverage_status, CASE WHEN ph.contribution_count IS NULL THEN 'SIN_CONTEO' WHEN ph.physical_quantity - b.theoretical_quantity < 0 THEN 'FALTANTE' WHEN ph.physical_quantity - b.theoretical_quantity > 0 THEN 'SOBRANTE' ELSE 'SIN_DIFERENCIA' END AS variance_status FROM base b LEFT JOIN physical ph ON ph.bsale_variant_id = b.bsale_variant_id
    ), filtered AS (
        SELECT c.* FROM computed c WHERE (v_search = '' OR c.sku ILIKE '%' || v_search || '%' OR c.name ILIKE '%' || v_search || '%') AND (v_var_status = '' OR c.variance_status = v_var_status) AND (v_cov_status = '' OR c.coverage_status = v_cov_status)
    ), paged AS (
        SELECT f.* FROM filtered f
        ORDER BY CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'SKU' THEN f.sku END ASC NULLS LAST,
                 CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'SKU' THEN f.sku END DESC NULLS LAST,
                 f.sku, f.bsale_variant_id
        LIMIT v_page_size OFFSET v_offset
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object('product_key', f.bsale_variant_id::text, 'bsale_variant_id', f.bsale_variant_id, 'product_id', f.product_id, 'sku', f.sku, 'name', f.name, 'in_theoretical_stock', f.in_theoretical_stock, 'in_any_snapshot', f.in_theoretical_stock, 'theoretical_quantity', f.theoretical_quantity, 'physical_quantity', f.physical_quantity, 'contribution_count', f.contribution_count, 'difference_quantity', f.difference_quantity, 'unit_cost', f.unit_cost, 'difference_value', CASE WHEN f.difference_quantity IS NULL THEN NULL ELSE f.difference_quantity * f.unit_cost END, 'variance_status', f.variance_status, 'coverage_status', f.coverage_status) ORDER BY f.sku, f.bsale_variant_id), '[]'::jsonb)
    INTO v_items FROM paged f;

    RETURN jsonb_build_object('campaign_id', p_campaign_id, 'campaign_status', v_campaign_status, 'is_final', v_is_final,
        'summary', jsonb_build_object('total_products', v_prod_total, 'faltantes', v_prod_faltante, 'sobrantes', v_prod_sobrante, 'sin_diferencia', v_prod_sin_dif, 'out_of_snapshot', v_prod_out_snap, 'contados', v_prod_counted, 'total_theoretical', v_sum_theo, 'total_physical', v_sum_phys, 'total_faltante_units', v_units_faltante, 'total_sobrante_units', v_units_sobrante, 'net_valuation', v_net_val, 'absolute_valuation', v_abs_val),
        'total', v_total, 'page', v_page, 'page_size', v_page_size, 'has_more', v_offset + jsonb_array_length(v_items) < v_total, 'items', v_items);
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer, text, text) TO authenticated, service_role;

COMMIT;
