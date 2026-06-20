-- ============================================================================
-- MIGRACIÓN: MULTIEMPRESA CONTROLADA EN MYM
-- ============================================================================

-- 1. CREACIÓN DE SCHEMA Y TABLAS DE CORE
CREATE SCHEMA IF NOT EXISTS core;

GRANT USAGE ON SCHEMA core TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS core.companies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rut text,
    business_name text NOT NULL,
    trade_name text,
    email text,
    phone text,
    address text,
    logo_url text,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    created_by uuid,
    updated_at timestamptz DEFAULT now(),
    updated_by uuid
);

CREATE TABLE IF NOT EXISTS core.user_company_access (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    role text NOT NULL,
    is_default boolean DEFAULT false,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    created_by uuid,
    UNIQUE(user_id, company_id)
);

-- Habilitar RLS en tablas de Core
ALTER TABLE core.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.user_company_access ENABLE ROW LEVEL SECURITY;

-- Grados en el schema core
GRANT ALL ON ALL TABLES IN SCHEMA core TO authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA core TO authenticated, service_role;

-- 2. SEMBRADO DE EMPRESAS INICIALES (Idempotente)
INSERT INTO core.companies (id, rut, business_name, trade_name, email, phone, address, logo_url, is_active)
VALUES (
    'd1000000-0000-0000-0000-000000000001',
    '76.123.456-7',
    'DISTRIBUIDORA MYM',
    'DISTRIBUIDORA MYM',
    'contacto@mym.cl',
    '+56 2 1234 5678',
    'Santiago, Chile',
    '/logo-transparent.png',
    true
)
ON CONFLICT (id) DO UPDATE SET
    rut = EXCLUDED.rut,
    business_name = EXCLUDED.business_name,
    trade_name = EXCLUDED.trade_name,
    email = EXCLUDED.email,
    phone = EXCLUDED.phone,
    logo_url = EXCLUDED.logo_url;

INSERT INTO core.companies (id, rut, business_name, trade_name, email, phone, address, logo_url, is_active)
VALUES (
    'd2000000-0000-0000-0000-000000000002',
    '77.777.777-7',
    'EMPRESA 2',
    'EMPRESA 2',
    'contacto@empresa2.cl',
    '+56 9 9999 9999',
    'Calle Falsa 123, Santiago, Chile',
    NULL,
    true
)
ON CONFLICT (id) DO UPDATE SET
    rut = EXCLUDED.rut,
    business_name = EXCLUDED.business_name,
    trade_name = EXCLUDED.trade_name,
    email = EXCLUDED.email,
    phone = EXCLUDED.phone,
    logo_url = EXCLUDED.logo_url;

-- 3. ASOCIACIÓN DE USUARIOS A EMPRESAS
-- Todos los usuarios activos obtienen acceso a DISTRIBUIDORA MYM (como predeterminado)
INSERT INTO core.user_company_access (user_id, company_id, role, is_default, is_active)
SELECT u.id, 'd1000000-0000-0000-0000-000000000001', 'ADMIN', true, true
FROM portal.users u
ON CONFLICT (user_id, company_id) DO NOTHING;

-- Solo los usuarios con rol SUPER_USUARIO obtienen acceso a EMPRESA 2
INSERT INTO core.user_company_access (user_id, company_id, role, is_default, is_active)
SELECT u.id, 'd2000000-0000-0000-0000-000000000002', 'ADMIN', false, true
FROM portal.users u
JOIN portal.roles r ON u.role_id = r.id
WHERE r.name = 'SUPER_USUARIO'
ON CONFLICT (user_id, company_id) DO NOTHING;

-- 4. AGREGAR COLUMNA COMPANY_ID A TABLAS OPERATIVAS Y MIGRAR DATOS
-- 4.1 product_classifiers (nullable)
ALTER TABLE adquisiciones.product_classifiers ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES core.companies(id) ON DELETE SET NULL;

-- 4.2 products
ALTER TABLE adquisiciones.products ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES core.companies(id) ON DELETE CASCADE;
UPDATE adquisiciones.products SET company_id = 'd1000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
ALTER TABLE adquisiciones.products ALTER COLUMN company_id SET NOT NULL;

-- 4.3 suppliers
ALTER TABLE adquisiciones.suppliers ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES core.companies(id) ON DELETE CASCADE;
UPDATE adquisiciones.suppliers SET company_id = 'd1000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
ALTER TABLE adquisiciones.suppliers ALTER COLUMN company_id SET NOT NULL;

-- 4.4 warehouses
ALTER TABLE adquisiciones.warehouses ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES core.companies(id) ON DELETE CASCADE;
UPDATE adquisiciones.warehouses SET company_id = 'd1000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
ALTER TABLE adquisiciones.warehouses ALTER COLUMN company_id SET NOT NULL;

-- 4.5 authorized_personnel
ALTER TABLE adquisiciones.authorized_personnel ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES core.companies(id) ON DELETE CASCADE;
UPDATE adquisiciones.authorized_personnel SET company_id = 'd1000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
ALTER TABLE adquisiciones.authorized_personnel ALTER COLUMN company_id SET NOT NULL;

-- 4.6 purchase_orders
ALTER TABLE adquisiciones.purchase_orders ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES core.companies(id) ON DELETE CASCADE;
UPDATE adquisiciones.purchase_orders SET company_id = 'd1000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
ALTER TABLE adquisiciones.purchase_orders ALTER COLUMN company_id SET NOT NULL;

-- 4.7 purchase_order_items
ALTER TABLE adquisiciones.purchase_order_items ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES core.companies(id) ON DELETE CASCADE;
UPDATE adquisiciones.purchase_order_items SET company_id = 'd1000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
ALTER TABLE adquisiciones.purchase_order_items ALTER COLUMN company_id SET NOT NULL;

-- 4.8 purchase_order_documents
ALTER TABLE adquisiciones.purchase_order_documents ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES core.companies(id) ON DELETE CASCADE;
UPDATE adquisiciones.purchase_order_documents SET company_id = 'd1000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
ALTER TABLE adquisiciones.purchase_order_documents ALTER COLUMN company_id SET NOT NULL;

