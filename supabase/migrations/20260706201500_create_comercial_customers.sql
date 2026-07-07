-- Migración: Crear módulo comercial y tabla customers
-- Fase 2: Schema comercial y tabla customers

CREATE SCHEMA IF NOT EXISTS comercial;

-- Asignar permisos básicos del schema
GRANT USAGE ON SCHEMA comercial TO authenticated;
GRANT USAGE ON SCHEMA comercial TO service_role;

CREATE TABLE IF NOT EXISTS comercial.customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    source varchar(30) NOT NULL DEFAULT 'MANUAL',
    bsale_client_id bigint NULL,
    customer_type varchar(30) NULL,
    rut varchar(30) NULL,
    rut_clean varchar(30) NULL,
    business_name text NOT NULL,
    fantasy_name text NULL,
    email text NULL,
    phone text NULL,
    mobile text NULL,
    address text NULL,
    city text NULL,
    commune text NULL,
    region text NULL,
    seller_name text NULL,
    route_name text NULL,
    credit_days integer NULL,
    credit_limit numeric(14,2) NULL,
    notes text NULL,
    is_active boolean NOT NULL DEFAULT true,
    last_sale_at timestamptz NULL,
    last_bsale_sync_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NULL REFERENCES portal.users(id),
    updated_by uuid NULL REFERENCES portal.users(id)
);

-- Índices
CREATE INDEX IF NOT EXISTS customers_company_id_idx ON comercial.customers(company_id);
CREATE INDEX IF NOT EXISTS customers_bsale_client_id_idx ON comercial.customers(bsale_client_id) WHERE bsale_client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_rut_clean_idx ON comercial.customers(rut_clean) WHERE rut_clean IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_business_name_idx ON comercial.customers(business_name);

-- RLS
ALTER TABLE comercial.customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view customers of their company"
    ON comercial.customers
    FOR SELECT
    USING (
        company_id IN (
            SELECT company_id 
            FROM core.user_company_access 
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert customers for their company"
    ON comercial.customers
    FOR INSERT
    WITH CHECK (
        company_id IN (
            SELECT company_id 
            FROM core.user_company_access 
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update customers of their company"
    ON comercial.customers
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
CREATE OR REPLACE FUNCTION comercial.set_current_timestamp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_comercial_customers_updated_at ON comercial.customers;
CREATE TRIGGER set_comercial_customers_updated_at
BEFORE UPDATE ON comercial.customers
FOR EACH ROW
EXECUTE FUNCTION comercial.set_current_timestamp_updated_at();

-- Permisos sobre la tabla
GRANT SELECT, INSERT, UPDATE, DELETE ON comercial.customers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON comercial.customers TO service_role;


