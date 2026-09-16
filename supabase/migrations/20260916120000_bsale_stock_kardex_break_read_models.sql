-- Normalized Bsale stock events and compact physical-stock break read models.
CREATE TABLE integraciones.bsale_stock_kardex_events (
    id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id          uuid NOT NULL REFERENCES core.companies(id),
    office_id           int NOT NULL,
    variant_id          int NOT NULL,
    variant_code        text,
    event_date          date NOT NULL,
    source_type         text NOT NULL CHECK (source_type IN ('RECEPTION', 'CONSUMPTION', 'SHIPPING', 'RETURN')),
    source_header_id    int NOT NULL,
    source_detail_id    int NOT NULL,
    quantity_delta      numeric(14,3) NOT NULL,
    variant_stock_after numeric(14,3),
    update_stock        boolean,
    source_state        int,
    consumption_type_id int,
    related_document_id int,
    raw_json            jsonb NOT NULL DEFAULT '{}'::jsonb,
    captured_at         timestamptz NOT NULL DEFAULT now(),
    synced_at           timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    bsale_sync_run_id   uuid REFERENCES integraciones.bsale_sync_runs(id),
    UNIQUE (company_id, office_id, source_type, source_header_id, source_detail_id)
);

CREATE INDEX idx_bsale_kardex_events_company_office_date
    ON integraciones.bsale_stock_kardex_events(company_id, office_id, event_date DESC);
CREATE INDEX idx_bsale_kardex_events_variant_date
    ON integraciones.bsale_stock_kardex_events(company_id, office_id, variant_id, event_date DESC);

CREATE TABLE integraciones.bsale_stock_daily_break_evidence (
    id                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id              uuid NOT NULL REFERENCES core.companies(id),
    office_id               int NOT NULL,
    variant_id              int NOT NULL,
    variant_code            text,
    evidence_date           date NOT NULL,
    break_confirmed         boolean NOT NULL DEFAULT false,
    kardex_break_confirmed  boolean NOT NULL DEFAULT false,
    snapshot_break_confirmed boolean NOT NULL DEFAULT false,
    min_variant_stock_after numeric(14,3),
    evidence_source         text NOT NULL CHECK (evidence_source IN ('KARDEX', 'SNAPSHOT', 'BOTH')),
    refreshed_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, office_id, variant_id, evidence_date)
);

CREATE INDEX idx_bsale_daily_break_company_office_date
    ON integraciones.bsale_stock_daily_break_evidence(company_id, office_id, evidence_date DESC);
CREATE INDEX idx_bsale_daily_break_variant_date
    ON integraciones.bsale_stock_daily_break_evidence(company_id, office_id, variant_id, evidence_date DESC);

CREATE TABLE integraciones.bsale_stock_break_summary_60d (
    id                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id              uuid NOT NULL REFERENCES core.companies(id),
    office_id               int NOT NULL,
    variant_id              int NOT NULL,
    variant_code            text,
    date_from               date NOT NULL,
    date_to                 date NOT NULL,
    confirmed_break_days_60d int NOT NULL DEFAULT 0,
    kardex_break_days_60d   int NOT NULL DEFAULT 0,
    snapshot_break_days_60d int NOT NULL DEFAULT 0,
    last_break_date         date,
    refreshed_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, office_id, variant_id)
);

CREATE INDEX idx_bsale_break_summary_company_office
    ON integraciones.bsale_stock_break_summary_60d(company_id, office_id, variant_id);

ALTER TABLE integraciones.bsale_stock_kardex_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_stock_daily_break_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_stock_break_summary_60d ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_bsale_stock_kardex_events_select
    ON integraciones.bsale_stock_kardex_events FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_bsale_stock_daily_break_evidence_select
    ON integraciones.bsale_stock_daily_break_evidence FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_bsale_stock_break_summary_60d_select
    ON integraciones.bsale_stock_break_summary_60d FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id));

