-- Daily historical snapshots of Bsale stock for CASA MATRIZ.
CREATE TABLE integraciones.bsale_stock_daily_snapshots (
    id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id          uuid NOT NULL REFERENCES core.companies(id),
    office_id           int NOT NULL,
    variant_id          int NOT NULL,
    variant_code        text NOT NULL,
    quantity            numeric(14,3),
    quantity_reserved   numeric(14,3),
    quantity_available  numeric(14,3),
    snapshot_date       date NOT NULL,
    captured_at         timestamptz NOT NULL DEFAULT now(),
    bsale_sync_run_id   uuid NOT NULL REFERENCES integraciones.bsale_sync_runs(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, office_id, variant_id, snapshot_date)
);

CREATE INDEX idx_bsale_stock_daily_snapshots_company_date
    ON integraciones.bsale_stock_daily_snapshots(company_id, snapshot_date DESC);

CREATE INDEX idx_bsale_stock_daily_snapshots_company_sku_date
    ON integraciones.bsale_stock_daily_snapshots(company_id, variant_code, snapshot_date DESC);

ALTER TABLE integraciones.bsale_stock_daily_snapshots ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA integraciones TO authenticated, service_role;
GRANT ALL ON integraciones.bsale_stock_daily_snapshots TO service_role;
GRANT SELECT ON integraciones.bsale_stock_daily_snapshots TO authenticated;

CREATE POLICY rls_bsale_stock_daily_snapshots_select
    ON integraciones.bsale_stock_daily_snapshots
    FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id));

REVOKE INSERT, UPDATE, DELETE ON integraciones.bsale_stock_daily_snapshots FROM authenticated, anon;
