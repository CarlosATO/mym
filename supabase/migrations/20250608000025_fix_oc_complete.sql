-- ============================================================
-- FIX COMPLETO: Tablas y RPCs para Órdenes de Compra
-- La migración original 20250608000001 falló por un error de
-- variable (v_supplier_warehouse_id vs v_supplier_worker_id)
-- Esta migración es idempotente y recupera todo lo necesario.
-- ============================================================

-- ============================================================
-- 1. TABLAS
-- ============================================================

CREATE TABLE IF NOT EXISTS adquisiciones.authorized_personnel (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name varchar(200) NOT NULL,
    normalized_name varchar(200) NOT NULL,
    position varchar(200),
    email varchar(200),
    phone varchar(50),
    is_active boolean DEFAULT true,
    notes text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    created_by uuid REFERENCES portal.users(id),
    updated_by uuid REFERENCES portal.users(id)
);

CREATE INDEX IF NOT EXISTS idx_ap_normalized_name ON adquisiciones.authorized_personnel (normalized_name);
CREATE INDEX IF NOT EXISTS idx_ap_is_active ON adquisiciones.authorized_personnel (is_active);

DO $$ BEGIN
    ALTER TABLE adquisiciones.authorized_personnel ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'rls_authorized_personnel_select') THEN
        CREATE POLICY rls_authorized_personnel_select ON adquisiciones.authorized_personnel
            FOR SELECT TO authenticated USING (portal.has_permission('system.admin') OR portal.has_permission('module.adquisiciones.view'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'rls_authorized_personnel_insert') THEN
        CREATE POLICY rls_authorized_personnel_insert ON adquisiciones.authorized_personnel
            FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.po.create'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'rls_authorized_personnel_update') THEN
        CREATE POLICY rls_authorized_personnel_update ON adquisiciones.authorized_personnel
            FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.po.update'));
    END IF;
END $$;

GRANT ALL ON adquisiciones.authorized_personnel TO authenticated, service_role;

-- purchase_orders
CREATE TABLE IF NOT EXISTS adquisiciones.purchase_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    correlative varchar(30) NOT NULL,
    issue_date date NOT NULL DEFAULT CURRENT_DATE,
    required_date date,
    supplier_id uuid NOT NULL REFERENCES adquisiciones.suppliers(id),
    warehouse_id uuid REFERENCES adquisiciones.warehouses(id),
    po_type varchar(20) NOT NULL DEFAULT 'PRODUCTOS' CHECK (po_type IN ('PRODUCTOS','SERVICIOS','MIXTA')),
    currency varchar(10) DEFAULT 'CLP',
    payment_terms varchar(200),
    requested_by uuid NOT NULL REFERENCES portal.users(id),
    authorized_by uuid REFERENCES adquisiciones.authorized_personnel(id),
    notes text,
    net_total numeric(14,2) DEFAULT 0,
    discount_total numeric(14,2) DEFAULT 0,
    tax_total numeric(14,2) DEFAULT 0,
    exempt_total numeric(14,2) DEFAULT 0,
    grand_total numeric(14,2) DEFAULT 0,
    status varchar(30) NOT NULL DEFAULT 'BORRADOR',
    receipt_status varchar(30) DEFAULT 'PENDIENTE',
    invoice_status varchar(30) DEFAULT 'PENDIENTE',
    email_sent_at timestamptz,
    email_sent_by uuid REFERENCES portal.users(id),
    supplier_email_snapshot varchar(200),
    cancel_reason text,
    cancelled_at timestamptz,
    cancelled_by uuid REFERENCES portal.users(id),
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    created_by uuid REFERENCES portal.users(id),
    updated_by uuid REFERENCES portal.users(id)
);

