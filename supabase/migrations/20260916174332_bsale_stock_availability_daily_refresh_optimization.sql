-- Replace the correlated daily availability build with a set-based build.
-- The stock-only function and all sales formulas remain unchanged.

CREATE INDEX IF NOT EXISTS idx_bsale_kardex_events_company_office_date_variant
    ON integraciones.bsale_stock_kardex_events(company_id, office_id, event_date, variant_id);

CREATE INDEX IF NOT EXISTS idx_bsale_stock_snapshots_company_office_date_variant
    ON integraciones.bsale_stock_daily_snapshots(company_id, office_id, snapshot_date, variant_id);

ALTER FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date)
    RENAME TO refresh_bsale_stock_break_read_models_correlated;

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
            SELECT variant_id, variant_code
            FROM integraciones.bsale_stock_current
            WHERE company_id = p_company_id AND office_id = p_office_id
            UNION ALL
            SELECT variant_id, variant_code
            FROM integraciones.bsale_stock_kardex_events
            WHERE company_id = p_company_id AND office_id = p_office_id
            UNION ALL
            SELECT variant_id, variant_code
            FROM integraciones.bsale_stock_daily_snapshots
            WHERE company_id = p_company_id AND office_id = p_office_id
        ) source_variants
        GROUP BY variant_id
    ), days AS (
        SELECT v.variant_id, v.variant_code,
               generate_series(window_from, p_date_to, interval '1 day')::date AS availability_date
        FROM variants v
    ), points AS MATERIALIZED (
        SELECT variant_id, event_date AS checkpoint_date,
               variant_stock_after AS stock_after,
               variant_stock_after - quantity_delta AS stock_before,
               false AS is_snapshot, captured_at AS point_order
        FROM integraciones.bsale_stock_kardex_events
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND event_date <= p_date_to AND variant_stock_after IS NOT NULL
        UNION ALL
        SELECT variant_id, snapshot_date, quantity, NULL,
               true, captured_at
        FROM integraciones.bsale_stock_daily_snapshots
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND snapshot_date <= p_date_to AND quantity IS NOT NULL
    ), checkpoint_daily AS (
        SELECT variant_id, checkpoint_date,
               COALESCE(bool_or(stock_after <= 0), false) AS has_zero,
               COALESCE(bool_or(stock_after > 0 OR COALESCE(stock_before > 0, false)), false) AS has_positive,
               COALESCE(bool_or(stock_after > 0), false) AS has_positive_after,
               COALESCE(bool_or(is_snapshot), false) AS has_snapshot,
               (array_agg(stock_after ORDER BY is_snapshot DESC, point_order DESC))[1] AS closing_stock
        FROM points
        GROUP BY variant_id, checkpoint_date
    ), checkpoint_state AS (
        SELECT variant_id, checkpoint_date,
               CASE
                   WHEN has_snapshot THEN CASE WHEN closing_stock <= 0 THEN 'ZERO' ELSE 'POSITIVE' END
                   WHEN has_zero AND has_positive_after THEN 'POSITIVE'
                   WHEN has_zero THEN 'ZERO'
                   WHEN has_positive THEN 'POSITIVE'
                   ELSE 'UNKNOWN'
               END AS closing_state
        FROM checkpoint_daily
    ), initial_checkpoint AS (
        SELECT DISTINCT ON (variant_id)
               variant_id, checkpoint_date, closing_state
        FROM checkpoint_state
        WHERE checkpoint_date < window_from
        ORDER BY variant_id, checkpoint_date DESC
    ), marked_days AS (
        SELECT d.variant_id, d.variant_code, d.availability_date,
               COALESCE(c.has_positive, false) AS has_positive,
               COALESCE(c.has_zero, false) AS has_zero,
               max(COALESCE(c.checkpoint_date, initial.checkpoint_date)) OVER (
                   PARTITION BY d.variant_id ORDER BY d.availability_date
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS last_checkpoint_date,
               COALESCE(max(COALESCE(c.checkpoint_date, initial.checkpoint_date)) OVER (
                   PARTITION BY d.variant_id ORDER BY d.availability_date
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ), initial.checkpoint_date) AS previous_checkpoint_date
        FROM days d
        LEFT JOIN checkpoint_daily c
          ON c.variant_id = d.variant_id
         AND c.checkpoint_date = d.availability_date
        LEFT JOIN initial_checkpoint initial
          ON initial.variant_id = d.variant_id
    ), resolved_days AS (
        SELECT m.*, previous_state.closing_state AS previous_state,
               (m.last_checkpoint_date IS NOT NULL) AS state_known
        FROM marked_days m
        LEFT JOIN checkpoint_state previous_state
          ON previous_state.variant_id = m.variant_id
         AND previous_state.checkpoint_date = m.previous_checkpoint_date
    )
    SELECT p_company_id, p_office_id, variant_id, variant_code, availability_date,
        (has_positive OR previous_state = 'POSITIVE'),
        (has_zero OR (state_known AND NOT (has_positive OR previous_state = 'POSITIVE'))),
        state_known,
        now()
    FROM resolved_days;
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
               count(*) FILTER (WHERE s.logistic_net_quantity > 0
                                 AND d.state_known AND NOT d.available_during_day) AS positive_without_stock
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
