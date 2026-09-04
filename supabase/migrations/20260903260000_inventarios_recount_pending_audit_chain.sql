-- Migration: 20260903260000_inventarios_recount_pending_audit_chain.sql
-- Refuerza la tolerancia a recount_request pendiente en el resto del camino de lectura:
-- _inventarios_campaign_effective_snapshot (usado por Revisar diferencias) y
-- get_inventory_campaign_all_products (universo del Informe). El reconteo pendiente deja de
-- elevar INV_RECOUNT_PENDING y no aporta como contribución efectiva. Guardas de escritura
-- intactas: p_strict DEFAULT true conserva el bloqueo para los validadotes de escritura.

BEGIN;
DROP FUNCTION IF EXISTS inventarios._inventarios_campaign_effective_snapshot(uuid, uuid);

-- 1. _inventarios_campaign_effective_snapshot(..., p_strict boolean DEFAULT true)
CREATE OR REPLACE FUNCTION inventarios._inventarios_campaign_effective_snapshot(
    p_company_id uuid,
    p_campaign_id uuid,
    p_strict boolean DEFAULT true
)
RETURNS TABLE (
    bsale_variant_id integer,
    product_id uuid,
    sku text,
    name text,
    in_theoretical_stock boolean,
    in_any_snapshot boolean,
    theoretical_quantity numeric,
    physical_quantity numeric,
    contribution_count bigint,
    unit_cost numeric,
    difference_quantity numeric,
    variance_status text,
    coverage_status text
)
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
WITH campaign_status AS (
    SELECT status FROM inventarios.inventory_campaigns
    WHERE company_id = p_company_id AND id = p_campaign_id
    LIMIT 1
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
    SELECT ovi.bsale_variant_id,
           pg_catalog.sum(ovi.physical_quantity) AS physical_quantity,
           pg_catalog.count(*) AS contribution_count
    FROM inventarios.official_version_items ovi
    JOIN inventarios.sessions s ON s.company_id = ovi.company_id AND s.id = ovi.session_id
    WHERE ovi.company_id = p_company_id AND s.campaign_id = p_campaign_id
      AND s.status = 'APPROVED' AND (SELECT status FROM campaign_status) = 'APPROVED'
    GROUP BY ovi.bsale_variant_id
    UNION ALL
    SELECT ce.bsale_variant_id,
           pg_catalog.sum(ce.physical_quantity) AS physical_quantity,
           pg_catalog.count(*) AS contribution_count
    FROM campaign_tasks ct
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, p_strict) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    WHERE ce.bsale_variant_id IS NOT NULL
      AND coalesce((SELECT status FROM campaign_status), '') <> 'APPROVED'
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
)
SELECT d.bsale_variant_id,
       d.product_id,
       d.sku,
       d.name,
       d.in_theoretical_stock,
       d.in_any_snapshot,
       d.theoretical_quantity,
       d.physical_quantity,
       d.contribution_count,
       d.unit_cost,
       (d.physical_quantity - d.theoretical_quantity) AS difference_quantity,
       CASE
           WHEN (d.physical_quantity - d.theoretical_quantity) < 0 THEN 'FALTANTE'
           WHEN (d.physical_quantity - d.theoretical_quantity) > 0 THEN 'SOBRANTE'
           ELSE 'SIN_DIFERENCIA'
       END AS variance_status,
       CASE
           WHEN d.physical_quantity > 0 THEN 'COUNTED'
           WHEN d.in_any_snapshot THEN 'NOT_COUNTED'
           ELSE 'OUT_OF_SNAPSHOT'
       END AS coverage_status
FROM dataset d;
$function$;