GRANT USAGE ON SCHEMA integraciones TO authenticated, service_role;
GRANT ALL ON integraciones.bsale_stock_kardex_events TO service_role;
GRANT ALL ON integraciones.bsale_stock_daily_break_evidence TO service_role;
GRANT ALL ON integraciones.bsale_stock_break_summary_60d TO service_role;
GRANT SELECT ON integraciones.bsale_stock_kardex_events TO authenticated;
GRANT SELECT ON integraciones.bsale_stock_daily_break_evidence TO authenticated;
GRANT SELECT ON integraciones.bsale_stock_break_summary_60d TO authenticated;

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
    SELECT
        company_id,
        office_id,
        variant_id,
        max(variant_code),
        evidence_date,
        bool_or(kardex_break_confirmed OR snapshot_break_confirmed),
        bool_or(kardex_break_confirmed),
        bool_or(snapshot_break_confirmed),
        min(min_variant_stock_after),
        CASE
            WHEN bool_or(kardex_break_confirmed) AND bool_or(snapshot_break_confirmed) THEN 'BOTH'
            WHEN bool_or(kardex_break_confirmed) THEN 'KARDEX'
            ELSE 'SNAPSHOT'
        END,
        now()
    FROM (
        SELECT
            company_id, office_id, variant_id, variant_code,
            event_date AS evidence_date,
            true AS kardex_break_confirmed,
            false AS snapshot_break_confirmed,
            variant_stock_after AS min_variant_stock_after
        FROM integraciones.bsale_stock_kardex_events
        WHERE company_id = p_company_id
          AND office_id = p_office_id
          AND event_date BETWEEN p_date_from AND p_date_to
          AND variant_stock_after <= 0
        UNION ALL
        SELECT
            company_id, office_id, variant_id, variant_code,
            snapshot_date AS evidence_date,
            false,
            true,
            quantity
        FROM integraciones.bsale_stock_daily_snapshots
        WHERE company_id = p_company_id
          AND office_id = p_office_id
          AND snapshot_date BETWEEN p_date_from AND p_date_to
          AND quantity <= 0
    ) evidence
    GROUP BY company_id, office_id, variant_id, evidence_date;

    GET DIAGNOSTICS evidence_count = ROW_COUNT;

    INSERT INTO integraciones.bsale_stock_break_summary_60d (
        company_id, office_id, variant_id, variant_code, date_from, date_to,
        confirmed_break_days_60d, kardex_break_days_60d,
        snapshot_break_days_60d, last_break_date, refreshed_at
    )
    SELECT
        p_company_id,
        p_office_id,
        variants.variant_id,
        variants.variant_code,
        p_date_to - 59,
        p_date_to,
        count(*) FILTER (WHERE evidence.break_confirmed),
        count(*) FILTER (WHERE evidence.kardex_break_confirmed),
        count(*) FILTER (WHERE evidence.snapshot_break_confirmed),
        max(evidence.evidence_date) FILTER (WHERE evidence.break_confirmed),
        now()
    FROM (
        SELECT variant_id, max(variant_code) AS variant_code
        FROM integraciones.bsale_stock_current
        WHERE company_id = p_company_id AND office_id = p_office_id
        GROUP BY variant_id
        UNION
        SELECT variant_id, max(variant_code)
        FROM integraciones.bsale_stock_kardex_events
        WHERE company_id = p_company_id AND office_id = p_office_id
        GROUP BY variant_id
        UNION
        SELECT variant_id, max(variant_code)
        FROM integraciones.bsale_stock_daily_snapshots
        WHERE company_id = p_company_id AND office_id = p_office_id
        GROUP BY variant_id
    ) variants
    LEFT JOIN integraciones.bsale_stock_daily_break_evidence evidence
      ON evidence.company_id = p_company_id
     AND evidence.office_id = p_office_id
     AND evidence.variant_id = variants.variant_id
     AND evidence.evidence_date BETWEEN p_date_to - 59 AND p_date_to
    GROUP BY variants.variant_id, variants.variant_code
    ON CONFLICT (company_id, office_id, variant_id) DO UPDATE SET
        variant_code = EXCLUDED.variant_code,
        date_from = EXCLUDED.date_from,
        date_to = EXCLUDED.date_to,
        confirmed_break_days_60d = EXCLUDED.confirmed_break_days_60d,
        kardex_break_days_60d = EXCLUDED.kardex_break_days_60d,
        snapshot_break_days_60d = EXCLUDED.snapshot_break_days_60d,
        last_break_date = EXCLUDED.last_break_date,
        refreshed_at = EXCLUDED.refreshed_at;

    GET DIAGNOSTICS summary_count = ROW_COUNT;
    RETURN jsonb_build_object('evidence_rows', evidence_count, 'summary_rows', summary_count);
END;
$$;

REVOKE ALL ON FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date) TO service_role;
