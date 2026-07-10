-- ============================================================================
-- bsale_sync_locks — control de concurrencia de sincronizaciones Bsale
-- ============================================================================

CREATE TABLE IF NOT EXISTS integraciones.bsale_sync_locks (
    company_id          uuid NOT NULL REFERENCES core.companies(id),
    lock_name           text NOT NULL,
    run_id              uuid,
    acquired_at         timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,
    metadata            jsonb,
    PRIMARY KEY (company_id, lock_name)
);

-- Habilitar RLS
ALTER TABLE integraciones.bsale_sync_locks ENABLE ROW LEVEL SECURITY;

-- Nota: Esta tabla será escrita principalmente por el backend usando el service_role_key,
-- por lo que el RLS no requiere políticas complejas por ahora para lectura de usuarios.
