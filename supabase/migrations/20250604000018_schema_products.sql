CREATE TABLE adquisiciones.products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sku varchar(50) NOT NULL,
    barcode varchar(100),
    internal_code varchar(50),
    description varchar(250) NOT NULL,
    short_description varchar(120),
    brand varchar(120),
    category varchar(120),
    subcategory varchar(120),
    product_type varchar(80),
    species varchar(80),
    presentation varchar(120),
    unit_of_measure varchar(50),
    net_weight numeric(12,3),
    weight_unit varchar(20),
    package_quantity numeric(12,3),
    package_unit varchar(50),
    purchase_unit varchar(50),
    sales_unit varchar(50),
    min_stock numeric(12,3) DEFAULT 0,
    max_stock numeric(12,3) DEFAULT 0,
    reorder_point numeric(12,3) DEFAULT 0,
    tax_rate numeric(5,2) DEFAULT 19,
    is_perishable boolean DEFAULT false,
    requires_lot boolean DEFAULT false,
    requires_expiration boolean DEFAULT false,
    image_url text,
    notes text,
    status varchar(30) DEFAULT 'ACTIVE',
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    created_by uuid REFERENCES portal.users(id),
    updated_by uuid REFERENCES portal.users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku ON adquisiciones.products (sku);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON adquisiciones.products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_description ON adquisiciones.products (description);
CREATE INDEX IF NOT EXISTS idx_products_brand ON adquisiciones.products (brand);
CREATE INDEX IF NOT EXISTS idx_products_category ON adquisiciones.products (category);
CREATE INDEX IF NOT EXISTS idx_products_status ON adquisiciones.products (status);
CREATE INDEX IF NOT EXISTS idx_products_is_active ON adquisiciones.products (is_active);

ALTER TABLE adquisiciones.products ADD CONSTRAINT chk_products_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLOCKED', 'DISCONTINUED'));
ALTER TABLE adquisiciones.products ADD CONSTRAINT chk_products_tax_rate CHECK (tax_rate >= 0 AND tax_rate <= 100);
ALTER TABLE adquisiciones.products ADD CONSTRAINT chk_products_min_stock CHECK (min_stock >= 0);
ALTER TABLE adquisiciones.products ADD CONSTRAINT chk_products_max_stock CHECK (max_stock >= 0);
ALTER TABLE adquisiciones.products ADD CONSTRAINT chk_products_reorder_point CHECK (reorder_point >= 0);

CREATE OR REPLACE FUNCTION adquisiciones.trg_products_audit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
    v_severity varchar;
BEGIN
    v_user_id := auth.uid();
    v_severity := CASE
        WHEN NEW.status IN ('INACTIVE', 'BLOCKED', 'DISCONTINUED') OR (OLD IS NOT NULL AND OLD.status IN ('INACTIVE', 'BLOCKED', 'DISCONTINUED')) THEN 'CRITICAL'
        ELSE 'INFO'
    END;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, NEW.id, 'INSERT', row_to_json(NEW)::jsonb, v_user_id, 'products_INSERT', 'INFO');
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, old_data, new_data, performed_by, event_type, severity)
        VALUES ('adquisiciones', 'ADQUISICIONES', TG_TABLE_NAME, NEW.id, 'UPDATE', row_to_json(OLD)::jsonb, row_to_json(NEW)::jsonb, v_user_id, 'products_UPDATE', v_severity);
        RETURN NEW;
    END IF;
END;
$$;

CREATE TRIGGER trg_products_audit AFTER INSERT OR UPDATE ON adquisiciones.products
    FOR EACH ROW EXECUTE FUNCTION adquisiciones.trg_products_audit();

ALTER TABLE adquisiciones.products ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_products_select ON adquisiciones.products
    FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.products.view') OR portal.has_permission('module.adquisiciones.view'));

CREATE POLICY rls_products_insert ON adquisiciones.products
    FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.products.create'));

CREATE POLICY rls_products_update ON adquisiciones.products
    FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.products.update'))
    WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.products.update'));

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.products.view', 'Ver catálogo', 'Ver catálogo de productos', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.products.view');

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.products.create', 'Crear productos', 'Crear productos en el catálogo', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.products.create');

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.products.update', 'Editar productos', 'Editar productos del catálogo', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.products.update');

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.products.deactivate', 'Desactivar productos', 'Desactivar productos del catálogo', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.products.deactivate');

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.products.import', 'Importar productos', 'Importar productos desde Excel', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.products.import');

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.products.upload_image', 'Subir imagen de producto', 'Subir imágenes de productos', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.products.upload_image');

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r, portal.permissions p
WHERE r.name = 'SUPER_USUARIO' AND p.code LIKE 'adquisiciones.products.%'
AND NOT EXISTS (
    SELECT 1 FROM portal.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
