-- Migración: Crear tabla espejo de clientes Bsale
-- Fase 2: Sincronización Bsale -> PetGrup

CREATE SCHEMA IF NOT EXISTS integraciones;

-- Asignar permisos básicos del schema
GRANT USAGE ON SCHEMA integraciones TO authenticated;
GRANT USAGE ON SCHEMA integraciones TO service_role;

DROP TABLE IF EXISTS integraciones.bsale_clients;

CREATE TABLE IF NOT EXISTS integraciones.bsale_clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    bsale_client_id bigint NOT NULL,
    code text NULL,
    code_clean text NULL,
    business_name text NULL,
    first_name text NULL,
    last_name text NULL,
    email text NULL,
    phone text NULL,
    mobile text NULL,
    address text NULL,
    city text NULL,
    commune text NULL,
    region text NULL,
    district text NULL,
    activity text NULL,
    company text NULL,
    client_type text NULL,
    price_list_id bigint NULL,
    price_list_name text NULL,
    payment_type_id bigint NULL,
    payment_type_name text NULL,
    credit_limit numeric(14,2) NULL,
    credit_days integer NULL,
    is_active_bsale boolean NULL,
    raw_payload jsonb NOT NULL,
    payload_hash text NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    last_sync_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    
    CONSTRAINT bsale_clients_company_bsale_id_key UNIQUE(company_id, bsale_client_id)
);

-- Índices
CREATE INDEX IF NOT EXISTS bsale_clients_company_id_idx ON integraciones.bsale_clients(company_id);
CREATE INDEX IF NOT EXISTS bsale_clients_bsale_id_idx ON integraciones.bsale_clients(bsale_client_id);
CREATE INDEX IF NOT EXISTS bsale_clients_code_clean_idx ON integraciones.bsale_clients(code_clean) WHERE code_clean IS NOT NULL;
CREATE INDEX IF NOT EXISTS bsale_clients_business_name_idx ON integraciones.bsale_clients(business_name) WHERE business_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS bsale_clients_email_idx ON integraciones.bsale_clients(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS bsale_clients_is_active_idx ON integraciones.bsale_clients(is_active_bsale);
CREATE INDEX IF NOT EXISTS bsale_clients_last_sync_idx ON integraciones.bsale_clients(last_sync_at);

-- RLS
ALTER TABLE integraciones.bsale_clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view bsale_clients of their company"
    ON integraciones.bsale_clients
    FOR SELECT
    USING (
        company_id IN (
            SELECT company_id 
            FROM core.user_company_access 
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert bsale_clients for their company"
    ON integraciones.bsale_clients
    FOR INSERT
    WITH CHECK (
        company_id IN (
            SELECT company_id 
            FROM core.user_company_access 
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update bsale_clients of their company"
    ON integraciones.bsale_clients
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

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION integraciones.set_current_timestamp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_bsale_clients_updated_at ON integraciones.bsale_clients;
CREATE TRIGGER set_bsale_clients_updated_at
BEFORE UPDATE ON integraciones.bsale_clients
FOR EACH ROW
EXECUTE FUNCTION integraciones.set_current_timestamp_updated_at();

-- Permisos sobre la tabla
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_clients TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_clients TO service_role;
