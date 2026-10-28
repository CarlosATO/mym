-- Add server-side operational views to the purchase-order read model.
-- The existing function signature and response contract remain unchanged.

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
    v_operational_view text := CASE
        WHEN p_filters->>'operational_view' IN ('PENDING', 'RECEIVED', 'CLOSED', 'CANCELLED', 'ALL')
            THEN p_filters->>'operational_view'
        ELSE 'PENDING'
    END;
    v_search text := p_filters->>'search';
    v_status text := p_filters->>'status';
    v_supplier_id uuid := (p_filters->>'supplier_id')::uuid;
    v_po_type text := p_filters->>'po_type';
    v_date_from date := (p_filters->>'date_from')::date;
    v_date_to date := (p_filters->>'date_to')::date;
    v_page integer := GREATEST(COALESCE((p_filters->>'page')::integer, 1), 1);
    v_page_size integer := GREATEST(COALESCE((p_filters->>'page_size')::integer, 50), 1);
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
        AND (
            v_operational_view = 'ALL'
            OR (v_operational_view = 'PENDING'
                AND po.status NOT IN ('CERRADA', 'CANCELADA', 'RECHAZADA', 'PAGADA', 'RECEPCION_TOTAL')
                AND COALESCE(po.receipt_status, 'PENDIENTE') <> 'RECEPCION_TOTAL')
            OR (v_operational_view = 'RECEIVED'
                AND po.status NOT IN ('CERRADA', 'CANCELADA')
                AND (po.receipt_status = 'RECEPCION_TOTAL' OR po.status = 'RECEPCION_TOTAL'))
            OR (v_operational_view = 'CLOSED' AND po.status = 'CERRADA')
            OR (v_operational_view = 'CANCELLED' AND po.status = 'CANCELADA')
        )
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

REVOKE ALL ON FUNCTION adquisiciones.get_purchase_orders(jsonb, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adquisiciones.get_purchase_orders(jsonb, uuid, uuid) TO service_role;
