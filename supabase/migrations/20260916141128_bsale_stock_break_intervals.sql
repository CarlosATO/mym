ALTER TABLE integraciones.bsale_stock_break_summary_60d
    ADD COLUMN IF NOT EXISTS break_count_60d int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS days_without_stock_60d int NOT NULL DEFAULT 0;

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
    variant record;
    point record;
    previous_state text;
    open_start date;
    unknown_open boolean;
    break_count int;
    days_without_stock int;
    confirmed_days int;
    kardex_days int;
    snapshot_days int;
    last_break date;
BEGIN
    DELETE FROM integraciones.bsale_stock_daily_break_evidence
    WHERE company_id = p_company_id
      AND office_id = p_office_id
      AND evidence_date BETWEEN p_date_from AND p_date_to;

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
          AND event_date BETWEEN p_date_from AND p_date_to AND variant_stock_after <= 0
        UNION ALL
        SELECT company_id, office_id, variant_id, variant_code, snapshot_date,
            false, true, quantity
        FROM integraciones.bsale_stock_daily_snapshots
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND snapshot_date BETWEEN p_date_from AND p_date_to AND quantity <= 0
    ) evidence
    GROUP BY company_id, office_id, variant_id, evidence_date;
    GET DIAGNOSTICS evidence_count = ROW_COUNT;

    CREATE TEMP TABLE _bsale_stock_break_daily (
        variant_id int NOT NULL,
        checkpoint_date date NOT NULL,
        has_zero boolean NOT NULL,
        state text NOT NULL,
        is_snapshot boolean NOT NULL,
        PRIMARY KEY (variant_id, checkpoint_date)
    ) ON COMMIT DROP;

    INSERT INTO _bsale_stock_break_daily (variant_id, checkpoint_date, has_zero, state, is_snapshot)
    WITH points AS (
        SELECT variant_id, event_date AS checkpoint_date, variant_stock_after AS stock_value,
            false AS is_snapshot, captured_at AS point_order
        FROM integraciones.bsale_stock_kardex_events
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND event_date <= p_date_to AND variant_stock_after IS NOT NULL
        UNION ALL
        SELECT variant_id, snapshot_date, quantity, true, captured_at
        FROM integraciones.bsale_stock_daily_snapshots
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND snapshot_date <= p_date_to AND quantity IS NOT NULL
    ), daily AS (
        SELECT variant_id, checkpoint_date,
            bool_or(stock_value <= 0) AS has_zero,
            bool_or(stock_value > 0) AS has_positive,
            bool_or(is_snapshot) AS has_snapshot,
            (array_agg(stock_value ORDER BY is_snapshot DESC, point_order DESC))[1] AS closing_stock
        FROM points
        GROUP BY variant_id, checkpoint_date
    )
    SELECT variant_id, checkpoint_date, has_zero,
        CASE
            WHEN has_snapshot THEN CASE WHEN closing_stock <= 0 THEN 'ZERO' ELSE 'POSITIVE' END
            WHEN has_zero AND has_positive THEN 'POSITIVE'
            WHEN has_zero THEN 'ZERO'
            WHEN has_positive THEN 'POSITIVE'
            ELSE 'UNKNOWN'
        END,
        has_snapshot
    FROM daily;

    CREATE TEMP TABLE _bsale_stock_break_interval_calc (
        variant_id int PRIMARY KEY,
        break_count int NOT NULL,
        days_without_stock int NOT NULL
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
        unknown_open := false;
        break_count := 0;
        days_without_stock := 0;

        FOR point IN
            SELECT checkpoint_date, state, has_zero, false AS is_initial
            FROM _bsale_stock_break_daily
            WHERE variant_id = variant.variant_id AND checkpoint_date < p_date_from
            ORDER BY checkpoint_date DESC
            LIMIT 1
        LOOP
            previous_state := point.state;
            IF previous_state = 'ZERO' THEN
                break_count := 1;
                open_start := p_date_from;
            END IF;
        END LOOP;

        FOR point IN
            SELECT checkpoint_date, state, has_zero, true AS is_initial
            FROM _bsale_stock_break_daily
            WHERE variant_id = variant.variant_id
              AND checkpoint_date BETWEEN p_date_from AND p_date_to
            ORDER BY checkpoint_date
        LOOP
            IF point.has_zero AND previous_state IS DISTINCT FROM 'ZERO' THEN
                break_count := break_count + 1;
            END IF;

            IF point.state = 'ZERO' THEN
                IF previous_state = 'POSITIVE' THEN
                    open_start := point.checkpoint_date;
                    unknown_open := false;
                ELSIF previous_state IS NULL OR previous_state = 'UNKNOWN' THEN
                    unknown_open := true;
                END IF;
            ELSIF point.state = 'POSITIVE' THEN
                IF open_start IS NOT NULL THEN
                    days_without_stock := days_without_stock + (point.checkpoint_date - open_start);
                    open_start := NULL;
                END IF;
                unknown_open := false;
            END IF;

            previous_state := point.state;
        END LOOP;

        IF open_start IS NOT NULL THEN
            days_without_stock := days_without_stock + (p_date_to - open_start + 1);
        END IF;

        INSERT INTO _bsale_stock_break_interval_calc VALUES (variant.variant_id, break_count, days_without_stock);
    END LOOP;

    INSERT INTO integraciones.bsale_stock_break_summary_60d (
        company_id, office_id, variant_id, variant_code, date_from, date_to,
        confirmed_break_days_60d, kardex_break_days_60d, snapshot_break_days_60d,
        break_count_60d, days_without_stock_60d, last_break_date, refreshed_at
    )
    SELECT p_company_id, p_office_id, variants.variant_id, variants.variant_code,
        p_date_to - 59, p_date_to,
        count(evidence.evidence_date) FILTER (WHERE evidence.break_confirmed),
        count(evidence.evidence_date) FILTER (WHERE evidence.kardex_break_confirmed),
        count(evidence.evidence_date) FILTER (WHERE evidence.snapshot_break_confirmed),
        intervals.break_count, intervals.days_without_stock,
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
    GROUP BY variants.variant_id, variants.variant_code, intervals.break_count, intervals.days_without_stock
    ON CONFLICT (company_id, office_id, variant_id) DO UPDATE SET
        variant_code = EXCLUDED.variant_code, date_from = EXCLUDED.date_from,
        date_to = EXCLUDED.date_to, confirmed_break_days_60d = EXCLUDED.confirmed_break_days_60d,
        kardex_break_days_60d = EXCLUDED.kardex_break_days_60d,
        snapshot_break_days_60d = EXCLUDED.snapshot_break_days_60d,
        break_count_60d = EXCLUDED.break_count_60d,
        days_without_stock_60d = EXCLUDED.days_without_stock_60d,
        last_break_date = EXCLUDED.last_break_date, refreshed_at = EXCLUDED.refreshed_at;
    GET DIAGNOSTICS summary_count = ROW_COUNT;
    RETURN jsonb_build_object('evidence_rows', evidence_count, 'summary_rows', summary_count);
END;
$$;

CREATE OR REPLACE FUNCTION integraciones.get_bsale_stock_break_summary_60d(
    p_company_id uuid,
    p_office_id int
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, integraciones
AS $$
    SELECT COALESCE(
        jsonb_object_agg(
            variant_id::text,
            jsonb_build_object(
                'breakDays', confirmed_break_days_60d,
                'breakCount', break_count_60d,
                'daysWithoutStock', days_without_stock_60d,
                'lastBreakDate', last_break_date
            )
        ), '{}'::jsonb
    )
    FROM integraciones.bsale_stock_break_summary_60d
    WHERE company_id = p_company_id AND office_id = p_office_id;
$$;

REVOKE ALL ON FUNCTION integraciones.get_bsale_stock_break_summary_60d(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integraciones.get_bsale_stock_break_summary_60d(uuid, int) TO service_role;
