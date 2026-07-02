-- MIGRATION: 20260702000000_route_fund_closures.sql

-- 1. Create permissions
INSERT INTO portal.permissions (code, name, description) VALUES
('adquisiciones.route_fund_closures.view', 'Ver Cierres de Fondos', 'Permite ver los cierres de fondos de rutas'),
('adquisiciones.route_fund_closures.create', 'Crear Cierre de Fondos', 'Permite agrupar fondos pendientes en un nuevo cierre'),
('adquisiciones.route_fund_closures.update', 'Actualizar Cierre de Fondos', 'Permite agregar gastos y depósitos a un cierre de fondos'),
('adquisiciones.route_fund_closures.close', 'Cerrar Fondos', 'Permite dar por cerrado un fondo cuadrado o con diferencias'),
('adquisiciones.route_fund_closures.cancel', 'Anular Cierre de Fondos', 'Permite anular un cierre de fondos y liberar sus facturas')
ON CONFLICT (code) DO NOTHING;

-- Assign permissions to roles (SUPER_USUARIO, GERENCIA, FINANZAS, ADQUISICIONES)
DO $$
DECLARE
    v_super_role_id uuid;
    v_gerencia_role_id uuid;
    v_finanzas_role_id uuid;
    v_adquisiciones_role_id uuid;
    v_role_id uuid;
BEGIN
    SELECT id INTO v_super_role_id FROM portal.roles WHERE name = 'SUPER_USUARIO';
    SELECT id INTO v_gerencia_role_id FROM portal.roles WHERE name = 'GERENCIA';
    SELECT id INTO v_finanzas_role_id FROM portal.roles WHERE name = 'FINANZAS';
    SELECT id INTO v_adquisiciones_role_id FROM portal.roles WHERE name = 'ADQUISICIONES';

    FOR v_role_id IN SELECT unnest(ARRAY[v_super_role_id, v_gerencia_role_id, v_finanzas_role_id, v_adquisiciones_role_id]) LOOP
        IF v_role_id IS NOT NULL THEN
            INSERT INTO portal.role_permissions (role_id, permission_id)
            SELECT v_role_id, p.id FROM portal.permissions p
            WHERE p.code IN (
                'adquisiciones.route_fund_closures.view',
                'adquisiciones.route_fund_closures.create',
                'adquisiciones.route_fund_closures.update',
                'adquisiciones.route_fund_closures.close',
                'adquisiciones.route_fund_closures.cancel'
            )
            AND NOT EXISTS (
                SELECT 1 FROM portal.role_permissions rp 
                WHERE rp.role_id = v_role_id AND rp.permission_id = p.id
            );
        END IF;
    END LOOP;
END $$;


-- 2. Schema and Tables

-- 2.0 Counters for Fund Closures
CREATE TABLE IF NOT EXISTS adquisiciones.route_fund_closure_counters (
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    closure_year integer NOT NULL,
    last_sequence integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, closure_year)
);

-- 2.1 Route Fund Closures (Cabecera)
CREATE TABLE IF NOT EXISTS adquisiciones.route_fund_closures (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    
    closure_number text NOT NULL,
    closure_year integer NOT NULL,
    closure_sequence integer NOT NULL,
    
    status varchar(30) NOT NULL CHECK (status IN ('OPEN', 'PARTIAL', 'CLOSED', 'WITH_DIFFERENCE', 'CANCELLED')),
    
    -- Totales (recalculados desde hijas)
    total_cash_received numeric(14,2) NOT NULL DEFAULT 0,
    total_check_received numeric(14,2) NOT NULL DEFAULT 0,
    total_expenses numeric(14,2) NOT NULL DEFAULT 0,
    total_deposits numeric(14,2) NOT NULL DEFAULT 0,
    total_pending numeric(14,2) NOT NULL DEFAULT 0,
    difference_amount numeric(14,2) NOT NULL DEFAULT 0,
    
    notes text,
    
    -- Auditoría de estados
    created_by uuid NOT NULL REFERENCES portal.users(id),
    updated_by uuid REFERENCES portal.users(id),
    closed_by uuid REFERENCES portal.users(id),
    cancelled_by uuid REFERENCES portal.users(id),
    
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    cancelled_at timestamptz,
    
    CONSTRAINT uq_route_fund_closures_number UNIQUE(company_id, closure_number)
);

CREATE INDEX idx_route_fund_closures_status ON adquisiciones.route_fund_closures (company_id, status);

-- 2.2 Route Fund Closure Items (Fondos)
CREATE TABLE IF NOT EXISTS adquisiciones.route_fund_closure_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    fund_closure_id uuid NOT NULL REFERENCES adquisiciones.route_fund_closures(id) ON DELETE CASCADE,
    
    -- Origen exacto
    route_settlement_item_id uuid NOT NULL REFERENCES adquisiciones.route_settlement_items(id),
    route_settlement_id uuid NOT NULL REFERENCES adquisiciones.route_settlements(id),
    route_guide_id uuid NOT NULL REFERENCES logistica.route_guides(id),
    
    -- Snapshots
    invoice_number text NOT NULL,
    customer_name text NOT NULL,
    payment_method varchar(30) NOT NULL CHECK (payment_method IN ('CASH', 'CHECK')),
    amount numeric(14,2) NOT NULL,
    
    -- Historial / Liberación (Soft delete funcional para no romper trazabilidad si se anula el cierre)
    released_at timestamptz,
    released_by uuid REFERENCES portal.users(id),
    release_reason text,
    
    created_at timestamptz NOT NULL DEFAULT now()
);

