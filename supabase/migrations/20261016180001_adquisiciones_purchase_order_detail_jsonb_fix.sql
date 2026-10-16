-- Fix get_purchase_order_detail payload construction.
--
-- The detail payload grew past jsonb_build_object's 100 argument limit when the
-- company metadata fields were added, so the function raised SQLSTATE 54023
-- ("cannot pass more than 100 arguments to a function") on every call. This
-- keeps the same access controls and response shape but builds the JSON in two
-- concatenated fragments.

CREATE OR REPLACE FUNCTION adquisiciones.get_purchase_order_detail(
    p_po_id uuid,
    p_user_id uuid,
    p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = adquisiciones, core, portal, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_is_admin boolean;
    v_po jsonb;
    v_items jsonb;
BEGIN
    IF v_actor IS NOT NULL AND v_actor IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION 'El usuario de la sesión no coincide con p_user_id';
    END IF;
    IF p_user_id IS NULL OR p_company_id IS NULL THEN
        RAISE EXCEPTION 'Usuario y empresa son obligatorios';
    END IF;

    v_is_admin := portal.user_has_permission(p_user_id, 'system.admin');
    IF NOT (v_is_admin OR core.has_company_access(p_user_id, p_company_id)) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa';
    END IF;
    IF NOT (v_is_admin OR portal.user_has_permission(p_user_id, 'adquisiciones.po.view')) THEN
        RAISE EXCEPTION 'Permisos insuficientes para consultar órdenes de compra';
    END IF;

    SELECT jsonb_build_object(
        'id', po.id, 'correlative', po.correlative, 'issue_date', po.issue_date, 'required_date', po.required_date,
        'supplier_id', po.supplier_id, 'supplier_name', s.business_name, 'supplier_rut', s.rut,
        'supplier_contact', s.contact_name, 'supplier_email', s.contact_email, 'supplier_phone', s.contact_phone,
        'supplier_address', s.address, 'warehouse_id', po.warehouse_id, 'warehouse_name', w.name,
        'po_type', po.po_type, 'currency', po.currency, 'payment_terms', po.payment_terms,
        'requested_by', po.requested_by, 'requester_name', u.nombre || ' ' || u.apellido, 'requester_email', u.email,
        'authorized_by', po.authorized_by, 'authorized_name', ap.full_name, 'authorized_position', ap.position,
        'notes', po.notes, 'source_type', po.source_type, 'net_total', po.net_total, 'discount_total', po.discount_total,
        'tax_total', po.tax_total, 'exempt_total', po.exempt_total, 'grand_total', po.grand_total,
        'status', po.status, 'receipt_status', po.receipt_status, 'invoice_status', po.invoice_status,
        'cancel_reason', po.cancel_reason, 'cancelled_at', po.cancelled_at,
        'closed_with_pending', po.closed_with_pending, 'closure_reason', po.closure_reason,
        'closed_at', po.closed_at, 'closed_by', po.closed_by,
        'email_sent_at', po.email_sent_at, 'supplier_email_snapshot', po.supplier_email_snapshot,
        'created_at', po.created_at, 'updated_at', po.updated_at
    ) || jsonb_build_object(
        'company_name', c.business_name, 'company_rut', c.rut, 'company_logo_url', c.logo_url,
        'company_phone', c.phone, 'company_email', c.email, 'company_address', c.address,
        'company_giro', c.giro, 'company_region', c.region, 'company_comuna', c.comuna,
        'company_city', c.city, 'company_purchase_terms', c.purchase_terms, 'company_document_footer', c.document_footer
    ) INTO v_po
    FROM adquisiciones.purchase_orders po
    LEFT JOIN core.companies c ON c.id = po.company_id
    LEFT JOIN adquisiciones.suppliers s ON s.id = po.supplier_id
    LEFT JOIN adquisiciones.warehouses w ON w.id = po.warehouse_id
    LEFT JOIN portal.users u ON u.id = po.requested_by
    LEFT JOIN adquisiciones.authorized_personnel ap ON ap.id = po.authorized_by
    WHERE po.id = p_po_id AND po.company_id = p_company_id;

    IF v_po IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT jsonb_agg(jsonb_build_object('id', i.id, 'line_number', i.line_number, 'item_type', i.item_type, 'product_id', i.product_id, 'product_description', i.product_description, 'unit', i.unit, 'quantity', i.quantity, 'unit_price', i.unit_price, 'discount_percent', i.discount_percent, 'discount_unit_amount', COALESCE(i.discount_unit_amount, 0), 'discount_amount', i.discount_amount, 'tax_rate', i.tax_rate, 'tax_amount', i.tax_amount, 'line_total', i.line_total, 'warehouse_id', i.warehouse_id, 'warehouse_name', iw.name, 'cost_center', i.cost_center, 'required_date', i.required_date, 'notes', i.notes, 'quantity_received', i.quantity_received, 'quantity_pending', i.quantity_pending, 'lot_number', i.lot_number, 'expiration_date', i.expiration_date) ORDER BY i.line_number) INTO v_items FROM adquisiciones.purchase_order_items i LEFT JOIN adquisiciones.warehouses iw ON iw.id = i.warehouse_id WHERE i.po_id = p_po_id AND i.is_active = true;

    RETURN jsonb_build_object('po', v_po, 'items', COALESCE(v_items, '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_purchase_order_detail(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adquisiciones.get_purchase_order_detail(uuid, uuid, uuid) TO service_role;
