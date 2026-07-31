-- Migration: 20260731055000_integraciones_bsale_sync_v2_financial_reconciliation.sql
-- Description: Creación de tablas de conciliación financiera y cola de reparación para Motor Sync Bsale V2 (CV-1B.3A).
-- Author: Assistant

-- Soporte de integridad en tablas previas
-- El núcleo V2 ya define uq_bsale_sync_v2_runs_co_id UNIQUE (id, company_id), suficiente
-- para la FK compuesta de reconciliation_runs hacia bsale_sync_v2_runs. No se agrega duplicado.
-- 1. Asegurar constraint de soporte multiempresa en comercial.customers.
-- Auditado previamente: id es PK (uuid), company_id es NOT NULL (uuid).
ALTER TABLE comercial.customers
    DROP CONSTRAINT IF EXISTS uq_comercial_customers_co_id;
ALTER TABLE comercial.customers
    ADD CONSTRAINT uq_comercial_customers_co_id UNIQUE (id, company_id);

-- 1. Table: integraciones.bsale_sync_v2_reconciliation_runs
CREATE TABLE IF NOT EXISTS integraciones.bsale_sync_v2_reconciliation_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    sync_run_id uuid NOT NULL,
    sync_step_id uuid NOT NULL,
    reconciliation_type text NOT NULL,
    business_date date NOT NULL,
    status text NOT NULL,

    customers_planned integer NOT NULL DEFAULT 0,
    customers_processed integer NOT NULL DEFAULT 0,
    customers_matched integer NOT NULL DEFAULT 0,
    customers_mismatched integer NOT NULL DEFAULT 0,
    customers_review_required integer NOT NULL DEFAULT 0,
    customers_failed integer NOT NULL DEFAULT 0,

    started_at timestamptz NULL,
    completed_at timestamptz NULL,
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_bsale_recon_runs_company FOREIGN KEY (company_id) REFERENCES core.companies(id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_recon_runs_sync_run FOREIGN KEY (sync_run_id, company_id) REFERENCES integraciones.bsale_sync_v2_runs(id, company_id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_recon_runs_sync_step FOREIGN KEY (sync_step_id, sync_run_id, company_id) REFERENCES integraciones.bsale_sync_v2_steps(id, run_id, company_id) ON DELETE RESTRICT,

    CONSTRAINT uq_bsale_recon_runs_step UNIQUE (sync_step_id),
    CONSTRAINT uq_bsale_recon_runs_co_id UNIQUE (id, company_id),

    CONSTRAINT chk_bsale_recon_runs_type CHECK (reconciliation_type IN ('NIGHTLY', 'MANUAL', 'POST_REPAIR', 'BACKFILL')),
    CONSTRAINT chk_bsale_recon_runs_status CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED')),

    CONSTRAINT chk_bsale_recon_runs_counters CHECK (
        customers_planned >= 0 AND customers_processed >= 0 AND customers_matched >= 0 AND
        customers_mismatched >= 0 AND customers_review_required >= 0 AND customers_failed >= 0
    ),
    CONSTRAINT chk_bsale_recon_runs_processed CHECK (customers_processed <= customers_planned),
    CONSTRAINT chk_bsale_recon_runs_disjoint CHECK (
        customers_matched + customers_mismatched + customers_review_required + customers_failed <= customers_processed
    ),
    CONSTRAINT chk_bsale_recon_runs_json CHECK (jsonb_typeof(summary) = 'object'),

    CONSTRAINT chk_bsale_recon_runs_times CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
    CONSTRAINT chk_bsale_recon_runs_term_times CHECK (
        (status NOT IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED') OR completed_at IS NOT NULL) AND
        (status <> 'RUNNING' OR started_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_bsale_recon_runs_co_date ON integraciones.bsale_sync_v2_reconciliation_runs (company_id, business_date DESC);
CREATE INDEX IF NOT EXISTS idx_bsale_recon_runs_co_status ON integraciones.bsale_sync_v2_reconciliation_runs (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bsale_recon_runs_sync_run ON integraciones.bsale_sync_v2_reconciliation_runs (sync_run_id);

COMMENT ON TABLE integraciones.bsale_sync_v2_reconciliation_runs IS 'Resumen financiero de una ejecución. Bsale es la fuente de reconciliación. No es un orquestador.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_reconciliation_runs.sync_run_id IS 'Run del núcleo V2 del cual deriva esta conciliación.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_reconciliation_runs.business_date IS 'Fecha comercial (America/Santiago) bajo la que se evaluó la conciliación.';


-- 2. Table: integraciones.bsale_sync_v2_reconciliation_items
CREATE TABLE IF NOT EXISTS integraciones.bsale_sync_v2_reconciliation_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    reconciliation_run_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    bsale_client_id bigint NULL,
    attempt_number integer NOT NULL DEFAULT 1,
    status text NOT NULL,
    business_date date NOT NULL,

    remote_overdue_amount bigint NULL,
    local_overdue_amount bigint NULL,
    overdue_difference bigint GENERATED ALWAYS AS (local_overdue_amount - remote_overdue_amount) STORED,

    remote_upcoming_amount bigint NULL,
    local_upcoming_amount bigint NULL,
    upcoming_difference bigint GENERATED ALWAYS AS (local_upcoming_amount - remote_upcoming_amount) STORED,

    remote_total_amount bigint NULL,
    local_total_amount bigint NULL,
    total_difference bigint GENERATED ALWAYS AS (local_total_amount - remote_total_amount) STORED,

    remote_document_count integer NULL,
    local_document_count integer NULL,

    missing_local_documents jsonb NOT NULL DEFAULT '[]'::jsonb,
    extra_local_documents jsonb NOT NULL DEFAULT '[]'::jsonb,
    balance_differences jsonb NOT NULL DEFAULT '[]'::jsonb,
    comparison_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,

    mismatch_fingerprint text NULL,
    error_code text NULL,
    error_message text NULL,

    started_at timestamptz NULL,
    completed_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_bsale_recon_items_company FOREIGN KEY (company_id) REFERENCES core.companies(id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_recon_items_run FOREIGN KEY (reconciliation_run_id, company_id) REFERENCES integraciones.bsale_sync_v2_reconciliation_runs(id, company_id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_recon_items_customer FOREIGN KEY (customer_id, company_id) REFERENCES comercial.customers(id, company_id) ON DELETE RESTRICT,

    CONSTRAINT uq_bsale_recon_items_co_id UNIQUE (id, company_id),
    CONSTRAINT uq_bsale_recon_items_attempt UNIQUE (reconciliation_run_id, customer_id, attempt_number),

    CONSTRAINT chk_bsale_recon_items_client CHECK (bsale_client_id IS NULL OR bsale_client_id > 0),
    CONSTRAINT chk_bsale_recon_items_attempt CHECK (attempt_number >= 1),
    CONSTRAINT chk_bsale_recon_items_status CHECK (status IN (
        'PENDING', 'RUNNING', 'MATCHED', 'MISMATCH_TOTAL', 'MISMATCH_AGING',
        'MISMATCH_DOCUMENTS', 'MISMATCH_BALANCE', 'FAILED', 'REQUIRES_REVIEW'
    )),

    CONSTRAINT chk_bsale_recon_items_amounts CHECK (
        (status NOT IN ('MATCHED', 'MISMATCH_TOTAL', 'MISMATCH_AGING', 'MISMATCH_DOCUMENTS', 'MISMATCH_BALANCE')) OR
        (
            remote_overdue_amount >= 0 AND local_overdue_amount >= 0 AND
            remote_upcoming_amount >= 0 AND local_upcoming_amount >= 0 AND
            remote_total_amount >= 0 AND local_total_amount >= 0 AND
            remote_document_count >= 0 AND local_document_count >= 0
        )
    ),

    CONSTRAINT chk_bsale_recon_items_miss_docs CHECK (jsonb_typeof(missing_local_documents) = 'array'),
    CONSTRAINT chk_bsale_recon_items_extr_docs CHECK (jsonb_typeof(extra_local_documents) = 'array'),
    CONSTRAINT chk_bsale_recon_items_bal_diffs CHECK (jsonb_typeof(balance_differences) = 'array'),
    CONSTRAINT chk_bsale_recon_items_snapshot CHECK (jsonb_typeof(comparison_snapshot) = 'object'),

    CONSTRAINT chk_bsale_recon_items_fingerprint CHECK (
        (status = 'MATCHED' AND mismatch_fingerprint IS NULL) OR
        (status NOT IN ('MATCHED', 'FAILED', 'REQUIRES_REVIEW') AND (mismatch_fingerprint IS NOT NULL AND btrim(mismatch_fingerprint) <> '')) OR
        (status IN ('REQUIRES_REVIEW', 'FAILED') AND (mismatch_fingerprint IS NULL OR btrim(mismatch_fingerprint) <> ''))
    ),

    CONSTRAINT chk_bsale_recon_items_times CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
    CONSTRAINT chk_bsale_recon_items_term_times CHECK (
        (status NOT IN ('MATCHED', 'MISMATCH_TOTAL', 'MISMATCH_AGING', 'MISMATCH_DOCUMENTS', 'MISMATCH_BALANCE', 'FAILED', 'REQUIRES_REVIEW') OR completed_at IS NOT NULL) AND
        (status <> 'RUNNING' OR started_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_bsale_recon_items_run_status ON integraciones.bsale_sync_v2_reconciliation_items (reconciliation_run_id, status);
CREATE INDEX IF NOT EXISTS idx_bsale_recon_items_co_cust_created ON integraciones.bsale_sync_v2_reconciliation_items (company_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bsale_recon_items_co_status_created ON integraciones.bsale_sync_v2_reconciliation_items (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bsale_recon_items_co_fingerprint ON integraciones.bsale_sync_v2_reconciliation_items (company_id, mismatch_fingerprint) WHERE mismatch_fingerprint IS NOT NULL;

COMMENT ON TABLE integraciones.bsale_sync_v2_reconciliation_items IS 'Resultado inmutable de comparar un cliente comercial vs Bsale unpaid_documents.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_reconciliation_items.overdue_difference IS 'Montos en CLP enteros. Convención: local_amount - remote_amount. Diferencias pueden ser negativas.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_reconciliation_items.missing_local_documents IS 'Debe contener solo IDs/montos. La validación JSONB no impide PII por completo, depende de app.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_reconciliation_items.mismatch_fingerprint IS 'Firma determinista de la diferencia. Nulo en MATCHED. Obligatorio si hay mismatch.';


-- 3. Table: integraciones.bsale_sync_v2_repair_queue
CREATE TABLE IF NOT EXISTS integraciones.bsale_sync_v2_repair_queue (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    reconciliation_item_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    bsale_client_id bigint NULL,
    task_code text NOT NULL DEFAULT 'bsale.receivables_repair',
    mismatch_fingerprint text NOT NULL,
    priority text NOT NULL DEFAULT 'NORMAL',
    status text NOT NULL DEFAULT 'PENDING',
    attempt_count integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL,
    requested_by uuid NULL,
    requested_reason text NULL,
    scheduled_for_at timestamptz NOT NULL,
    claimed_at timestamptz NULL,
    locked_by text NULL,
    lock_expires_at timestamptz NULL,
    started_at timestamptz NULL,
    completed_at timestamptz NULL,
    next_retry_at timestamptz NULL,
    last_error_code text NULL,
    last_error_message text NULL,
    repair_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_bsale_repair_queue_company FOREIGN KEY (company_id) REFERENCES core.companies(id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_repair_queue_item FOREIGN KEY (reconciliation_item_id, company_id) REFERENCES integraciones.bsale_sync_v2_reconciliation_items(id, company_id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_repair_queue_customer FOREIGN KEY (customer_id, company_id) REFERENCES comercial.customers(id, company_id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_repair_queue_user FOREIGN KEY (requested_by) REFERENCES portal.users(id) ON DELETE SET NULL,

    CONSTRAINT uq_bsale_repair_queue_item UNIQUE (reconciliation_item_id),

    CONSTRAINT chk_bsale_repair_queue_task CHECK (btrim(task_code) <> ''),
    CONSTRAINT chk_bsale_repair_queue_fingerprint CHECK (btrim(mismatch_fingerprint) <> ''),
    CONSTRAINT chk_bsale_repair_queue_client CHECK (bsale_client_id IS NULL OR bsale_client_id > 0),
    CONSTRAINT chk_bsale_repair_queue_priority CHECK (priority IN ('CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND')),
    CONSTRAINT chk_bsale_repair_queue_status CHECK (status IN ('PENDING', 'CLAIMED', 'RUNNING', 'RETRY_PENDING', 'REPAIRED', 'REQUIRES_REVIEW', 'FAILED', 'CANCELLED')),

    CONSTRAINT chk_bsale_repair_queue_attempts CHECK (attempt_count >= 0 AND max_attempts >= 1 AND attempt_count <= max_attempts),

    CONSTRAINT chk_bsale_repair_queue_locks CHECK (
        (status NOT IN ('CLAIMED', 'RUNNING') OR (locked_by IS NOT NULL AND claimed_at IS NOT NULL AND lock_expires_at IS NOT NULL AND lock_expires_at > claimed_at)) AND
        (status IN ('CLAIMED', 'RUNNING') OR lock_expires_at IS NULL)
    ),

    CONSTRAINT chk_bsale_repair_queue_retry CHECK (
        (status <> 'RETRY_PENDING' OR next_retry_at IS NOT NULL) AND
        (status = 'RETRY_PENDING' OR next_retry_at IS NULL) AND
        (next_retry_at IS NULL OR scheduled_for_at IS NULL OR next_retry_at >= scheduled_for_at)
    ),
    CONSTRAINT chk_bsale_repair_queue_summary CHECK (jsonb_typeof(repair_summary) = 'object'),
    CONSTRAINT chk_bsale_repair_queue_repaired CHECK (
        status <> 'REPAIRED' OR
        (completed_at IS NOT NULL AND btrim(repair_summary::text) <> '{}' AND lock_expires_at IS NULL)
    ),

    CONSTRAINT chk_bsale_repair_queue_times CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bsale_repair_queue_active_fingerprint
    ON integraciones.bsale_sync_v2_repair_queue (company_id, customer_id, mismatch_fingerprint)
    WHERE status IN ('PENDING', 'CLAIMED', 'RUNNING', 'RETRY_PENDING');

CREATE INDEX IF NOT EXISTS idx_bsale_repair_queue_claim
    ON integraciones.bsale_sync_v2_repair_queue (
        company_id,
        (CASE priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 WHEN 'LOW' THEN 4 WHEN 'BACKGROUND' THEN 5 END),
        COALESCE(next_retry_at, scheduled_for_at),
        created_at
    )
    WHERE status IN ('PENDING', 'RETRY_PENDING');

CREATE INDEX IF NOT EXISTS idx_bsale_repair_queue_orphans
    ON integraciones.bsale_sync_v2_repair_queue (lock_expires_at)
    WHERE status IN ('CLAIMED', 'RUNNING') AND lock_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bsale_repair_queue_co_cust ON integraciones.bsale_sync_v2_repair_queue (company_id, customer_id, created_at DESC);

COMMENT ON TABLE integraciones.bsale_sync_v2_repair_queue IS 'Solicitudes idempotentes de reparación financiera por cliente.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_repair_queue.locked_by IS 'Worker ID u orquestador que reclamó la tarea.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_repair_queue.repair_summary IS 'Resumen técnico. La reparación no se considera confirmada hasta una nueva conciliación.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_repair_queue.bsale_client_id IS 'Identificador técnico duplicado para trazabilidad, no fuente independiente.';


-- Triggers
CREATE TRIGGER trg_bsale_sync_v2_reconciliation_runs_updated_at
    BEFORE UPDATE ON integraciones.bsale_sync_v2_reconciliation_runs
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();

CREATE TRIGGER trg_bsale_sync_v2_reconciliation_items_updated_at
    BEFORE UPDATE ON integraciones.bsale_sync_v2_reconciliation_items
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();

CREATE TRIGGER trg_bsale_sync_v2_repair_queue_updated_at
    BEFORE UPDATE ON integraciones.bsale_sync_v2_repair_queue
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();


-- RLS and Security
ALTER TABLE integraciones.bsale_sync_v2_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_sync_v2_reconciliation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_sync_v2_repair_queue ENABLE ROW LEVEL SECURITY;

-- Revocations (Mínimo privilegio)
REVOKE ALL ON integraciones.bsale_sync_v2_reconciliation_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON integraciones.bsale_sync_v2_reconciliation_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON integraciones.bsale_sync_v2_repair_queue FROM PUBLIC, anon, authenticated;

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sync_v2_reconciliation_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sync_v2_reconciliation_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sync_v2_repair_queue TO service_role;
