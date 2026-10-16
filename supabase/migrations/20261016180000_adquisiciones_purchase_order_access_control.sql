-- Least-privilege access control for purchase-order read models.
--
-- get_purchase_orders / get_purchase_order_detail were SECURITY DEFINER and
-- granted EXECUTE to `authenticated`, so any logged-in user could read every
-- company's purchase orders straight through PostgREST, bypassing the server
-- actions. This migration:
--   * makes both read models verify company access and the adquisiciones.po.view
--     permission (or system.admin) for the acting user,
--   * scopes the detail lookup to the caller's authorized company,
--   * removes EXECUTE from PUBLIC/anon/authenticated, leaving only service_role,
--     which is what the authenticated server actions actually use,
--   * applies the same least privilege to close_purchase_order_with_pending.

DROP FUNCTION IF EXISTS adquisiciones.get_purchase_orders(jsonb, uuid);
DROP FUNCTION IF EXISTS adquisiciones.get_purchase_order_detail(uuid);

CREATE OR REPLACE FUNCTION adquisiciones.get_purchase_orders(
    p_filters jsonb,
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
            'closed_with_pending', q.closed_with_pending, 'closure_reason', q.closure_reason,
            'closed_at', q.closed_at, 'closed_by', q.closed_by,
            'created_at', q.created_at, 'updated_at', q.updated_at
        ) ORDER BY q.created_at DESC), '[]'::jsonb),
        'total', (SELECT count(*) FROM q),
        'page', v_page, 'page_size', v_page_size
    ) INTO v_result
    FROM (SELECT * FROM q ORDER BY created_at DESC LIMIT v_page_size OFFSET v_offset) q;

    RETURN v_result;
END;
$$;

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

    SELECT jsonb_build_object('id', po.id, 'correlative', po.correlative, 'issue_date', po.issue_date, 'required_date', po.required_date, 'supplier_id', po.supplier_id, 'supplier_name', s.business_name, 'supplier_rut', s.rut, 'supplier_contact', s.contact_name, 'supplier_email', s.contact_email, 'supplier_phone', s.contact_phone, 'supplier_address', s.address, 'warehouse_id', po.warehouse_id, 'warehouse_name', w.name, 'po_type', po.po_type, 'currency', po.currency, 'payment_terms', po.payment_terms, 'requested_by', po.requested_by, 'requester_name', u.nombre || ' ' || u.apellido, 'requester_email', u.email, 'authorized_by', po.authorized_by, 'authorized_name', ap.full_name, 'authorized_position', ap.position, 'notes', po.notes, 'source_type', po.source_type, 'net_total', po.net_total, 'discount_total', po.discount_total, 'tax_total', po.tax_total, 'exempt_total', po.exempt_total, 'grand_total', po.grand_total, 'status', po.status, 'receipt_status', po.receipt_status, 'invoice_status', po.invoice_status, 'cancel_reason', po.cancel_reason, 'cancelled_at', po.cancelled_at, 'closed_with_pending', po.closed_with_pending, 'closure_reason', po.closure_reason, 'closed_at', po.closed_at, 'closed_by', po.closed_by, 'email_sent_at', po.email_sent_at, 'supplier_email_snapshot', po.supplier_email_snapshot, 'created_at', po.created_at, 'updated_at', po.updated_at, 'company_name', c.business_name, 'company_rut', c.rut, 'company_logo_url', c.logo_url, 'company_phone', c.phone, 'company_email', c.email, 'company_address', c.address, 'company_giro', c.giro, 'company_region', c.region, 'company_comuna', c.comuna, 'company_city', c.city, 'company_purchase_terms', c.purchase_terms, 'company_document_footer', c.document_footer) INTO v_po
    FROM adquisiciones.purchase_orders po LEFT JOIN core.companies c ON c.id = po.company_id LEFT JOIN adquisiciones.suppliers s ON s.id = po.supplier_id LEFT JOIN adquisiciones.warehouses w ON w.id = po.warehouse_id LEFT JOIN portal.users u ON u.id = po.requested_by LEFT JOIN adquisiciones.authorized_personnel ap ON ap.id = po.authorized_by WHERE po.id = p_po_id AND po.company_id = p_company_id;

    IF v_po IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT jsonb_agg(jsonb_build_object('id', i.id, 'line_number', i.line_number, 'item_type', i.item_type, 'product_id', i.product_id, 'product_description', i.product_description, 'unit', i.unit, 'quantity', i.quantity, 'unit_price', i.unit_price, 'discount_percent', i.discount_percent, 'discount_unit_amount', COALESCE(i.discount_unit_amount, 0), 'discount_amount', i.discount_amount, 'tax_rate', i.tax_rate, 'tax_amount', i.tax_amount, 'line_total', i.line_total, 'warehouse_id', i.warehouse_id, 'warehouse_name', iw.name, 'cost_center', i.cost_center, 'required_date', i.required_date, 'notes', i.notes, 'quantity_received', i.quantity_received, 'quantity_pending', i.quantity_pending, 'lot_number', i.lot_number, 'expiration_date', i.expiration_date) ORDER BY i.line_number) INTO v_items FROM adquisiciones.purchase_order_items i LEFT JOIN adquisiciones.warehouses iw ON iw.id = i.warehouse_id WHERE i.po_id = p_po_id AND i.is_active = true;

    RETURN jsonb_build_object('po', v_po, 'items', COALESCE(v_items, '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_purchase_orders(jsonb, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adquisiciones.get_purchase_orders(jsonb, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION adquisiciones.get_purchase_order_detail(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adquisiciones.get_purchase_order_detail(uuid, uuid, uuid) TO service_role;

-- The closure RPC is only invoked by the authenticated server action through the
-- service role; it must not be reachable directly by end users.
REVOKE ALL ON FUNCTION adquisiciones.close_purchase_order_with_pending(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adquisiciones.close_purchase_order_with_pending(uuid, text, uuid, uuid) TO service_role;
