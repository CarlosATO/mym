-- Daily physical-stock evidence and sales velocity while stock was available.
-- This migration intentionally follows the null-safe availability read model.

CREATE TABLE IF NOT EXISTS integraciones.bsale_stock_availability_daily_60d (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES core.companies(id),
    office_id int NOT NULL,
    variant_id int NOT NULL,
    variant_code text,
    availability_date date NOT NULL,
    available_during_day boolean NOT NULL,
    stockout_confirmed boolean NOT NULL,
    state_known boolean NOT NULL,
    refreshed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, office_id, variant_id, availability_date)
);

CREATE INDEX IF NOT EXISTS idx_bsale_stock_availability_daily_lookup
    ON integraciones.bsale_stock_availability_daily_60d
       (company_id, office_id, variant_id, availability_date);

ALTER TABLE integraciones.bsale_stock_availability_daily_60d ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'integraciones'
          AND tablename = 'bsale_stock_availability_daily_60d'
          AND policyname = 'rls_bsale_stock_availability_daily_select'
    ) THEN
        CREATE POLICY rls_bsale_stock_availability_daily_select
            ON integraciones.bsale_stock_availability_daily_60d FOR SELECT TO authenticated
            USING (core.has_company_access(auth.uid(), company_id));
    END IF;
END;
$$;

GRANT SELECT ON integraciones.bsale_stock_availability_daily_60d TO authenticated;
GRANT ALL ON integraciones.bsale_stock_availability_daily_60d TO service_role;

ALTER TABLE integraciones.bsale_stock_break_summary_60d
    ADD COLUMN IF NOT EXISTS units_sold_with_stock_60d numeric(14,3) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS units_sold_unknown_days_60d numeric(14,3) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS sales_rate_with_stock_60d numeric(14,6),
    ADD COLUMN IF NOT EXISTS known_days_60d int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS evidence_coverage_pct numeric(7,3) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS positive_sales_without_stock_60d int NOT NULL DEFAULT 0;

-- Preserve the already validated stock/interval calculation and decorate its
-- result with the daily model and sales metrics in one refresh call.
ALTER FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date)
    RENAME TO refresh_bsale_stock_break_read_models_stock_only;

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
    base_result jsonb;
    daily_count int;
    metric_count int;
    window_from date := p_date_to - 59;
BEGIN
    base_result := integraciones.refresh_bsale_stock_break_read_models_stock_only(
        p_company_id, p_office_id, p_date_from, p_date_to
    );

    DELETE FROM integraciones.bsale_stock_availability_daily_60d
    WHERE company_id = p_company_id
      AND office_id = p_office_id
      AND availability_date BETWEEN window_from AND p_date_to;

    INSERT INTO integraciones.bsale_stock_availability_daily_60d (
        company_id, office_id, variant_id, variant_code, availability_date,
        available_during_day, stockout_confirmed, state_known, refreshed_at
    )
    WITH variants AS (
        SELECT variant_id, max(variant_code) AS variant_code
        FROM (
            SELECT variant_id, variant_code FROM integraciones.bsale_stock_current
            WHERE company_id = p_company_id AND office_id = p_office_id
            UNION ALL
            SELECT variant_id, variant_code FROM integraciones.bsale_stock_kardex_events
            WHERE company_id = p_company_id AND office_id = p_office_id
            UNION ALL
            SELECT variant_id, variant_code FROM integraciones.bsale_stock_daily_snapshots
            WHERE company_id = p_company_id AND office_id = p_office_id
        ) all_variants
        GROUP BY variant_id
    ), days AS (
        SELECT variants.*, generate_series(window_from, p_date_to, interval '1 day')::date AS availability_date
        FROM variants
    ), points AS (
        SELECT variant_id, event_date AS point_date, variant_stock_after AS stock_after,
               variant_stock_after - quantity_delta AS stock_before,
               false AS is_snapshot, captured_at AS point_order
        FROM integraciones.bsale_stock_kardex_events
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND event_date <= p_date_to AND variant_stock_after IS NOT NULL
        UNION ALL
        SELECT variant_id, snapshot_date, quantity, NULL, true, captured_at
        FROM integraciones.bsale_stock_daily_snapshots
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND snapshot_date <= p_date_to AND quantity IS NOT NULL
    ), daily AS (
        SELECT d.variant_id, d.variant_code, d.availability_date,
            EXISTS (SELECT 1 FROM points p WHERE p.variant_id = d.variant_id
                AND p.point_date = d.availability_date
                AND (p.stock_after > 0 OR COALESCE(p.stock_before > 0, false))) AS has_positive,
            EXISTS (SELECT 1 FROM points p WHERE p.variant_id = d.variant_id
                AND p.point_date = d.availability_date AND p.stock_after <= 0) AS has_zero,
            EXISTS (SELECT 1 FROM points p WHERE p.variant_id = d.variant_id
                AND p.point_date <= d.availability_date) AS has_history,
            (SELECT p.stock_after > 0 FROM points p WHERE p.variant_id = d.variant_id
                AND p.point_date < d.availability_date
                ORDER BY p.point_date DESC, p.is_snapshot DESC, p.point_order DESC LIMIT 1) AS prior_positive,
            (SELECT p.stock_after > 0 FROM points p WHERE p.variant_id = d.variant_id
                AND p.point_date = d.availability_date
                ORDER BY p.is_snapshot DESC, p.point_order DESC LIMIT 1) AS closing_positive
        FROM days d
    )
    SELECT p_company_id, p_office_id, variant_id, variant_code, availability_date,
        (has_positive OR COALESCE(prior_positive, false)),
        (has_zero OR (has_history AND NOT (has_positive OR COALESCE(prior_positive, false)))),
        has_history,
        now()
    FROM daily;
    GET DIAGNOSTICS daily_count = ROW_COUNT;

    WITH daily_totals AS (
        SELECT variant_id,
            count(*) FILTER (WHERE available_during_day) AS days_with_stock,
            count(*) FILTER (WHERE NOT state_known) AS days_unknown
        FROM integraciones.bsale_stock_availability_daily_60d
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND availability_date BETWEEN window_from AND p_date_to
        GROUP BY variant_id
    ), sales_by_state AS (
        SELECT v.bsale_id AS variant_id,
            COALESCE(sum(s.logistic_net_quantity) FILTER (WHERE d.available_during_day), 0) AS units_with_stock,
            COALESCE(sum(s.logistic_net_quantity) FILTER (WHERE NOT d.state_known), 0) AS units_unknown,
            count(*) FILTER (WHERE s.logistic_net_quantity > 0 AND d.state_known AND NOT d.available_during_day) AS positive_without_stock
        FROM integraciones.vw_bsale_sales_logistic_valid s
        JOIN integraciones.bsale_variants v
          ON v.company_id = s.company_id AND v.code = s.variant_code
        JOIN integraciones.bsale_stock_availability_daily_60d d
          ON d.company_id = s.company_id AND d.office_id = p_office_id
         AND d.variant_id = v.bsale_id AND d.availability_date = s.emission_date::date
        WHERE s.company_id = p_company_id
          AND s.emission_date::date BETWEEN window_from AND p_date_to
        GROUP BY v.bsale_id
    )
    UPDATE integraciones.bsale_stock_break_summary_60d summary
    SET days_with_stock_60d = totals.days_with_stock,
        days_unknown_60d = totals.days_unknown,
        units_sold_with_stock_60d = COALESCE(sales.units_with_stock, 0),
        units_sold_unknown_days_60d = COALESCE(sales.units_unknown, 0),
        sales_rate_with_stock_60d = CASE WHEN totals.days_with_stock > 0
            THEN COALESCE(sales.units_with_stock, 0) / totals.days_with_stock ELSE NULL END,
        known_days_60d = 60 - totals.days_unknown,
        evidence_coverage_pct = (60 - totals.days_unknown)::numeric / 60 * 100,
        positive_sales_without_stock_60d = COALESCE(sales.positive_without_stock, 0),
        refreshed_at = now()
    FROM daily_totals totals
    LEFT JOIN sales_by_state sales ON sales.variant_id = totals.variant_id
    WHERE summary.company_id = p_company_id AND summary.office_id = p_office_id
      AND summary.variant_id = totals.variant_id;
    GET DIAGNOSTICS metric_count = ROW_COUNT;

    RETURN base_result || jsonb_build_object('daily_rows', daily_count, 'metric_rows', metric_count);
