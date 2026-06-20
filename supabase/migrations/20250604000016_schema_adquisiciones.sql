CREATE SCHEMA IF NOT EXISTS adquisiciones;

CREATE TABLE adquisiciones.suppliers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rut varchar(20),
    business_name varchar(200) NOT NULL,
    fantasy_name varchar(200),
    business_activity varchar(200),
    contact_name varchar(150),
    contact_email varchar(150),
    contact_phone varchar(50),
    address text,
    city varchar(100),
    region varchar(100),
    payment_terms varchar(100),
    credit_days integer DEFAULT 0,
    discount_percent numeric(5,2) DEFAULT 0,
    notes text,
    status varchar(30) DEFAULT 'ACTIVE',
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    created_by uuid REFERENCES portal.users(id),
    updated_by uuid REFERENCES portal.users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_rut ON adquisiciones.suppliers (rut) WHERE rut IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppliers_business_name ON adquisiciones.suppliers (business_name);
CREATE INDEX IF NOT EXISTS idx_suppliers_fantasy_name ON adquisiciones.suppliers (fantasy_name);
CREATE INDEX IF NOT EXISTS idx_suppliers_status ON adquisiciones.suppliers (status);
CREATE INDEX IF NOT EXISTS idx_suppliers_is_active ON adquisiciones.suppliers (is_active);

ALTER TABLE adquisiciones.suppliers ADD CONSTRAINT chk_suppliers_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLOCKED'));
ALTER TABLE adquisiciones.suppliers ADD CONSTRAINT chk_suppliers_credit_days CHECK (credit_days >= 0);
ALTER TABLE adquisiciones.suppliers ADD CONSTRAINT chk_suppliers_discount CHECK (discount_percent >= 0 AND discount_percent <= 100);

CREATE OR REPLACE FUNCTION adquisiciones.trg_suppliers_audit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
    v_severity varchar;
BEGIN
    v_user_id := auth.uid();
    v_severity := CASE
        WHEN NEW.status IN ('INACTIVE', 'BLOCKED') OR OLD.status IN ('INACTIVE', 'BLOCKED') THEN 'CRITICAL'
        ELSE 'INFO'
    END;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, NEW.id, 'INSERT', row_to_json(NEW)::jsonb, v_user_id, 'suppliers_INSERT', 'INFO');
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, old_data, new_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, NEW.id, 'UPDATE', row_to_json(OLD)::jsonb, row_to_json(NEW)::jsonb, v_user_id, 'suppliers_UPDATE', v_severity);
        RETURN NEW;
    END IF;
END;
$$;

CREATE TRIGGER trg_suppliers_audit AFTER INSERT OR UPDATE ON adquisiciones.suppliers
    FOR EACH ROW EXECUTE FUNCTION adquisiciones.trg_suppliers_audit();

ALTER TABLE adquisiciones.suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_suppliers_select ON adquisiciones.suppliers
    FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.suppliers.view'));

CREATE POLICY rls_suppliers_insert ON adquisiciones.suppliers
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.suppliers.create'));

CREATE POLICY rls_suppliers_update ON adquisiciones.suppliers
    FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.suppliers.update'))
    WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.suppliers.update'));

GRANT USAGE ON SCHEMA adquisiciones TO authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA adquisiciones TO authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA adquisiciones TO authenticated, service_role;

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.suppliers.view', 'Ver proveedores', 'Ver listado de proveedores', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.suppliers.view');

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.suppliers.create', 'Crear proveedores', 'Crear nuevos proveedores', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.suppliers.create');

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.suppliers.update', 'Editar proveedores', 'Editar proveedores existentes', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.suppliers.update');

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.suppliers.deactivate', 'Desactivar proveedores', 'Desactivar proveedores', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.suppliers.deactivate');

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.suppliers.import', 'Importar proveedores', 'Importar proveedores desde Excel', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.suppliers.import');

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r, portal.permissions p
WHERE r.name = 'SUPER_USUARIO' AND p.code LIKE 'adquisiciones.suppliers.%'
AND NOT EXISTS (
    SELECT 1 FROM portal.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
