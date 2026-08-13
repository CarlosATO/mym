-- Corrección de la descripción visible (name) del Informe Global del Inventario.
--
-- El Informe resolvía 'name' desde snapshot_products de la sesión (descripción
-- corta de variante, p.ej. '380GR','2KG'), mostrando nombres incompletos en UI,
-- breakdown y en la hoja 'Detalle de conteos' del Excel.
--
-- Se introduce inventarios.campaign_product_display_name(bsale_variant_id) con
-- prioridad de fuentes (catálogo maestro read-only):
--   1) adquisiciones.products.description (descripción comercial completa oficial)
--   2) integraciones.bsale_products.name + bsale_variants.description
--   3) NULL (cada RPC conserva su propio fallback)
--
-- Los tres contratos (variances, breakdown, export) se alinean a esta fuente.
-- Esquema afectado EXCLUSIVAMENTE: inventarios (DDL).

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.campaign_product_display_name(
    p_bsale_variant_id integer
)
RETURNS text
LANGUAGE sql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
    SELECT
        COALESCE(
            NULLIF(pg_catalog.btrim(ap.description), ''),
            NULLIF(pg_catalog.btrim(pg_catalog.concat_ws(' - ', bp.name, bv.description)), ''),
            NULL
        )
    FROM adquisiciones.products ap
    LEFT JOIN integraciones.bsale_variants bv
      ON bv.company_id = ap.company_id AND bv.bsale_id = ap.bsale_variant_id
    LEFT JOIN integraciones.bsale_products bp
      ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
    WHERE ap.bsale_variant_id = p_bsale_variant_id
    ORDER BY ap.is_active DESC NULLS LAST, ap.sku NULLS LAST
    LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaign_variances(
    p_company_id uuid,
    p_campaign_id uuid,
    p_search text DEFAULT NULL,
    p_variance_status text DEFAULT NULL::text,
    p_coverage_status text DEFAULT NULL::text,
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
    v_search text;
    v_var_status text;
    v_cov_status text;
    v_sort_by text;
    v_sort_dir text;
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
    v_sort_by := pg_catalog.upper(pg_catalog.btrim(coalesce(p_sort_by, '')));
    v_sort_dir := pg_catalog.upper(pg_catalog.btrim(coalesce(p_sort_direction, 'ASC')));
    IF v_sort_by <> '' AND v_sort_by NOT IN ('SKU','NAME','THEORETICAL','PHYSICAL','DIFFERENCE','VARIANCE_STATUS','COVERAGE_STATUS','UNIT_COST','DIFFERENCE_VALUE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF v_sort_dir NOT IN ('ASC','DESC') THEN v_sort_dir := 'ASC'; END IF;
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
            SELECT sp.product_id AS snapshot_product_id, sp.sku AS snapshot_sku,
                   coalesce(NULLIF(inventarios.campaign_product_display_name(sp.bsale_variant_id), ''), sp.name) AS snapshot_name
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
            SELECT sp.product_id AS snapshot_product_id, sp.sku AS snapshot_sku,
                   coalesce(NULLIF(inventarios.campaign_product_display_name(sp.bsale_variant_id), ''), sp.name) AS snapshot_name
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
            SELECT sp.product_id AS snapshot_product_id, sp.sku AS snapshot_sku,
                   coalesce(NULLIF(inventarios.campaign_product_display_name(sp.bsale_variant_id), ''), sp.name) AS snapshot_name
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
            ) ORDER BY
                CASE
                    WHEN v_sort_dir = 'ASC' AND v_sort_by = 'SKU' THEN c.sku
                    WHEN v_sort_dir = 'ASC' AND v_sort_by = 'NAME' THEN c.name
                    WHEN v_sort_dir = 'ASC' AND v_sort_by = 'VARIANCE_STATUS' THEN c.variance_status
                    WHEN v_sort_dir = 'ASC' AND v_sort_by = 'COVERAGE_STATUS' THEN c.coverage_status
                END ASC NULLS LAST,
                CASE
                    WHEN v_sort_dir = 'DESC' AND v_sort_by = 'SKU' THEN c.sku
                    WHEN v_sort_dir = 'DESC' AND v_sort_by = 'NAME' THEN c.name
                    WHEN v_sort_dir = 'DESC' AND v_sort_by = 'VARIANCE_STATUS' THEN c.variance_status
                    WHEN v_sort_dir = 'DESC' AND v_sort_by = 'COVERAGE_STATUS' THEN c.coverage_status
                END DESC NULLS LAST,
                CASE
                    WHEN v_sort_dir = 'ASC' AND v_sort_by = 'THEORETICAL' THEN c.theoretical_quantity
                    WHEN v_sort_dir = 'ASC' AND v_sort_by = 'PHYSICAL' THEN c.physical_quantity
                    WHEN v_sort_dir = 'ASC' AND v_sort_by = 'DIFFERENCE' THEN c.difference_quantity
                    WHEN v_sort_dir = 'ASC' AND v_sort_by = 'UNIT_COST' THEN c.unit_cost
                    WHEN v_sort_dir = 'ASC' AND v_sort_by = 'DIFFERENCE_VALUE' THEN coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric)
                END ASC NULLS LAST,
                CASE
                    WHEN v_sort_dir = 'DESC' AND v_sort_by = 'THEORETICAL' THEN c.theoretical_quantity
                    WHEN v_sort_dir = 'DESC' AND v_sort_by = 'PHYSICAL' THEN c.physical_quantity
                    WHEN v_sort_dir = 'DESC' AND v_sort_by = 'DIFFERENCE' THEN c.difference_quantity
                    WHEN v_sort_dir = 'DESC' AND v_sort_by = 'UNIT_COST' THEN c.unit_cost
                    WHEN v_sort_dir = 'DESC' AND v_sort_by = 'DIFFERENCE_VALUE' THEN coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric)
                END DESC NULLS LAST,
                c.sku, c.bsale_variant_id
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
        v_theoretical_quantity := 0;
        v_unit_cost := NULL;
        -- Sobrante sin teórico: resolver identidad desde el snapshot de las secciones.
        SELECT sp2.sku, coalesce(NULLIF(inventarios.campaign_product_display_name(sp2.bsale_variant_id), ''), sp2.name), sp2.product_id
        INTO v_sku, v_name, v_product_id
        FROM inventarios.snapshot_products sp2
        WHERE sp2.bsale_variant_id = p_bsale_variant_id
        ORDER BY sp2.sku NULLS LAST
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

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_export(
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
    v_contributions jsonb;
    v_operational jsonb;
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

    -- Contribuciones efectivas con contexto.
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'sku', sp.sku,
                'name', coalesce(NULLIF(inventarios.campaign_product_display_name(sp.bsale_variant_id), ''), NULLIF(pg_catalog.btrim(sp.name), ''), 'PRODUCTO ' || ce.bsale_variant_id::text),
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
                'contribution_source', g.contribution_source
            ) ORDER BY s.name, sz.zone_code, sl.code, ce.captured_at
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
    LEFT JOIN inventarios.snapshot_products sp ON sp.company_id = ce.company_id AND sp.snapshot_id = ce.snapshot_id AND sp.id = ce.snapshot_product_id
    LEFT JOIN inventarios.session_zones sz ON sz.company_id = ce.company_id AND sz.session_id = ce.session_id AND sz.id = ce.session_zone_id
    LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = ce.company_id AND sl.snapshot_id = ce.snapshot_id AND sl.id = ce.snapshot_location_id;

    -- Filas de auditoría del estado operacional.
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'tipo', r.tipo,
                'seccion', r.seccion,
                'zona', r.zona,
                'ubicacion', r.ubicacion,
                'estado', r.estado,
                'detalle', r.detalle
            ) ORDER BY r.tipo, r.seccion, r.zona, r.ubicacion
        )
    END
    INTO v_operational
    FROM (
        -- Secciones por estado
        SELECT 'Sección' AS tipo, s.name AS seccion, NULL::text AS zona, NULL::text AS ubicacion,
               CASE s.status
                   WHEN 'DRAFT' THEN 'Pendiente'
                   WHEN 'PREPARED' THEN 'Preparada'
                   WHEN 'COUNTING' THEN 'En conteo'
                   WHEN 'UNDER_REVIEW' THEN 'En revisión'
                   WHEN 'APPROVED' THEN 'Terminada'
                   ELSE s.status
               END AS estado,
               'Sección de conteo' AS detalle
        FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id

        UNION ALL
        -- Zonas por estado de su tarea activa
        SELECT 'Zona', s.name, sz.zone_code, NULL,
               CASE coalesce(max(t.status), 'ASSIGNED')
                   WHEN 'COMPLETED' THEN 'Completada'
                   WHEN 'IN_PROGRESS' THEN 'En curso'
                   WHEN 'PAUSED' THEN 'En pausa'
                   WHEN 'ASSIGNED' THEN 'No iniciada'
                   ELSE coalesce(max(t.status), 'ASSIGNED')
               END,
               sz.display_name
        FROM inventarios.session_zones sz
        JOIN inventarios.sessions s ON s.company_id = sz.company_id AND s.id = sz.session_id
        LEFT JOIN inventarios.tasks t ON t.company_id = sz.company_id AND t.session_id = sz.session_id
            AND t.session_zone_id = sz.id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
        WHERE s.campaign_id = p_campaign_id
        GROUP BY sz.id, s.name, sz.zone_code, sz.display_name

        UNION ALL
        -- Tareas pendientes
        SELECT 'Tarea', s.name, NULL, NULL,
               CASE t.status
                   WHEN 'IN_PROGRESS' THEN 'En curso'
                   WHEN 'PAUSED' THEN 'En pausa'
                   ELSE t.status
               END,
               'Tarea de conteo'
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE s.campaign_id = p_campaign_id AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
          AND t.status IN ('IN_PROGRESS','PAUSED')

        UNION ALL
        -- Ubicaciones abiertas
        SELECT 'Ubicación', s.name, sz.zone_code, sl.code, 'Abierta', 'Ubicación con tarea abierta'
        FROM inventarios.task_locations tl
        JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
        LEFT JOIN inventarios.session_zones sz ON sz.company_id = tl.company_id AND sz.session_id = tl.session_id AND sz.id = tl.session_zone_id
        LEFT JOIN inventarios.session_zone_locations szl ON szl.company_id = tl.company_id AND szl.session_id = tl.session_id AND szl.id = tl.session_zone_location_id
        LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = tl.company_id AND sl.snapshot_id = szl.snapshot_id AND sl.id = szl.snapshot_location_id
        WHERE s.campaign_id = p_campaign_id AND tl.status = 'OPEN'

        UNION ALL
        -- Ubicaciones visitadas sin registros
        SELECT 'Ubicación', s.name, sz.zone_code, sl.code, 'Sin registros', 'Visitada sin conteos efectivos'
        FROM inventarios.task_locations tl
        JOIN inventarios.sessions s ON s.company_id = tl.company_id AND s.id = tl.session_id
        LEFT JOIN inventarios.session_zones sz ON sz.company_id = tl.company_id AND sz.session_id = tl.session_id AND sz.id = tl.session_zone_id
        LEFT JOIN inventarios.session_zone_locations szl ON szl.company_id = tl.company_id AND szl.session_id = tl.session_id AND szl.id = tl.session_zone_location_id
        LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = tl.company_id AND sl.snapshot_id = szl.snapshot_id AND sl.id = szl.snapshot_location_id
        WHERE s.campaign_id = p_campaign_id
          AND NOT EXISTS (
              SELECT 1
              FROM inventarios.count_entries ce
              JOIN inventarios.session_zone_locations szl2
                ON szl2.company_id = ce.company_id AND szl2.session_id = ce.session_id
               AND szl2.session_zone_id = ce.session_zone_id AND szl2.snapshot_location_id = ce.snapshot_location_id
              WHERE ce.company_id = tl.company_id AND ce.session_id = tl.session_id
                AND szl2.id = tl.session_zone_location_id
                AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
          )

        UNION ALL
        -- Productos no incluidos para conteo
        SELECT 'Producto', NULL, NULL, NULL, 'No incluido para conteo',
               csp.sku || ' · ' || coalesce(NULLIF(pg_catalog.btrim(csp.name), ''), 'PRODUCTO ' || csp.bsale_variant_id::text)
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
          )

        UNION ALL
        -- Códigos pendientes de revisión
        SELECT 'Código pendiente', s.name, NULL, NULL, 'Pendiente de revisión',
               pbp.scanned_code
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
        WHERE s.campaign_id = p_campaign_id AND pbp.status = 'PENDING_REVIEW'
    ) r;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'contributions', CASE WHEN v_contributions IS NULL THEN '[]'::jsonb ELSE v_contributions END,
        'operational_rows', CASE WHEN v_operational IS NULL THEN '[]'::jsonb ELSE v_operational END
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.campaign_product_display_name(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_product_breakdown(uuid, uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_export(uuid, uuid) TO authenticated, service_role;

COMMIT;
