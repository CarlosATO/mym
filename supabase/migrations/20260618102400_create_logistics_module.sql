-- CREATE SCHEMA LOGISTICA
CREATE SCHEMA IF NOT EXISTS logistica;
GRANT USAGE ON SCHEMA logistica TO authenticated, service_role;

-- Register Logistics module in portal.modules
INSERT INTO portal.modules (code, name, description, icon, route, sort_order)
VALUES ('logistica', 'Logística', 'Módulo de recepción, ubicaciones, kardex y stock', 'Package', '/dashboard/logistica', 7)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name, description = EXCLUDED.description, icon = EXCLUDED.icon, route = EXCLUDED.route;

-- Register module permission
INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'module.logistica.view', 'Ver Logística', 'Acceso al módulo de Logística', id
FROM portal.modules WHERE code = 'logistica'
ON CONFLICT (code) DO NOTHING;

-- Grant to SUPER_USUARIO, GERENCIA, BODEGA
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r, portal.permissions p
WHERE r.name IN ('SUPER_USUARIO', 'GERENCIA', 'BODEGA') AND p.code = 'module.logistica.view'
AND NOT EXISTS (
    SELECT 1 FROM portal.role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- CREATE TABLES

-- 1. Locations Table
CREATE TABLE IF NOT EXISTS logistica.locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    warehouse_id uuid NOT NULL REFERENCES adquisiciones.warehouses(id) ON DELETE CASCADE,
    code varchar(50) NOT NULL,
    name varchar(100),
    aisle varchar(50),
    rack varchar(50),
    level varchar(50),
    position varchar(50),
    description text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id),
    CONSTRAINT uq_locations_company_warehouse_code UNIQUE (company_id, warehouse_id, code)
);

-- 2. Kardex Movements Table
CREATE TABLE IF NOT EXISTS logistica.kardex_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES adquisiciones.products(id) ON DELETE CASCADE,
    warehouse_id uuid NOT NULL REFERENCES adquisiciones.warehouses(id) ON DELETE CASCADE,
    location_id uuid REFERENCES logistica.locations(id) ON DELETE SET NULL,
    movement_type varchar(30) NOT NULL CHECK (movement_type IN ('IN', 'OUT', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT')),
    source_type varchar(50) NOT NULL CHECK (source_type IN ('PURCHASE_RECEIPT', 'ADJUSTMENT', 'TRANSFER')),
    source_id uuid NOT NULL,
    source_line_id uuid,
    quantity numeric(14,4) NOT NULL,
    unit_cost numeric(14,4),
    total_cost numeric(14,4),
    lot_number varchar(100),
    expiration_date date,
    movement_date timestamptz NOT NULL DEFAULT now(),
    notes text,
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Purchase Receipts Table
CREATE TABLE IF NOT EXISTS logistica.purchase_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    purchase_order_id uuid NOT NULL REFERENCES adquisiciones.purchase_orders(id) ON DELETE CASCADE,
    receipt_number varchar(50) NOT NULL,
    receiving_type varchar(30) NOT NULL CHECK (receiving_type IN ('WAREHOUSE', 'OFFICE')),
    warehouse_id uuid REFERENCES adquisiciones.warehouses(id) ON DELETE SET NULL,
    status varchar(30) NOT NULL CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED')),
    received_at timestamptz NOT NULL DEFAULT now(),
    received_by uuid REFERENCES portal.users(id),
    notes text,
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Purchase Receipt Items Table
CREATE TABLE IF NOT EXISTS logistica.purchase_receipt_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    receipt_id uuid NOT NULL REFERENCES logistica.purchase_receipts(id) ON DELETE CASCADE,
    purchase_order_item_id uuid NOT NULL REFERENCES adquisiciones.purchase_order_items(id) ON DELETE CASCADE,
    product_id uuid REFERENCES adquisiciones.products(id) ON DELETE SET NULL,
    service_description text,
    quantity_ordered numeric(14,4) NOT NULL,
    quantity_previously_received numeric(14,4) NOT NULL DEFAULT 0,
    quantity_received numeric(14,4) NOT NULL,
    quantity_pending_after numeric(14,4) NOT NULL,
    warehouse_id uuid REFERENCES adquisiciones.warehouses(id) ON DELETE SET NULL,
    location_id uuid REFERENCES logistica.locations(id) ON DELETE SET NULL,
    lot_number varchar(100),
    expiration_date date,
    notes text,
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 5. Receipt Documents Table
CREATE TABLE IF NOT EXISTS logistica.receipt_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    receipt_id uuid NOT NULL REFERENCES logistica.purchase_receipts(id) ON DELETE CASCADE,
    document_type varchar(30) NOT NULL CHECK (document_type IN ('GD', 'FA', 'EVIDENCIA', 'OTRO')),
    document_number varchar(100),
    file_url text,
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS AND GRANTS
ALTER TABLE logistica.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.kardex_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.purchase_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.purchase_receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.receipt_documents ENABLE ROW LEVEL SECURITY;

GRANT ALL ON ALL TABLES IN SCHEMA logistica TO authenticated, service_role;

-- POLICIES USING HAS_COMPANY_ACCESS
CREATE POLICY rls_locations_select ON logistica.locations FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_locations_insert ON logistica.locations FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_locations_update ON logistica.locations FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id))
    WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_kardex_select ON logistica.kardex_movements FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_kardex_insert ON logistica.kardex_movements FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_receipts_select ON logistica.purchase_receipts FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_receipts_insert ON logistica.purchase_receipts FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_receipt_items_select ON logistica.purchase_receipt_items FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_receipt_items_insert ON logistica.purchase_receipt_items FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_receipt_docs_select ON logistica.receipt_documents FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_receipt_docs_insert ON logistica.receipt_documents FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

