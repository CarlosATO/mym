-- ============================================================================
-- Detalle lazy de artículos sin costo identificado
--
-- Comparte exactamente la selección de costo de:
--   logistica.get_sales_order_preparation_profitability_summary_v1
--
-- Sólo devuelve líneas SIN_COSTO. No participa del resumen financiero por NV.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION logistica.get_sales_order_preparation_missing_cost_lines_v1(
    p_company_id uuid,
    p_bsale_nv_ids bigint[]
)
RETURNS TABLE (
    bsale_nv_id bigint,
    nv_folio text,
    variant_id integer,
    sku text,
    product_name text,
    quantity numeric,
    line_net_amount numeric(14,2),
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
            det.net_amount AS line_net_amount,
            ns.company_id
        FROM nv_scope ns
        JOIN integraciones.bsale_document_details det
          ON det.company_id = ns.company_id
         AND det.bsale_document_id = ns.bsale_nv_id
        LEFT JOIN integraciones.bsale_variants v
          ON v.company_id = ns.company_id
         AND v.bsale_id = det.variant_id
        LEFT JOIN integraciones.bsale_variants code_variant
          ON code_variant.company_id = ns.company_id
         AND code_variant.code = det.variant_code
         AND det.variant_id IS NULL
        LEFT JOIN integraciones.bsale_products bp
          ON bp.company_id = ns.company_id
         AND bp.bsale_id = COALESCE(v.bsale_product_id, code_variant.bsale_product_id)
    ),
    resolved_lines AS (
        SELECT
            sl.*,
            CASE
                WHEN reception.bsale_reception_id IS NOT NULL OR sl.bsale_variant_id = 5729
                    THEN 'COSTED'
                ELSE 'SIN_COSTO'
            END AS line_cost_status
        FROM sales_lines sl
        LEFT JOIN LATERAL (
            SELECT rd.bsale_reception_id
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
    )
    SELECT
        rl.bsale_nv_id,
        rl.nv_folio,
        rl.bsale_variant_id AS variant_id,
        rl.sku,
        rl.product_name,
        rl.quantity,
        rl.line_net_amount::numeric(14,2),
        rl.line_cost_status AS cost_status
    FROM resolved_lines rl
    WHERE rl.line_cost_status = 'SIN_COSTO'
    ORDER BY rl.bsale_nv_id, rl.sku NULLS LAST, rl.product_name, rl.document_detail_id;
END;
$function$;

REVOKE ALL ON FUNCTION logistica.get_sales_order_preparation_missing_cost_lines_v1(uuid, bigint[])
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.get_sales_order_preparation_missing_cost_lines_v1(uuid, bigint[])
    TO authenticated, service_role;

COMMIT;
