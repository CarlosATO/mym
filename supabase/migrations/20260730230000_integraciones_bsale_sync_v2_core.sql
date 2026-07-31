-- Migration: 20260730230000_integraciones_bsale_sync_v2_core.sql
-- Description: Implementación del núcleo mínimo V2 para Motor Sync Bsale (CV-1B.1).
-- Author: Assistant

-- 1. Table: integraciones.bsale_sync_v2_runs
CREATE TABLE IF NOT EXISTS integraciones.bsale_sync_v2_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    run_type text NOT NULL,
    trigger_source text NOT NULL,
    scheduled_for_at timestamptz NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL,
    priority text NOT NULL,
    requested_by uuid NULL,
    requested_reason text NULL,
    worker_id text NULL,
    started_at timestamptz NULL,
    completed_at timestamptz NULL,
    cancelled_at timestamptz NULL,
    configuration_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_code text NULL,
    error_message text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_bsale_sync_v2_runs_company FOREIGN KEY (company_id) REFERENCES core.companies(id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_sync_v2_runs_user FOREIGN KEY (requested_by) REFERENCES portal.users(id) ON DELETE SET NULL,
    CONSTRAINT chk_bsale_sync_v2_runs_type CHECK (run_type IN ('INCREMENTAL', 'FULL', 'BACKFILL', 'REPAIR', 'RECONCILIATION', 'MANUAL')),
    CONSTRAINT chk_bsale_sync_v2_runs_trigger CHECK (trigger_source IN ('SCHEDULED', 'MANUAL', 'API', 'REPAIR_QUEUE', 'SYSTEM')),
    CONSTRAINT chk_bsale_sync_v2_runs_status CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED')),
    CONSTRAINT chk_bsale_sync_v2_runs_priority CHECK (priority IN ('CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND')),
    CONSTRAINT chk_bsale_sync_v2_runs_completed CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
    CONSTRAINT chk_bsale_sync_v2_runs_cancelled CHECK (cancelled_at IS NULL OR started_at IS NULL OR cancelled_at >= started_at),
    CONSTRAINT chk_bsale_sync_v2_runs_status_time CHECK (
        (status NOT IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED') OR completed_at IS NOT NULL) AND
        (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
    ),
    CONSTRAINT uq_bsale_sync_v2_runs_idempotency UNIQUE (company_id, idempotency_key),
    CONSTRAINT uq_bsale_sync_v2_runs_co_id UNIQUE (id, company_id) -- Permite FKs compuestas seguras para hijos
);

-- Partial index for scheduled runs
CREATE UNIQUE INDEX IF NOT EXISTS idx_bsale_sync_v2_runs_scheduled_idemp
    ON integraciones.bsale_sync_v2_runs (company_id, run_type, scheduled_for_at)
    WHERE trigger_source = 'SCHEDULED';

-- Indices
CREATE INDEX IF NOT EXISTS idx_bsale_sync_v2_runs_co_created ON integraciones.bsale_sync_v2_runs (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bsale_sync_v2_runs_co_st_created ON integraciones.bsale_sync_v2_runs (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bsale_sync_v2_runs_st_sched ON integraciones.bsale_sync_v2_runs (status, scheduled_for_at);

-- Comments
COMMENT ON TABLE integraciones.bsale_sync_v2_runs IS 'V2 coexiste temporalmente con V1. No existe dual-write de una misma tarea. Representa una ejecución general del nuevo motor extensible.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_runs.idempotency_key IS 'Clave estable para evitar duplicación, ej. scheduled:2026-07-30T14:00:00Z:incremental. Diferente para manuales.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_runs.scheduled_for_at IS 'Fecha programada de ejecución. Clave para agrupaciones.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_runs.worker_id IS 'Identificador del pod o servicio técnico. No es una FK humana.';


-- 2. Table: integraciones.bsale_sync_v2_steps
CREATE TABLE IF NOT EXISTS integraciones.bsale_sync_v2_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    run_id uuid NOT NULL,
    task_code text NOT NULL,
    task_version integer NOT NULL DEFAULT 1,
    mode text NOT NULL,
    attempt_number integer NOT NULL DEFAULT 1,
    status text NOT NULL,
    dependency_status jsonb NOT NULL DEFAULT '{}'::jsonb,
    cursor_before jsonb NULL,
    cursor_after jsonb NULL,
    records_fetched integer NOT NULL DEFAULT 0,
    records_created integer NOT NULL DEFAULT 0,
    records_updated integer NOT NULL DEFAULT 0,
    records_unchanged integer NOT NULL DEFAULT 0,
    records_invalid integer NOT NULL DEFAULT 0,
    records_failed integer NOT NULL DEFAULT 0,
    requests_count integer NOT NULL DEFAULT 0,
    retries_count integer NOT NULL DEFAULT 0,
    rate_limits_count integer NOT NULL DEFAULT 0,
    started_at timestamptz NULL,
    completed_at timestamptz NULL,
    error_code text NULL,
    error_message text NULL,
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_bsale_sync_v2_steps_company FOREIGN KEY (company_id) REFERENCES core.companies(id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_sync_v2_steps_run_co FOREIGN KEY (run_id, company_id) REFERENCES integraciones.bsale_sync_v2_runs(id, company_id) ON DELETE RESTRICT,
    CONSTRAINT chk_bsale_sync_v2_steps_version CHECK (task_version >= 1),
    CONSTRAINT chk_bsale_sync_v2_steps_attempt CHECK (attempt_number >= 1),
    CONSTRAINT chk_bsale_sync_v2_steps_mode CHECK (mode IN ('INCREMENTAL', 'FULL', 'BACKFILL', 'REPAIR', 'RECONCILIATION', 'MANUAL')),
    CONSTRAINT chk_bsale_sync_v2_steps_status CHECK (status IN ('PENDING', 'WAITING_DEPENDENCY', 'RUNNING', 'COMPLETED', 'SKIPPED', 'FAILED', 'CANCELLED')),
    CONSTRAINT chk_bsale_sync_v2_steps_positive_counters CHECK (
        records_fetched >= 0 AND records_created >= 0 AND records_updated >= 0 AND
        records_unchanged >= 0 AND records_invalid >= 0 AND records_failed >= 0 AND
        requests_count >= 0 AND retries_count >= 0 AND rate_limits_count >= 0
    ),
    CONSTRAINT chk_bsale_sync_v2_steps_completed CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
    CONSTRAINT chk_bsale_sync_v2_steps_status_time CHECK (
        (status NOT IN ('COMPLETED', 'FAILED') OR completed_at IS NOT NULL)
    ),
    CONSTRAINT uq_bsale_sync_v2_steps_hist UNIQUE (run_id, task_code, attempt_number),
    CONSTRAINT uq_bsale_sync_v2_steps_co_id UNIQUE (id, company_id)
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_bsale_sync_v2_steps_run_created ON integraciones.bsale_sync_v2_steps (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bsale_sync_v2_steps_task_created ON integraciones.bsale_sync_v2_steps (company_id, task_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bsale_sync_v2_steps_status_created ON integraciones.bsale_sync_v2_steps (company_id, status, created_at DESC);

-- Comments
COMMENT ON TABLE integraciones.bsale_sync_v2_steps IS 'V2 coexiste temporalmente con V1. Representa cada intento de una tarea registrada dentro de un run. No hacer UPSERT sobre intentos.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_steps.task_code IS 'Identificador único de la tarea ejecutada (ej. bsale.payments).';
COMMENT ON COLUMN integraciones.bsale_sync_v2_steps.attempt_number IS 'Número de intento para preservar historial (>=1).';


-- 3. Table: integraciones.bsale_sync_v2_cursors
CREATE TABLE IF NOT EXISTS integraciones.bsale_sync_v2_cursors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    task_code text NOT NULL,
    task_version integer NOT NULL,
    mode text NOT NULL,
    cursor_type text NOT NULL,
    cursor_scope text NOT NULL DEFAULT 'DEFAULT',
    cursor_value jsonb NOT NULL,
    previous_cursor_value jsonb NULL,
    last_successful_run_id uuid NULL,
    last_successful_step_id uuid NULL,
    last_advanced_at timestamptz NULL,
    source_high_watermark jsonb NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_bsale_sync_v2_cursors_company FOREIGN KEY (company_id) REFERENCES core.companies(id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_sync_v2_cursors_run_co FOREIGN KEY (last_successful_run_id, company_id) REFERENCES integraciones.bsale_sync_v2_runs(id, company_id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_sync_v2_cursors_step_co FOREIGN KEY (last_successful_step_id, company_id) REFERENCES integraciones.bsale_sync_v2_steps(id, company_id) ON DELETE RESTRICT,
    CONSTRAINT chk_bsale_sync_v2_cursors_version CHECK (task_version >= 1),
    CONSTRAINT chk_bsale_sync_v2_cursors_mode CHECK (mode IN ('INCREMENTAL', 'FULL', 'BACKFILL', 'REPAIR', 'RECONCILIATION', 'MANUAL')),
    CONSTRAINT chk_bsale_sync_v2_cursors_type CHECK (cursor_type IN ('OFFSET', 'SOURCE_DATE', 'SOURCE_ID', 'COMPOSITE', 'SNAPSHOT', 'NONE')),
    CONSTRAINT uq_bsale_sync_v2_cursors_scope UNIQUE (company_id, task_code, task_version, mode, cursor_scope)
);

-- Comments
COMMENT ON TABLE integraciones.bsale_sync_v2_cursors IS 'V2 coexiste temporalmente con V1. Los cursores V2 son independientes de V1. Mantiene el estado vivo canónico.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_cursors.cursor_scope IS 'Diferenciador adicional para scopes particulares, por defecto DEFAULT.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_cursors.cursor_value IS 'Valor actual del cursor, en JSONB.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_cursors.source_high_watermark IS 'Último punto alto registrado si corresponde, en JSONB.';


-- Triggers
CREATE TRIGGER trg_bsale_sync_v2_runs_updated_at
    BEFORE UPDATE ON integraciones.bsale_sync_v2_runs
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();

CREATE TRIGGER trg_bsale_sync_v2_steps_updated_at
    BEFORE UPDATE ON integraciones.bsale_sync_v2_steps
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();

CREATE TRIGGER trg_bsale_sync_v2_cursors_updated_at
    BEFORE UPDATE ON integraciones.bsale_sync_v2_cursors
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();


-- RLS and Security
ALTER TABLE integraciones.bsale_sync_v2_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_sync_v2_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_sync_v2_cursors ENABLE ROW LEVEL SECURITY;

-- Revocations (Mínimo privilegio)
REVOKE ALL ON integraciones.bsale_sync_v2_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON integraciones.bsale_sync_v2_steps FROM PUBLIC, anon, authenticated;
REVOKE ALL ON integraciones.bsale_sync_v2_cursors FROM PUBLIC, anon, authenticated;

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sync_v2_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sync_v2_steps TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sync_v2_cursors TO service_role;
