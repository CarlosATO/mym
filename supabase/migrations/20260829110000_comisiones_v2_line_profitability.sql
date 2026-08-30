-- COMV2-34B2: read-only historical profitability for the V2 simulation lines.
-- Costs follow the validated Route Guide rule and never use current average cost.

CREATE OR REPLACE FUNCTION comisiones.get_v2_lines_profitability(
    p_company_id uuid,
    p_period_from date,
    p_period_to date
)
RETURNS TABLE (
    company_id uuid,
    line_id uuid,
    document_id uuid,
    document_bsale_id bigint,
    document_detail_id uuid,
    document_detail_bsale_id bigint,
    variant_id integer,
    document_type_id integer,
    document_number bigint,
    emission_date date,
    quantity numeric,
    net_sales numeric,
    line_kind text,
    original_invoice_line_id uuid,
    original_invoice_bsale_id bigint,
    original_invoice_number bigint,
    original_invoice_detail_bsale_id bigint,
    selected_reception_id integer,
    selected_reception_date timestamptz,
    unit_cost numeric,
    line_cost numeric,
    gross_profit numeric,
    gross_margin_pct numeric,
    cost_status text,
    total_lines bigint,
    covered_lines bigint,
    uncovered_lines bigint,
    cost_coverage_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, integraciones, comercial
AS $$
WITH simulation_lines AS MATERIALIZED (
    SELECT s.*
    FROM comisiones.get_sales_period_simulation(
        p_company_id,
        p_period_from,
        p_period_to
    ) s
    WHERE auth.uid() IS NOT NULL
      AND (
          portal.has_permission('system.admin')
          OR portal.has_permission('comisiones.v2.read')
      )
      AND core.has_company_access(auth.uid(), p_company_id)
), invoice_costs AS MATERIALIZED (
    SELECT
        i.company_id,
        i.detail_id AS line_id,
        i.document_id,
        i.document_bsale_id,
        i.detail_id AS document_detail_id,
        i.detail_bsale_id AS document_detail_bsale_id,
        i.variant_id,
        i.document_type_id,
        i.document_number,
        i.emission_date,
        i.quantity,
        i.net_amount AS net_sales,
        i.line_kind,
        i.original_invoice_line_id,
        i.original_invoice_bsale_id,
        i.original_invoice_number,
        i.original_invoice_detail_bsale_id,
        reception.bsale_reception_id AS selected_reception_id,
        reception.admission_date AS selected_reception_date,
        CASE
            WHEN reception.bsale_reception_id IS NOT NULL THEN reception.cost
            WHEN i.variant_id = 5729 THEN 0::numeric
            ELSE NULL::numeric
        END AS unit_cost,
        CASE
            WHEN reception.bsale_reception_id IS NOT NULL
                THEN (reception.cost * i.quantity)::numeric
            WHEN i.variant_id = 5729 THEN 0::numeric
            ELSE NULL::numeric
        END AS line_cost,
        CASE
            WHEN reception.bsale_reception_id IS NOT NULL
                OR i.variant_id = 5729 THEN 'COSTED'::text
            ELSE 'SIN_COSTO'::text
        END AS cost_status,
        CASE
            WHEN reception.bsale_reception_id IS NOT NULL OR i.variant_id = 5729
                THEN (i.net_amount - COALESCE(reception.cost * i.quantity, 0))::numeric
            ELSE NULL::numeric
        END AS gross_profit,
        CASE
            WHEN (reception.bsale_reception_id IS NOT NULL OR i.variant_id = 5729)
              AND i.net_amount <> 0
                THEN round(((i.net_amount - COALESCE(reception.cost * i.quantity, 0)) / i.net_amount) * 100, 2)::numeric
            ELSE NULL::numeric
        END AS gross_margin_pct
    FROM simulation_lines i
    LEFT JOIN LATERAL (
        SELECT
            rd.bsale_reception_id,
            r.admission_date,
            rd.cost
        FROM integraciones.bsale_reception_details rd
        JOIN integraciones.bsale_receptions r
          ON r.company_id = rd.company_id
         AND r.bsale_id = rd.bsale_reception_id
        WHERE i.line_kind = 'INVOICE'
          AND rd.company_id = i.company_id
          AND rd.variant_id = i.variant_id
          AND rd.cost > 0
          AND r.admission_date <= i.emission_date
          AND COALESCE((r.raw_json ->> 'cancellationStatus')::integer, 0) <> 1
          AND translate(
                upper(COALESCE(r.document, '')),
                'ÁÉÍÓÚÜÑ',
                'AEIOUUN'
              ) NOT LIKE '%NOTA DE CREDITO%'
        ORDER BY r.admission_date DESC, rd.updated_at DESC NULLS LAST, rd.bsale_id DESC
        LIMIT 1
    ) reception ON true
    WHERE i.line_kind = 'INVOICE'
), resolved_lines AS MATERIALIZED (
    SELECT * FROM invoice_costs
    UNION ALL
    SELECT
        nc.company_id,
        nc.detail_id AS line_id,
        nc.document_id,
        nc.document_bsale_id,
        nc.detail_id AS document_detail_id,
        nc.detail_bsale_id AS document_detail_bsale_id,
        origin.variant_id,
        nc.document_type_id,
        nc.document_number,
        nc.emission_date,
        nc.quantity,
        nc.net_amount AS net_sales,
        nc.line_kind,
        nc.original_invoice_line_id,
        nc.original_invoice_bsale_id,
        nc.original_invoice_number,
        nc.original_invoice_detail_bsale_id,
        origin.selected_reception_id,
        origin.selected_reception_date,
        origin.unit_cost,
        CASE
            WHEN origin.cost_status = 'COSTED'
                THEN (origin.unit_cost * nc.quantity)::numeric
            ELSE NULL::numeric
        END AS line_cost,
        COALESCE(origin.cost_status, 'SIN_COSTO') AS cost_status,
        CASE
            WHEN origin.cost_status = 'COSTED'
                THEN (nc.net_amount - (origin.unit_cost * nc.quantity))::numeric
            ELSE NULL::numeric
        END AS gross_profit,
        CASE
            WHEN origin.cost_status = 'COSTED' AND nc.net_amount <> 0
                THEN round(((nc.net_amount - (origin.unit_cost * nc.quantity)) / nc.net_amount) * 100, 2)::numeric
            ELSE NULL::numeric
        END AS gross_margin_pct
    FROM simulation_lines nc
    LEFT JOIN invoice_costs origin
      ON origin.company_id = nc.company_id
     AND origin.line_id = nc.original_invoice_line_id
    WHERE nc.line_kind = 'CREDIT_NOTE'
), calculated_lines AS MATERIALIZED (
    SELECT
        r.*,
        CASE
            WHEN r.cost_status = 'COSTED' AND r.line_cost IS NOT NULL
                THEN (r.net_sales - r.line_cost)::numeric
            ELSE NULL::numeric
        END AS calculated_gross_profit,
        CASE
            WHEN r.cost_status = 'COSTED'
              AND r.net_sales <> 0
              AND r.line_cost IS NOT NULL
                THEN round(((r.net_sales - r.line_cost) / r.net_sales) * 100, 2)::numeric
            ELSE NULL::numeric
        END AS calculated_gross_margin_pct
    FROM resolved_lines r
), summary AS (
    SELECT
        count(*)::bigint AS total_lines,
        count(*) FILTER (WHERE cost_status = 'COSTED')::bigint AS covered_lines,
        count(*) FILTER (WHERE cost_status = 'SIN_COSTO')::bigint AS uncovered_lines
    FROM calculated_lines
)
SELECT
    l.company_id,
    l.line_id,
    l.document_id,
    l.document_bsale_id,
    l.document_detail_id,
    l.document_detail_bsale_id,
    l.variant_id,
    l.document_type_id,
    l.document_number,
    l.emission_date,
    l.quantity,
    l.net_sales,
    l.line_kind,
    l.original_invoice_line_id,
    l.original_invoice_bsale_id,
    l.original_invoice_number,
    l.original_invoice_detail_bsale_id,
    l.selected_reception_id,
    l.selected_reception_date,
    l.unit_cost,
    l.line_cost,
    l.calculated_gross_profit,
    l.calculated_gross_margin_pct,
    l.cost_status,
    s.total_lines,
    s.covered_lines,
    s.uncovered_lines,
    CASE
        WHEN s.total_lines = 0 THEN 0::numeric
        ELSE round((s.covered_lines::numeric / s.total_lines) * 100, 2)
    END AS cost_coverage_pct
FROM calculated_lines l
CROSS JOIN summary s
ORDER BY l.emission_date DESC, l.document_number DESC, l.line_id;
$$;

REVOKE ALL ON FUNCTION comisiones.get_v2_lines_profitability(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_v2_lines_profitability(uuid, date, date) TO authenticated, service_role;

COMMENT ON FUNCTION comisiones.get_v2_lines_profitability(uuid, date, date) IS
    'Read-only historical profitability for Comisiones V2 simulation lines. Uses the latest valid reception on or before invoice emission and resolves credit notes through their original invoice line.';
