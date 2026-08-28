-- Set-based summary contract for the route-guide listing.
-- It intentionally omits the line payload returned by the single-guide RPC.

BEGIN;

CREATE OR REPLACE FUNCTION logistica.get_route_guides_profitability_summary_v1(
    p_company_id uuid,
    p_route_guide_ids uuid[]
)
RETURNS TABLE (
    route_guide_id uuid,
    guide_number text,
    sales_net_total numeric(14,2),
    covered_sales_net numeric(14,2),
    uncovered_sales_net numeric(14,2),
    last_purchase_cost_total numeric(14,2),
    estimated_gross_profit numeric(14,2),
    estimated_margin_pct numeric(14,2),
    cost_coverage_pct numeric(14,6),
    total_lines integer,
    covered_lines integer,
    uncovered_lines integer,
    cost_status text
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, logistica, integraciones
AS $function$
DECLARE
    v_actor_id uuid;
BEGIN
    v_actor_id := auth.uid();

    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'COMPANY_REQUIRED';
    END IF;

    IF auth.role() <> 'service_role'
       AND (v_actor_id IS NULL OR NOT core.has_company_access(v_actor_id, p_company_id)) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'COMPANY_ACCESS_DENIED';
    END IF;

    IF auth.role() <> 'service_role'
       AND NOT portal.user_has_permission(v_actor_id, 'logistica.route_guides.view') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ROUTE_GUIDE_VIEW_DENIED';
    END IF;

    RETURN QUERY
    WITH guide_scope AS (
        SELECT rg.id, rg.guide_number, rg.company_id
        FROM logistica.route_guides rg
        WHERE rg.company_id = p_company_id
          AND rg.id = ANY(COALESCE(p_route_guide_ids, ARRAY[]::uuid[]))
    ),
    sales_lines AS (
        SELECT
            gs.id AS route_guide_id,
            gs.guide_number,
            rgi.line_number,
            det.bsale_id AS document_detail_id,
            d.emission_date AS document_date,
            COALESCE(det.variant_id, code_variant.bsale_id) AS bsale_variant_id,
            det.net_amount AS net_sales,
            det.quantity,
            gs.company_id
        FROM guide_scope gs
        JOIN logistica.route_guide_items rgi
          ON rgi.route_guide_id = gs.id
         AND rgi.company_id = gs.company_id
        JOIN LATERAL (
            SELECT d.*
            FROM integraciones.bsale_documents d
            WHERE d.company_id = gs.company_id
              AND d.number::text = rgi.invoice_number
              AND d.state = 0
            ORDER BY d.emission_date DESC NULLS LAST, d.bsale_id DESC
            LIMIT 1
        ) d ON true
        JOIN integraciones.bsale_document_details det
          ON det.company_id = gs.company_id
         AND det.bsale_document_id = d.bsale_id
        LEFT JOIN integraciones.bsale_variants code_variant
          ON code_variant.company_id = gs.company_id
         AND code_variant.code = det.variant_code
         AND det.variant_id IS NULL
    ),
    resolved_lines AS (
        SELECT
            sl.*,
            reception.bsale_reception_id,
            CASE
                WHEN reception.bsale_reception_id IS NULL AND sl.bsale_variant_id = 5729
                    THEN 0::numeric(14,2)
                ELSE reception.cost
            END AS last_purchase_unit_cost,
            CASE
                WHEN reception.bsale_reception_id IS NOT NULL OR sl.bsale_variant_id = 5729
                    THEN 'COSTED'
                ELSE 'SIN_COSTO'
            END AS line_cost_status,
            CASE
                WHEN reception.bsale_reception_id IS NULL AND sl.bsale_variant_id = 5729
                    THEN 0::numeric(14,2)
                WHEN reception.bsale_reception_id IS NULL
                    THEN NULL::numeric(14,2)
                ELSE (reception.cost * sl.quantity)::numeric(14,2)
            END AS line_cost
        FROM sales_lines sl
        LEFT JOIN LATERAL (
            SELECT rd.bsale_reception_id, rd.cost
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
    rollup AS (
        SELECT
            gs.id AS route_guide_id,
            gs.guide_number,
            pg_catalog.count(rl.document_detail_id)::integer AS total_lines,
            pg_catalog.count(rl.document_detail_id) FILTER (WHERE rl.line_cost_status = 'COSTED')::integer AS covered_lines,
            pg_catalog.count(rl.document_detail_id) FILTER (WHERE rl.line_cost_status = 'SIN_COSTO')::integer AS uncovered_lines,
            COALESCE(pg_catalog.sum(rl.net_sales), 0)::numeric(14,2) AS sales_net_total,
            COALESCE(pg_catalog.sum(rl.net_sales) FILTER (WHERE rl.line_cost_status = 'COSTED'), 0)::numeric(14,2) AS covered_sales_net,
            COALESCE(pg_catalog.sum(rl.net_sales) FILTER (WHERE rl.line_cost_status = 'SIN_COSTO'), 0)::numeric(14,2) AS uncovered_sales_net,
            COALESCE(pg_catalog.sum(rl.line_cost) FILTER (WHERE rl.line_cost_status = 'COSTED'), 0)::numeric(14,2) AS last_purchase_cost_total
        FROM guide_scope gs
        LEFT JOIN resolved_lines rl ON rl.route_guide_id = gs.id
        GROUP BY gs.id, gs.guide_number
    )
    SELECT
        r.route_guide_id,
        r.guide_number,
        r.sales_net_total,
        r.covered_sales_net,
        r.uncovered_sales_net,
        r.last_purchase_cost_total,
        (r.covered_sales_net - r.last_purchase_cost_total)::numeric(14,2),
        CASE WHEN r.covered_sales_net = 0 THEN NULL::numeric(14,2)
             ELSE round(((r.covered_sales_net - r.last_purchase_cost_total) / r.covered_sales_net) * 100, 2)::numeric(14,2)
        END,
        CASE WHEN r.sales_net_total = 0 THEN NULL::numeric(14,6)
             ELSE ((r.covered_sales_net / r.sales_net_total) * 100)::numeric(14,6)
        END,
        r.total_lines,
        r.covered_lines,
        r.uncovered_lines,
        CASE WHEN r.covered_sales_net = 0 THEN 'UNAVAILABLE'
             WHEN r.covered_sales_net < r.sales_net_total THEN 'PARTIAL'
             ELSE 'COMPLETE'
        END
    FROM rollup r
    ORDER BY r.route_guide_id;
END;
$function$;

REVOKE ALL ON FUNCTION logistica.get_route_guides_profitability_summary_v1(uuid, uuid[])
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.get_route_guides_profitability_summary_v1(uuid, uuid[])
    TO authenticated, service_role;

COMMIT;
