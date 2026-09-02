-- Add formal origin tracking to purchase orders without changing existing callers.
ALTER TABLE adquisiciones.purchase_orders
  ADD COLUMN IF NOT EXISTS source_type text DEFAULT 'MANUAL';

UPDATE adquisiciones.purchase_orders
SET source_type = 'MANUAL'
WHERE source_type IS NULL;

ALTER TABLE adquisiciones.purchase_orders
  ALTER COLUMN source_type SET DEFAULT 'MANUAL',
  ALTER COLUMN source_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'purchase_orders_source_type_check'
      AND conrelid = 'adquisiciones.purchase_orders'::regclass
  ) THEN
    ALTER TABLE adquisiciones.purchase_orders
      ADD CONSTRAINT purchase_orders_source_type_check
      CHECK (source_type IN ('MANUAL', 'REPLENISHMENT'));
  END IF;
END $$;

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
    v_initial_status varchar(30);
    v_source_type text;
BEGIN
    IF NOT core.has_company_access(p_user_id, p_company_id) AND NOT portal.has_permission('system.admin') THEN
        RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a la empresa especificada');
    END IF;

    v_initial_status := COALESCE(p_data->>'status', 'EMITIDA');
    IF v_initial_status NOT IN ('BORRADOR', 'EMITIDA') THEN
        RETURN jsonb_build_object('success', false, 'error', 'El estado inicial de la OC debe ser BORRADOR o EMITIDA.');
    END IF;

    v_source_type := COALESCE(p_data->>'source_type', 'MANUAL');
    IF v_source_type NOT IN ('MANUAL', 'REPLENISHMENT') THEN
        RETURN jsonb_build_object('success', false, 'error', 'El origen de la OC debe ser MANUAL o REPLENISHMENT.');
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
        notes, source_type, net_total, discount_total, tax_total, exempt_total, grand_total,
        status, receipt_status, invoice_status, created_by, updated_by
    ) VALUES (
        p_company_id, v_corr, CURRENT_DATE, (p_data->>'required_date')::date,
        (p_data->>'supplier_id')::uuid, v_wh_id, v_po_type,
        COALESCE(p_data->>'currency', 'CLP'), p_data->>'payment_terms', p_user_id,
        (p_data->>'authorized_by')::uuid, p_data->>'notes', v_source_type,
        0, 0, 0, 0, 0, v_initial_status, 'PENDIENTE', 'PENDIENTE', p_user_id, p_user_id
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
            p_company_id, v_po_id, v_line_num, v_item->>'item_type',
            (v_item->>'product_id')::uuid, v_item->>'product_description', v_item->>'unit',
            (v_item->>'quantity')::numeric, (v_item->>'unit_price')::numeric,
            COALESCE((v_item->>'discount_percent')::numeric, 0), v_line_disc,
            COALESCE((v_item->>'tax_rate')::numeric, 19), v_line_tax,
            v_line_total - v_line_disc + v_line_tax,
            COALESCE((v_item->>'warehouse_id')::uuid, v_wh_id), v_item->>'cost_center',
            (v_item->>'required_date')::date, v_item->>'notes', p_user_id, p_user_id
        );

        v_net := v_net + (v_line_total - v_line_disc);
        v_disc := v_disc + v_line_disc;
        v_tax := v_tax + v_line_tax;
    END LOOP;

    v_total := v_net + v_tax;

    UPDATE adquisiciones.purchase_orders SET
        net_total = ROUND(v_net, 2), discount_total = ROUND(v_disc, 2),
        tax_total = ROUND(v_tax, 2), exempt_total = ROUND(v_exempt, 2),
        grand_total = ROUND(v_total, 2), updated_by = p_user_id
    WHERE id = v_po_id;

    INSERT INTO adquisiciones.purchase_order_status_history (company_id, po_id, from_status, to_status, changed_by)
    VALUES (p_company_id, v_po_id, NULL, v_initial_status, p_user_id);

    RETURN jsonb_build_object('success', true, 'po_id', v_po_id, 'correlative', v_corr);
END;
$$;

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
        'required_date', po.required_date, 'supplier_id', po.supplier_id,
        'supplier_name', s.business_name, 'supplier_rut', s.rut,
        'supplier_contact', s.contact_name, 'supplier_email', s.contact_email,
        'supplier_phone', s.contact_phone, 'supplier_address', s.address,
        'warehouse_id', po.warehouse_id, 'warehouse_name', w.name,
        'po_type', po.po_type, 'currency', po.currency, 'payment_terms', po.payment_terms,
        'requested_by', po.requested_by, 'requester_name', u.nombre || ' ' || u.apellido,
        'requester_email', u.email, 'authorized_by', po.authorized_by,
        'authorized_name', ap.full_name, 'authorized_position', ap.position,
        'notes', po.notes, 'source_type', po.source_type,
        'net_total', po.net_total, 'discount_total', po.discount_total,
        'tax_total', po.tax_total, 'exempt_total', po.exempt_total,
        'grand_total', po.grand_total, 'status', po.status,
        'receipt_status', po.receipt_status, 'invoice_status', po.invoice_status,
        'cancel_reason', po.cancel_reason, 'cancelled_at', po.cancelled_at,
        'email_sent_at', po.email_sent_at, 'supplier_email_snapshot', po.supplier_email_snapshot,
        'created_at', po.created_at, 'updated_at', po.updated_at,
        'company_name', c.business_name, 'company_rut', c.rut,
        'company_logo_url', c.logo_url, 'company_phone', c.phone,
        'company_email', c.email, 'company_address', c.address,
        'company_giro', c.giro, 'company_region', c.region,
        'company_comuna', c.comuna, 'company_city', c.city,
        'company_purchase_terms', c.purchase_terms,
        'company_document_footer', c.document_footer
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
