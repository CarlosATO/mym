-- Migration: 20260730231000_integraciones_bsale_sync_v2_config_errors.sql
-- Description: Creación de tablas de configuración y errores para Motor Sync Bsale V2 (CV-1B.2A).
-- Author: Assistant

-- 0. Soporte de integridad en núcleo V2 (Única alteración al núcleo V2 permitida)
ALTER TABLE integraciones.bsale_sync_v2_steps
    ADD CONSTRAINT uq_bsale_sync_v2_steps_run_co UNIQUE (id, run_id, company_id);

-- 1. Table: integraciones.bsale_sync_v2_task_config
CREATE TABLE IF NOT EXISTS integraciones.bsale_sync_v2_task_config (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    task_code text NOT NULL,
    task_version integer NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    schedule_expression text NULL,
    window_days integer NULL,
    page_size integer NULL,
    request_rate_per_second numeric NULL,
    max_concurrency integer NULL,
    timeout_ms integer NULL,
    max_retries integer NULL,
    priority text NOT NULL DEFAULT 'NORMAL',
    freshness_warning_minutes integer NULL,
    freshness_blocking_minutes integer NULL,
    retention_days integer NULL,
    configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_by uuid NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_bsale_sync_v2_task_config_company FOREIGN KEY (company_id) REFERENCES core.companies(id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_sync_v2_task_config_user FOREIGN KEY (updated_by) REFERENCES portal.users(id) ON DELETE SET NULL,
    CONSTRAINT uq_bsale_sync_v2_task_config UNIQUE (company_id, task_code, task_version),
    CONSTRAINT chk_bsale_sync_v2_task_config_code CHECK (btrim(task_code) <> ''),
    CONSTRAINT chk_bsale_sync_v2_task_config_sched CHECK (schedule_expression IS NULL OR btrim(schedule_expression) <> ''),
    CONSTRAINT chk_bsale_sync_v2_task_config_version CHECK (task_version >= 1),
    CONSTRAINT chk_bsale_sync_v2_task_config_window CHECK (window_days IS NULL OR window_days >= 0),
    CONSTRAINT chk_bsale_sync_v2_task_config_pagesize CHECK (page_size IS NULL OR (page_size >= 1 AND page_size <= 100)),
    CONSTRAINT chk_bsale_sync_v2_task_config_rate CHECK (request_rate_per_second IS NULL OR request_rate_per_second > 0),
    CONSTRAINT chk_bsale_sync_v2_task_config_concurrency CHECK (max_concurrency IS NULL OR max_concurrency >= 1),
    CONSTRAINT chk_bsale_sync_v2_task_config_timeout CHECK (timeout_ms IS NULL OR timeout_ms >= 1000),
    CONSTRAINT chk_bsale_sync_v2_task_config_retries CHECK (max_retries IS NULL OR max_retries >= 0),
    CONSTRAINT chk_bsale_sync_v2_task_config_priority CHECK (priority IN ('CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND')),
    CONSTRAINT chk_bsale_sync_v2_task_config_warning CHECK (freshness_warning_minutes IS NULL OR freshness_warning_minutes >= 0),
    CONSTRAINT chk_bsale_sync_v2_task_config_blocking CHECK (freshness_blocking_minutes IS NULL OR freshness_blocking_minutes >= 0),
    CONSTRAINT chk_bsale_sync_v2_task_config_freshness CHECK (
        freshness_warning_minutes IS NULL OR
        freshness_blocking_minutes IS NULL OR
        freshness_blocking_minutes >= freshness_warning_minutes
    ),
    CONSTRAINT chk_bsale_sync_v2_task_config_retention CHECK (retention_days IS NULL OR retention_days >= 1),
    CONSTRAINT chk_bsale_sync_v2_task_config_json CHECK (jsonb_typeof(configuration) = 'object')
);

-- Partial index for active configurations
CREATE UNIQUE INDEX IF NOT EXISTS idx_bsale_sync_v2_task_config_active
    ON integraciones.bsale_sync_v2_task_config (company_id, task_code)
    WHERE enabled = true;

-- Indices
CREATE INDEX IF NOT EXISTS idx_bsale_sync_v2_task_config_priority ON integraciones.bsale_sync_v2_task_config (company_id, priority, enabled);

-- Comments
COMMENT ON TABLE integraciones.bsale_sync_v2_task_config IS 'Configuración operativa segura por empresa y tarea. Ningún módulo escribe directamente aquí. V2 coexiste con V1.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_task_config.task_code IS 'Identificador de la tarea (ej. bsale.clients). La lógica contractual vive en código.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_task_config.task_version IS 'Versión contractual de la tarea para la que aplica la configuración.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_task_config.schedule_expression IS 'Identificador de programación o cron. El Scheduler Adapter lo interpreta, la tabla no crea jobs automáticamente.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_task_config.configuration IS 'Parámetros operativos extra declarados en código. No contiene tokens ni SQL ni código.';


-- 2. Table: integraciones.bsale_sync_v2_errors
CREATE TABLE IF NOT EXISTS integraciones.bsale_sync_v2_errors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    run_id uuid NOT NULL,
    step_id uuid NULL,
    task_code text NOT NULL,
    error_category text NOT NULL,
    error_code text NULL,
    severity text NOT NULL,
    retryable boolean NOT NULL DEFAULT false,
    attempt_number integer NULL,
    source_id text NULL,
    http_status integer NULL,
    message text NOT NULL,
    safe_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    payload_hash text NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz NULL,
    resolved_by uuid NULL,
    resolution text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_bsale_sync_v2_errors_company FOREIGN KEY (company_id) REFERENCES core.companies(id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_sync_v2_errors_run FOREIGN KEY (run_id, company_id) REFERENCES integraciones.bsale_sync_v2_runs(id, company_id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_sync_v2_errors_step FOREIGN KEY (step_id, run_id, company_id) REFERENCES integraciones.bsale_sync_v2_steps(id, run_id, company_id) ON DELETE RESTRICT,
    CONSTRAINT fk_bsale_sync_v2_errors_user FOREIGN KEY (resolved_by) REFERENCES portal.users(id) ON DELETE SET NULL,
    CONSTRAINT chk_bsale_sync_v2_errors_code CHECK (btrim(task_code) <> ''),
    CONSTRAINT chk_bsale_sync_v2_errors_category_txt CHECK (btrim(error_category) <> ''),
    CONSTRAINT chk_bsale_sync_v2_errors_err_code CHECK (error_code IS NULL OR btrim(error_code) <> ''),
    CONSTRAINT chk_bsale_sync_v2_errors_src_id CHECK (source_id IS NULL OR btrim(source_id) <> ''),
    CONSTRAINT chk_bsale_sync_v2_errors_msg CHECK (btrim(message) <> ''),
    CONSTRAINT chk_bsale_sync_v2_errors_phash CHECK (payload_hash IS NULL OR btrim(payload_hash) <> ''),
    CONSTRAINT chk_bsale_sync_v2_errors_json CHECK (jsonb_typeof(safe_detail) = 'object'),
    CONSTRAINT chk_bsale_sync_v2_errors_attempt CHECK (attempt_number IS NULL OR attempt_number >= 1),
    CONSTRAINT chk_bsale_sync_v2_errors_http CHECK (http_status IS NULL OR (http_status >= 100 AND http_status <= 599)),
    CONSTRAINT chk_bsale_sync_v2_errors_resolved CHECK (resolved_at IS NULL OR resolved_at >= occurred_at),
    CONSTRAINT chk_bsale_sync_v2_errors_resolution_complete CHECK (
        (resolved_at IS NULL AND resolved_by IS NULL AND resolution IS NULL) OR
        (resolved_at IS NOT NULL AND resolution IS NOT NULL AND btrim(resolution) <> '')
    ),
    CONSTRAINT chk_bsale_sync_v2_errors_category CHECK (error_category IN (
        'AUTH_ERROR', 'CONFIG_ERROR', 'RATE_LIMIT', 'NETWORK_ERROR', 'TIMEOUT',
        'BSALE_4XX', 'BSALE_5XX', 'INVALID_PAYLOAD', 'NORMALIZATION_ERROR',
        'DB_ERROR', 'CONSTRAINT_ERROR', 'PARTIAL_SYNC', 'DEPENDENCY_FAILED',
        'CURSOR_ERROR', 'RECONCILIATION_MISMATCH', 'UNRECOVERABLE'
    )),
    CONSTRAINT chk_bsale_sync_v2_errors_severity CHECK (severity IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL'))
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_bsale_sync_v2_errors_co_occ ON integraciones.bsale_sync_v2_errors (company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_bsale_sync_v2_errors_co_task_occ ON integraciones.bsale_sync_v2_errors (company_id, task_code, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_bsale_sync_v2_errors_run_occ ON integraciones.bsale_sync_v2_errors (run_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_bsale_sync_v2_errors_step_occ ON integraciones.bsale_sync_v2_errors (step_id, occurred_at);

-- Partial index for unresolved errors
CREATE INDEX IF NOT EXISTS idx_bsale_sync_v2_errors_unresolved
    ON integraciones.bsale_sync_v2_errors (company_id, severity, occurred_at DESC)
    WHERE resolved_at IS NULL;

-- Comments
COMMENT ON TABLE integraciones.bsale_sync_v2_errors IS 'Conserva errores. El run debe crearse en estado PENDING antes de registrar aquí. Rechazos previos son de validación de API, no errores V2.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_errors.task_code IS 'Código de la tarea V2 que falló.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_errors.safe_detail IS 'Detalle seguro del error. No guardar tokens, payloads de clientes completos ni SQL con secretos. Debe estar sanitizado.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_errors.payload_hash IS 'Permite correlacionar payloads sin almacenar su contenido original.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_errors.retryable IS 'Indica si el error es transitorio y apto para un reintento automático.';
COMMENT ON COLUMN integraciones.bsale_sync_v2_errors.resolved_at IS 'Fecha en la que el error fue resuelto manual o automáticamente.';


-- Triggers
CREATE TRIGGER trg_bsale_sync_v2_task_config_updated_at
    BEFORE UPDATE ON integraciones.bsale_sync_v2_task_config
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();


-- RLS and Security
ALTER TABLE integraciones.bsale_sync_v2_task_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE integraciones.bsale_sync_v2_errors ENABLE ROW LEVEL SECURITY;

-- Revocations (Mínimo privilegio)
REVOKE ALL ON integraciones.bsale_sync_v2_task_config FROM PUBLIC, anon, authenticated;
REVOKE ALL ON integraciones.bsale_sync_v2_errors FROM PUBLIC, anon, authenticated;

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sync_v2_task_config TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sync_v2_errors TO service_role;
