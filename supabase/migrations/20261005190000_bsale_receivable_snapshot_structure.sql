-- Estructura append-only para snapshots oficiales de CxC Bsale.
-- Esta migracion no ejecuta sincronizacion ni inserta datos.

CREATE TABLE integraciones.bsale_receivable_snapshot_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  snapshot_at timestamptz NOT NULL,
  snapshot_date date NOT NULL,
  source text NOT NULL DEFAULT 'BSALE_UNPAID_DOCUMENTS'
    CHECK (source = 'BSALE_UNPAID_DOCUMENTS'),
  status text NOT NULL
    CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  clients_total integer NOT NULL DEFAULT 0 CHECK (clients_total >= 0),
  clients_success integer NOT NULL DEFAULT 0 CHECK (clients_success >= 0),
  clients_unqueryable integer NOT NULL DEFAULT 0 CHECK (clients_unqueryable >= 0),
  clients_error integer NOT NULL DEFAULT 0 CHECK (clients_error >= 0),
  documents_total integer NOT NULL DEFAULT 0 CHECK (documents_total >= 0),
  total_amount_owed numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_amount_owed >= 0),
  coverage_percent numeric(5,2) NULL CHECK (coverage_percent IS NULL OR coverage_percent BETWEEN 0 AND 100),
  error_summary jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CHECK (clients_success + clients_unqueryable + clients_error <= clients_total)
);

CREATE TABLE integraciones.bsale_receivable_snapshot_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES integraciones.bsale_receivable_snapshot_runs(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  client_id bigint NOT NULL,
  client_state integer NULL,
  commercially_blocked boolean NULL,
  result text NOT NULL
    CHECK (result IN ('SUCCESS', 'UNPAID_DOCUMENTS_CLIENT_INVALID', 'HTTP_ERROR')),
  http_status integer NULL,
  error_code text NULL,
  error_message text NULL,
  documents_returned integer NOT NULL DEFAULT 0 CHECK (documents_returned >= 0),
  processed_at timestamptz NOT NULL DEFAULT now(),
  raw_response jsonb NULL,
  UNIQUE (run_id, client_id)
);

CREATE TABLE integraciones.bsale_receivable_snapshot_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES integraciones.bsale_receivable_snapshot_runs(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  snapshot_at timestamptz NOT NULL,
  snapshot_date date NOT NULL,
  bsale_document_id bigint NOT NULL,
  folio integer NULL,
  client_id bigint NOT NULL,
  emission_date date NULL,
  expiration_date date NULL,
  total_amount numeric(14,2) NULL,
  total_amount_owed numeric(14,2) NOT NULL CHECK (total_amount_owed >= 0),
  status text NOT NULL
    CHECK (status IN ('OVERDUE', 'UPCOMING')),
  source text NOT NULL DEFAULT 'BSALE_UNPAID_DOCUMENTS'
    CHECK (source = 'BSALE_UNPAID_DOCUMENTS'),
  raw_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, bsale_document_id)
);

CREATE INDEX idx_bsale_receivable_snapshot_runs_company_at
  ON integraciones.bsale_receivable_snapshot_runs (company_id, snapshot_at DESC);

CREATE INDEX idx_bsale_receivable_snapshot_documents_company_date
  ON integraciones.bsale_receivable_snapshot_documents (company_id, snapshot_date);

CREATE INDEX idx_bsale_receivable_snapshot_documents_document_at
  ON integraciones.bsale_receivable_snapshot_documents (company_id, bsale_document_id, snapshot_at DESC);

CREATE INDEX idx_bsale_receivable_snapshot_clients_run_result
  ON integraciones.bsale_receivable_snapshot_clients (run_id, result);

ALTER TABLE integraciones.bsale_receivable_snapshot_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_receivable_snapshot_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_receivable_snapshot_documents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE integraciones.bsale_receivable_snapshot_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE integraciones.bsale_receivable_snapshot_clients FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE integraciones.bsale_receivable_snapshot_documents FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE
  ON TABLE integraciones.bsale_receivable_snapshot_runs
  TO service_role;

GRANT SELECT, INSERT
  ON TABLE integraciones.bsale_receivable_snapshot_clients,
             integraciones.bsale_receivable_snapshot_documents
  TO service_role;
