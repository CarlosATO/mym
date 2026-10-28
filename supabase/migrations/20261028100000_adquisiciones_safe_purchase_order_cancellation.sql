-- Cancel purchase orders only through a guarded, transactional operation.

CREATE OR REPLACE FUNCTION adquisiciones.cancel_purchase_order(
    p_po_id uuid,
    p_reason text,
    p_user_id uuid,
    p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = adquisiciones, logistica, core, portal, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_po adquisiciones.purchase_orders%ROWTYPE;
    v_reason text := NULLIF(btrim(p_reason), '');
    v_is_admin boolean;
BEGIN
    IF v_actor IS NOT NULL AND v_actor IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION 'El usuario de la sesión no coincide con p_user_id';
    END IF;
    IF p_user_id IS NULL OR p_company_id IS NULL THEN
        RAISE EXCEPTION 'Usuario y empresa son obligatorios';
    END IF;
    IF v_reason IS NULL THEN
        RAISE EXCEPTION 'El motivo de anulación es obligatorio';
    END IF;

    v_is_admin := portal.user_has_permission(p_user_id, 'system.admin');
    IF NOT (v_is_admin OR core.has_company_access(p_user_id, p_company_id) AND
            core.has_permission_for_company(p_user_id, p_company_id, 'adquisiciones.po.update')) THEN
        RAISE EXCEPTION 'Permisos insuficientes para anular la orden de compra';
    END IF;

    -- Receipts lock this row before writing, so cancellation and receiving serialize.
    SELECT * INTO v_po
    FROM adquisiciones.purchase_orders
    WHERE id = p_po_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'La OC no existe o no pertenece a la empresa';
    END IF;
    IF v_po.status NOT IN ('BORRADOR', 'EMITIDA', 'PENDIENTE_APROBACION',
                           'APROBADA', 'ENVIADA_PROVEEDOR', 'CONFIRMADA') THEN
        RAISE EXCEPTION 'La OC no se puede anular desde el estado %', v_po.status;
    END IF;

    PERFORM 1
    FROM adquisiciones.purchase_order_items
    WHERE po_id = p_po_id AND company_id = p_company_id
    FOR UPDATE;

    IF EXISTS (
        SELECT 1 FROM adquisiciones.purchase_order_items
        WHERE po_id = p_po_id AND company_id = p_company_id
          AND COALESCE(quantity_received, 0) > 0
    ) THEN
        RAISE EXCEPTION 'La OC no se puede anular: existen cantidades efectivamente recibidas';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM logistica.purchase_receipts r
        WHERE r.purchase_order_id = p_po_id
          AND r.company_id = p_company_id
          AND r.status <> 'CANCELLED'
    ) OR EXISTS (
        SELECT 1
        FROM logistica.purchase_receipt_items ri
        JOIN logistica.purchase_receipts r ON r.id = ri.receipt_id
        WHERE r.purchase_order_id = p_po_id
          AND r.company_id = p_company_id
          AND r.status <> 'CANCELLED'
          AND (COALESCE(ri.quantity_received, 0) > 0
               OR COALESCE(ri.quantity_rejected, 0) > 0
               OR COALESCE(ri.quantity_missing, 0) > 0)
    ) THEN
        RAISE EXCEPTION 'La OC no se puede anular: existen registros de recepción';
    END IF;

    UPDATE adquisiciones.purchase_orders
    SET status = 'CANCELADA', cancel_reason = v_reason,
        cancelled_at = clock_timestamp(), cancelled_by = p_user_id,
        updated_by = p_user_id, updated_at = clock_timestamp()
    WHERE id = p_po_id AND company_id = p_company_id;

    INSERT INTO adquisiciones.purchase_order_status_history
        (company_id, po_id, from_status, to_status, changed_by, reason)
    VALUES (p_company_id, p_po_id, v_po.status, 'CANCELADA', p_user_id, v_reason);

    RETURN jsonb_build_object('success', true, 'po_id', p_po_id, 'status', 'CANCELADA');
END;
$$;