END;
$$;

REVOKE ALL ON FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date) TO service_role;

CREATE OR REPLACE FUNCTION integraciones.get_bsale_stock_break_summary_60d(
    p_company_id uuid,
    p_office_id int
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, integraciones
AS $$
    SELECT COALESCE(jsonb_object_agg(summary.variant_id::text, jsonb_build_object(
        'breakDays', summary.confirmed_break_days_60d,
        'breakCount', summary.break_count_60d,
        'daysWithoutStock', summary.days_without_stock_60d,
        'daysWithStock', summary.days_with_stock_60d,
        'daysUnknown', summary.days_unknown_60d,
        'unitsSoldWithStock', summary.units_sold_with_stock_60d,
        'unitsSoldUnknownDays', summary.units_sold_unknown_days_60d,
        'salesRateWithStock', summary.sales_rate_with_stock_60d,
        'knownDays', summary.known_days_60d,
        'evidenceCoveragePct', summary.evidence_coverage_pct,
        'positiveSalesWithoutStock', summary.positive_sales_without_stock_60d,
        'salesDatesWithStock', COALESCE(sales_dates.items, '[]'::jsonb),
        'lastBreakDate', summary.last_break_date,
        'stockoutRanges', COALESCE(ranges.items, '[]'::jsonb)
    )), '{}'::jsonb)
    FROM integraciones.bsale_stock_break_summary_60d summary
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('from', i.start_date, 'to', i.end_date) ORDER BY i.start_date) AS items
        FROM integraciones.bsale_stock_break_intervals_60d i
        WHERE i.company_id = summary.company_id AND i.office_id = summary.office_id
          AND i.variant_id = summary.variant_id
    ) ranges ON true
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('date', s.sale_date, 'units', s.units)
                         ORDER BY s.sale_date) AS items
        FROM (
            SELECT v.bsale_id AS variant_id, x.emission_date::date AS sale_date,
                   sum(x.logistic_net_quantity) AS units
            FROM integraciones.vw_bsale_sales_logistic_valid x
            JOIN integraciones.bsale_variants v
              ON v.company_id = x.company_id AND v.code = x.variant_code
            JOIN integraciones.bsale_stock_availability_daily_60d d
              ON d.company_id = x.company_id AND d.office_id = summary.office_id
             AND d.variant_id = v.bsale_id AND d.availability_date = x.emission_date::date
             AND d.available_during_day
            WHERE x.company_id = summary.company_id
              AND v.bsale_id = summary.variant_id
              AND x.emission_date::date BETWEEN summary.date_from AND summary.date_to
            GROUP BY v.bsale_id, x.emission_date::date
            HAVING sum(x.logistic_net_quantity) <> 0
        ) s
    ) sales_dates ON true
    WHERE summary.company_id = p_company_id AND summary.office_id = p_office_id;
$$;

REVOKE ALL ON FUNCTION integraciones.get_bsale_stock_break_summary_60d(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integraciones.get_bsale_stock_break_summary_60d(uuid, int) TO service_role;
