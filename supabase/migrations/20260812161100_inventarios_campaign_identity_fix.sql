-- Corrección de identidad en contratos del Informe Global del Inventario (V1).
--
-- list_inventory_campaign_variances resuelve ahora sku/name/product_id de los
-- productos contados que no existen en el stock teórico (sobrantes) leyendo
-- snapshot_products por bsale_variant_id.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaign_variances(
    p_company_id uuid,
    p_campaign_id uuid,
    p_search text DEFAULT NULL,
    p_variance_status text DEFAULT NULL,
    p_coverage_status text DEFAULT NULL,
    p_page integer DEFAULT 1,
    p_page_size integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_search text;
    v_var_status text;
    v_cov_status text;
    v_page integer;
    v_page_size integer;
    v_offset integer;
    v_total bigint := 0;
    v_items jsonb;
    v_is_final boolean;
    v_active_sessions bigint;
    v_prod_total bigint := 0;
    v_prod_faltante bigint := 0;
    v_prod_sobrante bigint := 0;
    v_prod_sin_dif bigint := 0;
    v_prod_out_snap bigint := 0;
    v_prod_counted bigint := 0;
    v_sum_theo numeric := 0;
    v_sum_phys numeric := 0;
    v_units_faltante numeric := 0;
    v_units_sobrante numeric := 0;
    v_net_val numeric := 0;
    v_abs_val numeric := 0;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');
    v_search := pg_catalog.btrim(coalesce(p_search, ''));
    v_var_status := pg_catalog.upper(pg_catalog.btrim(coalesce(p_variance_status, '')));
    v_cov_status := pg_catalog.upper(pg_catalog.btrim(coalesce(p_coverage_status, '')));
    v_page := coalesce(p_page, 1);
    v_page_size := coalesce(p_page_size, 50);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 50; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_active_sessions
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND s.status IN ('DRAFT','PREPARED','COUNTING','UNDER_REVIEW');
    v_is_final := (v_active_sessions = 0);

    -- ==========================================================
    -- Resumen global (sin filtros de página).
    -- ==========================================================
    WITH campaign_sessions AS (
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
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.bsale_variant_id IS NOT NULL
        GROUP BY ce.bsale_variant_id
    ),
    snapshot_coverage AS (
        SELECT DISTINCT sp.bsale_variant_id
        FROM inventarios.snapshot_products sp
        JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
        JOIN campaign_sessions cs ON cs.session_id = os.session_id
        WHERE sp.bsale_variant_id IS NOT NULL
    ),
    theoretical AS (
        SELECT csp.bsale_variant_id, csp.product_id, csp.sku, csp.name,
               icts.theoretical_quantity, icts.unit_cost
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id
         AND cs.campaign_id = p_campaign_id
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.company_id = icts.company_id
         AND csp.campaign_snapshot_id = icts.campaign_snapshot_id
         AND csp.id = icts.snapshot_product_id
        WHERE icts.company_id = p_company_id
          AND icts.scope_level = 'TOTAL_CAMPAIGN'
    ),
    base AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku, t.name,
               true AS in_theoretical_stock, t.theoretical_quantity, t.unit_cost
        FROM theoretical t
        UNION ALL
        SELECT ph.bsale_variant_id,
               sv.snapshot_product_id, sv.snapshot_sku, sv.snapshot_name,
               false, 0::numeric, NULL::numeric
        FROM physical ph
        LEFT JOIN LATERAL (
            SELECT sp.product_id AS snapshot_product_id, sp.sku AS snapshot_sku, sp.name AS snapshot_name
            FROM inventarios.snapshot_products sp
            WHERE sp.bsale_variant_id = ph.bsale_variant_id
            ORDER BY sp.sku NULLS LAST
            LIMIT 1
        ) sv ON true
        WHERE NOT EXISTS (SELECT 1 FROM theoretical t2 WHERE t2.bsale_variant_id = ph.bsale_variant_id)
    ),
    dataset AS (
        SELECT b.bsale_variant_id, b.product_id, b.sku, b.name, b.in_theoretical_stock,
               coalesce(b.theoretical_quantity, 0) AS theoretical_quantity,
               coalesce(ph.physical_quantity, 0) AS physical_quantity,
               coalesce(ph.contribution_count, 0) AS contribution_count,
               (EXISTS (SELECT 1 FROM snapshot_coverage sc2 WHERE sc2.bsale_variant_id = b.bsale_variant_id)) AS in_any_snapshot,
               b.unit_cost
        FROM base b
        LEFT JOIN physical ph ON ph.bsale_variant_id = b.bsale_variant_id
    ),
    computed AS (
        SELECT d.*,
               (d.physical_quantity - d.theoretical_quantity) AS difference_quantity,
               CASE
                   WHEN d.physical_quantity > 0 THEN 'COUNTED'
                   WHEN d.in_any_snapshot THEN 'NOT_COUNTED'
                   ELSE 'OUT_OF_SNAPSHOT'
               END AS coverage_status,
               CASE
                   WHEN (d.physical_quantity - d.theoretical_quantity) < 0 THEN 'FALTANTE'
                   WHEN (d.physical_quantity - d.theoretical_quantity) > 0 THEN 'SOBRANTE'
                   ELSE 'SIN_DIFERENCIA'
               END AS variance_status
        FROM dataset d
    )
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE c.variance_status = 'FALTANTE'),
        pg_catalog.count(*) FILTER (WHERE c.variance_status = 'SOBRANTE'),
        pg_catalog.count(*) FILTER (WHERE c.variance_status = 'SIN_DIFERENCIA'),
        pg_catalog.count(*) FILTER (WHERE c.coverage_status = 'OUT_OF_SNAPSHOT'),
        pg_catalog.count(*) FILTER (WHERE c.physical_quantity > 0),
        coalesce(pg_catalog.sum(c.theoretical_quantity), 0),
        coalesce(pg_catalog.sum(c.physical_quantity), 0),
        coalesce(pg_catalog.sum(CASE WHEN c.variance_status = 'FALTANTE' THEN pg_catalog.abs(c.difference_quantity) ELSE 0::numeric END), 0::numeric),
        coalesce(pg_catalog.sum(CASE WHEN c.variance_status = 'SOBRANTE' THEN c.difference_quantity ELSE 0::numeric END), 0::numeric),
        coalesce(pg_catalog.sum(coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric)), 0::numeric),
        coalesce(pg_catalog.sum(pg_catalog.abs(coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric))), 0::numeric)
    INTO v_prod_total, v_prod_faltante, v_prod_sobrante, v_prod_sin_dif,
         v_prod_out_snap, v_prod_counted, v_sum_theo, v_sum_phys,
         v_units_faltante, v_units_sobrante, v_net_val, v_abs_val
    FROM computed c;

    -- ==========================================================
    -- Total filtrado (paginación) + página de items.
    -- ==========================================================
    WITH campaign_sessions AS (
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
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.bsale_variant_id IS NOT NULL
        GROUP BY ce.bsale_variant_id
    ),
    snapshot_coverage AS (
        SELECT DISTINCT sp.bsale_variant_id
        FROM inventarios.snapshot_products sp
        JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
        JOIN campaign_sessions cs ON cs.session_id = os.session_id
        WHERE sp.bsale_variant_id IS NOT NULL
    ),
    theoretical AS (
        SELECT csp.bsale_variant_id, csp.product_id, csp.sku, csp.name,
               icts.theoretical_quantity, icts.unit_cost
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id
         AND cs.campaign_id = p_campaign_id
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.company_id = icts.company_id
         AND csp.campaign_snapshot_id = icts.campaign_snapshot_id
         AND csp.id = icts.snapshot_product_id
        WHERE icts.company_id = p_company_id
          AND icts.scope_level = 'TOTAL_CAMPAIGN'
    ),
    base AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku, t.name,
               true AS in_theoretical_stock, t.theoretical_quantity, t.unit_cost
        FROM theoretical t
        UNION ALL
        SELECT ph.bsale_variant_id,
               sv.snapshot_product_id, sv.snapshot_sku, sv.snapshot_name,
               false, 0::numeric, NULL::numeric
        FROM physical ph
        LEFT JOIN LATERAL (
            SELECT sp.product_id AS snapshot_product_id, sp.sku AS snapshot_sku, sp.name AS snapshot_name
            FROM inventarios.snapshot_products sp
            WHERE sp.bsale_variant_id = ph.bsale_variant_id
            ORDER BY sp.sku NULLS LAST
            LIMIT 1
        ) sv ON true
        WHERE NOT EXISTS (SELECT 1 FROM theoretical t2 WHERE t2.bsale_variant_id = ph.bsale_variant_id)
    ),
    dataset AS (
        SELECT b.bsale_variant_id, b.product_id, b.sku, b.name, b.in_theoretical_stock,
               coalesce(b.theoretical_quantity, 0) AS theoretical_quantity,
               coalesce(ph.physical_quantity, 0) AS physical_quantity,
               coalesce(ph.contribution_count, 0) AS contribution_count,
               (EXISTS (SELECT 1 FROM snapshot_coverage sc2 WHERE sc2.bsale_variant_id = b.bsale_variant_id)) AS in_any_snapshot,
               b.unit_cost,
               (b.bsale_variant_id::text) AS product_key
        FROM base b
        LEFT JOIN physical ph ON ph.bsale_variant_id = b.bsale_variant_id
    ),
    computed AS (
        SELECT d.*,
               (d.physical_quantity - d.theoretical_quantity) AS difference_quantity,
               CASE
                   WHEN d.physical_quantity > 0 THEN 'COUNTED'
                   WHEN d.in_any_snapshot THEN 'NOT_COUNTED'
                   ELSE 'OUT_OF_SNAPSHOT'
               END AS coverage_status,
               CASE
                   WHEN (d.physical_quantity - d.theoretical_quantity) < 0 THEN 'FALTANTE'
                   WHEN (d.physical_quantity - d.theoretical_quantity) > 0 THEN 'SOBRANTE'
                   ELSE 'SIN_DIFERENCIA'
               END AS variance_status
        FROM dataset d
    ),
    filtered AS (
        SELECT c.*
        FROM computed c
        WHERE (v_search = '' OR c.sku ILIKE '%' || v_search || '%' OR c.name ILIKE '%' || v_search || '%')
          AND (v_var_status = '' OR c.variance_status = v_var_status)
          AND (v_cov_status = '' OR c.coverage_status = v_cov_status)
    )
    SELECT pg_catalog.count(*)
    INTO v_total
    FROM filtered f;

    WITH campaign_sessions AS (
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
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.bsale_variant_id IS NOT NULL
        GROUP BY ce.bsale_variant_id
    ),
    snapshot_coverage AS (
        SELECT DISTINCT sp.bsale_variant_id
        FROM inventarios.snapshot_products sp
        JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
        JOIN campaign_sessions cs ON cs.session_id = os.session_id
        WHERE sp.bsale_variant_id IS NOT NULL
    ),
    theoretical AS (
        SELECT csp.bsale_variant_id, csp.product_id, csp.sku, csp.name,
               icts.theoretical_quantity, icts.unit_cost
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id
         AND cs.campaign_id = p_campaign_id
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.company_id = icts.company_id
         AND csp.campaign_snapshot_id = icts.campaign_snapshot_id
         AND csp.id = icts.snapshot_product_id
        WHERE icts.company_id = p_company_id
          AND icts.scope_level = 'TOTAL_CAMPAIGN'
    ),
    base AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku, t.name,
               true AS in_theoretical_stock, t.theoretical_quantity, t.unit_cost
        FROM theoretical t
        UNION ALL
        SELECT ph.bsale_variant_id,
               sv.snapshot_product_id, sv.snapshot_sku, sv.snapshot_name,
               false, 0::numeric, NULL::numeric
        FROM physical ph
        LEFT JOIN LATERAL (
            SELECT sp.product_id AS snapshot_product_id, sp.sku AS snapshot_sku, sp.name AS snapshot_name
            FROM inventarios.snapshot_products sp
            WHERE sp.bsale_variant_id = ph.bsale_variant_id
            ORDER BY sp.sku NULLS LAST
            LIMIT 1
        ) sv ON true
        WHERE NOT EXISTS (SELECT 1 FROM theoretical t2 WHERE t2.bsale_variant_id = ph.bsale_variant_id)
    ),
    dataset AS (
        SELECT b.bsale_variant_id, b.product_id, b.sku, b.name, b.in_theoretical_stock,
               coalesce(b.theoretical_quantity, 0) AS theoretical_quantity,
               coalesce(ph.physical_quantity, 0) AS physical_quantity,
               coalesce(ph.contribution_count, 0) AS contribution_count,
               (EXISTS (SELECT 1 FROM snapshot_coverage sc2 WHERE sc2.bsale_variant_id = b.bsale_variant_id)) AS in_any_snapshot,
               b.unit_cost,
               (b.bsale_variant_id::text) AS product_key
        FROM base b
        LEFT JOIN physical ph ON ph.bsale_variant_id = b.bsale_variant_id
    ),
    computed AS (
        SELECT d.*,
               (d.physical_quantity - d.theoretical_quantity) AS difference_quantity,
               CASE
                   WHEN d.physical_quantity > 0 THEN 'COUNTED'
                   WHEN d.in_any_snapshot THEN 'NOT_COUNTED'
                   ELSE 'OUT_OF_SNAPSHOT'
               END AS coverage_status,
               CASE
                   WHEN (d.physical_quantity - d.theoretical_quantity) < 0 THEN 'FALTANTE'
                   WHEN (d.physical_quantity - d.theoretical_quantity) > 0 THEN 'SOBRANTE'
                   ELSE 'SIN_DIFERENCIA'
               END AS variance_status
        FROM dataset d
    )
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'product_key', c.product_key,
                'bsale_variant_id', c.bsale_variant_id,
                'product_id', c.product_id,
                'sku', c.sku,
                'name', c.name,
                'in_theoretical_stock', c.in_theoretical_stock,
                'in_any_snapshot', c.in_any_snapshot,
                'theoretical_quantity', c.theoretical_quantity,
                'physical_quantity', c.physical_quantity,
                'contribution_count', c.contribution_count,
                'difference_quantity', c.difference_quantity,
                'unit_cost', c.unit_cost,
                'difference_value', coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric),
                'variance_status', c.variance_status,
                'coverage_status', c.coverage_status
            ) ORDER BY c.sku, c.bsale_variant_id
        )
    END
    INTO v_items
    FROM computed c
    WHERE (v_search = '' OR c.sku ILIKE '%' || v_search || '%' OR c.name ILIKE '%' || v_search || '%')
      AND (v_var_status = '' OR c.variance_status = v_var_status)
      AND (v_cov_status = '' OR c.coverage_status = v_cov_status)
    LIMIT v_page_size OFFSET v_offset;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'is_final', v_is_final,
        'summary', pg_catalog.jsonb_build_object(
            'total_products', v_prod_total,
            'faltantes', v_prod_faltante,
            'sobrantes', v_prod_sobrante,
            'sin_diferencia', v_prod_sin_dif,
            'out_of_snapshot', v_prod_out_snap,
            'contados', v_prod_counted,
            'total_theoretical', v_sum_theo,
            'total_physical', v_sum_phys,
            'total_faltante_units', v_units_faltante,
            'total_sobrante_units', v_units_sobrante,
            'net_valuation', v_net_val,
            'absolute_valuation', v_abs_val
        ),
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'has_more', v_offset + pg_catalog.jsonb_array_length(CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END) < v_total,
        'items', CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_review_summary(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_stock jsonb;
    v_operation jsonb;
    v_sessions_total bigint := 0;
    v_sessions_draft bigint := 0;
    v_sessions_prepared bigint := 0;
    v_sessions_counting bigint := 0;
    v_sessions_review bigint := 0;
    v_sessions_approved bigint := 0;
    v_zones_total bigint := 0;
    v_zones_completed bigint := 0;
    v_zones_in_progress bigint := 0;
    v_zones_not_started bigint := 0;
    v_locations_total bigint := 0;
    v_locations_visited bigint := 0;
    v_locations_open bigint := 0;
    v_locations_visited_no_counts bigint := 0;
    v_locations_never_visited bigint := 0;
    v_pending_barcodes bigint := 0;
    v_blocking_incidents bigint := 0;
    v_pending_recounts bigint := 0;
    v_products_theoretical bigint := 0;
    v_products_counted bigint := 0;
    v_products_with_difference bigint := 0;
    v_faltantes bigint := 0;
    v_sobrantes bigint := 0;
    v_sin_diferencia bigint := 0;
    v_out_of_snapshot bigint := 0;
    v_units_faltante numeric := 0;
    v_units_sobrante numeric := 0;
    v_net_valuation numeric := 0;
    v_abs_valuation numeric := 0;
    v_is_final boolean;
    v_active_sessions bigint := 0;
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

    -- ---------- Operación ----------
    SELECT pg_catalog.count(*) INTO v_sessions_total
    FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id;

    SELECT
        pg_catalog.count(*) FILTER (WHERE status = 'DRAFT'),
        pg_catalog.count(*) FILTER (WHERE status = 'PREPARED'),
        pg_catalog.count(*) FILTER (WHERE status = 'COUNTING'),
        pg_catalog.count(*) FILTER (WHERE status = 'UNDER_REVIEW'),
        pg_catalog.count(*) FILTER (WHERE status = 'APPROVED')
    INTO v_sessions_draft, v_sessions_prepared, v_sessions_counting, v_sessions_review, v_sessions_approved
    FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id;

    v_active_sessions := v_sessions_draft + v_sessions_prepared + v_sessions_counting + v_sessions_review;
    v_is_final := (v_active_sessions = 0);

    WITH z AS (
        SELECT sz.id, coalesce(max(t.status), 'ASSIGNED') AS task_status
        FROM inventarios.session_zones sz
        JOIN inventarios.sessions s ON s.company_id = sz.company_id AND s.id = sz.session_id
        LEFT JOIN inventarios.tasks t ON t.company_id = sz.company_id AND t.session_id = sz.session_id
            AND t.session_zone_id = sz.id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
        WHERE s.campaign_id = p_campaign_id
        GROUP BY sz.id
    )
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE task_status = 'COMPLETED'),
        pg_catalog.count(*) FILTER (WHERE task_status IN ('IN_PROGRESS','PAUSED')),
        pg_catalog.count(*) FILTER (WHERE task_status = 'ASSIGNED')
    INTO v_zones_total, v_zones_completed, v_zones_in_progress, v_zones_not_started
    FROM z;

    SELECT pg_catalog.count(*) INTO v_locations_total
    FROM inventarios.session_zone_locations szl
    JOIN inventarios.sessions s ON s.company_id = szl.company_id AND s.id = szl.session_id
    WHERE s.campaign_id = p_campaign_id;

    SELECT pg_catalog.count(*) INTO v_locations_visited
    FROM inventarios.task_locations tl
    JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
    WHERE s.campaign_id = p_campaign_id;

    SELECT pg_catalog.count(*) INTO v_locations_open
    FROM inventarios.task_locations tl
    JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
    WHERE s.campaign_id = p_campaign_id AND tl.status = 'OPEN';

    SELECT pg_catalog.count(*) INTO v_locations_visited_no_counts
    FROM (
        SELECT tl.id
        FROM inventarios.task_locations tl
        JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
        WHERE s.campaign_id = p_campaign_id
          AND NOT EXISTS (
              SELECT 1
              FROM inventarios.count_entries ce
              JOIN inventarios.session_zone_locations szl2
                ON szl2.company_id = ce.company_id
               AND szl2.session_id = ce.session_id
               AND szl2.session_zone_id = ce.session_zone_id
               AND szl2.snapshot_location_id = ce.snapshot_location_id
              WHERE ce.company_id = tl.company_id AND ce.session_id = tl.session_id
                AND szl2.id = tl.session_zone_location_id
                AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
          )
    ) x;

    v_locations_never_visited := GREATEST(v_locations_total - v_locations_visited, 0);

    SELECT pg_catalog.count(*) INTO v_pending_barcodes
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
    WHERE s.campaign_id = p_campaign_id AND pbp.status = 'PENDING_REVIEW';

    SELECT pg_catalog.count(*) INTO v_blocking_incidents
    FROM inventarios.incidents i
    JOIN inventarios.sessions s ON s.company_id = i.company_id AND s.id = i.session_id
    WHERE s.campaign_id = p_campaign_id AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW');

    SELECT pg_catalog.count(*) INTO v_pending_recounts
    FROM inventarios.recount_requests rr
    JOIN inventarios.sessions s ON s.company_id = rr.company_id AND s.id = rr.session_id
    WHERE s.campaign_id = p_campaign_id AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS');

    v_operation := pg_catalog.jsonb_build_object(
        'total_sessions', v_sessions_total,
        'sessions_by_status', pg_catalog.jsonb_build_object(
            'DRAFT', v_sessions_draft, 'PREPARED', v_sessions_prepared,
            'COUNTING', v_sessions_counting, 'UNDER_REVIEW', v_sessions_review,
            'APPROVED', v_sessions_approved),
        'zones_total', v_zones_total,
        'zones_completed', v_zones_completed,
        'zones_in_progress', v_zones_in_progress,
        'zones_not_started', v_zones_not_started,
        'locations_total', v_locations_total,
        'locations_visited', v_locations_visited,
        'locations_open', v_locations_open,
        'locations_visited_without_counts', v_locations_visited_no_counts,
        'locations_never_visited', v_locations_never_visited,
        'pending_barcode_proposals', v_pending_barcodes,
        'blocking_incident_count', v_blocking_incidents,
        'pending_recount_count', v_pending_recounts
    );

    -- ---------- Stock / diferencias ----------
    SELECT pg_catalog.count(*) INTO v_products_theoretical
    FROM inventarios.inventory_campaign_theoretical_stocks icts
    JOIN inventarios.inventory_campaign_snapshots cs
      ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id AND cs.campaign_id = p_campaign_id
    WHERE icts.company_id = p_company_id AND icts.scope_level = 'TOTAL_CAMPAIGN';

    WITH campaign_sessions AS (
        SELECT s.id AS session_id FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
    ),
    campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t JOIN campaign_sessions cs ON cs.session_id = t.session_id
        WHERE t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ),
    physical AS (
        SELECT ce.bsale_variant_id, pg_catalog.sum(ce.physical_quantity) AS physical_quantity
        FROM campaign_tasks ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.bsale_variant_id IS NOT NULL
        GROUP BY ce.bsale_variant_id
    ),
    snapshot_coverage AS (
        SELECT DISTINCT sp.bsale_variant_id
        FROM inventarios.snapshot_products sp
        JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
        JOIN campaign_sessions cs ON cs.session_id = os.session_id
        WHERE sp.bsale_variant_id IS NOT NULL
    ),
    theoretical AS (
        SELECT csp.bsale_variant_id, icts.theoretical_quantity, icts.unit_cost
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id AND cs.campaign_id = p_campaign_id
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.company_id = icts.company_id AND csp.campaign_snapshot_id = icts.campaign_snapshot_id AND csp.id = icts.snapshot_product_id
        WHERE icts.company_id = p_company_id AND icts.scope_level = 'TOTAL_CAMPAIGN'
    ),
    base AS (
        SELECT t.bsale_variant_id, t.theoretical_quantity, t.unit_cost, true AS in_theoretical_stock
        FROM theoretical t
        UNION ALL
        SELECT ph.bsale_variant_id, 0::numeric, NULL::numeric, false
        FROM physical ph
        WHERE NOT EXISTS (SELECT 1 FROM theoretical t2 WHERE t2.bsale_variant_id = ph.bsale_variant_id)
    ),
    dataset AS (
        SELECT b.bsale_variant_id, b.theoretical_quantity,
               coalesce(ph.physical_quantity, 0) AS physical_quantity,
               (EXISTS (SELECT 1 FROM snapshot_coverage sc2 WHERE sc2.bsale_variant_id = b.bsale_variant_id)) AS in_any_snapshot,
               b.unit_cost
        FROM base b LEFT JOIN physical ph ON ph.bsale_variant_id = b.bsale_variant_id
    ),
    computed AS (
        SELECT d.*,
               (d.physical_quantity - d.theoretical_quantity) AS difference_quantity,
               CASE WHEN d.physical_quantity > 0 THEN 'COUNTED'
                    WHEN d.in_any_snapshot THEN 'NOT_COUNTED'
                    ELSE 'OUT_OF_SNAPSHOT' END AS coverage_status,
               CASE WHEN (d.physical_quantity - d.theoretical_quantity) < 0 THEN 'FALTANTE'
                    WHEN (d.physical_quantity - d.theoretical_quantity) > 0 THEN 'SOBRANTE'
                    ELSE 'SIN_DIFERENCIA' END AS variance_status
        FROM dataset d
    )
    SELECT
        pg_catalog.count(*) FILTER (WHERE c.physical_quantity > 0),
        pg_catalog.count(*) FILTER (WHERE c.variance_status <> 'SIN_DIFERENCIA'),
        pg_catalog.count(*) FILTER (WHERE c.variance_status = 'FALTANTE'),
        pg_catalog.count(*) FILTER (WHERE c.variance_status = 'SOBRANTE'),
        pg_catalog.count(*) FILTER (WHERE c.variance_status = 'SIN_DIFERENCIA'),
        pg_catalog.count(*) FILTER (WHERE c.coverage_status = 'OUT_OF_SNAPSHOT'),
        coalesce(pg_catalog.sum(CASE WHEN c.variance_status = 'FALTANTE' THEN pg_catalog.abs(c.difference_quantity) ELSE 0::numeric END), 0::numeric),
        coalesce(pg_catalog.sum(CASE WHEN c.variance_status = 'SOBRANTE' THEN c.difference_quantity ELSE 0::numeric END), 0::numeric),
        coalesce(pg_catalog.sum(coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric)), 0::numeric),
        coalesce(pg_catalog.sum(pg_catalog.abs(coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric))), 0::numeric)
    INTO v_products_counted, v_products_with_difference, v_faltantes, v_sobrantes,
         v_sin_diferencia, v_out_of_snapshot, v_units_faltante, v_units_sobrante,
         v_net_valuation, v_abs_valuation
    FROM computed c;

    v_stock := pg_catalog.jsonb_build_object(
        'products_theoretical', v_products_theoretical,
        'products_counted', v_products_counted,
        'products_with_difference', v_products_with_difference,
        'faltantes', v_faltantes,
        'sobrantes', v_sobrantes,
        'sin_diferencia', v_sin_diferencia,
        'out_of_snapshot', v_out_of_snapshot,
        'units_faltante', v_units_faltante,
        'units_sobrante', v_units_sobrante,
        'net_valuation', v_net_valuation,
        'absolute_valuation', v_abs_valuation
    );

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'is_final', v_is_final,
        'stock', v_stock,
        'operation', v_operation
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_review_summary(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_product_breakdown(
    p_company_id uuid,
    p_campaign_id uuid,
    p_bsale_variant_id integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_header jsonb;
    v_contributions jsonb;
    v_is_final boolean;
    v_active_sessions bigint;
    v_sku text;
    v_name text;
    v_product_id uuid;
    v_theoretical_quantity numeric := 0;
    v_physical_quantity numeric := 0;
    v_unit_cost numeric;
    v_difference_quantity numeric := 0;
    v_in_theoretical_stock boolean := false;
    v_in_any_snapshot boolean := false;
    v_coverage_status text;
    v_variance_status text;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_bsale_variant_id IS NULL THEN
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

    SELECT pg_catalog.count(*) INTO v_active_sessions
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND s.status IN ('DRAFT','PREPARED','COUNTING','UNDER_REVIEW');
    v_is_final := (v_active_sessions = 0);

    -- Cabecera: teórico global oficial.
    SELECT icts.theoretical_quantity, icts.unit_cost,
           csp.sku, csp.name, csp.product_id
    INTO v_theoretical_quantity, v_unit_cost, v_sku, v_name, v_product_id
    FROM inventarios.inventory_campaign_theoretical_stocks icts
    JOIN inventarios.inventory_campaign_snapshots cs
      ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id AND cs.campaign_id = p_campaign_id
    JOIN inventarios.inventory_campaign_snapshot_products csp
      ON csp.company_id = icts.company_id AND csp.campaign_snapshot_id = icts.campaign_snapshot_id AND csp.id = icts.snapshot_product_id
    WHERE icts.company_id = p_company_id AND icts.scope_level = 'TOTAL_CAMPAIGN'
      AND csp.bsale_variant_id = p_bsale_variant_id;

    IF FOUND THEN
        v_in_theoretical_stock := true;
    ELSE
        -- Sobrante sin teórico: resolver identidad desde el snapshot de las secciones.
        SELECT sp2.sku, sp2.name, sp2.product_id
        INTO v_sku, v_name, v_product_id
        FROM inventarios.snapshot_products sp2
        WHERE sp2.bsale_variant_id = p_bsale_variant_id
          AND sp2.product_id IS NOT NULL
        ORDER BY sp2.sku
        LIMIT 1;
    END IF;
    IF v_name IS NULL THEN
        v_name := 'PRODUCTO ' || p_bsale_variant_id::text;
    END IF;

    -- ¿Está en algún snapshot de las secciones?
    SELECT EXISTS (
        SELECT 1
        FROM inventarios.snapshot_products sp
        JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
        JOIN inventarios.sessions s ON s.company_id = os.company_id AND s.id = os.session_id
        WHERE s.campaign_id = p_campaign_id AND sp.bsale_variant_id = p_bsale_variant_id
    ) INTO v_in_any_snapshot;

    -- Físico efectivo global.
    SELECT pg_catalog.sum(ce.physical_quantity)
    INTO v_physical_quantity
    FROM (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ) ct
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    WHERE ce.bsale_variant_id = p_bsale_variant_id;

    IF v_physical_quantity IS NULL THEN v_physical_quantity := 0; END IF;
    v_difference_quantity := v_physical_quantity - v_theoretical_quantity;

    v_coverage_status := CASE
        WHEN v_physical_quantity > 0 THEN 'COUNTED'
        WHEN v_in_any_snapshot THEN 'NOT_COUNTED'
        ELSE 'OUT_OF_SNAPSHOT' END;
    v_variance_status := CASE
        WHEN v_difference_quantity < 0 THEN 'FALTANTE'
        WHEN v_difference_quantity > 0 THEN 'SOBRANTE'
        ELSE 'SIN_DIFERENCIA' END;

    -- Contribuciones detalladas.
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'session_id', s.id,
                'session_name', s.name,
                'session_status', s.status,
                'zone_code', sz.zone_code,
                'zone_name', sz.display_name,
                'location_code', sl.code,
                'location_name', sl.name,
                'counted_by', ce.counted_by,
                'counted_by_name', inventarios.user_display_name(ce.counted_by),
                'physical_quantity', ce.physical_quantity,
                'identification_method', ce.identification_method,
                'scanned_code', ce.scanned_code,
                'captured_at', ce.captured_at,
                'contribution_source', g.contribution_source,
                'task_cycle', ce.task_cycle
            ) ORDER BY ce.captured_at, s.name, sz.zone_code, sl.code
        )
    END
    INTO v_contributions
    FROM (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ) ct
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    LEFT JOIN inventarios.session_zones sz ON sz.company_id = ce.company_id AND sz.session_id = ce.session_id AND sz.id = ce.session_zone_id
    LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = ce.company_id AND sl.snapshot_id = ce.snapshot_id AND sl.id = ce.snapshot_location_id
    WHERE ce.bsale_variant_id = p_bsale_variant_id;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'is_final', v_is_final,
        'header', pg_catalog.jsonb_build_object(
            'bsale_variant_id', p_bsale_variant_id,
            'sku', v_sku,
            'name', v_name,
            'product_id', v_product_id,
            'in_theoretical_stock', v_in_theoretical_stock,
            'in_any_snapshot', v_in_any_snapshot,
            'theoretical_quantity', v_theoretical_quantity,
            'physical_quantity', v_physical_quantity,
            'difference_quantity', v_difference_quantity,
            'unit_cost', v_unit_cost,
            'difference_value', coalesce(v_difference_quantity, 0) * coalesce(v_unit_cost, 0),
            'variance_status', v_variance_status,
            'coverage_status', v_coverage_status
        ),
        'contributions', CASE WHEN v_contributions IS NULL THEN '[]'::jsonb ELSE v_contributions END
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_product_breakdown(uuid, uuid, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_close_readiness(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_sessions_draft bigint := 0;
    v_sessions_prepared bigint := 0;
    v_sessions_counting bigint := 0;
    v_sessions_review bigint := 0;
    v_sessions_approved bigint := 0;
    v_tasks_assigned bigint := 0;
    v_tasks_in_progress bigint := 0;
    v_tasks_paused bigint := 0;
    v_locations_open bigint := 0;
    v_locations_never_visited bigint := 0;
    v_locations_visited_no_counts bigint := 0;
    v_zones_not_started bigint := 0;
    v_zones_incomplete bigint := 0;
    v_blocking_incidents bigint := 0;
    v_pending_recounts bigint := 0;
    v_pending_barcodes bigint := 0;
    v_out_of_snapshot bigint := 0;
    v_locations_total bigint := 0;
    v_locations_visited bigint := 0;
    v_zones_total bigint := 0;
    v_zones_completed bigint := 0;
    v_can_close boolean;
    v_warnings jsonb;
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

    SELECT
        pg_catalog.count(*) FILTER (WHERE status = 'DRAFT'),
        pg_catalog.count(*) FILTER (WHERE status = 'PREPARED'),
        pg_catalog.count(*) FILTER (WHERE status = 'COUNTING'),
        pg_catalog.count(*) FILTER (WHERE status = 'UNDER_REVIEW'),
        pg_catalog.count(*) FILTER (WHERE status = 'APPROVED')
    INTO v_sessions_draft, v_sessions_prepared, v_sessions_counting, v_sessions_review, v_sessions_approved
    FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id;

    SELECT
        pg_catalog.count(*) FILTER (WHERE t.status = 'ASSIGNED'),
        pg_catalog.count(*) FILTER (WHERE t.status = 'IN_PROGRESS'),
        pg_catalog.count(*) FILTER (WHERE t.status = 'PAUSED')
    INTO v_tasks_assigned, v_tasks_in_progress, v_tasks_paused
    FROM inventarios.tasks t
    JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
    WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL;

    SELECT pg_catalog.count(*) INTO v_locations_total
    FROM inventarios.session_zone_locations szl
    JOIN inventarios.sessions s ON s.company_id = szl.company_id AND s.id = szl.session_id
    WHERE s.campaign_id = p_campaign_id;

    SELECT pg_catalog.count(*) INTO v_locations_visited
    FROM inventarios.task_locations tl
    JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
    WHERE s.campaign_id = p_campaign_id;

    SELECT pg_catalog.count(*) INTO v_locations_open
    FROM inventarios.task_locations tl
    JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
    WHERE s.campaign_id = p_campaign_id AND tl.status = 'OPEN';

    SELECT pg_catalog.count(*) INTO v_locations_visited_no_counts
    FROM (
        SELECT tl.id
        FROM inventarios.task_locations tl
        JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
        WHERE s.campaign_id = p_campaign_id
          AND NOT EXISTS (
              SELECT 1
              FROM inventarios.count_entries ce
              JOIN inventarios.session_zone_locations szl2
                ON szl2.company_id = ce.company_id
               AND szl2.session_id = ce.session_id
               AND szl2.session_zone_id = ce.session_zone_id
               AND szl2.snapshot_location_id = ce.snapshot_location_id
              WHERE ce.company_id = tl.company_id AND ce.session_id = tl.session_id
                AND szl2.id = tl.session_zone_location_id
                AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
          )
    ) x;

    v_locations_never_visited := GREATEST(v_locations_total - v_locations_visited, 0);

    WITH z AS (
        SELECT sz.id, coalesce(max(t.status), 'ASSIGNED') AS task_status
        FROM inventarios.session_zones sz
        JOIN inventarios.sessions s ON s.company_id = sz.company_id AND s.id = sz.session_id
        LEFT JOIN inventarios.tasks t ON t.company_id = sz.company_id AND t.session_id = sz.session_id
            AND t.session_zone_id = sz.id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
        WHERE s.campaign_id = p_campaign_id
        GROUP BY sz.id
    )
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE task_status = 'COMPLETED'),
        pg_catalog.count(*) FILTER (WHERE task_status = 'ASSIGNED'),
        pg_catalog.count(*) FILTER (WHERE task_status IN ('IN_PROGRESS','PAUSED'))
    INTO v_zones_total, v_zones_completed, v_zones_not_started, v_zones_incomplete
    FROM z;

    SELECT pg_catalog.count(*) INTO v_blocking_incidents
    FROM inventarios.incidents i
    JOIN inventarios.sessions s ON s.company_id = i.company_id AND s.id = i.session_id
    WHERE s.campaign_id = p_campaign_id AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW');

    SELECT pg_catalog.count(*) INTO v_pending_recounts
    FROM inventarios.recount_requests rr
    JOIN inventarios.sessions s ON s.company_id = rr.company_id AND s.id = rr.session_id
    WHERE s.campaign_id = p_campaign_id AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS');

    SELECT pg_catalog.count(*) INTO v_pending_barcodes
    FROM inventarios.product_barcode_proposals pbp
    JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
    WHERE s.campaign_id = p_campaign_id AND pbp.status = 'PENDING_REVIEW';

    SELECT pg_catalog.count(*) INTO v_out_of_snapshot
    FROM inventarios.inventory_campaign_theoretical_stocks icts
    JOIN inventarios.inventory_campaign_snapshots cs
      ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id AND cs.campaign_id = p_campaign_id
    JOIN inventarios.inventory_campaign_snapshot_products csp
      ON csp.company_id = icts.company_id AND csp.campaign_snapshot_id = icts.campaign_snapshot_id AND csp.id = icts.snapshot_product_id
    WHERE icts.company_id = p_company_id AND icts.scope_level = 'TOTAL_CAMPAIGN'
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.snapshot_products sp
          JOIN inventarios.operational_snapshots os ON os.id = sp.snapshot_id AND os.company_id = sp.company_id
          JOIN inventarios.sessions s ON s.company_id = os.company_id AND s.id = os.session_id
          WHERE s.campaign_id = p_campaign_id AND sp.bsale_variant_id = csp.bsale_variant_id
      );

    v_can_close := (
        v_sessions_draft = 0
        AND v_sessions_prepared = 0
        AND v_sessions_counting = 0
        AND v_sessions_review = 0
        AND v_blocking_incidents = 0
        AND v_pending_recounts = 0
    );

    v_warnings := pg_catalog.jsonb_build_object(
        'sessions_draft', v_sessions_draft,
        'sessions_prepared', v_sessions_prepared,
        'sessions_counting', v_sessions_counting,
        'sessions_under_review', v_sessions_review,
        'tasks_assigned', v_tasks_assigned,
        'tasks_in_progress', v_tasks_in_progress,
        'tasks_paused', v_tasks_paused,
        'locations_open', v_locations_open,
        'locations_never_visited', v_locations_never_visited,
        'locations_visited_without_counts', v_locations_visited_no_counts,
        'zones_not_started', v_zones_not_started,
        'zones_incomplete', v_zones_incomplete,
        'blocking_incident_count', v_blocking_incidents,
        'pending_recount_count', v_pending_recounts,
        'pending_barcode_proposals', v_pending_barcodes,
        'products_out_of_snapshot', v_out_of_snapshot
    );

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'can_close', v_can_close,
        'summary', pg_catalog.jsonb_build_object(
            'sessions_total', v_sessions_draft + v_sessions_prepared + v_sessions_counting + v_sessions_review + v_sessions_approved,
            'sessions_approved', v_sessions_approved,
            'zones_total', v_zones_total,
            'zones_completed', v_zones_completed,
            'locations_total', v_locations_total,
            'locations_visited', v_locations_visited
        ),
        'warnings', v_warnings
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_close_readiness(uuid, uuid) TO authenticated, service_role;

COMMIT;