-- The generic transition RPC must not provide a cancellation bypass.
CREATE OR REPLACE FUNCTION adquisiciones.update_purchase_order_status(
    p_po_id uuid, p_new_status text, p_reason text DEFAULT NULL, p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = adquisiciones, core, portal, public
AS $$
DECLARE
    v_old_status text;
    v_company_id uuid;
    v_user uuid := COALESCE(p_user_id, auth.uid());
    v_captured_at timestamptz;
    v_header_snapshot jsonb;
    v_items_snapshot jsonb;
BEGIN
    SELECT status, company_id INTO v_old_status, v_company_id
    FROM adquisiciones.purchase_orders WHERE id = p_po_id FOR UPDATE;
    IF v_old_status IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'OC no encontrada');
    END IF;
    IF p_new_status = 'CANCELADA' THEN
        RETURN jsonb_build_object('success', false, 'error', 'La anulación requiere la operación validada de cancelación');
    END IF;
    IF NOT (
        (v_old_status = 'EMITIDA' AND p_new_status IN ('RECEPCION_PARCIAL','RECEPCION_TOTAL','ENVIADA_PROVEEDOR')) OR
        (v_old_status = 'BORRADOR' AND p_new_status IN ('PENDIENTE_APROBACION','EMITIDA')) OR
        (v_old_status = 'PENDIENTE_APROBACION' AND p_new_status IN ('APROBADA','RECHAZADA','EMITIDA')) OR
        (v_old_status = 'APROBADA' AND p_new_status = 'ENVIADA_PROVEEDOR') OR
        (v_old_status = 'ENVIADA_PROVEEDOR' AND p_new_status IN ('RECEPCION_PARCIAL','RECEPCION_TOTAL')) OR
        (v_old_status = 'CONFIRMADA' AND p_new_status IN ('RECEPCION_PARCIAL','RECEPCION_TOTAL')) OR
        (v_old_status = 'RECEPCION_PARCIAL' AND p_new_status = 'RECEPCION_TOTAL') OR
        (v_old_status = 'RECEPCION_TOTAL' AND p_new_status IN ('FACTURADA_PARCIAL','FACTURADA_TOTAL','CERRADA')) OR
        (v_old_status = 'FACTURADA_PARCIAL' AND p_new_status IN ('FACTURADA_TOTAL','CERRADA')) OR
        (v_old_status = 'FACTURADA_TOTAL' AND p_new_status IN ('CERRADA','PAGADA'))
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida: ' || v_old_status || ' → ' || p_new_status);
    END IF;
    IF p_new_status = 'ENVIADA_PROVEEDOR' THEN
        v_captured_at := clock_timestamp();
        SELECT jsonb_build_object(
            'po_id', po.id, 'correlative', po.correlative, 'company_id', po.company_id,
            'issue_date', po.issue_date, 'required_date', po.required_date,
            'supplier_id', po.supplier_id,
            'supplier_name', COALESCE(NULLIF(s.business_name, ''), NULLIF(s.fantasy_name, '')),
            'supplier_rut', s.rut, 'warehouse_id', po.warehouse_id, 'warehouse_name', w.name,
            'po_type', po.po_type, 'source_type', po.source_type, 'currency', po.currency,
            'payment_terms', po.payment_terms, 'requested_by', po.requested_by,
            'requester_name', NULLIF(btrim(COALESCE(u.nombre, '') || ' ' || COALESCE(u.apellido, '')), ''),
            'authorized_by', po.authorized_by, 'authorized_name', ap.full_name, 'notes', po.notes,
            'net_total', po.net_total, 'discount_total', po.discount_total, 'tax_total', po.tax_total,
            'exempt_total', po.exempt_total, 'grand_total', po.grand_total,
            'status_before_snapshot', v_old_status, 'captured_at', v_captured_at
        ) INTO v_header_snapshot
        FROM adquisiciones.purchase_orders po
        LEFT JOIN adquisiciones.suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
        LEFT JOIN adquisiciones.warehouses w ON w.id = po.warehouse_id AND w.company_id = po.company_id
        LEFT JOIN portal.users u ON u.id = po.requested_by
        LEFT JOIN adquisiciones.authorized_personnel ap ON ap.id = po.authorized_by AND ap.company_id = po.company_id
        WHERE po.id = p_po_id AND po.company_id = v_company_id;

        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'item_id', i.id, 'line_number', i.line_number, 'item_type', i.item_type,
            'product_id', i.product_id, 'sku', pr.sku, 'product_description', i.product_description,
            'unit', i.unit, 'quantity', i.quantity, 'unit_price', i.unit_price,
            'discount_percent', i.discount_percent, 'discount_amount', i.discount_amount,
            'tax_rate', i.tax_rate, 'tax_amount', i.tax_amount, 'line_total', i.line_total,
            'warehouse_id', i.warehouse_id, 'warehouse_name', w.name, 'cost_center', i.cost_center,
            'required_date', i.required_date, 'notes', i.notes
        ) ORDER BY i.line_number), '[]'::jsonb) INTO v_items_snapshot
        FROM adquisiciones.purchase_order_items i
        LEFT JOIN adquisiciones.products pr ON pr.id = i.product_id AND pr.company_id = v_company_id
        LEFT JOIN adquisiciones.warehouses w ON w.id = i.warehouse_id AND w.company_id = v_company_id
        WHERE i.po_id = p_po_id AND i.company_id = v_company_id;

        INSERT INTO adquisiciones.purchase_order_snapshots
            (company_id, po_id, snapshot_type, version, header_snapshot, items_snapshot, created_by, created_at)
        VALUES (v_company_id, p_po_id, 'ORIGINAL_SENT', 1, v_header_snapshot, v_items_snapshot, v_user, v_captured_at)
        ON CONFLICT (po_id, snapshot_type) DO NOTHING;
    END IF;
    UPDATE adquisiciones.purchase_orders
    SET status = p_new_status, updated_by = v_user, updated_at = clock_timestamp()
    WHERE id = p_po_id AND company_id = v_company_id;
    INSERT INTO adquisiciones.purchase_order_status_history
        (company_id, po_id, from_status, to_status, changed_by, reason)
    VALUES (v_company_id, p_po_id, v_old_status, p_new_status, v_user, p_reason);
    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.cancel_purchase_order(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adquisiciones.cancel_purchase_order(uuid, text, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION adquisiciones.update_purchase_order_status(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adquisiciones.update_purchase_order_status(uuid, text, text, uuid) TO service_role;
