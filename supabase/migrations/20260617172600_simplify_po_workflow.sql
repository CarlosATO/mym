-- Migration: Simplify PO workflow and add EMITIDA status
-- 1. Update chk_po_status constraint to support EMITIDA status
ALTER TABLE adquisiciones.purchase_orders DROP CONSTRAINT IF EXISTS chk_po_status;
ALTER TABLE adquisiciones.purchase_orders ADD CONSTRAINT chk_po_status CHECK (
    status IN ('BORRADOR','EMITIDA','PENDIENTE_APROBACION','APROBADA','ENVIADA_PROVEEDOR',
               'RECEPCION_PARCIAL','RECEPCION_TOTAL','FACTURADA_PARCIAL',
               'FACTURADA_TOTAL','CERRADA','CANCELADA','RECHAZADA')
);

-- 2. Update create_purchase_order function to set status = 'EMITIDA' directly
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
        'EMITIDA', 'PENDIENTE', 'PENDIENTE',
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
    VALUES (p_company_id, v_po_id, NULL, 'EMITIDA', p_user_id);

    RETURN jsonb_build_object('success', true, 'po_id', v_po_id, 'correlative', v_corr);
END;
$$;

-- 3. Update update_purchase_order_status function to handle EMITIDA transitions and insert company_id
CREATE OR REPLACE FUNCTION adquisiciones.update_purchase_order_status(
    p_po_id uuid, p_new_status text, p_reason text DEFAULT NULL, p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_old_status text;
    v_company_id uuid;
    v_user uuid;
BEGIN
    v_user := COALESCE(p_user_id, auth.uid());
    SELECT status, company_id INTO v_old_status, v_company_id FROM adquisiciones.purchase_orders WHERE id = p_po_id;
    IF v_old_status IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'OC no encontrada');
    END IF;
    IF NOT (
        (v_old_status = 'EMITIDA' AND p_new_status IN ('RECEPCION_PARCIAL','RECEPCION_TOTAL','CANCELADA','ENVIADA_PROVEEDOR')) OR
        (v_old_status = 'BORRADOR' AND p_new_status IN ('PENDIENTE_APROBACION','CANCELADA','EMITIDA')) OR
        (v_old_status = 'PENDIENTE_APROBACION' AND p_new_status IN ('APROBADA','RECHAZADA','CANCELADA','EMITIDA')) OR
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
    INSERT INTO adquisiciones.purchase_order_status_history (company_id, po_id, from_status, to_status, changed_by, reason)
    VALUES (v_company_id, p_po_id, v_old_status, p_new_status, v_user, p_reason);
    RETURN jsonb_build_object('success', true);
END;
$$;
