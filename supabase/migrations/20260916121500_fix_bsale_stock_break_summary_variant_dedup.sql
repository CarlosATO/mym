-- Deduplicate variant sources before the summary upsert. A variant can have
-- different nullable codes across current stock, events and snapshots.
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

    INSERT INTO integraciones.bsale_stock_break_summary_60d (
        company_id, office_id, variant_id, variant_code, date_from, date_to,
        confirmed_break_days_60d, kardex_break_days_60d,
        snapshot_break_days_60d, last_break_date, refreshed_at
    )
    SELECT p_company_id, p_office_id, variants.variant_id, variants.variant_code,
        p_date_to - 59, p_date_to,
        count(*) FILTER (WHERE evidence.break_confirmed),
        count(*) FILTER (WHERE evidence.kardex_break_confirmed),
        count(*) FILTER (WHERE evidence.snapshot_break_confirmed),
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
    LEFT JOIN integraciones.bsale_stock_daily_break_evidence evidence
      ON evidence.company_id = p_company_id AND evidence.office_id = p_office_id
     AND evidence.variant_id = variants.variant_id
     AND evidence.evidence_date BETWEEN p_date_to - 59 AND p_date_to
    GROUP BY variants.variant_id, variants.variant_code
    ON CONFLICT (company_id, office_id, variant_id) DO UPDATE SET
        variant_code = EXCLUDED.variant_code, date_from = EXCLUDED.date_from,
        date_to = EXCLUDED.date_to, confirmed_break_days_60d = EXCLUDED.confirmed_break_days_60d,
        kardex_break_days_60d = EXCLUDED.kardex_break_days_60d,
        snapshot_break_days_60d = EXCLUDED.snapshot_break_days_60d,
        last_break_date = EXCLUDED.last_break_date, refreshed_at = EXCLUDED.refreshed_at;
    GET DIAGNOSTICS summary_count = ROW_COUNT;
    RETURN jsonb_build_object('evidence_rows', evidence_count, 'summary_rows', summary_count);
END;
$$;
