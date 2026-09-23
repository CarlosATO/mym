-- Reconciled definition for the 60d stock read models applied remotely.
-- Public RPC names and JSON keys remain unchanged.

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
    evidence_count int;
    daily_count int;
    interval_count int;
    summary_count int;
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
    episode_open boolean;
    window_from date := p_date_to - 59;
BEGIN
    -- This implementation is self-contained. It intentionally does not call
    -- an earlier refresh function, which could reintroduce captured_at order.
    base_result := '{}'::jsonb;

    CREATE TEMP TABLE _bsale_effective_events ON COMMIT DROP AS
    SELECT e.*
    FROM integraciones.bsale_stock_kardex_events e
    WHERE e.company_id = p_company_id
      AND e.office_id = p_office_id
      AND NOT (
          e.source_type = 'RECEPTION'
          AND EXISTS (
              SELECT 1
              FROM integraciones.bsale_stock_kardex_events r
              WHERE r.company_id = e.company_id
                AND r.office_id = e.office_id
                AND r.source_type = 'RETURN'
                AND r.event_date = e.event_date
                AND r.variant_id = e.variant_id
                AND r.quantity_delta = e.quantity_delta
                AND r.variant_stock_after IS NOT DISTINCT FROM e.variant_stock_after
                AND e.raw_json #>> '{header,note}' = r.source_header_id::text
                AND e.raw_json #>> '{header,documentNumber}' = r.raw_json #>> '{header,credit_note,number}'
          )
      );
    CREATE INDEX ON _bsale_effective_events (variant_id, event_date);

    DELETE FROM integraciones.bsale_stock_daily_break_evidence
    WHERE company_id = p_company_id AND office_id = p_office_id
      AND evidence_date BETWEEN window_from AND p_date_to;

    INSERT INTO integraciones.bsale_stock_daily_break_evidence (
        company_id, office_id, variant_id, variant_code, evidence_date,
        break_confirmed, kardex_break_confirmed, snapshot_break_confirmed,
        min_variant_stock_after, evidence_source, refreshed_at
    )
    SELECT company_id, office_id, variant_id, max(variant_code), evidence_date,
        true, bool_or(kardex_break_confirmed), bool_or(snapshot_break_confirmed),
        min(stock_after),
        CASE WHEN bool_or(kardex_break_confirmed) AND bool_or(snapshot_break_confirmed)
             THEN 'BOTH' WHEN bool_or(kardex_break_confirmed) THEN 'KARDEX'
             ELSE 'SNAPSHOT' END, now()
    FROM (
        SELECT company_id, office_id, variant_id, variant_code,
               event_date AS evidence_date, true AS kardex_break_confirmed,
               false AS snapshot_break_confirmed, variant_stock_after AS stock_after
        FROM _bsale_effective_events
        WHERE event_date BETWEEN window_from AND p_date_to
          AND variant_stock_after <= 0
        UNION ALL
        SELECT company_id, office_id, variant_id, variant_code,
               snapshot_date, false, true, quantity
        FROM integraciones.bsale_stock_daily_snapshots
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND snapshot_date BETWEEN window_from AND p_date_to
          AND quantity <= 0
    ) evidence
    GROUP BY company_id, office_id, variant_id, evidence_date;
    GET DIAGNOSTICS evidence_count = ROW_COUNT;

    CREATE TEMP TABLE _bsale_daily_state (
        variant_id int NOT NULL,
        checkpoint_date date NOT NULL,
        has_positive boolean NOT NULL,
        has_zero boolean NOT NULL,
        has_entry boolean NOT NULL,
        state text,
        available_during_day boolean NOT NULL,
        PRIMARY KEY (variant_id, checkpoint_date)
    ) ON COMMIT DROP;

    CREATE TEMP TABLE _bsale_semantic_interval_calc (
        variant_id int PRIMARY KEY,
        break_count int NOT NULL,
        days_without_stock int NOT NULL,
        days_with_stock int NOT NULL,
        days_unknown int NOT NULL
    ) ON COMMIT DROP;

    INSERT INTO _bsale_daily_state
    WITH RECURSIVE points AS (
        SELECT variant_id, event_date AS checkpoint_date,
               variant_stock_after AS stock_after,
               variant_stock_after - quantity_delta AS stock_before,
               false AS is_snapshot, NULL::timestamptz AS point_order
        FROM _bsale_effective_events
        WHERE variant_stock_after IS NOT NULL AND event_date <= p_date_to
        UNION ALL
        SELECT variant_id, snapshot_date, quantity, NULL, true, captured_at
        FROM integraciones.bsale_stock_daily_snapshots
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND quantity IS NOT NULL AND snapshot_date <= p_date_to
    ), daily AS (
        SELECT variant_id, checkpoint_date,
               coalesce(bool_or(stock_after > 0 OR coalesce(stock_before > 0, false)), false) AS has_positive,
               coalesce(bool_or(stock_after <= 0), false) AS has_zero,
               coalesce(bool_or(coalesce(stock_before > 0, false) AND stock_after <= 0), false) AS has_entry,
               bool_or(is_snapshot) AS has_snapshot,
               -- captured_at resolves competing snapshots only; kardex event
               -- sequencing is derived exclusively from stock_before/after.
               (array_agg(stock_after ORDER BY point_order DESC)
                    FILTER (WHERE is_snapshot))[1] AS snapshot_close
        FROM points
        GROUP BY variant_id, checkpoint_date
    ), edges AS (
        SELECT variant_id, checkpoint_date, stock_before AS from_stock, stock_after AS to_stock
        FROM points
        WHERE NOT is_snapshot AND stock_before IS NOT NULL AND stock_after IS NOT NULL
    ), degree_rows AS (
        SELECT variant_id, checkpoint_date, from_stock AS node, 1 AS out_degree, 0 AS in_degree FROM edges
        UNION ALL
        SELECT variant_id, checkpoint_date, to_stock, 0, 1 FROM edges
    ), degrees AS (
        SELECT variant_id, checkpoint_date, node,
               sum(out_degree) AS out_degree, sum(in_degree) AS in_degree
        FROM degree_rows
        GROUP BY variant_id, checkpoint_date, node
    ), roots AS (
        SELECT variant_id, checkpoint_date, min(node) AS node
        FROM degrees
        GROUP BY variant_id, checkpoint_date
    ), reachable (variant_id, checkpoint_date, node) AS (
        SELECT variant_id, checkpoint_date, node FROM roots
        UNION
        SELECT r.variant_id, r.checkpoint_date,
               CASE WHEN e.from_stock = r.node THEN e.to_stock ELSE e.from_stock END
        FROM reachable r
        JOIN edges e ON e.variant_id = r.variant_id
                    AND e.checkpoint_date = r.checkpoint_date
                    AND (e.from_stock = r.node OR e.to_stock = r.node)
    ), connected AS (
        SELECT variant_id, checkpoint_date, count(*) AS reached_count
        FROM reachable
        GROUP BY variant_id, checkpoint_date
    ), sequence_state AS (
        SELECT d.variant_id, d.checkpoint_date,
               c.reached_count = count(*) AND
               bool_and(abs(d.out_degree - d.in_degree) <= 1) AND
               ((count(*) FILTER (WHERE d.out_degree - d.in_degree = 1) = 0
                 AND count(*) FILTER (WHERE d.in_degree - d.out_degree = 1) = 0)
                OR (count(*) FILTER (WHERE d.out_degree - d.in_degree = 1) = 1
                    AND count(*) FILTER (WHERE d.in_degree - d.out_degree = 1) = 1)) AS complete,
               CASE WHEN count(*) FILTER (WHERE d.out_degree - d.in_degree = 1) = 1
                    THEN 1 ELSE count(*) END AS final_count,
               CASE WHEN count(*) FILTER (WHERE d.out_degree - d.in_degree = 1) = 1
                    THEN min(d.node) FILTER (WHERE d.in_degree - d.out_degree = 1)
                    ELSE min(d.node) END AS final_stock
        FROM degrees d
        JOIN connected c ON c.variant_id = d.variant_id AND c.checkpoint_date = d.checkpoint_date
        GROUP BY d.variant_id, d.checkpoint_date, c.reached_count
    ), resolved AS (
        SELECT daily.*, sequence_state.complete, sequence_state.final_count,
               sequence_state.final_stock
        FROM daily
        LEFT JOIN sequence_state
          ON sequence_state.variant_id = daily.variant_id
         AND sequence_state.checkpoint_date = daily.checkpoint_date
    )
    SELECT variant_id, checkpoint_date, has_positive, has_zero, has_entry,
        CASE
            WHEN has_snapshot THEN CASE WHEN snapshot_close <= 0 THEN 'CONFIRMED_ZERO' ELSE 'CONFIRMED_POSITIVE' END
            WHEN complete AND final_count = 1 THEN CASE WHEN final_stock <= 0 THEN 'CONFIRMED_ZERO' ELSE 'CONFIRMED_POSITIVE' END
            WHEN complete AND final_count > 1 THEN 'AMBIGUOUS'
            WHEN complete IS FALSE THEN CASE WHEN has_zero AND has_positive THEN 'AMBIGUOUS' ELSE 'CHECKPOINT_GAP' END
            WHEN has_zero AND has_positive THEN 'AMBIGUOUS'
            WHEN has_zero THEN 'CONFIRMED_ZERO'
            WHEN has_positive THEN 'CONFIRMED_POSITIVE'
            ELSE NULL
        END,
        has_positive
    FROM resolved;

    -- A day with positive evidence remains available even if its close is
    -- ambiguous. Previous state is propagated only when it is confirmed.
    DELETE FROM integraciones.bsale_stock_availability_daily_60d
    WHERE company_id = p_company_id AND office_id = p_office_id
      AND availability_date BETWEEN window_from AND p_date_to;

    INSERT INTO integraciones.bsale_stock_availability_daily_60d (
        company_id, office_id, variant_id, variant_code, availability_date,
        available_during_day, stockout_confirmed, state_known, refreshed_at
    )
    WITH RECURSIVE variants AS (
        SELECT variant_id, max(variant_code) AS variant_code
        FROM (
            SELECT variant_id, variant_code FROM integraciones.bsale_stock_current
            WHERE company_id = p_company_id AND office_id = p_office_id
            UNION ALL SELECT variant_id, variant_code FROM _bsale_effective_events
            UNION ALL SELECT variant_id, variant_code FROM integraciones.bsale_stock_daily_snapshots
            WHERE company_id = p_company_id AND office_id = p_office_id
        ) x GROUP BY variant_id
    ), resolved AS (
        SELECT v.variant_id, v.variant_code, window_from AS day,
               s.has_positive, s.has_zero, s.state AS raw_state,
               COALESCE(s.state, prior.state) AS propagated_state,
               COALESCE(s.has_positive, false)
                    OR prior.state = 'CONFIRMED_POSITIVE' AS available_during_day
        FROM variants v
        LEFT JOIN _bsale_daily_state s
          ON s.variant_id = v.variant_id AND s.checkpoint_date = window_from
        LEFT JOIN LATERAL (
            SELECT state FROM _bsale_daily_state prior_state
            WHERE prior_state.variant_id = v.variant_id
              AND prior_state.checkpoint_date < window_from
            ORDER BY prior_state.checkpoint_date DESC
            LIMIT 1
        ) prior ON true
        UNION ALL
        SELECT r.variant_id, r.variant_code, r.day + 1,
               s.has_positive, s.has_zero, s.state,
               CASE WHEN s.state IS NOT NULL THEN s.state
                    WHEN r.propagated_state IN ('CONFIRMED_POSITIVE', 'CONFIRMED_ZERO')
                    THEN r.propagated_state ELSE NULL END,
               COALESCE(s.has_positive, false)
                    OR r.propagated_state = 'CONFIRMED_POSITIVE'
        FROM resolved r
        LEFT JOIN _bsale_daily_state s
          ON s.variant_id = r.variant_id AND s.checkpoint_date = r.day + 1
        WHERE r.day < p_date_to
    )
    SELECT p_company_id, p_office_id, variant_id, variant_code, resolved.day,
           COALESCE(available_during_day, false), COALESCE(has_zero, false),
           CASE WHEN raw_state IN ('CONFIRMED_POSITIVE', 'CONFIRMED_ZERO') THEN true
                WHEN raw_state IS NULL AND propagated_state IN ('CONFIRMED_POSITIVE', 'CONFIRMED_ZERO') THEN true
                ELSE false END,
           now()
    FROM resolved;
    GET DIAGNOSTICS daily_count = ROW_COUNT;

    -- Rebuild ranges without treating AMBIGUOUS or UNKNOWN as continuity.
    DELETE FROM integraciones.bsale_stock_break_intervals_60d
    WHERE company_id = p_company_id AND office_id = p_office_id;

    FOR variant IN
        SELECT variant_id FROM (
            SELECT variant_id FROM integraciones.bsale_stock_current
            WHERE company_id = p_company_id AND office_id = p_office_id
            UNION SELECT variant_id FROM _bsale_effective_events
            UNION SELECT variant_id FROM integraciones.bsale_stock_daily_snapshots
            WHERE company_id = p_company_id AND office_id = p_office_id
        ) x
    LOOP
        previous_state := NULL; open_start := NULL; break_count := 0; episode_open := false;
        days_without_stock := 0; days_with_stock := 0; days_unknown := 0;

        SELECT state INTO previous_state
        FROM _bsale_daily_state
        WHERE variant_id = variant.variant_id AND checkpoint_date < window_from
        ORDER BY checkpoint_date DESC
        LIMIT 1;
        IF previous_state = 'CONFIRMED_ZERO' THEN
            break_count := 1;
            open_start := window_from;
            episode_open := true;
        END IF;

        FOR day IN SELECT generate_series(window_from, p_date_to, interval '1 day')::date
        LOOP
            SELECT state, has_zero, has_entry, has_positive
            INTO point
            FROM _bsale_daily_state
            WHERE variant_id = variant.variant_id AND checkpoint_date = day;

            IF FOUND THEN
                IF (point.has_entry OR point.has_zero) AND NOT episode_open THEN
                    break_count := break_count + 1;
                    episode_open := true;
                END IF;
                available_today := point.has_positive OR previous_state = 'CONFIRMED_POSITIVE';

                IF point.state = 'CONFIRMED_ZERO' THEN
                    IF open_start IS NULL THEN open_start := day; END IF;
                ELSIF point.state = 'CONFIRMED_POSITIVE' THEN
                    IF open_start IS NOT NULL THEN
                        INSERT INTO integraciones.bsale_stock_break_intervals_60d
                            (company_id, office_id, variant_id, start_date, end_date,
                             days_without_stock, is_open, refreshed_at)
                        VALUES (p_company_id, p_office_id, variant.variant_id,
                                open_start, day - 1, day - open_start, false, now());
                        days_without_stock := days_without_stock + (day - open_start);
                        open_start := NULL;
                    END IF;
                    episode_open := false;
                ELSE
                    -- AMBIGUOUS invalidates duration continuity but not the
                    -- observed break count or same-day availability.
                    IF open_start IS NOT NULL THEN
                        INSERT INTO integraciones.bsale_stock_break_intervals_60d
                            (company_id, office_id, variant_id, start_date, end_date,
                             days_without_stock, is_open, refreshed_at)
                        VALUES (p_company_id, p_office_id, variant.variant_id,
                                open_start, day - 1, day - open_start, false, now());
                        days_without_stock := days_without_stock + (day - open_start);
                        open_start := NULL;
                    END IF;
                    previous_state := NULL;
                END IF;
                IF point.state IN ('CONFIRMED_POSITIVE', 'CONFIRMED_ZERO') THEN
                    previous_state := point.state;
                END IF;
            ELSE
                available_today := previous_state = 'CONFIRMED_POSITIVE';
            END IF;

            IF available_today THEN days_with_stock := days_with_stock + 1;
            ELSIF previous_state IS NULL THEN days_unknown := days_unknown + 1;
            END IF;
        END LOOP;

        IF open_start IS NOT NULL THEN
            INSERT INTO integraciones.bsale_stock_break_intervals_60d
                (company_id, office_id, variant_id, start_date, end_date,
                 days_without_stock, is_open, refreshed_at)
            VALUES (p_company_id, p_office_id, variant.variant_id, open_start,
                    p_date_to, p_date_to - open_start + 1, true, now());
            days_without_stock := days_without_stock + (p_date_to - open_start + 1);
        END IF;

        INSERT INTO _bsale_semantic_interval_calc
            (variant_id, break_count, days_without_stock, days_with_stock, days_unknown)
        VALUES (variant.variant_id, break_count, days_without_stock, days_with_stock, days_unknown)
        ON CONFLICT (variant_id) DO UPDATE SET
            break_count = EXCLUDED.break_count,
            days_without_stock = EXCLUDED.days_without_stock,
            days_with_stock = EXCLUDED.days_with_stock,
            days_unknown = EXCLUDED.days_unknown;
    END LOOP;

    SELECT count(*) INTO interval_count
    FROM integraciones.bsale_stock_break_intervals_60d
    WHERE company_id = p_company_id AND office_id = p_office_id;

    -- The following summary update preserves the public metric contract. The
    -- existing sales-identity pass remains the source of sales identity and
    -- sales-rate fields after these physical-day values are replaced.
    INSERT INTO integraciones.bsale_stock_break_summary_60d (
        company_id, office_id, variant_id, variant_code, date_from, date_to,
        confirmed_break_days_60d, kardex_break_days_60d, snapshot_break_days_60d,
        break_count_60d, days_without_stock_60d, days_with_stock_60d,
        days_unknown_60d, last_break_date, refreshed_at
    )
    SELECT p_company_id, p_office_id, v.variant_id, v.variant_code,
           window_from, p_date_to,
           count(e.evidence_date) FILTER (WHERE e.break_confirmed),
           count(e.evidence_date) FILTER (WHERE e.kardex_break_confirmed),
           count(e.evidence_date) FILTER (WHERE e.snapshot_break_confirmed),
           c.break_count, c.days_without_stock, c.days_with_stock, c.days_unknown,
           max(e.evidence_date) FILTER (WHERE e.break_confirmed), now()
    FROM (
        SELECT variant_id, max(variant_code) AS variant_code
        FROM (
            SELECT variant_id, variant_code FROM integraciones.bsale_stock_current
            WHERE company_id = p_company_id AND office_id = p_office_id
            UNION ALL SELECT variant_id, variant_code FROM _bsale_effective_events
            UNION ALL SELECT variant_id, variant_code FROM integraciones.bsale_stock_daily_snapshots
            WHERE company_id = p_company_id AND office_id = p_office_id
        ) x GROUP BY variant_id
    ) v
    JOIN _bsale_semantic_interval_calc c ON c.variant_id = v.variant_id
    LEFT JOIN integraciones.bsale_stock_daily_break_evidence e
      ON e.company_id = p_company_id AND e.office_id = p_office_id
     AND e.variant_id = v.variant_id
     AND e.evidence_date BETWEEN window_from AND p_date_to
    GROUP BY v.variant_id, v.variant_code, c.break_count,
             c.days_without_stock, c.days_with_stock, c.days_unknown
    ON CONFLICT (company_id, office_id, variant_id) DO UPDATE SET
        variant_code = EXCLUDED.variant_code, date_from = EXCLUDED.date_from,
        date_to = EXCLUDED.date_to,
        confirmed_break_days_60d = EXCLUDED.confirmed_break_days_60d,
        kardex_break_days_60d = EXCLUDED.kardex_break_days_60d,
        snapshot_break_days_60d = EXCLUDED.snapshot_break_days_60d,
        break_count_60d = EXCLUDED.break_count_60d,
        days_without_stock_60d = EXCLUDED.days_without_stock_60d,
        days_with_stock_60d = EXCLUDED.days_with_stock_60d,
        days_unknown_60d = EXCLUDED.days_unknown_60d,
        last_break_date = EXCLUDED.last_break_date, refreshed_at = now();
    GET DIAGNOSTICS summary_count = ROW_COUNT;

    -- known_days is a property of the persisted daily model. It cannot be
    -- reconstructed from days_with_stock/days_without_stock because an
    -- ambiguous close may still be available during the day.
    WITH daily_counts AS (
        SELECT variant_id,
               count(*) FILTER (WHERE state_known)::int AS known_days
        FROM integraciones.bsale_stock_availability_daily_60d
        WHERE company_id = p_company_id AND office_id = p_office_id
          AND availability_date BETWEEN window_from AND p_date_to
        GROUP BY variant_id
    )
    UPDATE integraciones.bsale_stock_break_summary_60d summary
    SET known_days_60d = daily_counts.known_days,
        evidence_coverage_pct = round(daily_counts.known_days::numeric / 60 * 100, 3),
        refreshed_at = now()
    FROM daily_counts
    WHERE summary.company_id = p_company_id
      AND summary.office_id = p_office_id
      AND summary.variant_id = daily_counts.variant_id;

    -- Reapply the existing identity contract after candidate availability has
    -- been rebuilt, so sales-rate metrics use the candidate daily states.
    WITH summary_rows AS (
        SELECT s.company_id, s.office_id, s.variant_id, s.variant_code,
               id_variant.bsale_id AS id_match, id_variant.code AS id_code,
               COALESCE(code_catalog.variant_count, 0) AS catalog_code_count,
               COALESCE(summary_codes.summary_code_count, 0) AS summary_code_count
        FROM integraciones.bsale_stock_break_summary_60d s
        LEFT JOIN integraciones.bsale_variants id_variant
          ON id_variant.company_id = s.company_id AND id_variant.bsale_id = s.variant_id
        LEFT JOIN (
            SELECT company_id, btrim(code) AS code, count(DISTINCT bsale_id) AS variant_count
            FROM integraciones.bsale_variants
            WHERE code IS NOT NULL AND btrim(code) <> ''
            GROUP BY company_id, btrim(code)
        ) code_catalog ON code_catalog.company_id = s.company_id
                      AND code_catalog.code = btrim(s.variant_code)
        LEFT JOIN (
            SELECT company_id, btrim(variant_code) AS code, count(DISTINCT variant_id) AS summary_code_count
            FROM integraciones.bsale_stock_break_summary_60d
            WHERE variant_code IS NOT NULL AND btrim(variant_code) <> ''
            GROUP BY company_id, btrim(variant_code)
        ) summary_codes ON summary_codes.company_id = s.company_id
                       AND summary_codes.code = btrim(s.variant_code)
        WHERE s.company_id = p_company_id AND s.office_id = p_office_id
    ), classified AS (
        SELECT r.*, CASE
            WHEN r.id_match IS NOT NULL THEN 'VARIANT_ID'
            WHEN r.variant_code IS NULL OR btrim(r.variant_code) = '' THEN 'NONE'
            WHEN r.catalog_code_count = 0 AND r.summary_code_count = 1 THEN 'VARIANT_CODE'
            ELSE 'AMBIGUOUS' END AS identity_method,
        CASE WHEN r.id_match IS NOT NULL THEN r.id_code
             WHEN r.catalog_code_count = 0 AND r.summary_code_count = 1 THEN btrim(r.variant_code)
             ELSE NULL END AS effective_code
        FROM summary_rows r
    ), sales_daily AS (
        SELECT company_id, btrim(variant_code) AS code, emission_date::date AS sale_date,
               sum(logistic_net_quantity) AS units
        FROM integraciones.vw_bsale_sales_logistic_valid
        WHERE company_id = p_company_id AND emission_date::date BETWEEN window_from AND p_date_to
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
        sales_rate_with_stock_60d = CASE WHEN c.identity_method IN ('VARIANT_ID', 'VARIANT_CODE') AND summary.days_with_stock_60d > 0
            THEN COALESCE(m.units_with_stock, 0) / summary.days_with_stock_60d ELSE NULL END,
        positive_sales_without_stock_60d = CASE WHEN c.identity_method IN ('VARIANT_ID', 'VARIANT_CODE') THEN COALESCE(m.positive_without_stock, 0) ELSE 0 END,
        refreshed_at = now()
    FROM classified c LEFT JOIN metrics m ON m.variant_id = c.variant_id
    WHERE summary.company_id = c.company_id AND summary.office_id = c.office_id
      AND summary.variant_id = c.variant_id;

    RETURN base_result || jsonb_build_object(
        'semantic_effective_events', (SELECT count(*) FROM _bsale_effective_events),
        'evidence_rows', evidence_count, 'daily_rows', daily_count,
        'interval_rows', interval_count, 'summary_rows', summary_count
    );
END;
$$;

REVOKE ALL ON FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date) TO service_role;
