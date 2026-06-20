-- Migration: Update get_purchase_order_detail to return expanded company metadata fields
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
        'company_address', c.address,
        'company_giro', c.giro,
        'company_region', c.region,
        'company_comuna', c.comuna,
        'company_city', c.city,
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
