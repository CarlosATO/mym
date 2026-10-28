-- Bind purchase-order cancellation to the authenticated Supabase JWT.

CREATE OR REPLACE FUNCTION adquisiciones.cancel_purchase_order(
    p_po_id uuid,
    p_reason text,
    p_user_id uuid,
    p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, adquisiciones, logistica, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_po adquisiciones.purchase_orders%ROWTYPE;
    v_reason text := NULLIF(btrim(p_reason), '');
    v_is_admin boolean;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Se requiere una sesión autenticada';
    END IF;
    IF p_user_id IS NULL OR v_actor IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION 'El usuario de la sesión no coincide con p_user_id';
    END IF;
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION 'La empresa es obligatoria';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM portal.users u
        WHERE u.id = v_actor
          AND u.is_active = true
          AND u.deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'El usuario no está activo';
    END IF;
    IF v_reason IS NULL THEN
        RAISE EXCEPTION 'El motivo de anulación es obligatorio';
    END IF;

    v_is_admin := portal.user_has_permission(v_actor, 'system.admin');
    IF NOT v_is_admin AND NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa';
    END IF;
    IF NOT v_is_admin
       AND NOT core.has_permission_for_company(v_actor, p_company_id, 'adquisiciones.po.update') THEN
        RAISE EXCEPTION 'Permisos insuficientes para anular la orden de compra';
    END IF;

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
        SELECT 1
        FROM adquisiciones.purchase_order_items
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
        cancelled_at = clock_timestamp(), cancelled_by = v_actor,
        updated_by = v_actor, updated_at = clock_timestamp()
    WHERE id = p_po_id AND company_id = p_company_id;

    INSERT INTO adquisiciones.purchase_order_status_history
        (company_id, po_id, from_status, to_status, changed_by, reason)
    VALUES (p_company_id, p_po_id, v_po.status, 'CANCELADA', v_actor, v_reason);

    RETURN jsonb_build_object('success', true, 'po_id', p_po_id, 'status', 'CANCELADA');
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.cancel_purchase_order(uuid, text, uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.cancel_purchase_order(uuid, text, uuid, uuid)
    TO authenticated;
