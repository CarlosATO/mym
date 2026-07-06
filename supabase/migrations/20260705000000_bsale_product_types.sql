-- ============================================================================
-- Migration: Bsale Product Types
-- Schema: integraciones
-- Descripción: Tabla para almacenar los product types traídos desde Bsale.
--              Se usarán como proveedores operativos en adquisiciones.
-- ============================================================================

CREATE TABLE IF NOT EXISTS integraciones.bsale_product_types (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id),
    bsale_id        int NOT NULL,
    name            text,
    state           int,
    raw_json        jsonb,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id),
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

-- RLS
ALTER TABLE integraciones.bsale_product_types ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'bsale_product_types' AND policyname = 'rls_bsale_product_types_select'
    ) THEN
        CREATE POLICY rls_bsale_product_types_select ON integraciones.bsale_product_types
            FOR SELECT TO authenticated
            USING (core.has_company_access(auth.uid(), company_id));
    END IF;
END
$$;