-- DATABASE helper function for receipt process (SECURITY DEFINER)
CREATE OR REPLACE FUNCTION logistica.create_purchase_receipt_db(
    p_company_id uuid,
    p_purchase_order_id uuid,
    p_receiving_type text,
    p_warehouse_id uuid,
    p_notes text,
    p_items jsonb,
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_receipt_id uuid;
    v_receipt_number text;
    v_item record;
    v_locations_count integer;
    v_po_status text;
    v_has_pending boolean;
    v_po_company_id uuid;
BEGIN
    -- 1. Check PO company and status
    SELECT company_id, status INTO v_po_company_id, v_po_status
    FROM adquisiciones.purchase_orders
    WHERE id = p_purchase_order_id;

    IF v_po_company_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Orden de Compra no encontrada');
    END IF;

    IF v_po_company_id <> p_company_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'La Orden de Compra pertenece a otra empresa');
    END IF;

    IF v_po_status NOT IN ('EMITIDA', 'RECEPCION_PARCIAL') THEN
        RETURN jsonb_build_object('success', false, 'error', 'La Orden de Compra no está en un estado válido para recepción (Debe ser EMITIDA o RECEPCION_PARCIAL)');
    END IF;

    -- 2. Generate receipt number
    SELECT COALESCE(COUNT(*), 0) + 1 INTO v_locations_count
    FROM logistica.purchase_receipts
    WHERE company_id = p_company_id;

    v_receipt_number := 'REC-' || LPAD(v_locations_count::text, 6, '0');

    -- 3. Insert Purchase Receipt
    INSERT INTO logistica.purchase_receipts (
        company_id,
        purchase_order_id,
        receipt_number,
        receiving_type,
        warehouse_id,
        status,
        notes,
        created_by
    )
    VALUES (
        p_company_id,
        p_purchase_order_id,
        v_receipt_number,
        p_receiving_type,
        CASE WHEN p_receiving_type = 'WAREHOUSE' THEN p_warehouse_id ELSE NULL END,
        'COMPLETED',
        p_notes,
        p_user_id
    )
    RETURNING id INTO v_receipt_id;

    -- 4. Process items
    FOR v_item IN 
        SELECT 
            (value->>'purchase_order_item_id')::uuid AS po_item_id,
            (value->>'quantity_received')::numeric AS qty_rec,
            (value->>'location_id')::uuid AS loc_id,
            value->>'lot_number' AS lot,
            (value->>'expiration_date')::date AS exp_date,
            value->>'notes' AS note
        FROM jsonb_array_elements(p_items)
    LOOP
        -- Skip items with 0 received quantity
        IF v_item.qty_rec <= 0 THEN
            CONTINUE;
        END IF;

        -- Retrieve PO item details
        DECLARE
            v_po_item_type varchar;
            v_product_id uuid;
            v_quantity_ordered numeric;
            v_quantity_prev_received numeric;
            v_quantity_pending numeric;
            v_service_desc text;
            v_unit_price numeric;
            v_po_item_wh uuid;
        BEGIN
            SELECT 
                item_type, product_id, product_description, quantity, quantity_received, quantity_pending, unit_price, warehouse_id
            INTO 
                v_po_item_type, v_product_id, v_service_desc, v_quantity_ordered, v_quantity_prev_received, v_quantity_pending, v_unit_price, v_po_item_wh
            FROM 
                adquisiciones.purchase_order_items
            WHERE 
                id = v_item.po_item_id AND purchase_order_id = p_purchase_order_id;

            IF v_po_item_type IS NULL THEN
                RAISE EXCEPTION 'Línea de Orden de Compra % no encontrada', v_item.po_item_id;
            END IF;

            IF v_item.qty_rec > v_quantity_pending THEN
                RAISE EXCEPTION 'No se puede recibir una cantidad mayor a la pendiente para el producto %. Máximo pendiente: %', v_service_desc, v_quantity_pending;
            END IF;

            -- Validate location for WAREHOUSE receiving of PRODUCTs
            IF p_receiving_type = 'WAREHOUSE' AND v_po_item_type = 'PRODUCT' THEN
                IF v_item.loc_id IS NULL THEN
                    RAISE EXCEPTION 'Se requiere ubicación para recibir el producto: %', v_service_desc;
                END IF;

                -- Check location belongs to active company and warehouse
                IF NOT EXISTS (
                    SELECT 1 FROM logistica.locations
                    WHERE id = v_item.loc_id AND company_id = p_company_id AND warehouse_id = COALESCE(v_po_item_wh, p_warehouse_id)
                ) THEN
                    RAISE EXCEPTION 'La ubicación no existe, pertenece a otra empresa o no corresponde al almacén de recepción';
                END IF;
            END IF;

            -- Insert into purchase_receipt_items
            INSERT INTO logistica.purchase_receipt_items (
                company_id,
                receipt_id,
                purchase_order_item_id,
                product_id,
                service_description,
                quantity_ordered,
                quantity_previously_received,
                quantity_received,
                quantity_pending_after,
                warehouse_id,
                location_id,
                lot_number,
                expiration_date,
                notes,
                created_by
            )
            VALUES (
                p_company_id,
                v_receipt_id,
                v_item.po_item_id,
                v_product_id,
                v_service_desc,
                v_quantity_ordered,
                v_quantity_prev_received,
                v_item.qty_rec,
                v_quantity_pending - v_item.qty_rec,
                CASE WHEN v_po_item_type = 'PRODUCT' THEN COALESCE(v_po_item_wh, p_warehouse_id) ELSE NULL END,
                CASE WHEN p_receiving_type = 'WAREHOUSE' AND v_po_item_type = 'PRODUCT' THEN v_item.loc_id ELSE NULL END,
                CASE WHEN v_po_item_type = 'PRODUCT' THEN v_item.lot ELSE NULL END,
                CASE WHEN v_po_item_type = 'PRODUCT' THEN v_item.exp_date ELSE NULL END,
                v_item.note,
                p_user_id
            );

            -- Generate Kardex Movement for WAREHOUSE items (PRODUCT only)
            IF p_receiving_type = 'WAREHOUSE' AND v_po_item_type = 'PRODUCT' THEN
                INSERT INTO logistica.kardex_movements (
                    company_id,
                    product_id,
                    warehouse_id,
                    location_id,
                    movement_type,
                    source_type,
                    source_id,
                    source_line_id,
                    quantity,
                    unit_cost,
                    total_cost,
                    lot_number,
                    expiration_date,
                    notes,
                    created_by
                )
                VALUES (
                    p_company_id,
                    v_product_id,
                    COALESCE(v_po_item_wh, p_warehouse_id),
                    v_item.loc_id,
                    'IN',
                    'PURCHASE_RECEIPT',
                    v_receipt_id,
                    v_item.po_item_id,
                    v_item.qty_rec,
                    v_unit_price,
                    v_item.qty_rec * v_unit_price,
                    v_item.lot,
                    v_item.exp_date,
                    v_item.note,
                    p_user_id
                );
            END IF;

            -- Update quantity_received on purchase_order_items
            UPDATE adquisiciones.purchase_order_items
            SET quantity_received = quantity_received + v_item.qty_rec
            WHERE id = v_item.po_item_id;

        END;
    END LOOP;

    -- 5. Check PO reception completion
    SELECT EXISTS (
        SELECT 1 FROM adquisiciones.purchase_order_items
        WHERE purchase_order_id = p_purchase_order_id AND quantity_pending > 0
    ) INTO v_has_pending;

    -- Update PO status
    IF v_has_pending THEN
        UPDATE adquisiciones.purchase_orders
        SET status = 'RECEPCION_PARCIAL', receipt_status = 'RECEPCION_PARCIAL'
        WHERE id = p_purchase_order_id;

        -- Log status history
        INSERT INTO adquisiciones.purchase_order_status_history (po_id, from_status, to_status, changed_by, reason)
        VALUES (p_purchase_order_id, v_po_status, 'RECEPCION_PARCIAL', p_user_id, 'Recepción parcial registrada - N° ' || v_receipt_number);
    ELSE
        UPDATE adquisiciones.purchase_orders
        SET status = 'RECEPCION_TOTAL', receipt_status = 'RECEPCION_TOTAL'
        WHERE id = p_purchase_order_id;

        -- Log status history
        INSERT INTO adquisiciones.purchase_order_status_history (po_id, from_status, to_status, changed_by, reason)
        VALUES (p_purchase_order_id, v_po_status, 'RECEPCION_TOTAL', p_user_id, 'Recepción total registrada - N° ' || v_receipt_number);
    END IF;

    RETURN jsonb_build_object('success', true, 'receipt_id', v_receipt_id, 'receipt_number', v_receipt_number);
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION logistica.create_purchase_receipt_db(uuid, uuid, text, uuid, text, jsonb, uuid) TO authenticated, service_role;
