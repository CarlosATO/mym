-- Preserve the exact purchase order version sent to the supplier.

CREATE TABLE adquisiciones.purchase_order_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id),
    po_id uuid NOT NULL,
    snapshot_type text NOT NULL,
    version integer NOT NULL DEFAULT 1,
    header_snapshot jsonb NOT NULL,
    items_snapshot jsonb NOT NULL,
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT purchase_order_snapshots_po_company_fkey
        FOREIGN KEY (po_id, company_id)
        REFERENCES adquisiciones.purchase_orders(id, company_id),
    CONSTRAINT purchase_order_snapshots_type_check
        CHECK (snapshot_type IN ('ORIGINAL_SENT', 'CONFIRMED')),
    CONSTRAINT purchase_order_snapshots_version_check
        CHECK (version > 0),
    CONSTRAINT purchase_order_snapshots_unique_type
        UNIQUE (po_id, snapshot_type)
);

CREATE INDEX purchase_order_snapshots_company_id_idx
    ON adquisiciones.purchase_order_snapshots(company_id);

ALTER TABLE adquisiciones.purchase_order_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_po_snapshots_select
    ON adquisiciones.purchase_order_snapshots
    FOR SELECT TO authenticated
    USING (
        portal.has_permission('system.admin')
        OR (
            portal.has_permission('adquisiciones.po.view')
            AND core.has_company_access(auth.uid(), company_id)
        )
    );

GRANT SELECT ON adquisiciones.purchase_order_snapshots TO authenticated, service_role;

CREATE OR REPLACE FUNCTION adquisiciones.reject_purchase_order_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Los snapshots de órdenes de compra son inmutables';
END;
$$;

CREATE TRIGGER trg_purchase_order_snapshots_immutable
    BEFORE UPDATE OR DELETE
    ON adquisiciones.purchase_order_snapshots
    FOR EACH ROW
    EXECUTE FUNCTION adquisiciones.reject_purchase_order_snapshot_mutation();

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
    v_captured_at timestamptz;
    v_header_snapshot jsonb;
    v_items_snapshot jsonb;
