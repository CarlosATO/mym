-- Aggregated indicators for the purchase-order operational bar.

CREATE OR REPLACE FUNCTION adquisiciones.get_purchase_order_indicators(
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
    v_pending_count bigint;
    v_pending_amount numeric(14,2);
    v_received_order_count bigint;
    v_received_amount numeric(14,2);
BEGIN
    IF v_actor IS NOT NULL AND v_actor IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION 'El usuario de la sesión no coincide con p_user_id';
    END IF;
    IF p_user_id IS NULL OR p_company_id IS NULL THEN
        RAISE EXCEPTION 'Usuario y empresa son obligatorios';
    END IF;
    IF NOT (portal.user_has_permission(p_user_id, 'system.admin') OR core.has_company_access(p_user_id, p_company_id)) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa';
    END IF;
    IF NOT (portal.user_has_permission(p_user_id, 'system.admin') OR portal.user_has_permission(p_user_id, 'adquisiciones.po.view')) THEN
        RAISE EXCEPTION 'Permisos insuficientes para consultar órdenes de compra';
    END IF;

    SELECT count(DISTINCT po.id), coalesce(sum(greatest(coalesce(i.line_total, 0) *
        greatest(coalesce(i.quantity, 0) - coalesce(i.quantity_received, 0), 0) /
        nullif(i.quantity, 0), 0)), 0)
    INTO v_pending_count, v_pending_amount
    FROM adquisiciones.purchase_orders po
    LEFT JOIN adquisiciones.purchase_order_items i
      ON i.po_id = po.id AND i.company_id = p_company_id AND i.is_active = true
    WHERE po.company_id = p_company_id
      AND po.is_active = true
      AND po.status NOT IN ('CERRADA', 'CANCELADA', 'RECHAZADA', 'PAGADA', 'RECEPCION_TOTAL')
      AND coalesce(po.receipt_status, 'PENDIENTE') <> 'RECEPCION_TOTAL';

    SELECT count(DISTINCT r.purchase_order_id), coalesce(sum(r.receipt_total_gross), 0)
    INTO v_received_order_count, v_received_amount
    FROM logistica.purchase_receipts r
    WHERE r.company_id = p_company_id
      AND r.status = 'COMPLETED'
      AND r.received_at >= now() - interval '30 days';

    RETURN jsonb_build_object(
        'pending_count', v_pending_count,
        'pending_amount', round(v_pending_amount, 2),
        'received_order_count', v_received_order_count,
        'received_amount', round(v_received_amount, 2),
        'received_since', now() - interval '30 days'
    );
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_purchase_order_indicators(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adquisiciones.get_purchase_order_indicators(uuid, uuid) TO service_role;
