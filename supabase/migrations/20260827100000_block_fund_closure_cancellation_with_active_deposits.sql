-- A fund closure cannot be cancelled while it still has active deposits.
-- Deposits are independent financial operations and must be voided explicitly.

CREATE OR REPLACE FUNCTION adquisiciones.cancel_route_fund_closure(
    p_company_id uuid,
    p_closure_id uuid,
    p_cancel_reason text,
    p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_closure record;
    v_now timestamptz := now();
    v_reason text := btrim(p_cancel_reason);
    v_released_items integer;
    v_released_expenses integer;
BEGIN
    IF p_user_id IS DISTINCT FROM auth.uid()
       OR NOT core.has_company_access(auth.uid(), p_company_id) THEN
        RAISE EXCEPTION 'Usuario o empresa inválidos.';
    END IF;
    IF NOT portal.user_has_permission(auth.uid(), 'adquisiciones.route_fund_closures.cancel') THEN
        RAISE EXCEPTION 'El usuario no tiene permisos para anular el Cierre de Fondos.';
    END IF;
    IF COALESCE(length(v_reason), 0) < 5 THEN
        RAISE EXCEPTION 'Debe proporcionar un motivo válido para la anulación (mínimo 5 caracteres).';
    END IF;

    SELECT *
    INTO v_closure
    FROM adquisiciones.route_fund_closures
    WHERE id = p_closure_id
      AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cierre no encontrado.';
    END IF;
    IF v_closure.status = 'CANCELLED' THEN
        RAISE EXCEPTION 'Este cierre ya está anulado.';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM adquisiciones.route_fund_closure_deposits
        WHERE fund_closure_id = p_closure_id
          AND company_id = p_company_id
          AND status = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'El cierre tiene depósitos activos. Anule primero los depósitos antes de anular el Cierre de Fondos.';
    END IF;

    UPDATE adquisiciones.route_fund_closure_items
    SET released_at = v_now,
        released_by = p_user_id,
        release_reason = v_reason
    WHERE company_id = p_company_id
      AND fund_closure_id = p_closure_id
      AND released_at IS NULL;
    GET DIAGNOSTICS v_released_items = ROW_COUNT;

    UPDATE adquisiciones.route_fund_closure_expenses
    SET fund_closure_id = NULL
    WHERE company_id = p_company_id
      AND fund_closure_id = p_closure_id
      AND status = 'ACTIVE'
      AND voided_at IS NULL;
    GET DIAGNOSTICS v_released_expenses = ROW_COUNT;

    UPDATE adquisiciones.route_fund_closures
    SET status = 'CANCELLED',
        cancelled_at = v_now,
        cancelled_by = p_user_id,
        cancel_reason = v_reason
    WHERE id = p_closure_id
      AND company_id = p_company_id;

    RETURN jsonb_build_object(
        'closure_id', p_closure_id,
        'status', 'CANCELLED',
        'released_items', v_released_items,
        'released_expenses', v_released_expenses
    );
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.cancel_route_fund_closure(uuid, uuid, text, uuid)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.cancel_route_fund_closure(uuid, uuid, text, uuid)
    TO authenticated;
