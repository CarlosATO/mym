-- MIGRATION: 20260628000003_fix_route_settlements_audit_logs.sql

-- 1. Fix adquisiciones.create_route_settlement_from_guide
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
BEGIN
    -- 1. Get guide info
    SELECT company_id, status INTO v_company_id, v_status
    FROM logistica.route_guides
    WHERE id = p_route_guide_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Guía de ruta no encontrada';
    END IF;

    -- 2. Validations
    IF auth.uid() != p_user_id THEN
        RAISE EXCEPTION 'Usuario no coincide con la sesión';
    END IF;
    
    IF NOT core.has_company_access(p_user_id, v_company_id) THEN
        RAISE EXCEPTION 'No tiene acceso a la empresa de esta guía';
    END IF;
    
    IF NOT portal.user_has_permission(p_user_id, 'adquisiciones.route_settlements.create') THEN
        RAISE EXCEPTION 'No tiene permiso para crear rendiciones';
    END IF;

    IF v_status != 'DISPATCHED' THEN
        RAISE EXCEPTION 'Solo se pueden rendir guías despachadas';
    END IF;

    IF EXISTS (SELECT 1 FROM adquisiciones.route_settlements WHERE route_guide_id = p_route_guide_id AND status != 'CANCELLED') THEN
        RAISE EXCEPTION 'Ya existe una rendición activa para esta guía';
    END IF;

    -- 3. Sequence and Number
    v_year := extract(year from current_date);
    
    INSERT INTO adquisiciones.route_settlement_counters (company_id, settlement_year, last_sequence)
    VALUES (v_company_id, v_year, 1)
    ON CONFLICT (company_id, settlement_year) 
    DO UPDATE SET last_sequence = adquisiciones.route_settlement_counters.last_sequence + 1
    RETURNING last_sequence INTO v_seq;

    v_number := 'RR-' || v_year::text || '-' || lpad(v_seq::text, 6, '0');

    -- 4. Insert Header
    INSERT INTO adquisiciones.route_settlements (
        company_id, route_guide_id, settlement_number, settlement_year, settlement_sequence,
        settlement_date, status, received_by, created_by
    ) VALUES (
        v_company_id, p_route_guide_id, v_number, v_year, v_seq,
        current_date, 'IN_REVIEW', p_user_id, p_user_id
    ) RETURNING id INTO v_settlement_id;

    -- 5. Insert Items (Initialization logic based on requested conditions)
    INSERT INTO adquisiciones.route_settlement_items (
        company_id, settlement_id, route_guide_item_id,
        invoice_number, customer_name, expected_payment_method, expected_amount,
        status, received_amount, difference_amount, is_pending
    )
    SELECT 
        v_company_id, v_settlement_id, i.id,
        i.invoice_number, i.customer_name, i.payment_method_normalized, i.amount,
        CASE 
            WHEN i.payment_method_normalized = 'CASH' THEN 'PENDING_PAYMENT'
            WHEN i.payment_method_normalized = 'CHECK' THEN 'PENDING_PAYMENT'
            WHEN i.payment_method_normalized = 'TRANSFER' THEN 'TRANSFER_PENDING'
            WHEN i.payment_method_normalized = 'CREDIT' THEN 'CREDIT_REGISTERED'
            ELSE 'REVIEW_REQUIRED'
        END,
        0, -- received_amount
        CASE WHEN i.payment_method_normalized IN ('CASH', 'CHECK') THEN i.amount ELSE 0 END, -- difference_amount
        CASE WHEN i.payment_method_normalized IN ('CASH', 'CHECK') THEN true ELSE false END -- is_pending
    FROM logistica.route_guide_items i
    WHERE i.route_guide_id = p_route_guide_id
      AND i.invoice_number != ''; -- ignore empty rows

    -- 6. Recalculate totals (We use the update logic here or do it directly)
    -- We can call the recalculation function directly or inline it. Let's do it in a shared way or just inline here since it's initial.
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

    -- 7. Audit (CORREGIDO)
    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES ('adquisiciones', 'ADQUISICIONES', 'route_settlements', v_settlement_id, 'INSERT', jsonb_build_object('settlement_number', v_number, 'route_guide_id', p_route_guide_id), p_user_id, 'ROUTE_SETTLEMENT_CREATED', 'INFO');

    RETURN jsonb_build_object('success', true, 'id', v_settlement_id, 'settlement_number', v_number);
END;
$$;


