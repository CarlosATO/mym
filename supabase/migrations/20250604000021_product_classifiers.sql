CREATE TABLE adquisiciones.product_classifiers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    classifier_type varchar(50) NOT NULL,
    name varchar(120) NOT NULL,
    normalized_name varchar(120) NOT NULL,
    parent_id uuid REFERENCES adquisiciones.product_classifiers(id),
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    created_by uuid REFERENCES portal.users(id),
    updated_by uuid REFERENCES portal.users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_classifiers_type_name ON adquisiciones.product_classifiers (classifier_type, normalized_name);
CREATE INDEX IF NOT EXISTS idx_classifiers_type ON adquisiciones.product_classifiers (classifier_type);
CREATE INDEX IF NOT EXISTS idx_classifiers_parent ON adquisiciones.product_classifiers (parent_id);

ALTER TABLE adquisiciones.product_classifiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_classifiers_select ON adquisiciones.product_classifiers FOR SELECT TO authenticated USING (true);
CREATE POLICY rls_classifiers_insert ON adquisiciones.product_classifiers FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.products.create') OR portal.has_permission('adquisiciones.products.update'));
CREATE POLICY rls_classifiers_update ON adquisiciones.product_classifiers FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.products.update')) WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.products.update'));

CREATE OR REPLACE FUNCTION adquisiciones.trg_classifiers_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id uuid; BEGIN v_user_id := auth.uid();
IF TG_OP = 'INSERT' THEN INSERT INTO portal.audit_logs (schema_name,module_code,table_name,record_id,action,new_data,performed_by,event_type,severity) VALUES ('adquisiciones','ADQUISICIONES',TG_TABLE_NAME,NEW.id,'INSERT',row_to_json(NEW)::jsonb,v_user_id,'classifiers_INSERT','INFO'); RETURN NEW;
ELSIF TG_OP = 'UPDATE' THEN INSERT INTO portal.audit_logs (schema_name,module_code,table_name,record_id,action,old_data,new_data,performed_by,event_type,severity) VALUES ('adquisiciones','ADQUISICIONES',TG_TABLE_NAME,NEW.id,'UPDATE',row_to_json(OLD)::jsonb,row_to_json(NEW)::jsonb,v_user_id,'classifiers_UPDATE','INFO'); RETURN NEW; END IF; END; $$;
CREATE TRIGGER trg_classifiers_audit AFTER INSERT OR UPDATE ON adquisiciones.product_classifiers FOR EACH ROW EXECUTE FUNCTION adquisiciones.trg_classifiers_audit();

GRANT ALL ON adquisiciones.product_classifiers TO authenticated, service_role;

INSERT INTO adquisiciones.product_classifiers (classifier_type, name, normalized_name) VALUES
    ('BRAND', 'SIN MARCA', 'SIN MARCA'),
    ('CATEGORY', 'SIN CATEGORIA', 'SIN CATEGORIA'),
    ('SUBCATEGORY', 'SIN SUBCATEGORIA', 'SIN SUBCATEGORIA'),
    ('PRODUCT_TYPE', 'SIN TIPO', 'SIN TIPO'),
    ('WEIGHT_UNIT', 'KG', 'KG'),
    ('WEIGHT_UNIT', 'GR', 'GR'),
    ('WEIGHT_UNIT', 'LB', 'LB'),
    ('WEIGHT_UNIT', 'UNIDAD', 'UNIDAD'),
    ('MEASURE_UNIT', 'UNIDAD', 'UNIDAD'),
    ('MEASURE_UNIT', 'KILOGRAMO', 'KILOGRAMO'),
    ('MEASURE_UNIT', 'LITRO', 'LITRO'),
    ('MEASURE_UNIT', 'MILILITRO', 'MILILITRO'),
    ('PURCHASE_UNIT', 'UNIDAD', 'UNIDAD'),
    ('PURCHASE_UNIT', 'CAJA', 'CAJA'),
    ('PURCHASE_UNIT', 'PALLET', 'PALLET'),
    ('SALES_UNIT', 'UNIDAD', 'UNIDAD'),
    ('SALES_UNIT', 'CAJA', 'CAJA'),
    ('PACKAGE_UNIT', 'BOLSA', 'BOLSA'),
    ('PACKAGE_UNIT', 'CAJA', 'CAJA'),
    ('PACKAGE_UNIT', 'TARRO', 'TARRO'),
    ('PACKAGE_UNIT', 'BOTELLA', 'BOTELLA'),
    ('PACKAGE_UNIT', 'LATA', 'LATA'),
    ('PACKAGE_UNIT', 'SACHET', 'SACHET');