-- 2. list_inventory_audit_candidates -> usa el snapshot efectivo en modo lectura
CREATE OR REPLACE FUNCTION inventarios.list_inventory_audit_candidates(
    p_company_id uuid,
    p_campaign_id uuid,
    p_search text DEFAULT NULL,
    p_variance_status text DEFAULT NULL,
    p_page integer DEFAULT 1,
    p_page_size integer DEFAULT 50,
    p_sort_by text DEFAULT NULL,
    p_sort_direction text DEFAULT 'ASC'
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_search text;
    v_var text;
    v_sort_by text;
    v_sort_dir text;
    v_page integer;
    v_page_size integer;
    v_offset integer;
    v_total bigint := 0;
    v_faltantes bigint := 0;
    v_sobrantes bigint := 0;
    v_audited bigint := 0;
    v_items jsonb;
    v_audits jsonb;
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

    v_search := pg_catalog.btrim(coalesce(p_search, ''));
    v_var := pg_catalog.upper(pg_catalog.btrim(coalesce(p_variance_status, '')));
    IF v_var <> '' AND v_var NOT IN ('FALTANTE','SOBRANTE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_sort_by := pg_catalog.upper(pg_catalog.btrim(coalesce(p_sort_by, 'SKU')));
    IF v_sort_by <> '' AND v_sort_by NOT IN ('SKU','NAME','VARIANCE_STATUS','THEORETICAL','PHYSICAL','DIFFERENCE') THEN
        v_sort_by := 'SKU';
    END IF;
    v_sort_dir := pg_catalog.upper(pg_catalog.btrim(coalesce(p_sort_direction, 'ASC')));
    IF v_sort_dir NOT IN ('ASC','DESC') THEN v_sort_dir := 'ASC'; END IF;
    v_page := coalesce(p_page, 1);
    v_page_size := coalesce(p_page_size, 50);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 50; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    -- Variantes con ubicacion determinable (conteos efectivos o teorico BY_LOCATION).
    -- Replica exactamente la resolucion de create_inventory_audit.
    DROP TABLE IF EXISTS _inventarios_audit_resolved_variants;
    CREATE TEMP TABLE _inventarios_audit_resolved_variants ON COMMIT DROP AS
    WITH campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE t.company_id = p_company_id AND s.campaign_id = p_campaign_id
          AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ),
    counted AS (
        SELECT DISTINCT ce.bsale_variant_id
        FROM campaign_tasks ct
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, false) g
        JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
        WHERE ce.bsale_variant_id IS NOT NULL AND ce.snapshot_location_id IS NOT NULL
    ),
    theoretical AS (
        SELECT DISTINCT csp.bsale_variant_id
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.id = icts.campaign_snapshot_id AND cs.company_id = icts.company_id
         AND cs.campaign_id = p_campaign_id
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.id = icts.snapshot_product_id AND csp.company_id = icts.company_id
        JOIN inventarios.inventory_site_locations isl
          ON isl.id = icts.inventory_site_location_id AND isl.company_id = icts.company_id
        WHERE icts.company_id = p_company_id
          AND icts.scope_level = 'BY_LOCATION'
          AND icts.theoretical_quantity > 0
    )
    SELECT bsale_variant_id FROM counted
    UNION
    SELECT bsale_variant_id FROM theoretical;

    -- Dataset efectivo filtrado (diferencias <> 0) en tabla temporal para paginar
    -- y resumir sobre una sola evaluacion del snapshot efectivo.
    -- Teorico desde la fuente canonica (MATERIALIZED -> IMPORT_FALLBACK).
    DROP TABLE IF EXISTS _inventarios_audit_candidates;
    CREATE TEMP TABLE _inventarios_audit_candidates ON COMMIT DROP AS
    WITH effective AS (
        SELECT d.bsale_variant_id, d.product_id, d.sku, d.name,
               d.physical_quantity, d.contribution_count, d.in_any_snapshot
        FROM inventarios._inventarios_campaign_effective_snapshot(p_company_id, p_campaign_id, false) d
    ),
    canonical AS (
        SELECT t.bsale_variant_id, t.product_id, t.sku, t.theoretical_quantity, t.unit_cost,
               COALESCE(NULLIF(inventarios.campaign_product_display_name(t.bsale_variant_id), ''), t.sku) AS display_name
        FROM inventarios.get_campaign_theoretical_stock(p_company_id, p_campaign_id) t
    ),
    base AS (
        SELECT c.bsale_variant_id, c.product_id, c.sku,
               COALESCE(NULLIF(e.ef_name, ''), c.display_name) AS name,
               true AS in_theoretical_stock,
               c.theoretical_quantity, c.unit_cost,
               COALESCE(e.physical_quantity, 0) AS physical_quantity,
               COALESCE(e.contribution_count, 0) AS contribution_count,
               COALESCE(e.in_any_snapshot, false) AS in_any_snapshot
        FROM canonical c
        LEFT JOIN (
            SELECT b.bsale_variant_id, b.name AS ef_name, b.physical_quantity,
                   b.contribution_count, b.in_any_snapshot
            FROM effective b
        ) e ON e.bsale_variant_id = c.bsale_variant_id
        UNION ALL
        SELECT ph.bsale_variant_id, ph.product_id, ph.sku, ph.name,
               false, 0::numeric, NULL::numeric,
               ph.physical_quantity, ph.contribution_count, ph.in_any_snapshot
        FROM effective ph
        WHERE NOT EXISTS (SELECT 1 FROM canonical c2 WHERE c2.bsale_variant_id = ph.bsale_variant_id)
    ),
    dataset AS (
        SELECT b.bsale_variant_id, b.product_id, b.sku, b.name, b.in_theoretical_stock,
               b.theoretical_quantity, b.physical_quantity, b.contribution_count, b.unit_cost,
               (b.physical_quantity - b.theoretical_quantity) AS difference_quantity,
               CASE WHEN (b.physical_quantity - b.theoretical_quantity) < 0 THEN 'FALTANTE'
                    WHEN (b.physical_quantity - b.theoretical_quantity) > 0 THEN 'SOBRANTE'
                    ELSE 'SIN_DIFERENCIA' END AS variance_status,
               CASE WHEN b.physical_quantity > 0 THEN 'COUNTED'
                    WHEN b.in_any_snapshot THEN 'NOT_COUNTED'
                    ELSE 'OUT_OF_SNAPSHOT' END AS coverage_status
        FROM base b
    )
    SELECT d.bsale_variant_id, d.product_id, d.sku, d.name,
           d.in_theoretical_stock, d.theoretical_quantity, d.physical_quantity,
           d.contribution_count, d.unit_cost, d.difference_quantity,
           d.variance_status, d.coverage_status,
           CASE WHEN EXISTS (
               SELECT 1 FROM _inventarios_audit_resolved_variants rv
               WHERE rv.bsale_variant_id = d.bsale_variant_id
           ) THEN 'LOCATIONS_RESOLVED' ELSE 'NO_PREVIOUS_LOCATION' END AS scope_status
    FROM dataset d
    WHERE d.difference_quantity <> 0
      AND (v_search = '' OR d.sku ILIKE '%' || v_search || '%' OR d.name ILIKE '%' || v_search || '%')
      AND (v_var = '' OR d.variance_status = v_var);

    SELECT pg_catalog.count(*),
           pg_catalog.count(*) FILTER (WHERE variance_status = 'FALTANTE'),
           pg_catalog.count(*) FILTER (WHERE variance_status = 'SOBRANTE')
    INTO v_total, v_faltantes, v_sobrantes
    FROM _inventarios_audit_candidates;

    -- Cantidad de productos con auditoria activa dentro del set candidato.
    SELECT pg_catalog.count(*)
    INTO v_audited
    FROM _inventarios_audit_candidates c
    WHERE EXISTS (
        SELECT 1
        FROM inventarios.inventory_audit_products ap
        JOIN inventarios.inventory_audits a ON a.id = ap.audit_id
        WHERE ap.company_id = p_company_id AND ap.campaign_id = p_campaign_id
          AND ap.bsale_variant_id = c.bsale_variant_id
          AND a.status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED')
    );

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'product_key', c.bsale_variant_id::text,
                'bsale_variant_id', c.bsale_variant_id,
                'product_id', c.product_id,
                'sku', c.sku,
                'name', c.name,
                'theoretical_quantity', c.theoretical_quantity,
                'physical_quantity', c.physical_quantity,
                'difference_quantity', c.difference_quantity,
                'unit_cost', c.unit_cost,
                'difference_value', coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric),
                'variance_status', c.variance_status,
                'coverage_status', c.coverage_status,
                'scope_status', c.scope_status,
                'audit_id', aud.audit_id,
                'audit_number', aud.audit_number,
                'audit_status', aud.audit_status,
                'auditor_user_id', aud.auditor_user_id,
                'auditor_name', aud.auditor_name,
                'selectable', (aud.audit_id IS NULL)
            ) ORDER BY
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'SKU' THEN c.sku END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'SKU' THEN c.sku END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'NAME' THEN c.name END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'NAME' THEN c.name END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'VARIANCE_STATUS' THEN c.variance_status END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'VARIANCE_STATUS' THEN c.variance_status END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'THEORETICAL' THEN c.theoretical_quantity END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'THEORETICAL' THEN c.theoretical_quantity END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'PHYSICAL' THEN c.physical_quantity END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'PHYSICAL' THEN c.physical_quantity END DESC NULLS LAST,
                CASE WHEN v_sort_dir = 'ASC' AND v_sort_by = 'DIFFERENCE' THEN c.difference_quantity END ASC NULLS LAST,
                CASE WHEN v_sort_dir = 'DESC' AND v_sort_by = 'DIFFERENCE' THEN c.difference_quantity END DESC NULLS LAST,
                c.sku, c.bsale_variant_id
        )
    END
    INTO v_items
    FROM _inventarios_audit_candidates c
    LEFT JOIN LATERAL (
        SELECT a.id AS audit_id, a.audit_number, a.status AS audit_status,
               a.assigned_user_id AS auditor_user_id, pu.nombre AS auditor_name
        FROM inventarios.inventory_audit_products ap2
        JOIN inventarios.inventory_audits a ON a.id = ap2.audit_id
        LEFT JOIN portal.users pu ON pu.id = a.assigned_user_id
        WHERE ap2.company_id = p_company_id AND ap2.campaign_id = p_campaign_id
          AND ap2.bsale_variant_id = c.bsale_variant_id
          AND a.status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED')
        LIMIT 1
    ) aud ON true
    LIMIT v_page_size OFFSET v_offset;

    -- Resumen de auditorias activas de la campana (para la pantalla ERP).
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_id', a.id,
                'audit_number', a.audit_number,
                'status', a.status,
                'assigned_user_id', a.assigned_user_id,
                'auditor_name', pu.nombre,
                'product_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_products ap WHERE ap.audit_id = a.id),
                'location_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_locations l WHERE l.audit_id = a.id),
                'search_scope_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_search_scopes sc WHERE sc.audit_id = a.id),
                'created_at', a.created_at,
                'created_by', a.created_by
            ) ORDER BY a.audit_number
        )
    END
    INTO v_audits
    FROM inventarios.inventory_audits a
    LEFT JOIN portal.users pu ON pu.id = a.assigned_user_id
    WHERE a.company_id = p_company_id AND a.campaign_id = p_campaign_id
      AND a.status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED');

    RETURN pg_catalog.jsonb_build_object(
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'summary', pg_catalog.jsonb_build_object(
            'total_differences', v_total,
            'faltantes', v_faltantes,
            'sobrantes', v_sobrantes,
            'audited_products', v_audited
        ),
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'has_more', v_offset + pg_catalog.jsonb_array_length(CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END) < v_total,
        'items', CASE WHEN v_items IS NULL THEN '[]'::jsonb ELSE v_items END,
        'active_audits', coalesce(v_audits, '[]'::jsonb)
    );
END;
$function$;

-- 3. get_inventory_campaign_all_products -> lectura tolerante a reconteo pendiente
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
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id, false) g
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

ALTER FUNCTION inventarios._inventarios_campaign_effective_snapshot(uuid, uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._inventarios_campaign_effective_snapshot(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios._inventarios_campaign_effective_snapshot(uuid, uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_audit_candidates(uuid, uuid, text, text, integer, integer, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_all_products(uuid, uuid) TO authenticated, service_role;
COMMIT;