-- 2. Fix adquisiciones.update_route_settlement
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
BEGIN
    SELECT company_id, status INTO v_company_id, v_status
    FROM adquisiciones.route_settlements
    WHERE id = p_settlement_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'Rendición no encontrada'; END IF;
    IF auth.uid() != p_user_id THEN RAISE EXCEPTION 'Usuario no coincide'; END IF;
    IF NOT portal.user_has_permission(p_user_id, 'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'No tiene permisos'; END IF;
    IF v_status != 'IN_REVIEW' THEN RAISE EXCEPTION 'Rendición no está en edición (IN_REVIEW)'; END IF;

    -- Update Items
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_item_id := (v_item->>'id')::uuid;
        
        UPDATE adquisiciones.route_settlement_items
        SET
            received_amount = (v_item->>'received_amount')::numeric,
            difference_amount = expected_amount - (v_item->>'received_amount')::numeric,
            status = v_item->>'status',
            notes = v_item->>'notes',
            
            transfer_confirmed = COALESCE((v_item->>'transfer_confirmed')::boolean, transfer_confirmed),
            transfer_reference = v_item->>'transfer_reference',
            
            check_received = COALESCE((v_item->>'check_received')::boolean, check_received),
            check_bank = v_item->>'check_bank',
            check_number = v_item->>'check_number',
            check_date = (v_item->>'check_date')::date,
            check_amount = (v_item->>'check_amount')::numeric,
            
            is_pending = COALESCE((v_item->>'is_pending')::boolean, is_pending),
            requires_followup = COALESCE((v_item->>'requires_followup')::boolean, requires_followup)
        WHERE id = v_item_id AND settlement_id = p_settlement_id;
    END LOOP;

    -- Recalculate totals
    UPDATE adquisiciones.route_settlements s
    SET 
        notes = p_notes,
        total_cash_received = (SELECT coalesce(sum(received_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CASH'),
        total_check_received = (SELECT coalesce(sum(received_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_confirmed = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'TRANSFER' AND transfer_confirmed = true),
        
        total_cash_difference = (SELECT coalesce(sum(difference_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CASH'),
        total_check_difference = (SELECT coalesce(sum(difference_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_pending = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'TRANSFER' AND transfer_confirmed = false),
        
        total_difference = (SELECT coalesce(sum(difference_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method IN ('CASH', 'CHECK')),
        
        paid_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND status IN ('PAID_CASH', 'CHECK_RECEIVED')),
        pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND is_pending = true),
        difference_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND difference_amount > 0 AND expected_payment_method IN ('CASH', 'CHECK')),
        transfer_pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'TRANSFER' AND transfer_confirmed = false),
        check_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND check_received = true)
    WHERE s.id = p_settlement_id;

    -- Audit (CORREGIDO)
    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES ('adquisiciones', 'ADQUISICIONES', 'route_settlements', p_settlement_id, 'UPDATE', '{}', p_user_id, 'ROUTE_SETTLEMENT_UPDATED', 'INFO');

    RETURN jsonb_build_object('success', true);
END;
$$;


-- 3. Fix adquisiciones.close_route_settlement
CREATE OR REPLACE FUNCTION adquisiciones.close_route_settlement(
    p_settlement_id uuid,
    p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_company_id uuid;
    v_status varchar;
    v_total_difference numeric;
    v_transfer_pending_count integer;
    v_pending_count integer;
    v_review_required integer;
    v_new_status varchar;
BEGIN
    SELECT company_id, status INTO v_company_id, v_status
    FROM adquisiciones.route_settlements
    WHERE id = p_settlement_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'Rendición no encontrada'; END IF;
    IF auth.uid() != p_user_id THEN RAISE EXCEPTION 'Usuario no coincide'; END IF;
    IF NOT portal.user_has_permission(p_user_id, 'adquisiciones.route_settlements.close') THEN RAISE EXCEPTION 'No tiene permisos para cerrar rendición'; END IF;
    IF v_status != 'IN_REVIEW' THEN RAISE EXCEPTION 'Solo se puede cerrar rendición en edición'; END IF;

    -- Ensure latest recalculation
    SELECT 
        total_difference, 
        transfer_pending_count, 
        pending_count,
        (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND status = 'REVIEW_REQUIRED')
    INTO 
        v_total_difference, 
        v_transfer_pending_count, 
        v_pending_count,
        v_review_required
    FROM adquisiciones.route_settlements WHERE id = p_settlement_id;

    IF v_review_required > 0 THEN
        RAISE EXCEPTION 'Hay formas de pago desconocidas (UNKNOWN) que requieren revisión antes de cerrar.';
    END IF;

    IF v_total_difference > 0 OR v_transfer_pending_count > 0 OR v_pending_count > 0 THEN
        v_new_status := 'SETTLED_WITH_DIFFERENCE';
    ELSE
        v_new_status := 'SETTLED';
    END IF;

    UPDATE adquisiciones.route_settlements
    SET 
        status = v_new_status,
        closed_by = p_user_id,
        closed_at = now()
    WHERE id = p_settlement_id;

    -- Audit (CORREGIDO)
    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES ('adquisiciones', 'ADQUISICIONES', 'route_settlements', p_settlement_id, 'UPDATE', jsonb_build_object('new_status', v_new_status), p_user_id, 'ROUTE_SETTLEMENT_CLOSED', 'INFO');

    RETURN jsonb_build_object('success', true, 'status', v_new_status);
END;
$$;