-- 4.9 purchase_order_status_history
ALTER TABLE adquisiciones.purchase_order_status_history ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES core.companies(id) ON DELETE CASCADE;
UPDATE adquisiciones.purchase_order_status_history SET company_id = 'd1000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
ALTER TABLE adquisiciones.purchase_order_status_history ALTER COLUMN company_id SET NOT NULL;

-- 4.10 supplier_price_agreements
ALTER TABLE adquisiciones.supplier_price_agreements ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES core.companies(id) ON DELETE CASCADE;
UPDATE adquisiciones.supplier_price_agreements SET company_id = 'd1000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
ALTER TABLE adquisiciones.supplier_price_agreements ALTER COLUMN company_id SET NOT NULL;


-- 5. AJUSTAR CLAVES E ÍNDICES ÚNICOS PARA SCOPE POR EMPRESA
-- 5.1 products (SKU y código de barra únicos por empresa)
DROP INDEX IF EXISTS adquisiciones.idx_products_sku;
DROP INDEX IF EXISTS adquisiciones.idx_products_barcode;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku_company ON adquisiciones.products (company_id, sku);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_company ON adquisiciones.products (company_id, barcode) WHERE barcode IS NOT NULL;

-- 5.2 suppliers (RUT único por empresa)
DROP INDEX IF EXISTS adquisiciones.idx_suppliers_rut;
DROP INDEX IF EXISTS adquisiciones.idx_suppliers_rut_normalized;
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_rut_company ON adquisiciones.suppliers (company_id, rut) WHERE rut IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_rut_normalized_company ON adquisiciones.suppliers (company_id, rut_normalized) WHERE rut_normalized IS NOT NULL;

-- 5.3 warehouses (código y nombre únicos por empresa)
DROP INDEX IF EXISTS adquisiciones.idx_warehouses_code;
DROP INDEX IF EXISTS adquisiciones.idx_warehouses_name;
CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_code_company ON adquisiciones.warehouses (company_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_name_company ON adquisiciones.warehouses (company_id, name);

-- 5.4 purchase_orders (correlativo único por empresa y clave compuesta para items)
ALTER TABLE adquisiciones.purchase_orders ADD CONSTRAINT uq_po_id_company UNIQUE (id, company_id);

-- Enlazar purchase_order_items con la empresa de la orden padre
ALTER TABLE adquisiciones.purchase_order_items DROP CONSTRAINT IF EXISTS purchase_order_items_po_id_fkey;
ALTER TABLE adquisiciones.purchase_order_items 
    ADD CONSTRAINT fk_poi_po_company 
    FOREIGN KEY (po_id, company_id) 
    REFERENCES adquisiciones.purchase_orders(id, company_id) 
    ON DELETE CASCADE;


-- 6. MODIFICAR TRIGGER DE DEFAULT WAREHOUSE POR EMPRESA
CREATE OR REPLACE FUNCTION adquisiciones.ensure_single_default()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.is_default THEN
        UPDATE adquisiciones.warehouses 
        SET is_default = false 
        WHERE id <> NEW.id AND is_default = true AND company_id = NEW.company_id;
    END IF;
    RETURN NEW;
END;
$$;


-- 7. REFACTORIZAR POLÍTICAS RLS CON VALIDACIÓN DE ACCESO DE EMPRESA
-- Función auxiliar para verificar acceso a empresa (SECURITY DEFINER para evitar recursión RLS)
CREATE OR REPLACE FUNCTION core.has_company_access(p_user_id uuid, p_company_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1 FROM core.user_company_access
        WHERE user_id = p_user_id AND company_id = p_company_id AND is_active = true
    );
$$;

GRANT EXECUTE ON FUNCTION core.has_company_access(uuid, uuid) TO authenticated, service_role;

-- Eliminar políticas antiguas
DROP POLICY IF EXISTS rls_products_select ON adquisiciones.products;
DROP POLICY IF EXISTS rls_products_insert ON adquisiciones.products;
DROP POLICY IF EXISTS rls_products_update ON adquisiciones.products;

DROP POLICY IF EXISTS rls_suppliers_select ON adquisiciones.suppliers;
DROP POLICY IF EXISTS rls_suppliers_insert ON adquisiciones.suppliers;
DROP POLICY IF EXISTS rls_suppliers_update ON adquisiciones.suppliers;

DROP POLICY IF EXISTS rls_warehouses_select ON adquisiciones.warehouses;
DROP POLICY IF EXISTS rls_warehouses_insert ON adquisiciones.warehouses;
DROP POLICY IF EXISTS rls_warehouses_update ON adquisiciones.warehouses;

DROP POLICY IF EXISTS rls_authorized_personnel_select ON adquisiciones.authorized_personnel;
DROP POLICY IF EXISTS rls_authorized_personnel_insert ON adquisiciones.authorized_personnel;
DROP POLICY IF EXISTS rls_authorized_personnel_update ON adquisiciones.authorized_personnel;

DROP POLICY IF EXISTS rls_po_select ON adquisiciones.purchase_orders;
DROP POLICY IF EXISTS rls_po_insert ON adquisiciones.purchase_orders;
DROP POLICY IF EXISTS rls_po_update ON adquisiciones.purchase_orders;

DROP POLICY IF EXISTS rls_poi_select ON adquisiciones.purchase_order_items;
DROP POLICY IF EXISTS rls_poi_insert ON adquisiciones.purchase_order_items;
DROP POLICY IF EXISTS rls_poi_update ON adquisiciones.purchase_order_items;

DROP POLICY IF EXISTS rls_posh_select ON adquisiciones.purchase_order_status_history;
DROP POLICY IF EXISTS rls_posh_insert ON adquisiciones.purchase_order_status_history;

DROP POLICY IF EXISTS rls_classifiers_select ON adquisiciones.product_classifiers;
DROP POLICY IF EXISTS rls_classifiers_insert ON adquisiciones.product_classifiers;
DROP POLICY IF EXISTS rls_classifiers_update ON adquisiciones.product_classifiers;

-- Crear nuevas políticas con scope de empresa
-- core.companies
DROP POLICY IF EXISTS rls_companies_select ON core.companies;
CREATE POLICY rls_companies_select ON core.companies
    FOR SELECT TO authenticated
    USING (
        portal.has_permission('system.admin') OR 
        core.has_company_access(auth.uid(), id)
    );

-- core.user_company_access
DROP POLICY IF EXISTS rls_uca_select ON core.user_company_access;
CREATE POLICY rls_uca_select ON core.user_company_access
    FOR SELECT TO authenticated
    USING (
        portal.has_permission('system.admin') OR user_id = auth.uid()
    );

-- products
CREATE POLICY rls_products_select ON adquisiciones.products FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR ((portal.has_permission('adquisiciones.products.view') OR portal.has_permission('module.adquisiciones.view')) AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_products_insert ON adquisiciones.products FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.products.create') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_products_update ON adquisiciones.products FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.products.update') AND core.has_company_access(auth.uid(), company_id)))
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.products.update') AND core.has_company_access(auth.uid(), company_id)));

