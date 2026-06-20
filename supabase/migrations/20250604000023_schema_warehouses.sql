CREATE TABLE adquisiciones.warehouses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code varchar(50) NOT NULL,
    name varchar(180) NOT NULL,
    warehouse_type varchar(50) NOT NULL DEFAULT 'CENTRAL',
    manager_name varchar(150),
    manager_email varchar(150),
    manager_phone varchar(50),
    address text,
    city varchar(100),
    commune varchar(100),
    region varchar(100),
    capacity_m2 numeric(12,2),
    capacity_pallets integer,
    is_default boolean DEFAULT false,
    notes text,
    status varchar(30) DEFAULT 'ACTIVE',
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    created_by uuid REFERENCES portal.users(id),
    updated_by uuid REFERENCES portal.users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_code ON adquisiciones.warehouses (code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_name ON adquisiciones.warehouses (name);
CREATE INDEX IF NOT EXISTS idx_warehouses_type ON adquisiciones.warehouses (warehouse_type);
CREATE INDEX IF NOT EXISTS idx_warehouses_status ON adquisiciones.warehouses (status);
CREATE INDEX IF NOT EXISTS idx_warehouses_is_active ON adquisiciones.warehouses (is_active);
CREATE INDEX IF NOT EXISTS idx_warehouses_is_default ON adquisiciones.warehouses (is_default);

ALTER TABLE adquisiciones.warehouses ADD CONSTRAINT chk_warehouses_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLOCKED'));
ALTER TABLE adquisiciones.warehouses ADD CONSTRAINT chk_warehouses_type CHECK (warehouse_type IN ('CENTRAL', 'SUCURSAL', 'TRANSITO', 'DEVOLUCIONES', 'CONSIGNACION', 'OTRO'));
ALTER TABLE adquisiciones.warehouses ADD CONSTRAINT chk_warehouses_capacity_m2 CHECK (capacity_m2 IS NULL OR capacity_m2 >= 0);
ALTER TABLE adquisiciones.warehouses ADD CONSTRAINT chk_warehouses_pallets CHECK (capacity_pallets IS NULL OR capacity_pallets >= 0);

CREATE OR REPLACE FUNCTION adquisiciones.ensure_single_default()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.is_default THEN
        UPDATE adquisiciones.warehouses SET is_default = false WHERE id <> NEW.id AND is_default = true;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_warehouses_single_default AFTER INSERT OR UPDATE ON adquisiciones.warehouses
    FOR EACH ROW WHEN (NEW.is_default) EXECUTE FUNCTION adquisiciones.ensure_single_default();

CREATE OR REPLACE FUNCTION adquisiciones.trg_warehouses_audit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE v_user_id uuid; v_severity varchar;
BEGIN
    v_user_id := auth.uid();
    v_severity := CASE WHEN (TG_OP = 'UPDATE' AND (NEW.is_default IS DISTINCT FROM OLD.is_default OR NEW.status IN ('INACTIVE','BLOCKED') OR OLD.status IN ('INACTIVE','BLOCKED'))) THEN 'CRITICAL' ELSE 'INFO' END;
    IF TG_OP = 'INSERT' THEN
        INSERT INTO portal.audit_logs (schema_name,module_code,table_name,record_id,action,new_data,performed_by,event_type,severity)
        VALUES ('adquisiciones','ADQUISICIONES',TG_TABLE_NAME,NEW.id,'INSERT',row_to_json(NEW)::jsonb,v_user_id,'warehouses_INSERT','INFO');
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO portal.audit_logs (schema_name,module_code,table_name,record_id,action,old_data,new_data,performed_by,event_type,severity)
        VALUES ('adquisiciones','ADQUISICIONES',TG_TABLE_NAME,NEW.id,'UPDATE',row_to_json(OLD)::jsonb,row_to_json(NEW)::jsonb,v_user_id,'warehouses_UPDATE',v_severity);
        RETURN NEW;
    END IF;
END;
$$;

CREATE TRIGGER trg_warehouses_audit AFTER INSERT OR UPDATE ON adquisiciones.warehouses FOR EACH ROW EXECUTE FUNCTION adquisiciones.trg_warehouses_audit();

ALTER TABLE adquisiciones.warehouses ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_warehouses_select ON adquisiciones.warehouses FOR SELECT TO authenticated USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.warehouses.view') OR portal.has_permission('module.adquisiciones.view'));
CREATE POLICY rls_warehouses_insert ON adquisiciones.warehouses FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.warehouses.create'));
CREATE POLICY rls_warehouses_update ON adquisiciones.warehouses FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.warehouses.update')) WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.warehouses.update'));

GRANT ALL ON adquisiciones.warehouses TO authenticated, service_role;

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.warehouses.view', 'Ver bodegas', 'Ver listado de bodegas', id FROM portal.modules WHERE code = 'adquisiciones' AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.warehouses.view');
INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.warehouses.create', 'Crear bodegas', 'Crear nuevas bodegas', id FROM portal.modules WHERE code = 'adquisiciones' AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.warehouses.create');
INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.warehouses.update', 'Editar bodegas', 'Editar bodegas existentes', id FROM portal.modules WHERE code = 'adquisiciones' AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.warehouses.update');
INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.warehouses.deactivate', 'Desactivar bodegas', 'Desactivar bodegas', id FROM portal.modules WHERE code = 'adquisiciones' AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.warehouses.deactivate');
INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.warehouses.import', 'Importar bodegas', 'Importar bodegas desde Excel', id FROM portal.modules WHERE code = 'adquisiciones' AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.warehouses.import');
INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.warehouses.export', 'Exportar bodegas', 'Exportar bodegas a Excel', id FROM portal.modules WHERE code = 'adquisiciones' AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.warehouses.export');

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM portal.roles r, portal.permissions p WHERE r.name = 'SUPER_USUARIO' AND p.code LIKE 'adquisiciones.warehouses.%' AND NOT EXISTS (SELECT 1 FROM portal.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

INSERT INTO adquisiciones.warehouses (code, name, warehouse_type, is_default, status) VALUES
('PRINCIPAL', 'BODEGA PRINCIPAL', 'CENTRAL', true, 'ACTIVE')
ON CONFLICT (code) DO NOTHING;