-- REGLA ANTI-DUPLICADO DE FONDOS
CREATE UNIQUE INDEX idx_route_fund_closures_active_item 
ON adquisiciones.route_fund_closure_items (route_settlement_item_id) 
WHERE released_at IS NULL;

CREATE INDEX idx_route_fund_closure_items_closure ON adquisiciones.route_fund_closure_items (fund_closure_id);
CREATE INDEX idx_route_fund_closure_items_guide ON adquisiciones.route_fund_closure_items (route_guide_id);

-- 2.3 Route Fund Closure Expenses (Gastos)
CREATE TABLE IF NOT EXISTS adquisiciones.route_fund_closure_expenses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    fund_closure_id uuid NOT NULL REFERENCES adquisiciones.route_fund_closures(id) ON DELETE CASCADE,
    
    -- Gasto nace obligatoriamente de una guía
    route_guide_id uuid NOT NULL REFERENCES logistica.route_guides(id),
    expense_scope varchar(20) NOT NULL CHECK (expense_scope IN ('GUIDE', 'ITEMS')),
    
    expense_type varchar(100) NOT NULL,
    amount numeric(14,2) NOT NULL,
    expense_date date NOT NULL,
    notes text,
    
    created_by uuid NOT NULL REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2.4 Expense Allocations (Apertura por Item)
CREATE TABLE IF NOT EXISTS adquisiciones.route_fund_closure_expense_allocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    expense_id uuid NOT NULL REFERENCES adquisiciones.route_fund_closure_expenses(id) ON DELETE CASCADE,
    
    route_settlement_item_id uuid NOT NULL REFERENCES adquisiciones.route_settlement_items(id),
    amount numeric(14,2) NOT NULL,
    
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rfcea_expense ON adquisiciones.route_fund_closure_expense_allocations(expense_id);

-- 2.5 Deposits / Entregas
CREATE TABLE IF NOT EXISTS adquisiciones.route_fund_closure_deposits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    fund_closure_id uuid NOT NULL REFERENCES adquisiciones.route_fund_closures(id) ON DELETE CASCADE,
    
    deposit_method varchar(30) NOT NULL CHECK (deposit_method IN ('DEPOSIT', 'CASH_DELIVERY', 'TRANSFER', 'OTHER')),
    amount numeric(14,2) NOT NULL,
    deposit_date date NOT NULL,
    reference_number text,
    notes text,
    
    attachment_required boolean NOT NULL DEFAULT false,
    
    created_by uuid NOT NULL REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2.6 Attachments
CREATE TABLE IF NOT EXISTS adquisiciones.route_fund_closure_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    fund_closure_id uuid NOT NULL REFERENCES adquisiciones.route_fund_closures(id) ON DELETE CASCADE,
    
    attachment_type varchar(30) NOT NULL CHECK (attachment_type IN ('EXPENSE', 'DEPOSIT', 'GENERAL')),
    expense_id uuid REFERENCES adquisiciones.route_fund_closure_expenses(id) ON DELETE CASCADE,
    deposit_id uuid REFERENCES adquisiciones.route_fund_closure_deposits(id) ON DELETE CASCADE,
    
    file_name text NOT NULL,
    storage_path text NOT NULL,
    file_mime_type text,
    file_size bigint,
    
    uploaded_by uuid NOT NULL REFERENCES portal.users(id),
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    
    CONSTRAINT chk_rfca_type_relation CHECK (
        (attachment_type = 'EXPENSE' AND expense_id IS NOT NULL) OR 
        (attachment_type = 'DEPOSIT' AND deposit_id IS NOT NULL) OR 
        (attachment_type = 'GENERAL')
    )
);

-- 3. Triggers
CREATE TRIGGER update_route_fund_closure_counters_updated_at BEFORE UPDATE ON adquisiciones.route_fund_closure_counters FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER update_route_fund_closures_updated_at BEFORE UPDATE ON adquisiciones.route_fund_closures FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER update_route_fund_closure_expenses_updated_at BEFORE UPDATE ON adquisiciones.route_fund_closure_expenses FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER update_route_fund_closure_deposits_updated_at BEFORE UPDATE ON adquisiciones.route_fund_closure_deposits FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();

-- 4. RLS
ALTER TABLE adquisiciones.route_fund_closure_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE adquisiciones.route_fund_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE adquisiciones.route_fund_closure_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE adquisiciones.route_fund_closure_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE adquisiciones.route_fund_closure_expense_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE adquisiciones.route_fund_closure_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE adquisiciones.route_fund_closure_attachments ENABLE ROW LEVEL SECURITY;

GRANT ALL ON ALL TABLES IN SCHEMA adquisiciones TO authenticated, service_role;

CREATE POLICY "Users can view route_fund_closure_counters if company access" ON adquisiciones.route_fund_closure_counters FOR SELECT USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can view route_fund_closures if company access" ON adquisiciones.route_fund_closures FOR SELECT USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can view route_fund_closure_items if company access" ON adquisiciones.route_fund_closure_items FOR SELECT USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can view route_fund_closure_expenses if company access" ON adquisiciones.route_fund_closure_expenses FOR SELECT USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can view route_fund_closure_expense_allocations if company access" ON adquisiciones.route_fund_closure_expense_allocations FOR SELECT USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can view route_fund_closure_deposits if company access" ON adquisiciones.route_fund_closure_deposits FOR SELECT USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can view route_fund_closure_attachments if company access" ON adquisiciones.route_fund_closure_attachments FOR SELECT USING (core.has_company_access(auth.uid(), company_id));
