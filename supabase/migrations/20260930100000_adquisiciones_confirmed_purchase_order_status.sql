-- Add CONFIRMADA as the supplier-confirmed purchase order state.

ALTER TABLE adquisiciones.purchase_orders DROP CONSTRAINT IF EXISTS chk_po_status;
ALTER TABLE adquisiciones.purchase_orders ADD CONSTRAINT chk_po_status CHECK (
    status IN ('BORRADOR','EMITIDA','PENDIENTE_APROBACION','APROBADA','ENVIADA_PROVEEDOR',
               'CONFIRMADA','RECEPCION_PARCIAL','RECEPCION_TOTAL','FACTURADA_PARCIAL',
               'FACTURADA_TOTAL','CERRADA','CANCELADA','RECHAZADA')
);

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
        (v_old_status = 'ENVIADA_PROVEEDOR' AND p_new_status IN ('CONFIRMADA','RECEPCION_PARCIAL','RECEPCION_TOTAL','CANCELADA')) OR
        (v_old_status = 'CONFIRMADA' AND p_new_status IN ('RECEPCION_PARCIAL','RECEPCION_TOTAL','CANCELADA')) OR
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