-- suppliers
CREATE POLICY rls_suppliers_select ON adquisiciones.suppliers FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.suppliers.view') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_suppliers_insert ON adquisiciones.suppliers FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.suppliers.create') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_suppliers_update ON adquisiciones.suppliers FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.suppliers.update') AND core.has_company_access(auth.uid(), company_id)))
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.suppliers.update') AND core.has_company_access(auth.uid(), company_id)));

-- warehouses
CREATE POLICY rls_warehouses_select ON adquisiciones.warehouses FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR ((portal.has_permission('adquisiciones.warehouses.view') OR portal.has_permission('module.adquisiciones.view')) AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_warehouses_insert ON adquisiciones.warehouses FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.warehouses.create') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_warehouses_update ON adquisiciones.warehouses FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.warehouses.update') AND core.has_company_access(auth.uid(), company_id)))
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.warehouses.update') AND core.has_company_access(auth.uid(), company_id)));

-- authorized_personnel
CREATE POLICY rls_authorized_personnel_select ON adquisiciones.authorized_personnel FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('module.adquisiciones.view') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_authorized_personnel_insert ON adquisiciones.authorized_personnel FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.create') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_authorized_personnel_update ON adquisiciones.authorized_personnel FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.update') AND core.has_company_access(auth.uid(), company_id)))
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.update') AND core.has_company_access(auth.uid(), company_id)));

-- purchase_orders
CREATE POLICY rls_po_select ON adquisiciones.purchase_orders FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.view') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_po_insert ON adquisiciones.purchase_orders FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.create') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_po_update ON adquisiciones.purchase_orders FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.update') AND core.has_company_access(auth.uid(), company_id)))
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.update') AND core.has_company_access(auth.uid(), company_id)));

-- purchase_order_items
CREATE POLICY rls_poi_select ON adquisiciones.purchase_order_items FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.view') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_poi_insert ON adquisiciones.purchase_order_items FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.create') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_poi_update ON adquisiciones.purchase_order_items FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.update') AND core.has_company_access(auth.uid(), company_id)))
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.update') AND core.has_company_access(auth.uid(), company_id)));

-- purchase_order_status_history
CREATE POLICY rls_posh_select ON adquisiciones.purchase_order_status_history FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.view') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_posh_insert ON adquisiciones.purchase_order_status_history FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.create') AND core.has_company_access(auth.uid(), company_id)));

-- purchase_order_documents
DROP POLICY IF EXISTS rls_pod_select ON adquisiciones.purchase_order_documents;
DROP POLICY IF EXISTS rls_pod_insert ON adquisiciones.purchase_order_documents;
CREATE POLICY rls_pod_select ON adquisiciones.purchase_order_documents FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.view') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_pod_insert ON adquisiciones.purchase_order_documents FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.po.create') AND core.has_company_access(auth.uid(), company_id)));

-- supplier_price_agreements
DROP POLICY IF EXISTS rls_spa_select ON adquisiciones.supplier_price_agreements;
DROP POLICY IF EXISTS rls_spa_insert ON adquisiciones.supplier_price_agreements;
DROP POLICY IF EXISTS rls_spa_update ON adquisiciones.supplier_price_agreements;
CREATE POLICY rls_spa_select ON adquisiciones.supplier_price_agreements FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('module.adquisiciones.view') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_spa_insert ON adquisiciones.supplier_price_agreements FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.suppliers.create') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY rls_spa_update ON adquisiciones.supplier_price_agreements FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.suppliers.update') AND core.has_company_access(auth.uid(), company_id)))
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.suppliers.update') AND core.has_company_access(auth.uid(), company_id)));

-- product_classifiers (clasificadores globales o de empresa)
CREATE POLICY rls_classifiers_select ON adquisiciones.product_classifiers FOR SELECT TO authenticated
    USING (company_id IS NULL OR portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_classifiers_insert ON adquisiciones.product_classifiers FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR ((portal.has_permission('adquisiciones.products.create') OR portal.has_permission('adquisiciones.products.update')) AND (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))));
CREATE POLICY rls_classifiers_update ON adquisiciones.product_classifiers FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.products.update') AND (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))))
    WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('adquisiciones.products.update') AND (company_id IS NULL OR core.has_company_access(auth.uid(), company_id))));


