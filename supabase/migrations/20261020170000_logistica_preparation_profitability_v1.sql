-- ============================================================================
-- Rentabilidad V1 para Preparación de Pedidos
--
-- Reutiliza exactamente la metodología de Guías de Ruta:
--   * venta neta de las líneas de la NV comercial;
--   * último costo válido de recepción de compra con admission_date <= emisión;
--   * cost > 0;
--   * excluye recepciones canceladas y Notas de Crédito;
--   * resuelve variant_id igual que Guías;
--   * mantiene la regla especial vigente para variant_id = 5729;
--   * utilidad y margen se calculan sólo sobre venta cubierta.
--
-- No usa prepared_quantity ni audit_quantity: Preparación/Auditoría no
-- modifican la NV comercial.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION logistica.get_sales_order_preparation_profitability_summary_v1(
    p_company_id uuid,
    p_bsale_nv_ids bigint[]
)
RETURNS TABLE (
    bsale_nv_id bigint,
    nv_folio text,
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
       AND NOT core.has_permission_for_company(v_actor_id, p_company_id, 'module.logistica.view') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'LOGISTICA_VIEW_DENIED';
    END IF;

    RETURN QUERY
    WITH requested_nvs AS (
        SELECT DISTINCT nv_id AS bsale_nv_id
        FROM pg_catalog.unnest(COALESCE(p_bsale_nv_ids, ARRAY[]::bigint[])) AS nv_id
    ),
    nv_scope AS (
        SELECT
            r.bsale_nv_id,
            d.number::text AS nv_folio,
            d.company_id,
            d.emission_date AS document_date
        FROM requested_nvs r
        JOIN integraciones.bsale_documents d
          ON d.company_id = p_company_id
         AND d.bsale_id = r.bsale_nv_id
         AND d.state = 0
         AND d.document_type_id = 23
    ),
    sales_lines AS (
        SELECT
            ns.bsale_nv_id,
            ns.nv_folio,
            ns.document_date,
            det.bsale_id AS document_detail_id,
            COALESCE(det.variant_id, code_variant.bsale_id) AS bsale_variant_id,
            det.quantity,
            det.net_amount AS net_sales,
            ns.company_id
        FROM nv_scope ns
        JOIN integraciones.bsale_document_details det
          ON det.company_id = ns.company_id
         AND det.bsale_document_id = ns.bsale_nv_id
        LEFT JOIN integraciones.bsale_variants code_variant
          ON code_variant.company_id = ns.company_id
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
            r.bsale_nv_id,
            ns.nv_folio,
            pg_catalog.count(rl.document_detail_id)::integer AS total_lines,
            pg_catalog.count(rl.document_detail_id) FILTER (WHERE rl.line_cost_status = 'COSTED')::integer AS covered_lines,
            pg_catalog.count(rl.document_detail_id) FILTER (WHERE rl.line_cost_status = 'SIN_COSTO')::integer AS uncovered_lines,
            COALESCE(pg_catalog.sum(rl.net_sales), 0)::numeric(14,2) AS sales_net_total,
            COALESCE(pg_catalog.sum(rl.net_sales) FILTER (WHERE rl.line_cost_status = 'COSTED'), 0)::numeric(14,2) AS covered_sales_net,
            COALESCE(pg_catalog.sum(rl.net_sales) FILTER (WHERE rl.line_cost_status = 'SIN_COSTO'), 0)::numeric(14,2) AS uncovered_sales_net,
            COALESCE(pg_catalog.sum(rl.line_cost) FILTER (WHERE rl.line_cost_status = 'COSTED'), 0)::numeric(14,2) AS last_purchase_cost_total
        FROM requested_nvs r
        LEFT JOIN nv_scope ns ON ns.bsale_nv_id = r.bsale_nv_id
        LEFT JOIN resolved_lines rl ON rl.bsale_nv_id = r.bsale_nv_id
        GROUP BY r.bsale_nv_id, ns.nv_folio
    )
    SELECT
        r.bsale_nv_id,
        r.nv_folio,
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
    ORDER BY r.bsale_nv_id;
END;
$function$;

REVOKE ALL ON FUNCTION logistica.get_sales_order_preparation_profitability_summary_v1(uuid, bigint[])
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.get_sales_order_preparation_profitability_summary_v1(uuid, bigint[])
    TO authenticated, service_role;

COMMIT;