DO $$ BEGIN
    ALTER TABLE adquisiciones.purchase_orders ADD CONSTRAINT chk_po_status CHECK (
        status IN ('BORRADOR','PENDIENTE_APROBACION','APROBADA','ENVIADA_PROVEEDOR',
                   'RECEPCION_PARCIAL','RECEPCION_TOTAL','FACTURADA_PARCIAL',
                   'FACTURADA_TOTAL','CERRADA','CANCELADA','RECHAZADA')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE adquisiciones.purchase_orders ADD CONSTRAINT chk_po_receipt CHECK (receipt_status IN ('PENDIENTE','RECEPCION_PARCIAL','RECEPCION_TOTAL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE adquisiciones.purchase_orders ADD CONSTRAINT chk_po_invoice CHECK (invoice_status IN ('PENDIENTE','FACTURADA_PARCIAL','FACTURADA_TOTAL','PAGADA'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_po_correlative ON adquisiciones.purchase_orders (correlative);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON adquisiciones.purchase_orders (supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON adquisiciones.purchase_orders (status);
CREATE INDEX IF NOT EXISTS idx_po_issue_date ON adquisiciones.purchase_orders (issue_date);
CREATE INDEX IF NOT EXISTS idx_po_created_at ON adquisiciones.purchase_orders (created_at);

-- purchase_order_items
CREATE TABLE IF NOT EXISTS adquisiciones.purchase_order_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id uuid NOT NULL REFERENCES adquisiciones.purchase_orders(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    item_type varchar(20) NOT NULL DEFAULT 'PRODUCT' CHECK (item_type IN ('PRODUCT','SERVICE')),
    product_id uuid REFERENCES adquisiciones.products(id),
    product_description varchar(500) NOT NULL,
    unit varchar(50),
    quantity numeric(14,4) NOT NULL DEFAULT 1,
    unit_price numeric(14,4) NOT NULL DEFAULT 0,
    discount_percent numeric(5,2) DEFAULT 0,
    discount_amount numeric(14,2) DEFAULT 0,
    tax_rate numeric(5,2) DEFAULT 19,
    tax_amount numeric(14,2) DEFAULT 0,
    line_total numeric(14,2) DEFAULT 0,
    warehouse_id uuid REFERENCES adquisiciones.warehouses(id),
    cost_center varchar(100),
    required_date date,
    notes text,
    quantity_received numeric(14,4) DEFAULT 0,
    quantity_pending numeric(14,4) GENERATED ALWAYS AS (quantity - quantity_received) STORED,
    lot_number varchar(100),
    expiration_date date,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    created_by uuid REFERENCES portal.users(id),
    updated_by uuid REFERENCES portal.users(id)
);

CREATE INDEX IF NOT EXISTS idx_poi_po_id ON adquisiciones.purchase_order_items (po_id);
CREATE INDEX IF NOT EXISTS idx_poi_product ON adquisiciones.purchase_order_items (product_id);

-- purchase_order_status_history
CREATE TABLE IF NOT EXISTS adquisiciones.purchase_order_status_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id uuid NOT NULL REFERENCES adquisiciones.purchase_orders(id) ON DELETE CASCADE,
    from_status varchar(30),
    to_status varchar(30) NOT NULL,
    changed_by uuid REFERENCES portal.users(id),
    reason text,
    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_posh_po_id ON adquisiciones.purchase_order_status_history (po_id);

-- supplier_price_agreements
CREATE TABLE IF NOT EXISTS adquisiciones.supplier_price_agreements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id uuid NOT NULL REFERENCES adquisiciones.suppliers(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES adquisiciones.products(id) ON DELETE CASCADE,
    agreed_price numeric(14,4) NOT NULL,
    discount_percent numeric(5,2) DEFAULT 0,
    currency varchar(10) DEFAULT 'CLP',
    valid_from date NOT NULL,
    valid_until date,
    is_active boolean DEFAULT true,
    notes text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    created_by uuid REFERENCES portal.users(id),
    updated_by uuid REFERENCES portal.users(id)
);

CREATE INDEX IF NOT EXISTS idx_spa_supplier ON adquisiciones.supplier_price_agreements (supplier_id);
CREATE INDEX IF NOT EXISTS idx_spa_product ON adquisiciones.supplier_price_agreements (product_id);

-- purchase_order_documents
CREATE TABLE IF NOT EXISTS adquisiciones.purchase_order_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id uuid NOT NULL REFERENCES adquisiciones.purchase_orders(id) ON DELETE CASCADE,
    document_type varchar(50) NOT NULL CHECK (document_type IN ('GUIDE','INVOICE','RECEIPT','OTHER')),
    document_number varchar(100),
    file_url text,
    notes text,
    uploaded_by uuid REFERENCES portal.users(id),
    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pod_po_id ON adquisiciones.purchase_order_documents (po_id);

-- ============================================================
-- 2. RLS POLICIES for all PO tables
-- ============================================================

DO $$ BEGIN
    ALTER TABLE adquisiciones.purchase_orders ENABLE ROW LEVEL SECURITY;
    ALTER TABLE adquisiciones.purchase_order_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE adquisiciones.purchase_order_status_history ENABLE ROW LEVEL SECURITY;
    ALTER TABLE adquisiciones.supplier_price_agreements ENABLE ROW LEVEL SECURITY;
    ALTER TABLE adquisiciones.purchase_order_documents ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'rls_po_select') THEN
        CREATE POLICY rls_po_select ON adquisiciones.purchase_orders FOR SELECT TO authenticated USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.po.view'));
        CREATE POLICY rls_po_insert ON adquisiciones.purchase_orders FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.po.create'));
        CREATE POLICY rls_po_update ON adquisiciones.purchase_orders FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.po.update')) WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.po.update'));
        CREATE POLICY rls_poi_select ON adquisiciones.purchase_order_items FOR SELECT TO authenticated USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.po.view'));
        CREATE POLICY rls_poi_insert ON adquisiciones.purchase_order_items FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.po.create'));
        CREATE POLICY rls_poi_update ON adquisiciones.purchase_order_items FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.po.update')) WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.po.update'));
        CREATE POLICY rls_posh_select ON adquisiciones.purchase_order_status_history FOR SELECT TO authenticated USING (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.po.view'));
        CREATE POLICY rls_posh_insert ON adquisiciones.purchase_order_status_history FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.po.create'));
    END IF;
END $$;

-- ============================================================
-- 3. GRANTS
-- ============================================================

GRANT ALL ON adquisiciones.purchase_orders TO authenticated, service_role;
GRANT ALL ON adquisiciones.purchase_order_items TO authenticated, service_role;
GRANT ALL ON adquisiciones.purchase_order_status_history TO authenticated, service_role;
GRANT ALL ON adquisiciones.supplier_price_agreements TO authenticated, service_role;
GRANT ALL ON adquisiciones.purchase_order_documents TO authenticated, service_role;

-- ============================================================
-- 4. RPCs
-- ============================================================

-- generate_po_correlative
CREATE OR REPLACE FUNCTION adquisiciones.generate_po_correlative()
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
    WHERE correlative LIKE 'OC-' || v_year || '-%';
    v_corr := 'OC-' || v_year || '-' || LPAD(v_seq::text, 6, '0');
    RETURN v_corr;
END;
$$;

-- create_purchase_order
CREATE OR REPLACE FUNCTION adquisiciones.create_purchase_order(
    p_data jsonb,
    p_user_id uuid
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
    v_corr := adquisiciones.generate_po_correlative();

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
        correlative, issue_date, required_date, supplier_id, warehouse_id,
        po_type, currency, payment_terms, requested_by, authorized_by,
        notes, net_total, discount_total, tax_total, exempt_total, grand_total,
        status, receipt_status, invoice_status, created_by, updated_by
    ) VALUES (
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
            po_id, line_number, item_type, product_id, product_description,
            unit, quantity, unit_price, discount_percent, discount_amount,
            tax_rate, tax_amount, line_total, warehouse_id, cost_center,
            required_date, notes, created_by, updated_by
        ) VALUES (
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

    INSERT INTO adquisiciones.purchase_order_status_history (po_id, from_status, to_status, changed_by)
    VALUES (v_po_id, NULL, 'BORRADOR', p_user_id);

    RETURN jsonb_build_object('success', true, 'po_id', v_po_id, 'correlative', v_corr);
END;
$$;

-- get_purchase_orders
CREATE OR REPLACE FUNCTION adquisiciones.get_purchase_orders(p_filters jsonb DEFAULT '{}'::jsonb)
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
        WHERE po.is_active = true
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

-- get_purchase_order_detail
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
        'created_at', po.created_at, 'updated_at', po.updated_at
    ) INTO v_po
    FROM adquisiciones.purchase_orders po
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

-- update_purchase_order_status
CREATE OR REPLACE FUNCTION adquisiciones.update_purchase_order_status(
    p_po_id uuid, p_new_status text, p_reason text DEFAULT NULL, p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_old_status text;
    v_user uuid;
BEGIN
    v_user := COALESCE(p_user_id, auth.uid());
    SELECT status INTO v_old_status FROM adquisiciones.purchase_orders WHERE id = p_po_id;
    IF v_old_status IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'OC no encontrada');
    END IF;
    IF NOT (
        (v_old_status = 'BORRADOR' AND p_new_status IN ('PENDIENTE_APROBACION','CANCELADA')) OR
        (v_old_status = 'PENDIENTE_APROBACION' AND p_new_status IN ('APROBADA','RECHAZADA','CANCELADA')) OR
        (v_old_status = 'APROBADA' AND p_new_status IN ('ENVIADA_PROVEEDOR','CANCELADA')) OR
        (v_old_status = 'ENVIADA_PROVEEDOR' AND p_new_status IN ('RECEPCION_PARCIAL','RECEPCION_TOTAL','CANCELADA')) OR
        (v_old_status = 'RECEPCION_PARCIAL' AND p_new_status IN ('RECEPCION_TOTAL','CANCELADA')) OR
        (v_old_status = 'RECEPCION_TOTAL' AND p_new_status IN ('FACTURADA_PARCIAL','FACTURADA_TOTAL','CERRADA')) OR
        (v_old_status = 'FACTURADA_PARCIAL' AND p_new_status IN ('FACTURADA_TOTAL','CERRADA')) OR
        (v_old_status = 'FACTURADA_TOTAL' AND p_new_status IN ('CERRADA','PAGADA'))
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida: ' || v_old_status || ' → ' || p_new_status);
    END IF;
    IF p_new_status = 'CANCELADA' THEN
        UPDATE adquisiciones.purchase_orders SET status = p_new_status, cancel_reason = p_reason, cancelled_at = now(), cancelled_by = v_user, updated_by = v_user WHERE id = p_po_id;
    ELSE
        UPDATE adquisiciones.purchase_orders SET status = p_new_status, updated_by = v_user WHERE id = p_po_id;
    END IF;
    INSERT INTO adquisiciones.purchase_order_status_history (po_id, from_status, to_status, changed_by, reason)
    VALUES (p_po_id, v_old_status, p_new_status, v_user, p_reason);
    RETURN jsonb_build_object('success', true);
END;
$$;

-- create_product_from_po
CREATE OR REPLACE FUNCTION adquisiciones.create_product_from_po(p_data jsonb, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_sku varchar(50); v_product_id uuid;
BEGIN
    v_sku := upper(trim(p_data->>'sku'));
    IF v_sku IS NULL OR v_sku = '' THEN RETURN jsonb_build_object('success', false, 'error', 'SKU es obligatorio'); END IF;
    IF EXISTS (SELECT 1 FROM adquisiciones.products WHERE sku = v_sku) THEN
        RETURN jsonb_build_object('success', false, 'error', 'El SKU "' || v_sku || '" ya existe');
    END IF;
    INSERT INTO adquisiciones.products (sku, barcode, description, short_description, brand, category, subcategory, product_type, unit_of_measure, tax_rate, is_perishable, requires_lot, requires_expiration, notes, status, created_by)
    VALUES (v_sku, NULLIF(trim(COALESCE(p_data->>'barcode', '')),''), upper(trim(p_data->>'description')), upper(trim(COALESCE(p_data->>'short_description',''))), upper(trim(COALESCE(p_data->>'brand',''))), upper(trim(COALESCE(p_data->>'category',''))), upper(trim(COALESCE(p_data->>'subcategory',''))), upper(trim(COALESCE(p_data->>'product_type',''))), upper(trim(COALESCE(p_data->>'unit_of_measure',''))), COALESCE((p_data->>'tax_rate')::numeric, 19), COALESCE((p_data->>'is_perishable')::boolean, false), COALESCE((p_data->>'requires_lot')::boolean, false), COALESCE((p_data->>'requires_expiration')::boolean, false), p_data->>'notes', 'ACTIVE', p_user_id)
    RETURNING id INTO v_product_id;
    RETURN jsonb_build_object('success', true, 'product_id', v_product_id, 'sku', v_sku);
END;
$$;

-- create_authorized_personnel
CREATE OR REPLACE FUNCTION adquisiciones.create_authorized_personnel(p_data jsonb, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_id uuid; v_name varchar(200); v_normalized varchar(200);
BEGIN
    v_name := trim(p_data->>'full_name');
    v_normalized := upper(trim(regexp_replace(v_name, '\s+', ' ', 'g')));
    IF v_name IS NULL OR v_name = '' THEN RETURN jsonb_build_object('success', false, 'error', 'Nombre es obligatorio'); END IF;
    IF EXISTS (SELECT 1 FROM adquisiciones.authorized_personnel WHERE normalized_name = v_normalized AND is_active = true) THEN
        SELECT id INTO v_id FROM adquisiciones.authorized_personnel WHERE normalized_name = v_normalized AND is_active = true LIMIT 1;
        RETURN jsonb_build_object('success', false, 'error', 'Ya existe un autorizador con el nombre "' || v_name || '"', 'existing_id', v_id);
    END IF;
    INSERT INTO adquisiciones.authorized_personnel (full_name, normalized_name, position, email, phone, notes, created_by, updated_by)
    VALUES (v_name, v_normalized, trim(COALESCE(p_data->>'position', '')), trim(COALESCE(p_data->>'email', '')), trim(COALESCE(p_data->>'phone', '')), p_data->>'notes', p_user_id, p_user_id)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('success', true, 'id', v_id, 'full_name', v_name);
END;
$$;

-- get_authorized_personnel_list
CREATE OR REPLACE FUNCTION adquisiciones.get_authorized_personnel_list()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE v_result jsonb;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', ap.id, 'full_name', ap.full_name, 'position', ap.position, 'email', ap.email) ORDER BY ap.full_name), '[]'::jsonb)
    INTO v_result
    FROM adquisiciones.authorized_personnel ap WHERE ap.is_active = true;
    RETURN v_result;
END;
$$;

-- check_product_duplicates
CREATE OR REPLACE FUNCTION adquisiciones.check_product_duplicates(p_data jsonb)
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
        SELECT id, sku, description INTO v_dup FROM adquisiciones.products WHERE sku = v_sku LIMIT 1;
        IF FOUND THEN v_warnings := v_warnings || jsonb_build_object('type', 'SKU', 'message', 'El SKU "' || v_sku || '" ya existe', 'product_sku', v_dup.sku); END IF;
    END IF;
    IF v_barcode != '' THEN
        SELECT id, sku, barcode INTO v_dup FROM adquisiciones.products WHERE barcode = v_barcode LIMIT 1;
        IF FOUND THEN v_warnings := v_warnings || jsonb_build_object('type', 'BARCODE', 'message', 'El código de barra "' || v_barcode || '" ya existe', 'product_sku', v_dup.sku); END IF;
    END IF;
    RETURN jsonb_build_object('warnings', v_warnings);
END;
$$;

-- get_next_correlative_display
CREATE OR REPLACE FUNCTION adquisiciones.get_next_correlative_display()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN adquisiciones.generate_po_correlative();
END;
$$;

-- ============================================================
-- 5. TRIGGERS DE AUDITORÍA
-- ============================================================

CREATE OR REPLACE FUNCTION adquisiciones.trg_purchase_orders_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id uuid; v_severity varchar;
BEGIN
    v_user_id := COALESCE(NEW.updated_by, auth.uid());
    v_severity := CASE WHEN TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM NEW.status) THEN 'CRITICAL' ELSE 'INFO' END;
    IF TG_OP = 'INSERT' THEN
        INSERT INTO portal.audit_logs (schema_name,module_code,table_name,record_id,action,new_data,performed_by,event_type,severity)
        VALUES ('adquisiciones','ADQUISICIONES',TG_TABLE_NAME,NEW.id,'INSERT',row_to_json(NEW)::jsonb,v_user_id,'purchase_orders_INSERT','INFO');
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO portal.audit_logs (schema_name,module_code,table_name,record_id,action,old_data,new_data,performed_by,event_type,severity)
        VALUES ('adquisiciones','ADQUISICIONES',TG_TABLE_NAME,NEW.id,'UPDATE',row_to_json(OLD)::jsonb,row_to_json(NEW)::jsonb,v_user_id,'purchase_orders_UPDATE',v_severity);
        RETURN NEW;
    END IF;
END;
$$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_purchase_orders_audit') THEN
        CREATE TRIGGER trg_purchase_orders_audit AFTER INSERT OR UPDATE ON adquisiciones.purchase_orders
            FOR EACH ROW EXECUTE FUNCTION adquisiciones.trg_purchase_orders_audit();
    END IF;
END $$;

-- ============================================================
-- 6. PERMISOS
-- ============================================================

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.po.view', 'Ver Órdenes de Compra', 'Ver listado y detalle de OC', id
FROM portal.modules WHERE code = 'adquisiciones' AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.po.view');

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.po.create', 'Crear Órdenes de Compra', 'Crear nuevas OC', id
FROM portal.modules WHERE code = 'adquisiciones' AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.po.create');

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.po.update', 'Editar Órdenes de Compra', 'Editar OC existentes', id
FROM portal.modules WHERE code = 'adquisiciones' AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.po.update');

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.po.cancel', 'Cancelar Órdenes de Compra', 'Cancelar OC', id
FROM portal.modules WHERE code = 'adquisiciones' AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.po.cancel');

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM portal.roles r, portal.permissions p
WHERE r.name = 'SUPER_USUARIO' AND p.code LIKE 'adquisiciones.po.%'
AND NOT EXISTS (SELECT 1 FROM portal.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM portal.roles r, portal.permissions p
WHERE r.name = 'GERENCIA' AND p.code IN ('adquisiciones.po.view','adquisiciones.po.create')
AND NOT EXISTS (SELECT 1 FROM portal.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM portal.roles r, portal.permissions p
WHERE r.name = 'FINANZAS' AND p.code IN ('adquisiciones.po.view','adquisiciones.po.cancel')
AND NOT EXISTS (SELECT 1 FROM portal.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM portal.roles r, portal.permissions p
WHERE r.name = 'BODEGA' AND p.code = 'adquisiciones.po.view'
AND NOT EXISTS (SELECT 1 FROM portal.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- ============================================================
-- 7. GRANTS PARA RPCs
-- ============================================================

GRANT EXECUTE ON FUNCTION adquisiciones.generate_po_correlative() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.create_purchase_order(jsonb, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_purchase_orders(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_purchase_order_detail(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.update_purchase_order_status(uuid, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.create_product_from_po(jsonb, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.create_authorized_personnel(jsonb, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.check_product_duplicates(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_authorized_personnel_list() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_next_correlative_display() TO authenticated, service_role;

-- ============================================================
-- 8. RECARGAR SCHEMA CACHE DE PostgREST
-- ============================================================

NOTIFY pgrst, 'reload schema';
