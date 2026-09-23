-- Controlled rollback for 20260917153149.
-- Run only after the candidate function has been replaced and before the
-- product refresh is restored with the same company/date_to arguments.
BEGIN;

CREATE OR REPLACE FUNCTION integraciones.refresh_bsale_stock_break_read_models(
    p_company_id uuid,
    p_office_id int,
    p_date_from date,
    p_date_to date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, integraciones
AS $$
DECLARE
    result jsonb;
    updated_count int;
    window_from date := p_date_to - 59;
BEGIN
    result := integraciones.refresh_bsale_stock_break_read_models_before_sales_identity(
        p_company_id, p_office_id, p_date_from, p_date_to
    );

    WITH summary_rows AS (
        SELECT s.company_id, s.office_id, s.variant_id, s.variant_code,
               id_variant.bsale_id AS id_match,
               id_variant.code AS id_code,
               COALESCE(code_catalog.variant_count, 0) AS catalog_code_count,
               COALESCE(summary_codes.summary_code_count, 0) AS summary_code_count
        FROM integraciones.bsale_stock_break_summary_60d s
        LEFT JOIN integraciones.bsale_variants id_variant
          ON id_variant.company_id = s.company_id
         AND id_variant.bsale_id = s.variant_id
        LEFT JOIN (
            SELECT company_id, btrim(code) AS code,
                   count(DISTINCT bsale_id) AS variant_count
            FROM integraciones.bsale_variants
            WHERE code IS NOT NULL AND btrim(code) <> ''
            GROUP BY company_id, btrim(code)
        ) code_catalog
          ON code_catalog.company_id = s.company_id
         AND code_catalog.code = btrim(s.variant_code)
        LEFT JOIN (
            SELECT company_id, btrim(variant_code) AS code,
                   count(DISTINCT variant_id) AS summary_code_count
            FROM integraciones.bsale_stock_break_summary_60d
            WHERE variant_code IS NOT NULL AND btrim(variant_code) <> ''
            GROUP BY company_id, btrim(variant_code)
        ) summary_codes
          ON summary_codes.company_id = s.company_id
         AND summary_codes.code = btrim(s.variant_code)
        WHERE s.company_id = p_company_id AND s.office_id = p_office_id
    ), classified AS (
        SELECT r.*,
               CASE
                   WHEN r.id_match IS NOT NULL THEN 'VARIANT_ID'
                   WHEN r.variant_code IS NULL OR btrim(r.variant_code) = '' THEN 'NONE'
                   WHEN r.catalog_code_count = 0 AND r.summary_code_count = 1 THEN 'VARIANT_CODE'
                   ELSE 'AMBIGUOUS'
               END AS identity_method,
               CASE
                   WHEN r.id_match IS NOT NULL THEN r.id_code
                   WHEN r.catalog_code_count = 0 AND r.summary_code_count = 1 THEN btrim(r.variant_code)
                   ELSE NULL
               END AS effective_code
        FROM summary_rows r
    ), sales_daily AS (
        SELECT company_id, btrim(variant_code) AS code, emission_date::date AS sale_date,
               sum(logistic_net_quantity) AS units
        FROM integraciones.vw_bsale_sales_logistic_valid
        WHERE company_id = p_company_id
          AND emission_date::date BETWEEN window_from AND p_date_to
          AND variant_code IS NOT NULL AND btrim(variant_code) <> ''
        GROUP BY company_id, btrim(variant_code), emission_date::date
    ), metrics AS (
        SELECT c.variant_id,
               COALESCE(sum(s.units) FILTER (WHERE d.available_during_day), 0) AS units_with_stock,
               COALESCE(sum(s.units) FILTER (WHERE NOT d.state_known), 0) AS units_unknown,
               count(*) FILTER (WHERE s.units > 0 AND d.state_known AND NOT d.available_during_day) AS positive_without_stock
        FROM classified c
        JOIN sales_daily s ON s.company_id = c.company_id AND s.code = c.effective_code
        JOIN integraciones.bsale_stock_availability_daily_60d d
          ON d.company_id = c.company_id AND d.office_id = c.office_id
         AND d.variant_id = c.variant_id AND d.availability_date = s.sale_date
        WHERE c.identity_method IN ('VARIANT_ID', 'VARIANT_CODE')
        GROUP BY c.variant_id
    )
    UPDATE integraciones.bsale_stock_break_summary_60d summary
    SET sales_identity_resolved_60d = c.identity_method IN ('VARIANT_ID', 'VARIANT_CODE'),
        sales_identity_method_60d = c.identity_method,
        units_sold_with_stock_60d = CASE WHEN c.identity_method IN ('VARIANT_ID', 'VARIANT_CODE') THEN COALESCE(m.units_with_stock, 0) ELSE 0 END,
        units_sold_unknown_days_60d = CASE WHEN c.identity_method IN ('VARIANT_ID', 'VARIANT_CODE') THEN COALESCE(m.units_unknown, 0) ELSE 0 END,
        sales_rate_with_stock_60d = CASE WHEN c.identity_method IN ('VARIANT_ID', 'VARIANT_CODE') AND summary.days_with_stock_60d > 0 THEN COALESCE(m.units_with_stock, 0) / summary.days_with_stock_60d ELSE NULL END,
        positive_sales_without_stock_60d = CASE WHEN c.identity_method IN ('VARIANT_ID', 'VARIANT_CODE') THEN COALESCE(m.positive_without_stock, 0) ELSE 0 END,
        refreshed_at = now()
    FROM classified c LEFT JOIN metrics m ON m.variant_id = c.variant_id
    WHERE summary.company_id = c.company_id
      AND summary.office_id = c.office_id
      AND summary.variant_id = c.variant_id;
    GET DIAGNOSTICS updated_count = ROW_COUNT;

    RETURN result || jsonb_build_object('identity_metric_rows', updated_count);
END;
$$;

REVOKE ALL ON FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date) TO service_role;

COMMIT;

-- Then, with the original production arguments, execute once:
-- SELECT integraciones.refresh_bsale_stock_break_read_models(
--     '<company_id>'::uuid, 1, '<date_from>'::date, '<date_to>'::date
-- );
