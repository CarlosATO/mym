-- Make route settlement start safe for retries and concurrent requests.

CREATE OR REPLACE FUNCTION adquisiciones.create_route_settlement_from_guide(
    p_route_guide_id uuid,
    p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_company_id uuid;
    v_status varchar;
    v_year integer;
    v_seq integer;
    v_number text;
    v_settlement_id uuid;
    v_existing_id uuid;
    v_existing_number text;
    v_existing_status varchar;
    v_constraint_name text;
BEGIN
    SELECT company_id, status INTO v_company_id, v_status
    FROM logistica.route_guides
    WHERE id = p_route_guide_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Guía de ruta no encontrada';
    END IF;

    IF auth.uid() != p_user_id THEN
        RAISE EXCEPTION 'Usuario no coincide con la sesión';
    END IF;

    IF NOT core.has_company_access(p_user_id, v_company_id) THEN
        RAISE EXCEPTION 'No tiene acceso a la empresa de esta guía';
    END IF;

    IF NOT portal.user_has_permission(p_user_id, 'adquisiciones.route_settlements.create') THEN
        RAISE EXCEPTION 'No tiene permiso para crear rendiciones';
    END IF;

    SELECT id, settlement_number, status
    INTO v_existing_id, v_existing_number, v_existing_status
    FROM adquisiciones.route_settlements
    WHERE route_guide_id = p_route_guide_id;

    IF FOUND THEN
        IF v_existing_status = 'CANCELLED' THEN
            RAISE EXCEPTION 'La guía ya tiene una rendición anulada y no puede reutilizarse.';
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'created', false,
            'replayed', true,
            'id', v_existing_id,
            'settlement_id', v_existing_id,
            'route_guide_id', p_route_guide_id,
            'settlement_number', v_existing_number,
            'status', v_existing_status
        );
    END IF;

    IF v_status != 'DISPATCHED' THEN
        RAISE EXCEPTION 'Solo se pueden rendir guías despachadas';
    END IF;

    v_year := extract(year from current_date);

    INSERT INTO adquisiciones.route_settlement_counters (company_id, settlement_year, last_sequence)
    VALUES (v_company_id, v_year, 1)
    ON CONFLICT (company_id, settlement_year)
    DO UPDATE SET last_sequence = adquisiciones.route_settlement_counters.last_sequence + 1
    RETURNING last_sequence INTO v_seq;

    v_number := 'RR-' || v_year::text || '-' || lpad(v_seq::text, 6, '0');

    BEGIN
        INSERT INTO adquisiciones.route_settlements (
            company_id, route_guide_id, settlement_number, settlement_year, settlement_sequence,
            settlement_date, status, received_by, created_by
        ) VALUES (
            v_company_id, p_route_guide_id, v_number, v_year, v_seq,
            current_date, 'IN_REVIEW', p_user_id, p_user_id
        ) RETURNING id INTO v_settlement_id;
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
        IF v_constraint_name <> 'route_settlements_route_guide_id_key' THEN
            RAISE;
        END IF;

        SELECT id, settlement_number, status
        INTO v_existing_id, v_existing_number, v_existing_status
        FROM adquisiciones.route_settlements
        WHERE route_guide_id = p_route_guide_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'No se pudo iniciar la rendición porque la guía fue procesada simultáneamente.';
        END IF;

        IF v_existing_status = 'CANCELLED' THEN
            RAISE EXCEPTION 'La guía ya tiene una rendición anulada y no puede reutilizarse.';
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'created', false,
            'replayed', true,
            'id', v_existing_id,
            'settlement_id', v_existing_id,
            'route_guide_id', p_route_guide_id,
            'settlement_number', v_existing_number,
            'status', v_existing_status
        );
    END;

    INSERT INTO adquisiciones.route_settlement_items (
        company_id, settlement_id, route_guide_item_id,
        invoice_number, customer_name, expected_payment_method, expected_amount,
        status, received_amount, difference_amount, is_pending
    )
    SELECT
        v_company_id, v_settlement_id, i.id,
        i.invoice_number, i.customer_name, i.payment_method_normalized, i.amount,
        CASE
            WHEN i.payment_method_normalized IN ('CASH', 'CHECK') THEN 'PENDING_PAYMENT'
            WHEN i.payment_method_normalized = 'TRANSFER' THEN 'TRANSFER_PENDING'
            WHEN i.payment_method_normalized = 'CREDIT' THEN 'CREDIT_REGISTERED'
            ELSE 'REVIEW_REQUIRED'
        END,
        0,
        CASE WHEN i.payment_method_normalized IN ('CASH', 'CHECK') THEN i.amount ELSE 0 END,
        CASE WHEN i.payment_method_normalized IN ('CASH', 'CHECK') THEN true ELSE false END
    FROM logistica.route_guide_items i
    WHERE i.route_guide_id = p_route_guide_id
      AND i.invoice_number != '';

    UPDATE adquisiciones.route_settlements s
    SET
        total_invoices = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id),
        total_route_amount = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id),
        total_cash_expected = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CASH'),
        total_check_expected = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_expected = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'TRANSFER'),
        total_credit_amount = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CREDIT'),
        total_cash_difference = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CASH'),
        total_check_difference = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_pending = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'TRANSFER'),
        pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method IN ('CASH', 'CHECK')),
        transfer_pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'TRANSFER'),
        total_difference = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method IN ('CASH', 'CHECK'))
    WHERE s.id = v_settlement_id;

    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES ('adquisiciones', 'ADQUISICIONES', 'route_settlements', v_settlement_id, 'INSERT', jsonb_build_object('settlement_number', v_number, 'route_guide_id', p_route_guide_id), p_user_id, 'ROUTE_SETTLEMENT_CREATED', 'INFO');

    RETURN jsonb_build_object(
        'success', true,
        'created', true,
        'replayed', false,
        'id', v_settlement_id,
        'settlement_id', v_settlement_id,
        'route_guide_id', p_route_guide_id,
        'settlement_number', v_number,
        'status', 'IN_REVIEW'
    );
END;
$$;
