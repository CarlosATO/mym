-- Read-only V1 route-guide profitability contract.
-- Cost basis: latest valid Bsale purchase reception on or before each invoice.

BEGIN;

CREATE OR REPLACE FUNCTION logistica.get_route_guide_profitability_v1(
    p_route_guide_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, logistica, integraciones
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_guide_number text;
    v_sales_net_total numeric(14,2);
    v_covered_sales_net numeric(14,2);
    v_uncovered_sales_net numeric(14,2);
    v_cost_total numeric(14,2);
    v_line_count integer;
    v_covered_line_count integer;
    v_uncovered_line_count integer;
    v_variant_count integer;
    v_covered_variant_count integer;
    v_uncovered_variant_count integer;
    v_estimated_margin_pct numeric(14,2);
    v_cost_coverage_pct numeric(14,2);
    v_cost_status text;
    v_lines jsonb;
BEGIN
    v_actor_id := auth.uid();

    SELECT rg.company_id, rg.guide_number
    INTO v_company_id, v_guide_number
    FROM logistica.route_guides rg
    WHERE rg.id = p_route_guide_id;

    IF v_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ROUTE_GUIDE_NOT_FOUND';
    END IF;

    IF auth.role() <> 'service_role'
       AND (v_actor_id IS NULL OR NOT core.has_company_access(v_actor_id, v_company_id)) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'COMPANY_ACCESS_DENIED';
    END IF;

    IF auth.role() <> 'service_role'
       AND NOT portal.user_has_permission(v_actor_id, 'logistica.route_guides.view') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ROUTE_GUIDE_VIEW_DENIED';
    END IF;

    WITH guide_scope AS (
        SELECT rg.id, rg.company_id, rg.guide_date
        FROM logistica.route_guides rg
        WHERE rg.id = p_route_guide_id
          AND rg.company_id = v_company_id
    ),
    sales_lines AS (
        SELECT
            rgi.line_number,
            rgi.invoice_number,
            d.bsale_id AS document_id,
            d.emission_date AS document_date,
            det.bsale_id AS document_detail_id,
            COALESCE(det.variant_id, code_variant.bsale_id) AS bsale_variant_id,
            COALESCE(v.code, det.variant_code) AS sku,
            CASE
                WHEN NULLIF(pg_catalog.btrim(v.description), '') IS NULL
                    THEN COALESCE(NULLIF(pg_catalog.btrim(bp.name), ''), det.variant_description, 'Producto desconocido')
                WHEN NULLIF(pg_catalog.btrim(bp.name), '') IS NULL
                    THEN pg_catalog.btrim(v.description)
                WHEN pg_catalog.lower(pg_catalog.btrim(v.description)) = pg_catalog.lower(pg_catalog.btrim(bp.name))
                    THEN pg_catalog.btrim(bp.name)
                ELSE pg_catalog.concat(pg_catalog.btrim(bp.name), ' ', pg_catalog.btrim(v.description))
            END AS product_name,
            det.quantity,
            det.net_amount AS net_sales,
            guide_scope.company_id
        FROM guide_scope
        JOIN logistica.route_guide_items rgi
          ON rgi.route_guide_id = guide_scope.id
         AND rgi.company_id = guide_scope.company_id
        JOIN LATERAL (
            SELECT d.*
            FROM integraciones.bsale_documents d
            WHERE d.company_id = guide_scope.company_id
              AND d.number::text = rgi.invoice_number
              AND d.state = 0
            ORDER BY d.emission_date DESC NULLS LAST, d.bsale_id DESC
            LIMIT 1
        ) d ON true
        JOIN integraciones.bsale_document_details det
          ON det.company_id = guide_scope.company_id
         AND det.bsale_document_id = d.bsale_id
        LEFT JOIN integraciones.bsale_variants v
          ON v.company_id = guide_scope.company_id
         AND v.bsale_id = det.variant_id
        LEFT JOIN integraciones.bsale_variants code_variant
          ON code_variant.company_id = guide_scope.company_id
         AND code_variant.code = det.variant_code
         AND det.variant_id IS NULL
        LEFT JOIN integraciones.bsale_products bp
          ON bp.company_id = guide_scope.company_id
         AND bp.bsale_id = COALESCE(v.bsale_product_id, code_variant.bsale_product_id)
    ),
    resolved_lines AS (
        SELECT
            sl.*,
            reception.bsale_reception_id AS selected_reception_id,
            reception.admission_date AS selected_reception_date,
            reception.cost AS last_purchase_unit_cost,
            CASE WHEN reception.bsale_reception_id IS NULL THEN 'SIN_COSTO' ELSE 'COSTED' END AS cost_status,
            CASE WHEN reception.bsale_reception_id IS NULL THEN NULL::numeric(14,2)
                 ELSE (reception.cost * sl.quantity)::numeric(14,2) END AS line_cost
        FROM sales_lines sl
        LEFT JOIN LATERAL (
            SELECT
                rd.bsale_reception_id,
                r.admission_date,
                rd.cost
            FROM integraciones.bsale_reception_details rd
            JOIN integraciones.bsale_receptions r
              ON r.company_id = rd.company_id
             AND r.bsale_id = rd.bsale_reception_id
            WHERE rd.company_id = sl.company_id
              AND rd.variant_id = sl.bsale_variant_id
              AND rd.cost > 0
              AND r.admission_date <= sl.document_date
              AND COALESCE((r.raw_json ->> 'cancellationStatus')::integer, 0) <> 1
              AND pg_catalog.translate(
                    pg_catalog.upper(COALESCE(r.document, '')),
                    'ÁÉÍÓÚÜÑ',
                    'AEIOUUN'
                  ) NOT LIKE '%NOTA DE CREDITO%'
            ORDER BY r.admission_date DESC, rd.updated_at DESC NULLS LAST, rd.bsale_id DESC
            LIMIT 1
        ) reception ON true
    ),
    line_rollup AS (
        SELECT
            pg_catalog.count(*)::integer AS line_count,
            pg_catalog.count(*) FILTER (WHERE cost_status = 'COSTED')::integer AS covered_line_count,
            pg_catalog.count(*) FILTER (WHERE cost_status = 'SIN_COSTO')::integer AS uncovered_line_count,
            pg_catalog.count(DISTINCT bsale_variant_id)::integer AS variant_count,
            pg_catalog.count(DISTINCT bsale_variant_id) FILTER (WHERE cost_status = 'COSTED')::integer AS covered_variant_count,
            pg_catalog.count(DISTINCT bsale_variant_id) FILTER (WHERE cost_status = 'SIN_COSTO')::integer AS uncovered_variant_count,
            COALESCE(pg_catalog.sum(net_sales), 0)::numeric(14,2) AS sales_net_total,
            COALESCE(pg_catalog.sum(net_sales) FILTER (WHERE cost_status = 'COSTED'), 0)::numeric(14,2) AS covered_sales_net,
            COALESCE(pg_catalog.sum(net_sales) FILTER (WHERE cost_status = 'SIN_COSTO'), 0)::numeric(14,2) AS uncovered_sales_net,
            COALESCE(pg_catalog.sum(line_cost) FILTER (WHERE cost_status = 'COSTED'), 0)::numeric(14,2) AS cost_total
        FROM resolved_lines
    ),
    line_payload AS (
        SELECT COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'document', invoice_number,
                'document_date', document_date,
                'bsale_variant_id', bsale_variant_id,
                'sku', sku,
                'product_name', product_name,
                'quantity', quantity,
                'net_sales', net_sales,
                'selected_reception_id', selected_reception_id,
                'selected_reception_date', selected_reception_date,
                'last_purchase_unit_cost', last_purchase_unit_cost,
                'line_cost', line_cost,
                'estimated_profit', CASE WHEN cost_status = 'COSTED' THEN net_sales - line_cost ELSE NULL END,
                'estimated_margin_pct', CASE WHEN cost_status = 'COSTED' AND net_sales <> 0
                    THEN round(((net_sales - line_cost) / net_sales) * 100, 2) ELSE NULL END,
                'cost_status', cost_status
            ) ORDER BY line_number, document_detail_id
        ), '[]'::jsonb) AS lines
        FROM resolved_lines
    )
    SELECT
        lr.sales_net_total,
        lr.covered_sales_net,
        lr.uncovered_sales_net,
        lr.cost_total,
        lr.line_count,
        lr.covered_line_count,
        lr.uncovered_line_count,
        lr.variant_count,
        lr.covered_variant_count,
        lr.uncovered_variant_count,
        CASE WHEN lr.covered_sales_net = 0 THEN NULL::numeric(14,2)
             ELSE round(((lr.covered_sales_net - lr.cost_total) / lr.covered_sales_net) * 100, 2)::numeric(14,2) END,
        CASE WHEN lr.sales_net_total = 0 THEN NULL::numeric(14,2)
             ELSE round((lr.covered_sales_net / lr.sales_net_total) * 100, 2)::numeric(14,2) END,
        CASE WHEN lr.covered_sales_net = 0 THEN 'UNAVAILABLE'
             WHEN lr.covered_sales_net < lr.sales_net_total THEN 'PARTIAL'
             ELSE 'COMPLETE' END,
        lp.lines
    INTO
        v_sales_net_total,
        v_covered_sales_net,
        v_uncovered_sales_net,
        v_cost_total,
        v_line_count,
        v_covered_line_count,
        v_uncovered_line_count,
        v_variant_count,
        v_covered_variant_count,
        v_uncovered_variant_count,
        v_estimated_margin_pct,
        v_cost_coverage_pct,
        v_cost_status,
        v_lines
    FROM line_rollup lr
    CROSS JOIN line_payload lp;

    RETURN pg_catalog.jsonb_build_object(
        'guide_id', p_route_guide_id,
        'guide_number', (SELECT rg.guide_number FROM logistica.route_guides rg WHERE rg.id = p_route_guide_id),
        'sales_net_total', v_sales_net_total,
        'covered_sales_net', v_covered_sales_net,
        'uncovered_sales_net', v_uncovered_sales_net,
        'last_purchase_cost_total', v_cost_total,
        'estimated_gross_profit', v_covered_sales_net - v_cost_total,
        'estimated_margin_pct', v_estimated_margin_pct,
        'cost_coverage_pct', v_cost_coverage_pct,
        'total_lines', v_line_count,
        'covered_lines', v_covered_line_count,
        'uncovered_lines', v_uncovered_line_count,
        'total_variants', v_variant_count,
        'covered_variants', v_covered_variant_count,
        'uncovered_variants', v_uncovered_variant_count,
        'cost_status', v_cost_status,
        'lines', v_lines
    );
END;
$function$;

REVOKE ALL ON FUNCTION logistica.get_route_guide_profitability_v1(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.get_route_guide_profitability_v1(uuid)
    TO authenticated, service_role;

COMMIT;
