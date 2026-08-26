ALTER TABLE adquisiciones.route_fund_closures
    ADD COLUMN IF NOT EXISTS cash_delivered numeric(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS physical_difference numeric(14,2) NOT NULL DEFAULT 0;

-- Several partial Payments may belong to the same settlement item. Exact
-- payment ownership is enforced by the payment index, not by the legacy item index.
DROP INDEX IF EXISTS adquisiciones.idx_route_fund_closures_active_item;
CREATE UNIQUE INDEX IF NOT EXISTS idx_route_fund_closures_active_legacy_item
    ON adquisiciones.route_fund_closure_items (route_settlement_item_id)
    WHERE released_at IS NULL AND payment_id IS NULL;

CREATE OR REPLACE FUNCTION adquisiciones.create_route_fund_closure_from_payments(
    p_company_id uuid,
    p_payment_ids uuid[],
    p_check_payment_ids uuid[],
    p_cash_delivered numeric,
    p_notes text,
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, core, portal
AS $$
DECLARE
    v_payment record;
    v_first_payment record;
    v_closure_id uuid;
    v_closure_number text;
    v_sequence integer;
    v_year integer := EXTRACT(YEAR FROM CURRENT_DATE)::integer;
    v_cash numeric(14,2) := 0;
    v_checks numeric(14,2) := 0;
    v_expenses numeric(14,2) := 0;
    v_expected_cash numeric(14,2);
    v_difference numeric(14,2);
    v_status varchar(30);
    v_allocation record;
BEGIN
    IF p_user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Usuario inválido para crear el Cierre de Fondos.';
    END IF;
    IF NOT core.has_company_access(auth.uid(), p_company_id) THEN
        RAISE EXCEPTION 'La empresa no está habilitada para el usuario actual.';
    END IF;
    IF NOT portal.user_has_permission(auth.uid(), 'adquisiciones.route_fund_closures.create')
       OR NOT portal.user_has_permission(auth.uid(), 'adquisiciones.route_fund_closures.close') THEN
        RAISE EXCEPTION 'El usuario no tiene permisos para confirmar el Cierre de Fondos.';
    END IF;
    IF p_cash_delivered < 0 THEN RAISE EXCEPTION 'El efectivo entregado no puede ser negativo.'; END IF;
    IF cardinality(p_payment_ids) IS NULL OR cardinality(p_payment_ids) = 0 THEN
        RAISE EXCEPTION 'Debe seleccionar al menos un Payment.';
    END IF;
    IF cardinality(p_payment_ids) <> (SELECT count(DISTINCT id) FROM unnest(p_payment_ids) AS ids(id)) THEN
        RAISE EXCEPTION 'La selección contiene Payments duplicados.';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_check_payment_ids) id WHERE NOT id = ANY(p_payment_ids)) THEN
        RAISE EXCEPTION 'La selección de cheques no pertenece a los Payments seleccionados.';
    END IF;

    SELECT p.* INTO v_first_payment
    FROM adquisiciones.route_settlement_payments p
    WHERE p.company_id = p_company_id AND p.id = p_payment_ids[1]
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Payment no encontrado.'; END IF;
    IF (SELECT count(*) FROM adquisiciones.route_settlement_payments p
        WHERE p.company_id = p_company_id AND p.id = ANY(p_payment_ids)) <> cardinality(p_payment_ids) THEN
        RAISE EXCEPTION 'Uno o más Payments no pertenecen a la empresa activa.';
    END IF;
    IF v_first_payment.custody_user_id IS NULL THEN
        RAISE EXCEPTION 'Los Payments seleccionados no tienen custodio.';
    END IF;

    FOR v_payment IN
        SELECT p.*, s.workflow_status
        FROM adquisiciones.route_settlement_payments p
        JOIN adquisiciones.route_settlements s ON s.company_id = p.company_id AND s.id = p.settlement_id
        WHERE p.company_id = p_company_id AND p.id = ANY(p_payment_ids)
        FOR UPDATE OF p
    LOOP
        IF v_payment.verification_status <> 'CONFIRMED' OR v_payment.voided_at IS NOT NULL THEN
            RAISE EXCEPTION 'Sólo se pueden cerrar Payments activos y confirmados.';
        END IF;
        IF v_payment.payment_method_received NOT IN ('CASH', 'CHECK') THEN
            RAISE EXCEPTION 'Transferencias no forman parte de Cierre de Fondos.';
        END IF;
        IF v_payment.workflow_status <> 'CLOSED' THEN
            RAISE EXCEPTION 'Sólo se pueden cerrar Rendiciones CLOSED.';
        END IF;
        IF v_payment.custody_user_id IS DISTINCT FROM v_first_payment.custody_user_id THEN
            RAISE EXCEPTION 'No se pueden mezclar custodios en un Cierre de Fondos.';
        END IF;
        IF EXISTS (
            SELECT 1 FROM adquisiciones.route_fund_closure_items i
            JOIN adquisiciones.route_fund_closures fc ON fc.id = i.fund_closure_id
            WHERE i.payment_id = v_payment.id AND i.released_at IS NULL AND fc.status <> 'CANCELLED'
        ) THEN
            RAISE EXCEPTION 'Uno de los Payments ya fue incorporado a otro Cierre de Fondos.';
        END IF;
        IF v_payment.payment_method_received = 'CASH' THEN v_cash := v_cash + v_payment.amount_received;
        ELSE v_checks := v_checks + v_payment.amount_received;
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1 FROM unnest(p_check_payment_ids) id
        WHERE NOT EXISTS (
            SELECT 1 FROM adquisiciones.route_settlement_payments p
            WHERE p.id = id AND p.company_id = p_company_id AND p.payment_method_received = 'CHECK'
        )
    ) THEN RAISE EXCEPTION 'La selección contiene un cheque inválido.'; END IF;
    IF COALESCE(cardinality(p_check_payment_ids), 0) <> (
        SELECT count(*) FROM adquisiciones.route_settlement_payments p
        WHERE p.company_id = p_company_id AND p.id = ANY(p_payment_ids)
          AND p.payment_method_received = 'CHECK'
    ) THEN
        RAISE EXCEPTION 'Debe confirmar la recepción física de cada cheque.';
    END IF;

    SELECT COALESCE(sum(e.amount), 0)::numeric(14,2) INTO v_expenses
    FROM adquisiciones.route_fund_closure_expenses e
    WHERE e.company_id = p_company_id
      AND e.route_settlement_id IN (SELECT DISTINCT settlement_id FROM adquisiciones.route_settlement_payments WHERE id = ANY(p_payment_ids))
      AND e.status = 'ACTIVE' AND e.voided_at IS NULL;
    v_expected_cash := v_cash - v_expenses;
    v_difference := p_cash_delivered - v_expected_cash;
    IF v_difference <> 0 AND COALESCE(length(btrim(p_notes)), 0) < 1 THEN
        RAISE EXCEPTION 'Debe ingresar una explicación para el faltante o sobrante.';
    END IF;
    v_status := CASE WHEN v_difference = 0 THEN 'CLOSED' ELSE 'WITH_DIFFERENCE' END;

    v_sequence := adquisiciones.get_next_route_fund_closure_number(p_company_id, v_year);
    v_closure_number := 'CFC-' || v_year || '-' || lpad(v_sequence::text, 6, '0');
    INSERT INTO adquisiciones.route_fund_closures (
        company_id, closure_number, closure_year, closure_sequence, status,
        total_cash_received, total_check_received, total_expenses, total_pending,
        cash_delivered, physical_difference, notes, created_by, closed_by, closed_at,
        custody_user_id
    ) VALUES (
        p_company_id, v_closure_number, v_year, v_sequence, v_status,
        v_cash, v_checks, v_expenses, v_expected_cash + v_checks,
        p_cash_delivered, v_difference, p_notes, p_user_id, p_user_id, now(),
        v_first_payment.custody_user_id
    ) RETURNING id INTO v_closure_id;

    FOR v_payment IN SELECT * FROM adquisiciones.route_settlement_payments WHERE id = ANY(p_payment_ids) LOOP
        SELECT a.settlement_item_id INTO v_allocation
        FROM adquisiciones.route_settlement_payment_allocations a
        WHERE a.payment_id = v_payment.id AND a.company_id = p_company_id AND a.voided_at IS NULL
        ORDER BY a.created_at LIMIT 1;
        IF NOT FOUND THEN RAISE EXCEPTION 'Payment sin factura asignada.'; END IF;

        INSERT INTO adquisiciones.route_fund_closure_items (
            company_id, fund_closure_id, payment_id, route_settlement_item_id,
            route_settlement_id, route_guide_id, invoice_number, customer_name,
            payment_method, amount, custody_user_id, custody_received_at
        )
        SELECT p_company_id, v_closure_id, v_payment.id, si.id, si.settlement_id,
               rs.route_guide_id, si.invoice_number, si.customer_name,
               v_payment.payment_method_received, v_payment.amount_received,
               v_payment.custody_user_id, v_payment.custody_received_at
        FROM adquisiciones.route_settlement_items si
        JOIN adquisiciones.route_settlements rs ON rs.id = si.settlement_id
        WHERE si.id = v_allocation.settlement_item_id;
    END LOOP;

    UPDATE adquisiciones.route_fund_closure_expenses
    SET fund_closure_id = v_closure_id
    WHERE company_id = p_company_id
      AND route_settlement_id IN (SELECT DISTINCT settlement_id FROM adquisiciones.route_settlement_payments WHERE id = ANY(p_payment_ids))
      AND status = 'ACTIVE' AND voided_at IS NULL AND fund_closure_id IS NULL;

    RETURN jsonb_build_object('closure_id', v_closure_id, 'closure_number', v_closure_number, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.create_route_fund_closure_from_payments(uuid, uuid[], uuid[], numeric, text, uuid)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adquisiciones.create_route_fund_closure_from_payments(uuid, uuid[], uuid[], numeric, text, uuid)
    TO authenticated;
