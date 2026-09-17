-- Keep the daily stock state booleans non-null for snapshot-only rows.
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
    evidence_count int;
    summary_count int;
    interval_count int;
    variant record;
    point record;
    day date;
    previous_state text;
    open_start date;
    break_count int;
    days_without_stock int;
    days_with_stock int;
    days_unknown int;
    available_today boolean;
    window_from date := p_date_to - 59;
BEGIN
    DELETE FROM integraciones.bsale_stock_daily_break_evidence
    WHERE company_id = p_company_id
      AND office_id = p_office_id
      AND evidence_date BETWEEN window_from AND p_date_to;

    INSERT INTO integraciones.bsale_stock_daily_break_evidence (
        company_id, office_id, variant_id, variant_code, evidence_date,
        break_confirmed, kardex_break_confirmed, snapshot_break_confirmed,
        min_variant_stock_after, evidence_source, refreshed_at
    )
    SELECT company_id, office_id, variant_id, max(variant_code), evidence_date,
        bool_or(kardex_break_confirmed OR snapshot_break_confirmed),
        bool_or(kardex_break_confirmed), bool_or(snapshot_break_confirmed),
        min(min_variant_stock_after),
        CASE WHEN bool_or(kardex_break_confirmed) AND bool_or(snapshot_break_confirmed) THEN 'BOTH'
             WHEN bool_or(kardex_break_confirmed) THEN 'KARDEX' ELSE 'SNAPSHOT' END,
        now()
    FROM (
        SELECT company_id, office_id, variant_id, variant_code, event_date AS evidence_date,
            true AS kardex_break_confirmed, false AS snapshot_break_confirmed,
            variant_stock_after AS min_variant_stock_after
        FROM integraciones.bsale_stock_kardex_events
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND event_date BETWEEN window_from AND p_date_to AND variant_stock_after <= 0
        UNION ALL
        SELECT company_id, office_id, variant_id, variant_code, snapshot_date,
            false, true, quantity
        FROM integraciones.bsale_stock_daily_snapshots
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND snapshot_date BETWEEN window_from AND p_date_to AND quantity <= 0
    ) evidence
    GROUP BY company_id, office_id, variant_id, evidence_date;
    GET DIAGNOSTICS evidence_count = ROW_COUNT;

    CREATE TEMP TABLE _bsale_stock_break_daily (
        variant_id int NOT NULL,
        checkpoint_date date NOT NULL,
        has_zero boolean NOT NULL,
        has_positive boolean NOT NULL,
        state text NOT NULL,
        PRIMARY KEY (variant_id, checkpoint_date)
    ) ON COMMIT DROP;

    INSERT INTO _bsale_stock_break_daily (variant_id, checkpoint_date, has_zero, has_positive, state)
    WITH points AS (
        SELECT variant_id, event_date AS checkpoint_date,
            variant_stock_after AS stock_after,
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
        SELECT variant_id, checkpoint_date,
            COALESCE(bool_or(stock_after <= 0), false) AS has_zero,
            COALESCE(bool_or(
                stock_after > 0
                OR COALESCE(stock_before > 0, false)
            ), false) AS has_positive,
            COALESCE(bool_or(is_snapshot), false) AS has_snapshot,
            (array_agg(stock_after ORDER BY is_snapshot DESC, point_order DESC))[1] AS closing_stock,
            COALESCE(bool_or(stock_after > 0), false) AS has_positive_after
        FROM points
        GROUP BY variant_id, checkpoint_date
    )
    SELECT variant_id, checkpoint_date, has_zero, has_positive,
        CASE
            WHEN has_snapshot THEN CASE WHEN closing_stock <= 0 THEN 'ZERO' ELSE 'POSITIVE' END
            WHEN has_zero AND has_positive_after THEN 'POSITIVE'
            WHEN has_zero THEN 'ZERO'
            WHEN has_positive THEN 'POSITIVE'
            ELSE 'UNKNOWN'
        END
    FROM daily;

    DELETE FROM integraciones.bsale_stock_break_intervals_60d
    WHERE company_id = p_company_id AND office_id = p_office_id;

    CREATE TEMP TABLE _bsale_stock_break_interval_calc (
        variant_id int PRIMARY KEY,
        break_count int NOT NULL,
        days_without_stock int NOT NULL,
        days_with_stock int NOT NULL,
        days_unknown int NOT NULL
    ) ON COMMIT DROP;

    FOR variant IN
        SELECT variant_id FROM (
            SELECT variant_id FROM integraciones.bsale_stock_current
            WHERE company_id = p_company_id AND office_id = p_office_id
            UNION
            SELECT variant_id FROM integraciones.bsale_stock_kardex_events
            WHERE company_id = p_company_id AND office_id = p_office_id
            UNION
            SELECT variant_id FROM integraciones.bsale_stock_daily_snapshots
            WHERE company_id = p_company_id AND office_id = p_office_id
        ) variants
    LOOP
        previous_state := NULL;
        open_start := NULL;
        break_count := 0;
        days_without_stock := 0;
        days_with_stock := 0;
        days_unknown := 0;

        SELECT state INTO previous_state
        FROM _bsale_stock_break_daily
        WHERE variant_id = variant.variant_id AND checkpoint_date < window_from
        ORDER BY checkpoint_date DESC
        LIMIT 1;

        IF previous_state = 'ZERO' THEN
            break_count := 1;
            open_start := window_from;
        END IF;

        FOR day IN SELECT generate_series(window_from, p_date_to, interval '1 day')::date
        LOOP
            SELECT state, has_zero, has_positive
            INTO point
            FROM _bsale_stock_break_daily
            WHERE variant_id = variant.variant_id AND checkpoint_date = day;

            IF FOUND THEN
                IF point.has_zero AND previous_state IS DISTINCT FROM 'ZERO' THEN
                    break_count := break_count + 1;
                END IF;

                available_today := point.has_positive OR previous_state = 'POSITIVE';

                IF point.state = 'ZERO' THEN
                    IF open_start IS NULL THEN open_start := day; END IF;
                ELSIF point.state = 'POSITIVE' THEN
                    IF open_start IS NOT NULL THEN
                        INSERT INTO integraciones.bsale_stock_break_intervals_60d (
                            company_id, office_id, variant_id, start_date, end_date,
                            days_without_stock, is_open, refreshed_at
                        ) VALUES (
                            p_company_id, p_office_id, variant.variant_id, open_start, day - 1,
                            day - open_start, false, now()
                        );
                        days_without_stock := days_without_stock + (day - open_start);
                        open_start := NULL;
                    END IF;
                END IF;
                previous_state := point.state;
            ELSE
                available_today := previous_state = 'POSITIVE';
            END IF;

            IF available_today THEN
                days_with_stock := days_with_stock + 1;
            ELSIF previous_state IS NULL THEN
                days_unknown := days_unknown + 1;
            END IF;
        END LOOP;

        IF open_start IS NOT NULL THEN
            INSERT INTO integraciones.bsale_stock_break_intervals_60d (
                company_id, office_id, variant_id, start_date, end_date,
                days_without_stock, is_open, refreshed_at
            ) VALUES (
                p_company_id, p_office_id, variant.variant_id, open_start, p_date_to,
                p_date_to - open_start + 1, true, now()
            );
            days_without_stock := days_without_stock + (p_date_to - open_start + 1);
        END IF;

        INSERT INTO _bsale_stock_break_interval_calc
        VALUES (variant.variant_id, break_count, days_without_stock, days_with_stock, days_unknown);
    END LOOP;

    SELECT count(*) INTO interval_count
    FROM integraciones.bsale_stock_break_intervals_60d
    WHERE company_id = p_company_id AND office_id = p_office_id;

    INSERT INTO integraciones.bsale_stock_break_summary_60d (
        company_id, office_id, variant_id, variant_code, date_from, date_to,
        confirmed_break_days_60d, kardex_break_days_60d, snapshot_break_days_60d,
        break_count_60d, days_without_stock_60d, days_with_stock_60d, days_unknown_60d,
        last_break_date, refreshed_at
    )
    SELECT p_company_id, p_office_id, variants.variant_id, variants.variant_code,
        p_date_to - 59, p_date_to,
        count(evidence.evidence_date) FILTER (WHERE evidence.break_confirmed),
        count(evidence.evidence_date) FILTER (WHERE evidence.kardex_break_confirmed),
        count(evidence.evidence_date) FILTER (WHERE evidence.snapshot_break_confirmed),
        intervals.break_count, intervals.days_without_stock, intervals.days_with_stock,
        intervals.days_unknown,
        max(evidence.evidence_date) FILTER (WHERE evidence.break_confirmed), now()
    FROM (
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
    ) variants
    JOIN _bsale_stock_break_interval_calc intervals ON intervals.variant_id = variants.variant_id
    LEFT JOIN integraciones.bsale_stock_daily_break_evidence evidence
      ON evidence.company_id = p_company_id AND evidence.office_id = p_office_id
     AND evidence.variant_id = variants.variant_id
     AND evidence.evidence_date BETWEEN p_date_to - 59 AND p_date_to
    GROUP BY variants.variant_id, variants.variant_code, intervals.break_count,
        intervals.days_without_stock, intervals.days_with_stock, intervals.days_unknown
    ON CONFLICT (company_id, office_id, variant_id) DO UPDATE SET
        variant_code = EXCLUDED.variant_code, date_from = EXCLUDED.date_from,
        date_to = EXCLUDED.date_to, confirmed_break_days_60d = EXCLUDED.confirmed_break_days_60d,
        kardex_break_days_60d = EXCLUDED.kardex_break_days_60d,
        snapshot_break_days_60d = EXCLUDED.snapshot_break_days_60d,
        break_count_60d = EXCLUDED.break_count_60d,
        days_without_stock_60d = EXCLUDED.days_without_stock_60d,
        days_with_stock_60d = EXCLUDED.days_with_stock_60d,
        days_unknown_60d = EXCLUDED.days_unknown_60d,
        last_break_date = EXCLUDED.last_break_date, refreshed_at = now();
    GET DIAGNOSTICS summary_count = ROW_COUNT;
    RETURN jsonb_build_object(
        'evidence_rows', evidence_count,
        'interval_rows', interval_count,
        'summary_rows', summary_count
    );
END;
$$;
