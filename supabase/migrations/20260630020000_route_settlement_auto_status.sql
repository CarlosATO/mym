-- MIGRATION: 20260630020000_route_settlement_auto_status.sql
-- Estado automatico de Rendicion de Rutas despues de guardar items.

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
    v_relevant_count integer;
    v_pending_count integer;
    v_difference_count integer;
    v_new_status varchar;
BEGIN
    SELECT company_id, status INTO v_company_id, v_status
    FROM adquisiciones.route_settlements
    WHERE id = p_settlement_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'Rendición no encontrada'; END IF;
    IF auth.uid() != p_user_id THEN RAISE EXCEPTION 'Usuario no coincide'; END IF;
    IF NOT core.has_company_access(p_user_id, v_company_id) THEN RAISE EXCEPTION 'No tiene acceso a la empresa de esta rendición'; END IF;
    IF NOT portal.user_has_permission(p_user_id, 'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'No tiene permisos'; END IF;
    IF v_status NOT IN ('IN_REVIEW', 'SETTLED', 'SETTLED_WITH_DIFFERENCE') THEN RAISE EXCEPTION 'Rendición no está en edición'; END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
        v_item_id := (v_item->>'id')::uuid;

        UPDATE adquisiciones.route_settlement_items
        SET
            received_amount = COALESCE(NULLIF(v_item->>'received_amount', '')::numeric, 0),
            difference_amount = expected_amount - COALESCE(NULLIF(v_item->>'received_amount', '')::numeric, 0),
            status = v_item->>'status',
            notes = NULLIF(v_item->>'notes', ''),
            transfer_confirmed = COALESCE(NULLIF(v_item->>'transfer_confirmed', '')::boolean, transfer_confirmed),
            transfer_reference = NULLIF(v_item->>'transfer_reference', ''),
            check_received = COALESCE(NULLIF(v_item->>'check_received', '')::boolean, check_received),
            check_bank = NULLIF(v_item->>'check_bank', ''),
            check_number = NULLIF(v_item->>'check_number', ''),
            check_date = NULLIF(v_item->>'check_date', '')::date,
            check_amount = NULLIF(v_item->>'check_amount', '')::numeric,
            is_pending = COALESCE(NULLIF(v_item->>'is_pending', '')::boolean, is_pending),
            requires_followup = COALESCE(NULLIF(v_item->>'requires_followup', '')::boolean, requires_followup)
        WHERE id = v_item_id
          AND settlement_id = p_settlement_id
          AND company_id = v_company_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Ítem de rendición no encontrado o sin acceso: %', v_item_id;
        END IF;
    END LOOP;

    SELECT count(*) INTO v_relevant_count
    FROM adquisiciones.route_settlement_items
    WHERE settlement_id = p_settlement_id
      AND expected_payment_method IN ('CASH', 'TRANSFER', 'CHECK');

    SELECT count(*) INTO v_difference_count
    FROM adquisiciones.route_settlement_items
    WHERE settlement_id = p_settlement_id
      AND expected_payment_method IN ('CASH', 'TRANSFER', 'CHECK')
      AND (
        status IN ('PARTIAL_PAYMENT', 'DIFFERENCE', 'NOT_DELIVERED', 'REVIEW_REQUIRED')
        OR requires_followup = true
        OR (expected_payment_method IN ('CASH', 'CHECK') AND received_amount > 0 AND difference_amount <> 0)
      );

    SELECT count(*) INTO v_pending_count
    FROM adquisiciones.route_settlement_items
    WHERE settlement_id = p_settlement_id
      AND expected_payment_method IN ('CASH', 'TRANSFER', 'CHECK')
      AND (
        status IN ('PENDING_PAYMENT', 'TRANSFER_PENDING')
        OR (expected_payment_method = 'TRANSFER' AND transfer_confirmed = false)
        OR (expected_payment_method = 'CHECK' AND check_received = false AND status <> 'CHECK_RECEIVED')
      );

    IF v_relevant_count = 0 THEN
        v_new_status := 'IN_REVIEW';
    ELSIF v_difference_count > 0 THEN
        v_new_status := 'SETTLED_WITH_DIFFERENCE';
    ELSIF v_pending_count > 0 THEN
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
        total_transfer_confirmed = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'TRANSFER' AND transfer_confirmed = true),
        total_cash_difference = (SELECT coalesce(sum(difference_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CASH'),
        total_check_difference = (SELECT coalesce(sum(difference_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_pending = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'TRANSFER' AND transfer_confirmed = false),
        total_difference = (SELECT coalesce(sum(difference_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method IN ('CASH', 'CHECK')),
        paid_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND status IN ('PAID_CASH', 'CHECK_RECEIVED', 'TRANSFER_CONFIRMED')),
        pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND is_pending = true),
        difference_count = v_difference_count,
        transfer_pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'TRANSFER' AND transfer_confirmed = false),
        check_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND check_received = true)
    WHERE s.id = p_settlement_id
      AND s.company_id = v_company_id;

    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES ('adquisiciones', 'ADQUISICIONES', 'route_settlements', p_settlement_id, 'UPDATE', jsonb_build_object('items_count', jsonb_array_length(COALESCE(p_items, '[]'::jsonb)), 'status', v_new_status), p_user_id, 'ROUTE_SETTLEMENT_UPDATED', 'INFO');

    RETURN jsonb_build_object('success', true, 'status', v_new_status);
END;
$$;
