-- MIGRATION: 20260630040000_fix_route_settlement_transfer_confirmed_totals.sql
-- Corrige totales/estado cuando transferencias confirmadas mantenian flags pendientes.

CREATE OR REPLACE FUNCTION adquisiciones.update_route_settlement(
    p_settlement_id uuid,
    p_items jsonb,
    p_notes text,
    p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_company_id uuid;
    v_status varchar;
    v_item jsonb;
    v_item_id uuid;
    v_item_status text;
    v_received numeric;
    v_relevant_count integer;
    v_blocking_pending_count integer;
    v_blocking_difference_count integer;
    v_new_status varchar;
BEGIN
    SELECT company_id, status INTO v_company_id, v_status
    FROM adquisiciones.route_settlements
    WHERE id = p_settlement_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'Rendición no encontrada'; END IF;
    IF auth.uid() != p_user_id THEN RAISE EXCEPTION 'Usuario no coincide'; END IF;
    IF NOT core.has_company_access(p_user_id, v_company_id) THEN RAISE EXCEPTION 'No tiene acceso a la empresa de esta rendición'; END IF;
    IF NOT portal.user_has_permission(p_user_id, 'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'No tiene permisos'; END IF;
    IF v_status IN ('CLOSED', 'CANCELLED') THEN RAISE EXCEPTION 'Rendición cerrada o anulada no permite edición'; END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
        v_item_id := (v_item->>'id')::uuid;
        v_item_status := v_item->>'status';
        v_received := COALESCE(NULLIF(v_item->>'received_amount', '')::numeric, 0);

        UPDATE adquisiciones.route_settlement_items
        SET
            received_amount = CASE
                WHEN v_item_status IN ('TRANSFER_CONFIRMED', 'CHECK_RECEIVED') AND v_received = 0 THEN expected_amount
                ELSE v_received
            END,
            difference_amount = CASE
                WHEN v_item_status = 'TRANSFER_CONFIRMED' THEN 0
                WHEN v_item_status IN ('CHECK_RECEIVED') AND v_received = 0 THEN 0
                ELSE expected_amount - v_received
            END,
            status = v_item_status,
            notes = NULLIF(v_item->>'notes', ''),
            transfer_confirmed = CASE
                WHEN v_item_status = 'TRANSFER_CONFIRMED' THEN true
                ELSE COALESCE(NULLIF(v_item->>'transfer_confirmed', '')::boolean, transfer_confirmed)
            END,
            transfer_reference = NULLIF(v_item->>'transfer_reference', ''),
            check_received = CASE
                WHEN v_item_status = 'CHECK_RECEIVED' THEN true
                ELSE COALESCE(NULLIF(v_item->>'check_received', '')::boolean, check_received)
            END,
            check_bank = NULLIF(v_item->>'check_bank', ''),
            check_number = NULLIF(v_item->>'check_number', ''),
            check_date = NULLIF(v_item->>'check_date', '')::date,
            check_amount = NULLIF(v_item->>'check_amount', '')::numeric,
            is_pending = CASE
                WHEN v_item_status IN ('PAID_CASH', 'TRANSFER_CONFIRMED', 'CHECK_RECEIVED') THEN false
                ELSE COALESCE(NULLIF(v_item->>'is_pending', '')::boolean, is_pending)
            END,
            requires_followup = COALESCE(NULLIF(v_item->>'requires_followup', '')::boolean, requires_followup)
        WHERE id = v_item_id
          AND settlement_id = p_settlement_id
          AND company_id = v_company_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Ítem de rendición no encontrado o sin acceso: %', v_item_id;
        END IF;
    END LOOP;

    -- Normaliza estados finales ya persistidos para evitar que flags antiguos sigan bloqueando SETTLED.
    UPDATE adquisiciones.route_settlement_items
    SET
        transfer_confirmed = CASE WHEN status = 'TRANSFER_CONFIRMED' THEN true ELSE transfer_confirmed END,
        check_received = CASE WHEN status = 'CHECK_RECEIVED' THEN true ELSE check_received END,
        received_amount = CASE
            WHEN status IN ('TRANSFER_CONFIRMED', 'CHECK_RECEIVED') AND received_amount = 0 THEN expected_amount
            ELSE received_amount
        END,
        difference_amount = CASE
            WHEN status = 'TRANSFER_CONFIRMED' THEN 0
            WHEN status IN ('PAID_CASH', 'CHECK_RECEIVED') THEN expected_amount - CASE WHEN received_amount = 0 THEN expected_amount ELSE received_amount END
            ELSE difference_amount
        END,
        is_pending = CASE
            WHEN status IN ('PAID_CASH', 'TRANSFER_CONFIRMED', 'CHECK_RECEIVED') THEN false
            ELSE is_pending
        END
    WHERE settlement_id = p_settlement_id
      AND company_id = v_company_id;

    SELECT count(*) INTO v_relevant_count
    FROM adquisiciones.route_settlement_items
    WHERE settlement_id = p_settlement_id
      AND expected_payment_method IN ('CASH', 'TRANSFER', 'CHECK');

    SELECT count(*) INTO v_blocking_difference_count
    FROM adquisiciones.route_settlement_items
    WHERE settlement_id = p_settlement_id
      AND expected_payment_method IN ('CASH', 'TRANSFER', 'CHECK')
      AND (
        status IN ('PARTIAL_PAYMENT', 'DIFFERENCE', 'NOT_DELIVERED', 'REVIEW_REQUIRED')
        OR requires_followup = true
        OR (expected_payment_method IN ('CASH', 'CHECK') AND difference_amount <> 0)
      );

    SELECT count(*) INTO v_blocking_pending_count
    FROM adquisiciones.route_settlement_items
    WHERE settlement_id = p_settlement_id
      AND expected_payment_method IN ('CASH', 'TRANSFER', 'CHECK')
      AND (
        is_pending = true
        OR status IN ('PENDING_PAYMENT', 'TRANSFER_PENDING', 'CHECK_PENDING', 'REVIEW_REQUIRED')
        OR (expected_payment_method = 'CASH' AND (status <> 'PAID_CASH' OR received_amount <> expected_amount OR difference_amount <> 0))
        OR (expected_payment_method = 'TRANSFER' AND (status <> 'TRANSFER_CONFIRMED' OR COALESCE(transfer_confirmed, false) = false))
        OR (expected_payment_method = 'CHECK' AND (status <> 'CHECK_RECEIVED' OR COALESCE(check_received, false) = false OR difference_amount <> 0))
      );

    IF v_relevant_count = 0 THEN
        v_new_status := 'IN_REVIEW';
    ELSIF v_blocking_difference_count > 0 THEN
        v_new_status := 'SETTLED_WITH_DIFFERENCE';
    ELSIF v_blocking_pending_count > 0 THEN
        v_new_status := 'IN_REVIEW';
    ELSE
        v_new_status := 'SETTLED';
    END IF;

    UPDATE adquisiciones.route_settlements s
    SET
        notes = p_notes,
        status = v_new_status,
        total_cash_received = (SELECT coalesce(sum(received_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CASH'),
        total_check_received = (SELECT coalesce(sum(received_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_confirmed = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'TRANSFER' AND (status = 'TRANSFER_CONFIRMED' OR COALESCE(transfer_confirmed, false) = true)),
        total_cash_difference = (SELECT coalesce(sum(difference_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CASH'),
        total_check_difference = (SELECT coalesce(sum(difference_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_pending = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'TRANSFER' AND status <> 'TRANSFER_CONFIRMED' AND COALESCE(transfer_confirmed, false) = false),
        total_difference = (SELECT coalesce(sum(difference_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method IN ('CASH', 'CHECK')),
        paid_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method IN ('CASH', 'TRANSFER', 'CHECK') AND status IN ('PAID_CASH', 'CHECK_RECEIVED', 'TRANSFER_CONFIRMED')),
        pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method IN ('CASH', 'TRANSFER', 'CHECK') AND is_pending = true),
        difference_count = v_blocking_difference_count,
        transfer_pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'TRANSFER' AND status <> 'TRANSFER_CONFIRMED' AND COALESCE(transfer_confirmed, false) = false),
        check_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CHECK' AND status = 'CHECK_RECEIVED')
    WHERE s.id = p_settlement_id
      AND s.company_id = v_company_id;

    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES ('adquisiciones', 'ADQUISICIONES', 'route_settlements', p_settlement_id, 'UPDATE', jsonb_build_object('items_count', jsonb_array_length(COALESCE(p_items, '[]'::jsonb)), 'status', v_new_status), p_user_id, 'ROUTE_SETTLEMENT_UPDATED', 'INFO');

    RETURN jsonb_build_object('success', true, 'status', v_new_status);
END;
$$;
