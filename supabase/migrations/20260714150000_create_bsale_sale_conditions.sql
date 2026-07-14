-- supabase/migrations/20260714150000_create_bsale_sale_conditions.sql
-- ============================================================================
-- Migración: Crear tabla espejo de condiciones de venta (Bsale sale_conditions)
-- Fase: Sincronización Bsale -> PetGroup
-- ============================================================================
-- ATENCIÓN: Esta migración debe coordinarse antes de aplicar.
-- Verifica con el equipo que no haya conflictos con otras migraciones en curso.
-- ============================================================================

-- 1. Tabla espejo para condiciones de venta de Bsale
CREATE TABLE IF NOT EXISTS integraciones.bsale_sale_conditions (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    bsale_id        int NOT NULL,
    name            text NOT NULL,
    state           int,
    raw_json        jsonb,
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (company_id, bsale_id)
);

-- 2. Índices
CREATE INDEX idx_bsale_sale_conditions_company ON integraciones.bsale_sale_conditions (company_id);
CREATE INDEX idx_bsale_sale_conditions_name ON integraciones.bsale_sale_conditions (company_id, name);

-- 3. RLS
ALTER TABLE integraciones.bsale_sale_conditions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view bsale_sale_conditions of their company"
    ON integraciones.bsale_sale_conditions
    FOR SELECT
    USING (
        company_id IN (
            SELECT company_id 
            FROM core.user_company_access 
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert bsale_sale_conditions for their company"
    ON integraciones.bsale_sale_conditions
    FOR INSERT
    WITH CHECK (
        company_id IN (
            SELECT company_id 
            FROM core.user_company_access 
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update bsale_sale_conditions of their company"
    ON integraciones.bsale_sale_conditions
    FOR UPDATE
    USING (
        company_id IN (
            SELECT company_id 
            FROM core.user_company_access 
            WHERE user_id = auth.uid()
        )
    )
    WITH CHECK (
        company_id IN (
            SELECT company_id 
            FROM core.user_company_access 
            WHERE user_id = auth.uid()
        )
    );

-- 4. Trigger para updated_at
CREATE OR REPLACE FUNCTION integraciones.set_current_timestamp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_bsale_sale_conditions_updated_at ON integraciones.bsale_sale_conditions;
CREATE TRIGGER set_bsale_sale_conditions_updated_at
BEFORE UPDATE ON integraciones.bsale_sale_conditions
FOR EACH ROW
EXECUTE FUNCTION integraciones.set_current_timestamp_updated_at();

-- 5. Grants (same pattern as other integraciones tables)
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sale_conditions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_sale_conditions TO service_role;

-- 6. Sync job config (cada 12 horas como product_types)
INSERT INTO integraciones.sync_job_configs (
    company_id, provider, entity, frequency_minutes, is_enabled
)
VALUES (
    'd1000000-0000-0000-0000-000000000001', 'BSALE', 'sale_conditions', 720, true
)
ON CONFLICT (company_id, provider, entity) DO UPDATE
SET frequency_minutes = EXCLUDED.frequency_minutes,
    is_enabled = EXCLUDED.is_enabled;