BEGIN
    v_user := COALESCE(p_user_id, auth.uid());
    SELECT status, company_id INTO v_old_status, v_company_id
    FROM adquisiciones.purchase_orders
    WHERE id = p_po_id;

    IF v_old_status IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'OC no encontrada');
    END IF;

    IF NOT (
        (v_old_status = 'EMITIDA' AND p_new_status IN ('RECEPCION_PARCIAL','RECEPCION_TOTAL','CANCELADA','ENVIADA_PROVEEDOR')) OR
        (v_old_status = 'BORRADOR' AND p_new_status IN ('PENDIENTE_APROBACION','CANCELADA','EMITIDA')) OR
        (v_old_status = 'PENDIENTE_APROBACION' AND p_new_status IN ('APROBADA','RECHAZADA','CANCELADA','EMITIDA')) OR
        (v_old_status = 'APROBADA' AND p_new_status IN ('ENVIADA_PROVEEDOR','CANCELADA')) OR
        (v_old_status = 'ENVIADA_PROVEEDOR' AND p_new_status IN ('CONFIRMADA','RECEPCION_PARCIAL','RECEPCION_TOTAL','CANCELADA')) OR
        (v_old_status = 'CONFIRMADA' AND p_new_status IN ('RECEPCION_PARCIAL','RECEPCION_TOTAL','CANCELADA')) OR
        (v_old_status = 'RECEPCION_PARCIAL' AND p_new_status IN ('RECEPCION_TOTAL','CANCELADA')) OR
        (v_old_status = 'RECEPCION_TOTAL' AND p_new_status IN ('FACTURADA_PARCIAL','FACTURADA_TOTAL','CERRADA')) OR
        (v_old_status = 'FACTURADA_PARCIAL' AND p_new_status IN ('FACTURADA_TOTAL','CERRADA')) OR
        (v_old_status = 'FACTURADA_TOTAL' AND p_new_status IN ('CERRADA','PAGADA'))
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida: ' || v_old_status || ' → ' || p_new_status);
    END IF;

    IF p_new_status = 'ENVIADA_PROVEEDOR' THEN
        v_captured_at := clock_timestamp();

        SELECT jsonb_build_object(
            'po_id', po.id,
            'correlative', po.correlative,
            'company_id', po.company_id,
            'issue_date', po.issue_date,
            'required_date', po.required_date,
            'supplier_id', po.supplier_id,
            'supplier_name', COALESCE(NULLIF(s.business_name, ''), NULLIF(s.fantasy_name, '')),
            'supplier_rut', s.rut,
            'warehouse_id', po.warehouse_id,
            'warehouse_name', w.name,
            'po_type', po.po_type,
            'source_type', po.source_type,
            'currency', po.currency,
            'payment_terms', po.payment_terms,
            'requested_by', po.requested_by,
            'requester_name', NULLIF(btrim(COALESCE(u.nombre, '') || ' ' || COALESCE(u.apellido, '')), ''),
            'authorized_by', po.authorized_by,
            'authorized_name', ap.full_name,
            'notes', po.notes,
            'net_total', po.net_total,
            'discount_total', po.discount_total,
            'tax_total', po.tax_total,
            'exempt_total', po.exempt_total,
            'grand_total', po.grand_total,
            'status_before_snapshot', v_old_status,
            'captured_at', v_captured_at
        )
        INTO v_header_snapshot
        FROM adquisiciones.purchase_orders po
        LEFT JOIN adquisiciones.suppliers s
            ON s.id = po.supplier_id AND s.company_id = po.company_id
        LEFT JOIN adquisiciones.warehouses w
            ON w.id = po.warehouse_id AND w.company_id = po.company_id
        LEFT JOIN portal.users u ON u.id = po.requested_by
        LEFT JOIN adquisiciones.authorized_personnel ap
            ON ap.id = po.authorized_by AND ap.company_id = po.company_id
        WHERE po.id = p_po_id AND po.company_id = v_company_id;

        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'item_id', i.id,
                    'line_number', i.line_number,
                    'item_type', i.item_type,
                    'product_id', i.product_id,
                    'sku', pr.sku,
                    'product_description', i.product_description,
                    'unit', i.unit,
                    'quantity', i.quantity,
                    'unit_price', i.unit_price,
                    'discount_percent', i.discount_percent,
                    'discount_amount', i.discount_amount,
                    'tax_rate', i.tax_rate,
                    'tax_amount', i.tax_amount,
                    'line_total', i.line_total,
                    'warehouse_id', i.warehouse_id,
                    'warehouse_name', w.name,
                    'cost_center', i.cost_center,
                    'required_date', i.required_date,
                    'notes', i.notes
                ) ORDER BY i.line_number
            ),
            '[]'::jsonb
        )
        INTO v_items_snapshot
        FROM adquisiciones.purchase_order_items i
        LEFT JOIN adquisiciones.products pr
            ON pr.id = i.product_id AND pr.company_id = v_company_id
        LEFT JOIN adquisiciones.warehouses w
            ON w.id = i.warehouse_id AND w.company_id = v_company_id
        WHERE i.po_id = p_po_id AND i.company_id = v_company_id;

        INSERT INTO adquisiciones.purchase_order_snapshots (
            company_id, po_id, snapshot_type, version,
            header_snapshot, items_snapshot, created_by, created_at
        ) VALUES (
            v_company_id, p_po_id, 'ORIGINAL_SENT', 1,
            v_header_snapshot, v_items_snapshot, v_user, v_captured_at
        )
        ON CONFLICT (po_id, snapshot_type) DO NOTHING;
    END IF;

    IF p_new_status = 'CANCELADA' THEN
        UPDATE adquisiciones.purchase_orders
        SET status = p_new_status,
            cancel_reason = p_reason,
            cancelled_at = now(),
            cancelled_by = v_user,
            updated_by = v_user
        WHERE id = p_po_id;
    ELSE
        UPDATE adquisiciones.purchase_orders
        SET status = p_new_status, updated_by = v_user
        WHERE id = p_po_id;
    END IF;

    INSERT INTO adquisiciones.purchase_order_status_history (
        company_id, po_id, from_status, to_status, changed_by, reason
    ) VALUES (
        v_company_id, p_po_id, v_old_status, p_new_status, v_user, p_reason
    );

    RETURN jsonb_build_object('success', true);
END;
$$;
