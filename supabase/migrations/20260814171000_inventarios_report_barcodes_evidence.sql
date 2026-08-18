-- =========================================================================================
-- MIGRATION: Informe Global - códigos Bsale, aliases aprobados y evidencia por producto
-- =========================================================================================
-- Objetivo:
--   1) Corregir list_inventory_campaign_approved_barcodes: usaba pg_catalog.max() sobre
--      reviewed_by (uuid), que no existe en Postgres -> el contrato fallaba en runtime y
--      el Informe no podía enriquecer códigos. reviewed_by ahora es el revisor de la
--      revisión más reciente (array_agg ORDER BY reviewed_at DESC).
--   2) Extender list_inventory_campaign_variances (contrato read-only del Informe) para
--      entregar por producto:
--        - barcode / barcode_source : código principal vigente (fuente canónica
--          inventory_campaign_product_original_barcode: snapshot campaña -> snapshot
--          sesión -> bsale_variants.bar_code).
--        - approved_barcodes        : códigos adicionales aprobados/activos del producto
--          (product_barcode_aliases activos; NUNCA proposals PENDING/REJECTED).
--        - has_evidence / evidence_id : si el producto tiene evidencia fotográfica en el
--          campaign (evidence_files vinculados por proposal_id o count_entry_id de sus
--          conteos/proposals), para abrirla desde el resumen.
--   No cambia ninguna cantidad, diferencia ni resultado físico.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios (lectura de integraciones/storage).
-- =========================================================================================

BEGIN;

-- ============================================================
-- 1. FIX: list_inventory_campaign_approved_barcodes (max(uuid))
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaign_approved_barcodes(
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
    v_items jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    WITH agg AS (
        SELECT ce.bsale_variant_id,
               pbp.scanned_code,
               pg_catalog.count(*) AS occurrence_count,
               pg_catalog.count(DISTINCT ce.snapshot_location_id) AS location_count,
               pg_catalog.min(ce.captured_at) AS first_detected_at,
               pg_catalog.max(ce.captured_at) AS latest_detected_at,
               pg_catalog.max(pbp.reviewed_at) AS reviewed_at,
               (pg_catalog.array_agg(pbp.reviewed_by ORDER BY pbp.reviewed_at DESC NULLS LAST))[1] AS reviewed_by
        FROM inventarios.product_barcode_proposals pbp
        JOIN inventarios.count_entries ce ON ce.company_id = pbp.company_id AND ce.id = pbp.count_entry_id
        JOIN inventarios.sessions s ON s.company_id = pbp.company_id AND s.id = pbp.session_id
        WHERE pbp.company_id = p_company_id
          AND pbp.status = 'APPROVED'
          AND s.campaign_id = p_campaign_id
        GROUP BY ce.bsale_variant_id, pbp.scanned_code
    )
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'bsale_variant_id', a.bsale_variant_id,
                'sku', ident ->> 'sku',
                'product_name', ident ->> 'product_name',
                'original_barcode', orig ->> 'barcode',
                'original_barcode_source', orig ->> 'source',
                'approved_barcode', a.scanned_code,
                'occurrence_count', a.occurrence_count,
                'location_count', a.location_count,
                'first_detected_at', a.first_detected_at,
                'latest_detected_at', a.latest_detected_at,
                'reviewed_by', a.reviewed_by,
                'reviewed_at', a.reviewed_at,
                'status', 'Autorizado'
            ) ORDER BY ident ->> 'sku', a.scanned_code
        )
    END
    INTO v_items
    FROM agg a
    CROSS JOIN LATERAL (
        SELECT inventarios.barcode_product_identity(p_company_id, a.bsale_variant_id) AS ident
    ) idn
    CROSS JOIN LATERAL (
        SELECT inventarios.inventory_campaign_product_original_barcode(p_company_id, p_campaign_id, a.bsale_variant_id) AS orig
    ) og;

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'items', CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_approved_barcodes(uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- 2. EXTENSIÓN: list_inventory_campaign_variances (+barcode, approved_barcodes, evidencia)
-- ============================================================
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
                'coverage_status', c.coverage_status,
                'barcode', bc.info ->> 'barcode',
                'barcode_source', bc.info ->> 'source',
                'approved_barcodes', ab.codes,
                'has_evidence', ev.has_evidence,
                'evidence_id', ev.evidence_id
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
    CROSS JOIN LATERAL (
        SELECT inventarios.inventory_campaign_product_original_barcode(
            p_company_id, p_campaign_id, c.bsale_variant_id) AS info
    ) bc
    CROSS JOIN LATERAL (
        SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                    ELSE pg_catalog.jsonb_agg(pba.barcode ORDER BY pba.barcode) END AS codes
        FROM inventarios.product_barcode_aliases pba
        WHERE pba.company_id = p_company_id
          AND pba.bsale_variant_id = c.bsale_variant_id
          AND pba.is_active = true
    ) ab
    CROSS JOIN LATERAL (
        SELECT pg_catalog.count(*) > 0 AS has_evidence,
               pg_catalog.min(ef.id::text) AS evidence_id
        FROM inventarios.evidence_files ef
        WHERE ef.company_id = p_company_id
          AND ef.invalidated_at IS NULL AND ef.invalidated_by IS NULL AND ef.invalidation_reason IS NULL
          AND (
              ef.proposal_id IN (
                  SELECT pbp.id FROM inventarios.product_barcode_proposals pbp
                  JOIN inventarios.count_entries ce ON ce.id = pbp.count_entry_id
                  JOIN inventarios.sessions s ON s.id = ce.session_id
                  WHERE s.campaign_id = p_campaign_id AND ce.bsale_variant_id = c.bsale_variant_id
              )
              OR (ef.proposal_id IS NULL AND ef.count_entry_id IN (
                  SELECT ce.id FROM inventarios.count_entries ce
                  JOIN inventarios.sessions s ON s.id = ce.session_id
                  WHERE s.campaign_id = p_campaign_id AND ce.bsale_variant_id = c.bsale_variant_id
              ))
          )
    ) ev
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

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer, text, text) TO authenticated, service_role;

COMMIT;