-- 8. REFACTORIZAR RPCs DE ADQUISICIONES A NIVEL DE BASE DE DATOS
-- 8.1 generate_po_correlative
CREATE OR REPLACE FUNCTION adquisiciones.generate_po_correlative(p_company_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_year text;
    v_seq integer;
    v_corr text;
BEGIN
    v_year := to_char(CURRENT_DATE, 'YYYY');
    SELECT COALESCE(MAX(SUBSTRING(correlative FROM 'OC-' || v_year || '-(\d{6})')::integer), 0) + 1
    INTO v_seq
    FROM adquisiciones.purchase_orders
    WHERE correlative LIKE 'OC-' || v_year || '-%' AND company_id = p_company_id;
    v_corr := 'OC-' || v_year || '-' || LPAD(v_seq::text, 6, '0');
    RETURN v_corr;
END;
$$;

-- 8.2 get_next_correlative_display
DROP FUNCTION IF EXISTS adquisiciones.get_next_correlative_display();
CREATE OR REPLACE FUNCTION adquisiciones.get_next_correlative_display(p_company_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN adquisiciones.generate_po_correlative(p_company_id);
END;
$$;

-- 8.3 create_purchase_order
DROP FUNCTION IF EXISTS adquisiciones.create_purchase_order(jsonb, uuid);
CREATE OR REPLACE FUNCTION adquisiciones.create_purchase_order(
    p_data jsonb,
    p_user_id uuid,
    p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_po_id uuid;
    v_corr text;
    v_item jsonb;
    v_net numeric(14,2) := 0;
    v_disc numeric(14,2) := 0;
    v_tax numeric(14,2) := 0;
    v_exempt numeric(14,2) := 0;
    v_total numeric(14,2) := 0;
    v_line_total numeric(14,2);
    v_line_disc numeric(14,2);
    v_line_tax numeric(14,2);
    v_line_num integer := 0;
    v_po_type varchar(20);
    v_has_product boolean := false;
    v_has_service boolean := false;
    v_wh_id uuid;
BEGIN
    -- Validar acceso
    IF NOT core.has_company_access(p_user_id, p_company_id) AND NOT portal.has_permission('system.admin') THEN
        RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a la empresa especificada');
    END IF;

    v_corr := adquisiciones.generate_po_correlative(p_company_id);

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_data->'items')
    LOOP
        IF v_item->>'item_type' = 'PRODUCT' THEN v_has_product := true;
        ELSIF v_item->>'item_type' = 'SERVICE' THEN v_has_service := true;
        END IF;
    END LOOP;

    v_po_type := CASE
        WHEN v_has_product AND v_has_service THEN 'MIXTA'
        WHEN v_has_service THEN 'SERVICIOS'
        ELSE 'PRODUCTOS'
    END;

    v_wh_id := (p_data->>'warehouse_id')::uuid;

    INSERT INTO adquisiciones.purchase_orders (
        company_id, correlative, issue_date, required_date, supplier_id, warehouse_id,
        po_type, currency, payment_terms, requested_by, authorized_by,
        notes, net_total, discount_total, tax_total, exempt_total, grand_total,
        status, receipt_status, invoice_status, created_by, updated_by
    ) VALUES (
        p_company_id,
        v_corr,
        CURRENT_DATE,
        (p_data->>'required_date')::date,
        (p_data->>'supplier_id')::uuid,
        v_wh_id,
        v_po_type,
        COALESCE(p_data->>'currency', 'CLP'),
        p_data->>'payment_terms',
        p_user_id,
        (p_data->>'authorized_by')::uuid,
        p_data->>'notes',
        0, 0, 0, 0, 0,
        'BORRADOR', 'PENDIENTE', 'PENDIENTE',
        p_user_id, p_user_id
    ) RETURNING id INTO v_po_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_data->'items')
    LOOP
        v_line_num := v_line_num + 1;
        v_line_total := COALESCE((v_item->>'quantity')::numeric, 0) * COALESCE((v_item->>'unit_price')::numeric, 0);
        v_line_disc := v_line_total * COALESCE((v_item->>'discount_percent')::numeric, 0) / 100;
        v_line_tax := (v_line_total - v_line_disc) * COALESCE((v_item->>'tax_rate')::numeric, 19) / 100;

        INSERT INTO adquisiciones.purchase_order_items (
            company_id, po_id, line_number, item_type, product_id, product_description,
            unit, quantity, unit_price, discount_percent, discount_amount,
            tax_rate, tax_amount, line_total, warehouse_id, cost_center,
            required_date, notes, created_by, updated_by
        ) VALUES (
            p_company_id,
            v_po_id, v_line_num,
            v_item->>'item_type',
            (v_item->>'product_id')::uuid,
            v_item->>'product_description',
            v_item->>'unit',
            (v_item->>'quantity')::numeric,
            (v_item->>'unit_price')::numeric,
            COALESCE((v_item->>'discount_percent')::numeric, 0),
            v_line_disc,
            COALESCE((v_item->>'tax_rate')::numeric, 19),
            v_line_tax,
            v_line_total - v_line_disc + v_line_tax,
            COALESCE((v_item->>'warehouse_id')::uuid, v_wh_id),
            v_item->>'cost_center',
            (v_item->>'required_date')::date,
            v_item->>'notes',
            p_user_id, p_user_id
        );

        v_net := v_net + (v_line_total - v_line_disc);
        v_disc := v_disc + v_line_disc;
        v_tax := v_tax + v_line_tax;
    END LOOP;

    v_total := v_net + v_tax;

    UPDATE adquisiciones.purchase_orders SET
        net_total = ROUND(v_net, 2),
        discount_total = ROUND(v_disc, 2),
        tax_total = ROUND(v_tax, 2),
        exempt_total = ROUND(v_exempt, 2),
        grand_total = ROUND(v_total, 2),
        updated_by = p_user_id
    WHERE id = v_po_id;

    INSERT INTO adquisiciones.purchase_order_status_history (company_id, po_id, from_status, to_status, changed_by)
    VALUES (p_company_id, v_po_id, NULL, 'BORRADOR', p_user_id);

    RETURN jsonb_build_object('success', true, 'po_id', v_po_id, 'correlative', v_corr);
END;
$$;

-- 8.4 get_purchase_orders
DROP FUNCTION IF EXISTS adquisiciones.get_purchase_orders(jsonb);
CREATE OR REPLACE FUNCTION adquisiciones.get_purchase_orders(p_filters jsonb, p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_search text := p_filters->>'search';
    v_status text := p_filters->>'status';
    v_supplier_id uuid := (p_filters->>'supplier_id')::uuid;
    v_po_type text := p_filters->>'po_type';
    v_date_from date := (p_filters->>'date_from')::date;
    v_date_to date := (p_filters->>'date_to')::date;
    v_page integer := COALESCE((p_filters->>'page')::integer, 1);
    v_page_size integer := COALESCE((p_filters->>'page_size')::integer, 50);
    v_offset integer := (v_page - 1) * v_page_size;
    v_result jsonb;
BEGIN
    WITH q AS (
        SELECT po.*, s.business_name AS supplier_name, s.rut AS supplier_rut,
               w.name AS warehouse_name,
               u.nombre || ' ' || u.apellido AS requester_name,
               ap.full_name AS authorized_name
        FROM adquisiciones.purchase_orders po
        LEFT JOIN adquisiciones.suppliers s ON s.id = po.supplier_id
        LEFT JOIN adquisiciones.warehouses w ON w.id = po.warehouse_id
        LEFT JOIN portal.users u ON u.id = po.requested_by
        LEFT JOIN adquisiciones.authorized_personnel ap ON ap.id = po.authorized_by
        WHERE po.is_active = true AND po.company_id = p_company_id
        AND (v_search IS NULL OR po.correlative ILIKE '%' || v_search || '%' OR s.business_name ILIKE '%' || v_search || '%')
        AND (v_status IS NULL OR po.status = v_status)
        AND (v_supplier_id IS NULL OR po.supplier_id = v_supplier_id)
        AND (v_po_type IS NULL OR po.po_type = v_po_type)
        AND (v_date_from IS NULL OR po.issue_date >= v_date_from)
        AND (v_date_to IS NULL OR po.issue_date <= v_date_to)
    )
    SELECT jsonb_build_object(
        'data', COALESCE(jsonb_agg(jsonb_build_object(
            'id', q.id, 'correlative', q.correlative, 'issue_date', q.issue_date,
            'required_date', q.required_date, 'supplier_id', q.supplier_id,
            'supplier_name', q.supplier_name, 'supplier_rut', q.supplier_rut,
            'warehouse_id', q.warehouse_id, 'warehouse_name', q.warehouse_name,
            'po_type', q.po_type, 'currency', q.currency,
            'payment_terms', q.payment_terms, 'requested_by', q.requested_by,
            'requester_name', q.requester_name, 'authorized_by', q.authorized_by,
            'authorized_name', q.authorized_name, 'notes', q.notes,
            'net_total', q.net_total, 'discount_total', q.discount_total,
            'tax_total', q.tax_total, 'exempt_total', q.exempt_total,
            'grand_total', q.grand_total, 'status', q.status,
            'receipt_status', q.receipt_status, 'invoice_status', q.invoice_status,
            'email_sent_at', q.email_sent_at, 'cancel_reason', q.cancel_reason,
            'created_at', q.created_at, 'updated_at', q.updated_at
        ) ORDER BY q.created_at DESC), '[]'::jsonb),
        'total', (SELECT count(*) FROM q),
        'page', v_page, 'page_size', v_page_size
    ) INTO v_result
    FROM (SELECT * FROM q ORDER BY created_at DESC LIMIT v_page_size OFFSET v_offset) q;

    RETURN v_result;
END;
$$;

-- 8.5 get_purchase_order_detail
CREATE OR REPLACE FUNCTION adquisiciones.get_purchase_order_detail(p_po_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_po jsonb;
    v_items jsonb;
BEGIN
    SELECT jsonb_build_object(
        'id', po.id, 'correlative', po.correlative, 'issue_date', po.issue_date,
        'required_date', po.required_date,
        'supplier_id', po.supplier_id, 'supplier_name', s.business_name,
        'supplier_rut', s.rut, 'supplier_contact', s.contact_name,
        'supplier_email', s.contact_email, 'supplier_phone', s.contact_phone,
        'supplier_address', s.address,
        'warehouse_id', po.warehouse_id, 'warehouse_name', w.name,
        'po_type', po.po_type, 'currency', po.currency, 'payment_terms', po.payment_terms,
        'requested_by', po.requested_by,
        'requester_name', u.nombre || ' ' || u.apellido,
        'requester_email', u.email,
        'authorized_by', po.authorized_by, 'authorized_name', ap.full_name,
        'authorized_position', ap.position,
        'notes', po.notes,
        'net_total', po.net_total, 'discount_total', po.discount_total,
        'tax_total', po.tax_total, 'exempt_total', po.exempt_total,
        'grand_total', po.grand_total, 'status', po.status,
        'receipt_status', po.receipt_status, 'invoice_status', po.invoice_status,
        'cancel_reason', po.cancel_reason, 'cancelled_at', po.cancelled_at,
        'email_sent_at', po.email_sent_at, 'supplier_email_snapshot', po.supplier_email_snapshot,
        'created_at', po.created_at, 'updated_at', po.updated_at,
        -- Datos dinámicos de la empresa de la orden
        'company_name', c.business_name,
        'company_rut', c.rut,
        'company_logo_url', c.logo_url,
        'company_phone', c.phone,
        'company_email', c.email,
        'company_address', c.address
    ) INTO v_po
    FROM adquisiciones.purchase_orders po
    LEFT JOIN core.companies c ON c.id = po.company_id
    LEFT JOIN adquisiciones.suppliers s ON s.id = po.supplier_id
    LEFT JOIN adquisiciones.warehouses w ON w.id = po.warehouse_id
    LEFT JOIN portal.users u ON u.id = po.requested_by
    LEFT JOIN adquisiciones.authorized_personnel ap ON ap.id = po.authorized_by
    WHERE po.id = p_po_id;

    SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'line_number', i.line_number, 'item_type', i.item_type,
        'product_id', i.product_id, 'product_description', i.product_description,
        'unit', i.unit, 'quantity', i.quantity, 'unit_price', i.unit_price,
        'discount_percent', i.discount_percent, 'discount_amount', i.discount_amount,
        'tax_rate', i.tax_rate, 'tax_amount', i.tax_amount, 'line_total', i.line_total,
        'warehouse_id', i.warehouse_id, 'warehouse_name', iw.name,
        'cost_center', i.cost_center, 'required_date', i.required_date,
        'notes', i.notes, 'quantity_received', i.quantity_received,
        'quantity_pending', i.quantity_pending, 'lot_number', i.lot_number,
        'expiration_date', i.expiration_date
    ) ORDER BY i.line_number) INTO v_items
    FROM adquisiciones.purchase_order_items i
    LEFT JOIN adquisiciones.warehouses iw ON iw.id = i.warehouse_id
    WHERE i.po_id = p_po_id AND i.is_active = true;

    RETURN jsonb_build_object('po', v_po, 'items', COALESCE(v_items, '[]'::jsonb));
END;
$$;

-- 8.6 import_products_bulk
DROP FUNCTION IF EXISTS adquisiciones.import_products_bulk(jsonb, uuid);
CREATE OR REPLACE FUNCTION adquisiciones.import_products_bulk(
    p_products jsonb,
    p_user_id uuid,
    p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_product jsonb;
    v_sku varchar;
    v_barcode varchar;
    v_internal_code varchar;
    v_description varchar;
    v_brand varchar;
    v_category varchar;
    v_subcategory varchar;
    v_product_type varchar;
    v_unit_of_measure varchar;
    v_weight_unit varchar;
    v_package_unit varchar;
    v_purchase_unit varchar;
    v_sales_unit varchar;
    
    v_created_count integer := 0;
    v_omitted_sku_count integer := 0;
    v_omitted_barcode_count integer := 0;
    v_omitted_duplicate_name_count integer := 0;
    v_created_classifiers_count integer := 0;
    
    v_errors jsonb := '[]'::jsonb;
    v_row_idx integer := 0;
    
    v_norm_sku varchar;
    v_norm_barcode varchar;
    v_norm_desc varchar;
    v_norm_brand varchar;
    v_norm_unit varchar;
    
    v_classifier_types text[] := ARRAY['BRAND', 'CATEGORY', 'SUBCATEGORY', 'PRODUCT_TYPE', 'WEIGHT_UNIT', 'MEASURE_UNIT', 'PACKAGE_UNIT', 'PURCHASE_UNIT', 'SALES_UNIT'];
    v_classifier_vals text[];
    v_classifier_type text;
    v_classifier_val text;
    v_norm_cval text;
    i integer;
BEGIN
    FOR v_product IN SELECT * FROM jsonb_array_elements(p_products) LOOP
        v_row_idx := v_row_idx + 1;
        
        v_sku := trim(both ' ' from (v_product->>'sku'));
        v_barcode := trim(both ' ' from (v_product->>'codigo_barra'));
        v_internal_code := trim(both ' ' from (v_product->>'codigo_interno'));
        v_description := trim(both ' ' from (v_product->>'descripcion'));
        v_brand := trim(both ' ' from (v_product->>'marca'));
        v_category := trim(both ' ' from (v_product->>'categoria'));
        v_subcategory := trim(both ' ' from (v_product->>'subcategoria'));
        v_product_type := trim(both ' ' from (v_product->>'tipo_producto'));
        v_unit_of_measure := trim(both ' ' from (v_product->>'unidad_medida'));
        v_weight_unit := trim(both ' ' from (v_product->>'unidad_peso'));
        v_package_unit := trim(both ' ' from (v_product->>'unidad_empaque'));
        v_purchase_unit := trim(both ' ' from (v_product->>'unidad_compra'));
        v_sales_unit := trim(both ' ' from (v_product->>'unidad_venta'));
        
        IF v_sku IS NULL OR v_sku = '' THEN
            v_errors := jsonb_insert(v_errors, '{0}', jsonb_build_object('row', v_row_idx, 'message', 'SKU obligatorio'), true);
            CONTINUE;
        END IF;
        
        IF v_description IS NULL OR v_description = '' THEN
            v_errors := jsonb_insert(v_errors, '{0}', jsonb_build_object('row', v_row_idx, 'message', 'Descripción obligatoria'), true);
            CONTINUE;
        END IF;
        
        v_norm_sku := upper(regexp_replace(v_sku, '\s+', ' ', 'g'));
        v_norm_desc := upper(regexp_replace(v_description, '\s+', ' ', 'g'));
        
        -- Check duplicate by SKU (scoped by company)
        IF EXISTS (
            SELECT 1 FROM adquisiciones.products 
            WHERE company_id = p_company_id 
              AND (upper(sku) = v_norm_sku 
                 OR (v_internal_code IS NOT NULL AND v_internal_code != '' AND upper(internal_code) = upper(v_internal_code)))
        ) THEN
            v_omitted_sku_count := v_omitted_sku_count + 1;
            CONTINUE;
        END IF;
        
        -- Check duplicate by barcode (scoped by company)
        IF v_barcode IS NOT NULL AND v_barcode != '' THEN
            v_norm_barcode := upper(regexp_replace(v_barcode, '\s+', ' ', 'g'));
            IF EXISTS (SELECT 1 FROM adquisiciones.products WHERE company_id = p_company_id AND upper(barcode) = v_norm_barcode) THEN
                v_omitted_barcode_count := v_omitted_barcode_count + 1;
                CONTINUE;
            END IF;
        ELSE
            v_norm_barcode := NULL;
        END IF;
        
        -- Check duplicate by description + brand + unit (scoped by company)
        v_norm_brand := COALESCE(upper(regexp_replace(v_brand, '\s+', ' ', 'g')), 'SIN MARCA');
        v_norm_unit := COALESCE(upper(regexp_replace(v_unit_of_measure, '\s+', ' ', 'g')), 'UNIDAD');
        
        IF EXISTS (
            SELECT 1 FROM adquisiciones.products
            WHERE company_id = p_company_id
              AND upper(description) = v_norm_desc
              AND COALESCE(upper(brand), 'SIN MARCA') = v_norm_brand
              AND COALESCE(upper(unit_of_measure), 'UNIDAD') = v_norm_unit
        ) THEN
            v_omitted_duplicate_name_count := v_omitted_duplicate_name_count + 1;
            CONTINUE;
        END IF;
        
        -- Auto-seed/verify classifiers (scoped by company or global)
        v_classifier_vals := ARRAY[
            v_brand, v_category, v_subcategory, v_product_type, 
            v_weight_unit, v_unit_of_measure, v_package_unit, 
            v_purchase_unit, v_sales_unit
        ];
        
        FOR i IN 1..9 LOOP
            v_classifier_type := v_classifier_types[i];
            v_classifier_val := trim(both ' ' from v_classifier_vals[i]);
            
            IF v_classifier_val IS NULL OR v_classifier_val = '' THEN
                v_classifier_val := CASE
                    WHEN v_classifier_type = 'BRAND' THEN 'SIN MARCA'
                    WHEN v_classifier_type = 'CATEGORY' THEN 'SIN CATEGORIA'
                    WHEN v_classifier_type = 'SUBCATEGORY' THEN 'SIN SUBCATEGORIA'
                    WHEN v_classifier_type = 'PRODUCT_TYPE' THEN 'SIN TIPO'
                    WHEN v_classifier_type = 'WEIGHT_UNIT' THEN 'UNIDAD'
                    WHEN v_classifier_type = 'MEASURE_UNIT' THEN 'UNIDAD'
                    WHEN v_classifier_type = 'PACKAGE_UNIT' THEN 'CAJA'
                    WHEN v_classifier_type = 'PURCHASE_UNIT' THEN 'UNIDAD'
                    WHEN v_classifier_type = 'SALES_UNIT' THEN 'UNIDAD'
                    ELSE 'UNIDAD'
                END;
            END IF;
            
            v_norm_cval := upper(regexp_replace(v_classifier_val, '\s+', ' ', 'g'));
            
            -- Check if exists globally (company_id is null) or for this company
            IF NOT EXISTS (
                SELECT 1 FROM adquisiciones.product_classifiers 
                WHERE classifier_type = v_classifier_type 
                  AND normalized_name = v_norm_cval
                  AND (company_id IS NULL OR company_id = p_company_id)
            ) THEN
                -- Insert as company-specific classifier
                INSERT INTO adquisiciones.product_classifiers (company_id, classifier_type, name, normalized_name, created_by)
                VALUES (p_company_id, v_classifier_type, v_classifier_val, v_norm_cval, p_user_id);
                
                v_created_classifiers_count := v_created_classifiers_count + 1;
            END IF;
            
            CASE i
                WHEN 1 THEN v_brand := v_classifier_val;
                WHEN 2 THEN v_category := v_classifier_val;
                WHEN 3 THEN v_subcategory := v_classifier_val;
                WHEN 4 THEN v_product_type := v_classifier_val;
                WHEN 5 THEN v_weight_unit := v_classifier_val;
                WHEN 6 THEN v_unit_of_measure := v_classifier_val;
                WHEN 7 THEN v_package_unit := v_classifier_val;
                WHEN 8 THEN v_purchase_unit := v_classifier_val;
                WHEN 9 THEN v_sales_unit := v_classifier_val;
            END CASE;
        END LOOP;
        
        -- Insert product
        BEGIN
            INSERT INTO adquisiciones.products (
                company_id,
                sku, barcode, internal_code, description, short_description,
                brand, category, subcategory, product_type, species, presentation,
                unit_of_measure, net_weight, weight_unit, package_quantity, package_unit,
                purchase_unit, sales_unit, min_stock, max_stock, reorder_point,
                tax_rate, is_perishable, requires_lot, requires_expiration, notes,
                created_by, updated_by, status, is_active
            )
            VALUES (
                p_company_id,
                v_norm_sku,
                v_norm_barcode,
                CASE WHEN v_internal_code = '' THEN NULL ELSE upper(v_internal_code) END,
                v_norm_desc,
                CASE WHEN (v_product->>'descripcion_corta') IS NOT NULL AND trim(both ' ' from (v_product->>'descripcion_corta')) != '' THEN upper(trim(both ' ' from (v_product->>'descripcion_corta'))) ELSE NULL END,
                upper(v_brand),
                upper(v_category),
                upper(v_subcategory),
                upper(v_product_type),
                CASE WHEN (v_product->>'especie') IS NOT NULL AND trim(both ' ' from (v_product->>'especie')) != '' THEN upper(trim(both ' ' from (v_product->>'especie'))) ELSE NULL END,
                CASE WHEN (v_product->>'presentacion') IS NOT NULL AND trim(both ' ' from (v_product->>'presentacion')) != '' THEN upper(trim(both ' ' from (v_product->>'presentacion'))) ELSE NULL END,
                upper(v_unit_of_measure),
                COALESCE((v_product->>'peso_neto')::numeric, 0),
                upper(v_weight_unit),
                COALESCE((v_product->>'cantidad_empaque')::numeric, 0),
                upper(v_package_unit),
                upper(v_purchase_unit),
                upper(v_sales_unit),
                COALESCE((v_product->>'stock_minimo')::numeric, 0),
                COALESCE((v_product->>'stock_maximo')::numeric, 0),
                COALESCE((v_product->>'punto_reposicion')::numeric, 0),
                COALESCE((v_product->>'iva_porcentaje')::numeric, 19),
                COALESCE((v_product->>'perecible') IN ('SI', 'si', 'Si', 'TRUE', 'true', '1', 'YES', 'yes', 'Yes'), false),
                COALESCE((v_product->>'requiere_lote') IN ('SI', 'si', 'Si', 'TRUE', 'true', '1', 'YES', 'yes', 'Yes'), false),
                COALESCE((v_product->>'requiere_vencimiento') IN ('SI', 'si', 'Si', 'TRUE', 'true', '1', 'YES', 'yes', 'Yes'), false),
                CASE WHEN (v_product->>'observacion') IS NOT NULL AND trim(both ' ' from (v_product->>'observacion')) != '' THEN upper(trim(both ' ' from (v_product->>'observacion'))) ELSE NULL END,
                p_user_id,
                p_user_id,
                'ACTIVE',
                true
            );
            
            v_created_count := v_created_count + 1;
        EXCEPTION WHEN OTHERS THEN
            v_errors := v_errors || jsonb_build_array(jsonb_build_object('row', v_row_idx, 'message', SQLERRM));
        END;
    END LOOP;
    
    RETURN jsonb_build_object(
        'created', v_created_count,
        'omitted_sku', v_omitted_sku_count,
        'omitted_barcode', v_omitted_barcode_count,
        'omitted_duplicate_name', v_omitted_duplicate_name_count,
        'created_classifiers', v_created_classifiers_count,
        'errors', v_errors
    );
END;
$$;

-- 8.7 create_product_from_po
DROP FUNCTION IF EXISTS adquisiciones.create_product_from_po(jsonb, uuid);
CREATE OR REPLACE FUNCTION adquisiciones.create_product_from_po(p_data jsonb, p_user_id uuid, p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_sku varchar(50); v_product_id uuid;
BEGIN
    v_sku := upper(trim(p_data->>'sku'));
    IF v_sku IS NULL OR v_sku = '' THEN RETURN jsonb_build_object('success', false, 'error', 'SKU es obligatorio'); END IF;
    IF EXISTS (SELECT 1 FROM adquisiciones.products WHERE sku = v_sku AND company_id = p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'El SKU "' || v_sku || '" ya existe para esta empresa');
    END IF;
    INSERT INTO adquisiciones.products (company_id, sku, barcode, description, short_description, brand, category, subcategory, product_type, unit_of_measure, tax_rate, is_perishable, requires_lot, requires_expiration, notes, status, created_by)
    VALUES (p_company_id, v_sku, NULLIF(trim(COALESCE(p_data->>'barcode', '')),''), upper(trim(p_data->>'description')), upper(trim(COALESCE(p_data->>'short_description',''))), upper(trim(COALESCE(p_data->>'brand',''))), upper(trim(COALESCE(p_data->>'category',''))), upper(trim(COALESCE(p_data->>'subcategory',''))), upper(trim(COALESCE(p_data->>'product_type',''))), upper(trim(COALESCE(p_data->>'unit_of_measure',''))), COALESCE((p_data->>'tax_rate')::numeric, 19), COALESCE((p_data->>'is_perishable')::boolean, false), COALESCE((p_data->>'requires_lot')::boolean, false), COALESCE((p_data->>'requires_expiration')::boolean, false), p_data->>'notes', 'ACTIVE', p_user_id)
    RETURNING id INTO v_product_id;
    RETURN jsonb_build_object('success', true, 'product_id', v_product_id, 'sku', v_sku);
END;
$$;

-- 8.8 create_authorized_personnel
DROP FUNCTION IF EXISTS adquisiciones.create_authorized_personnel(jsonb, uuid);
CREATE OR REPLACE FUNCTION adquisiciones.create_authorized_personnel(p_data jsonb, p_user_id uuid, p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_id uuid; v_name varchar(200); v_normalized varchar(200);
BEGIN
    v_name := trim(p_data->>'full_name');
    v_normalized := upper(trim(regexp_replace(v_name, '\s+', ' ', 'g')));
    IF v_name IS NULL OR v_name = '' THEN RETURN jsonb_build_object('success', false, 'error', 'Nombre es obligatorio'); END IF;
    IF EXISTS (SELECT 1 FROM adquisiciones.authorized_personnel WHERE normalized_name = v_normalized AND is_active = true AND company_id = p_company_id) THEN
        SELECT id INTO v_id FROM adquisiciones.authorized_personnel WHERE normalized_name = v_normalized AND is_active = true AND company_id = p_company_id LIMIT 1;
        RETURN jsonb_build_object('success', false, 'error', 'Ya existe un autorizador con el nombre "' || v_name || '" para esta empresa', 'existing_id', v_id);
    END IF;
    INSERT INTO adquisiciones.authorized_personnel (company_id, full_name, normalized_name, position, email, phone, notes, created_by, updated_by)
    VALUES (p_company_id, v_name, v_normalized, trim(COALESCE(p_data->>'position', '')), trim(COALESCE(p_data->>'email', '')), trim(COALESCE(p_data->>'phone', '')), p_data->>'notes', p_user_id, p_user_id)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('success', true, 'id', v_id, 'full_name', v_name);
END;
$$;

-- 8.9 get_authorized_personnel_list
DROP FUNCTION IF EXISTS adquisiciones.get_authorized_personnel_list();
CREATE OR REPLACE FUNCTION adquisiciones.get_authorized_personnel_list(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE v_result jsonb;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', ap.id, 'full_name', ap.full_name, 'position', ap.position, 'email', ap.email) ORDER BY ap.full_name), '[]'::jsonb)
    INTO v_result
    FROM adquisiciones.authorized_personnel ap WHERE ap.is_active = true AND ap.company_id = p_company_id;
    RETURN v_result;
END;
$$;

-- 8.10 check_product_duplicates
DROP FUNCTION IF EXISTS adquisiciones.check_product_duplicates(jsonb);
CREATE OR REPLACE FUNCTION adquisiciones.check_product_duplicates(p_data jsonb, p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_sku varchar(50) := upper(trim(p_data->>'sku'));
    v_barcode varchar(100) := trim(COALESCE(p_data->>'barcode', ''));
    v_brand varchar(120) := upper(trim(COALESCE(p_data->>'brand', '')));
    v_description varchar(250) := upper(trim(COALESCE(p_data->>'description', '')));
    v_unit varchar(50) := upper(trim(COALESCE(p_data->>'unit', '')));
    v_warnings jsonb := '[]'::jsonb;
    v_dup record;
BEGIN
    IF v_sku != '' THEN
        SELECT id, sku, description INTO v_dup FROM adquisiciones.products WHERE sku = v_sku AND company_id = p_company_id LIMIT 1;
        IF FOUND THEN v_warnings := v_warnings || jsonb_build_object('type', 'SKU', 'message', 'El SKU "' || v_sku || '" ya existe para esta empresa', 'product_sku', v_dup.sku); END IF;
    END IF;
    IF v_barcode != '' THEN
        SELECT id, sku, barcode INTO v_dup FROM adquisiciones.products WHERE barcode = v_barcode AND company_id = p_company_id LIMIT 1;
        IF FOUND THEN v_warnings := v_warnings || jsonb_build_object('type', 'BARCODE', 'message', 'El código de barra "' || v_barcode || '" ya existe para esta empresa', 'product_sku', v_dup.sku); END IF;
    END IF;
    RETURN jsonb_build_object('warnings', v_warnings);
END;
$$;


-- 9. GRANTS Y NOTIFICACIONES
GRANT ALL ON ALL FUNCTIONS IN SCHEMA adquisiciones TO authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA core TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
