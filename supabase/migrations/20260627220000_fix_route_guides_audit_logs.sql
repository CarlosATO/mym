-- MIGRATION: 20260627220000_fix_route_guides_audit_logs.sql

-- 1. Fix logistica.create_route_guide_draft
CREATE OR REPLACE FUNCTION logistica.create_route_guide_draft(
    p_company_id uuid,
    p_guide_data jsonb,
    p_items_data jsonb,
    p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_year integer := date_part('year', (p_guide_data->>'guide_date')::date);
    v_sequence integer;
    v_guide_number text;
    v_guide_id uuid;
    v_item record;
BEGIN
    -- 1. Counter/Lock
    INSERT INTO logistica.route_guide_counters (company_id, guide_year, last_sequence)
    VALUES (p_company_id, v_year, 1)
    ON CONFLICT (company_id, guide_year) DO UPDATE
    SET last_sequence = logistica.route_guide_counters.last_sequence + 1, updated_at = now()
    RETURNING last_sequence INTO v_sequence;

    v_guide_number := 'GR-' || v_year::text || '-' || LPAD(v_sequence::text, 6, '0');

    -- 2. Insert Header
    INSERT INTO logistica.route_guides (
        company_id, guide_year, guide_sequence, guide_number, guide_date,
        route_id, route_name_snapshot,
        vehicle_id, vehicle_name_snapshot,
        driver_id, driver_name_snapshot,
        seller_id, seller_name_snapshot,
        dispatcher_id, dispatcher_name_snapshot,
        notes, status,
        total_invoices, total_amount, total_cash_expected, total_check_expected, total_credit, total_transfer, total_unknown_payment,
        error_count, duplicate_count, created_by
    ) VALUES (
        p_company_id, v_year, v_sequence, v_guide_number, (p_guide_data->>'guide_date')::date,
        (p_guide_data->>'route_id')::uuid, p_guide_data->>'route_name_snapshot',
        (p_guide_data->>'vehicle_id')::uuid, p_guide_data->>'vehicle_name_snapshot',
        (p_guide_data->>'driver_id')::uuid, p_guide_data->>'driver_name_snapshot',
        (p_guide_data->>'seller_id')::uuid, p_guide_data->>'seller_name_snapshot',
        (p_guide_data->>'dispatcher_id')::uuid, p_guide_data->>'dispatcher_name_snapshot',
        p_guide_data->>'notes', 'DRAFT',
        COALESCE((p_guide_data->>'total_invoices')::integer, 0),
        COALESCE((p_guide_data->>'total_amount')::numeric, 0),
        COALESCE((p_guide_data->>'total_cash_expected')::numeric, 0),
        COALESCE((p_guide_data->>'total_check_expected')::numeric, 0),
        COALESCE((p_guide_data->>'total_credit')::numeric, 0),
        COALESCE((p_guide_data->>'total_transfer')::numeric, 0),
        COALESCE((p_guide_data->>'total_unknown_payment')::numeric, 0),
        COALESCE((p_guide_data->>'error_count')::integer, 0),
        COALESCE((p_guide_data->>'duplicate_count')::integer, 0),
        p_user_id
    ) RETURNING id INTO v_guide_id;

    -- 3. Insert Items
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items_data) LOOP
        INSERT INTO logistica.route_guide_items (
            company_id, route_guide_id, line_number, invoice_number,
            customer_name, customer_address, commune, amount,
            payment_method_original, payment_method_normalized, requires_settlement,
            validation_status, validation_errors, notes, settlement_status
        ) VALUES (
            p_company_id, v_guide_id, (v_item.value->>'line_number')::integer, v_item.value->>'invoice_number',
            v_item.value->>'customer_name', v_item.value->>'customer_address', v_item.value->>'commune', (v_item.value->>'amount')::numeric,
            v_item.value->>'payment_method_original', v_item.value->>'payment_method_normalized', (v_item.value->>'requires_settlement')::boolean,
            v_item.value->>'validation_status', (v_item.value->>'validation_errors')::jsonb, v_item.value->>'notes',
            COALESCE(v_item.value->>'settlement_status', 'NOT_REQUIRED')
        );
    END LOOP;
    
    -- Audit log
    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES ('logistica', 'LOGISTICA', 'route_guides', v_guide_id, 'INSERT', jsonb_build_object('guide_number', v_guide_number), p_user_id, 'ROUTE_GUIDE_CREATED', 'INFO');

    RETURN jsonb_build_object('success', true, 'id', v_guide_id, 'guide_number', v_guide_number);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;


-- 2. Fix logistica.update_route_guide_draft
CREATE OR REPLACE FUNCTION logistica.update_route_guide_draft(
    p_company_id uuid,
    p_guide_id uuid,
    p_guide_data jsonb,
    p_items_data jsonb,
    p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_status text;
    v_item record;
BEGIN
    SELECT status INTO v_status FROM logistica.route_guides WHERE id = p_guide_id AND company_id = p_company_id;
    IF v_status IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Guía no encontrada');
    END IF;
    IF v_status <> 'DRAFT' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sólo se pueden editar guías en borrador');
    END IF;

    -- Update Header
    UPDATE logistica.route_guides SET
        guide_date = (p_guide_data->>'guide_date')::date,
        route_id = (p_guide_data->>'route_id')::uuid,
        route_name_snapshot = p_guide_data->>'route_name_snapshot',
        vehicle_id = (p_guide_data->>'vehicle_id')::uuid,
        vehicle_name_snapshot = p_guide_data->>'vehicle_name_snapshot',
        driver_id = (p_guide_data->>'driver_id')::uuid,
        driver_name_snapshot = p_guide_data->>'driver_name_snapshot',
        seller_id = (p_guide_data->>'seller_id')::uuid,
        seller_name_snapshot = p_guide_data->>'seller_name_snapshot',
        dispatcher_id = (p_guide_data->>'dispatcher_id')::uuid,
        dispatcher_name_snapshot = p_guide_data->>'dispatcher_name_snapshot',
        notes = p_guide_data->>'notes',
        total_invoices = COALESCE((p_guide_data->>'total_invoices')::integer, 0),
        total_amount = COALESCE((p_guide_data->>'total_amount')::numeric, 0),
        total_cash_expected = COALESCE((p_guide_data->>'total_cash_expected')::numeric, 0),
        total_check_expected = COALESCE((p_guide_data->>'total_check_expected')::numeric, 0),
        total_credit = COALESCE((p_guide_data->>'total_credit')::numeric, 0),
        total_transfer = COALESCE((p_guide_data->>'total_transfer')::numeric, 0),
        total_unknown_payment = COALESCE((p_guide_data->>'total_unknown_payment')::numeric, 0),
        error_count = COALESCE((p_guide_data->>'error_count')::integer, 0),
        duplicate_count = COALESCE((p_guide_data->>'duplicate_count')::integer, 0),
        updated_at = now()
    WHERE id = p_guide_id AND company_id = p_company_id;

    -- Replace items
    DELETE FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items_data) LOOP
        INSERT INTO logistica.route_guide_items (
            company_id, route_guide_id, line_number, invoice_number,
            customer_name, customer_address, commune, amount,
            payment_method_original, payment_method_normalized, requires_settlement,
            validation_status, validation_errors, notes, settlement_status
        ) VALUES (
            p_company_id, p_guide_id, (v_item.value->>'line_number')::integer, v_item.value->>'invoice_number',
            v_item.value->>'customer_name', v_item.value->>'customer_address', v_item.value->>'commune', (v_item.value->>'amount')::numeric,
            v_item.value->>'payment_method_original', v_item.value->>'payment_method_normalized', (v_item.value->>'requires_settlement')::boolean,
            v_item.value->>'validation_status', (v_item.value->>'validation_errors')::jsonb, v_item.value->>'notes',
            COALESCE(v_item.value->>'settlement_status', 'NOT_REQUIRED')
        );
    END LOOP;

    -- Audit log
    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES ('logistica', 'LOGISTICA', 'route_guides', p_guide_id, 'UPDATE', '{}', p_user_id, 'ROUTE_GUIDE_UPDATED', 'INFO');

    RETURN jsonb_build_object('success', true, 'id', p_guide_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;


-- 3. Fix logistica.dispatch_route_guide
CREATE OR REPLACE FUNCTION logistica.dispatch_route_guide(
    p_company_id uuid,
    p_guide_id uuid,
    p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_guide logistica.route_guides%ROWTYPE;
    v_has_errors boolean;
    v_has_unknown boolean;
    v_historical_dup boolean;
    v_internal_dup boolean;
    v_item record;
    
    v_total_invoices int := 0;
    v_total_amount numeric := 0;
    v_total_cash numeric := 0;
    v_total_check numeric := 0;
    v_total_credit numeric := 0;
    v_total_transfer numeric := 0;
BEGIN
    SELECT * INTO v_guide FROM logistica.route_guides WHERE id = p_guide_id AND company_id = p_company_id FOR UPDATE;
    IF v_guide.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Guía no encontrada');
    END IF;
    IF v_guide.status <> 'DRAFT' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sólo se pueden despachar guías en borrador');
    END IF;

    -- Enforce fields exist for Dispatch
    IF v_guide.route_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Falta ruta para despachar.'); END IF;
    IF v_guide.vehicle_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Falta vehículo para despachar.'); END IF;
    IF v_guide.driver_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Falta conductor para despachar.'); END IF;
    IF v_guide.seller_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Falta vendedor para despachar.'); END IF;
    IF v_guide.dispatcher_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Falta despachador para despachar.'); END IF;

    -- Enforce catalogs are active
    IF NOT EXISTS (SELECT 1 FROM logistica.delivery_routes WHERE id = v_guide.route_id AND is_active = true) THEN
        RETURN jsonb_build_object('success', false, 'error', 'La ruta seleccionada no está activa.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM logistica.route_vehicles WHERE id = v_guide.vehicle_id AND is_active = true) THEN
        RETURN jsonb_build_object('success', false, 'error', 'El vehículo seleccionado no está activo.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM logistica.route_personnel WHERE id = v_guide.driver_id AND is_active = true) THEN
        RETURN jsonb_build_object('success', false, 'error', 'El conductor seleccionado no está activo.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM logistica.route_personnel WHERE id = v_guide.seller_id AND is_active = true) THEN
        RETURN jsonb_build_object('success', false, 'error', 'El vendedor seleccionado no está activo.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM logistica.route_personnel WHERE id = v_guide.dispatcher_id AND is_active = true) THEN
        RETURN jsonb_build_object('success', false, 'error', 'El despachador seleccionado no está activo.');
    END IF;

    -- Validations
    SELECT EXISTS (SELECT 1 FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id AND validation_status = 'INVALID') INTO v_has_errors;
    IF v_has_errors THEN
        RETURN jsonb_build_object('success', false, 'error', 'No se puede despachar una guía con filas inválidas.');
    END IF;

    SELECT EXISTS (SELECT 1 FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id AND payment_method_normalized = 'UNKNOWN') INTO v_has_unknown;
    IF v_has_unknown THEN
        RETURN jsonb_build_object('success', false, 'error', 'No se puede despachar con formas de pago desconocidas (UNKNOWN).');
    END IF;

    -- Check internal dupes
    SELECT EXISTS (
        SELECT invoice_number FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id GROUP BY invoice_number HAVING count(*) > 1
    ) INTO v_internal_dup;
    IF v_internal_dup THEN
        RETURN jsonb_build_object('success', false, 'error', 'No se puede despachar con facturas duplicadas en la misma guía.');
    END IF;

    -- Check historical dupes (other guides that are not cancelled)
    SELECT EXISTS (
        SELECT 1 FROM logistica.route_guide_items rgi
        JOIN logistica.route_guides rg ON rgi.route_guide_id = rg.id
        WHERE rgi.company_id = p_company_id
          AND rg.status IN ('DRAFT', 'DISPATCHED')
          AND rg.id <> p_guide_id
          AND rgi.invoice_number IN (SELECT invoice_number FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id)
    ) INTO v_historical_dup;
    
    IF v_historical_dup THEN
        RETURN jsonb_build_object('success', false, 'error', 'No se puede despachar. Una o más facturas ya están incluidas en otra guía activa.');
    END IF;

    -- Recalculate totals
    FOR v_item IN SELECT * FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id LOOP
        v_total_invoices := v_total_invoices + 1;
        v_total_amount := v_total_amount + v_item.amount;
        
        IF v_item.payment_method_normalized = 'CASH' THEN v_total_cash := v_total_cash + v_item.amount;
        ELSIF v_item.payment_method_normalized = 'CHECK' THEN v_total_check := v_total_check + v_item.amount;
        ELSIF v_item.payment_method_normalized = 'CREDIT' THEN v_total_credit := v_total_credit + v_item.amount;
        ELSIF v_item.payment_method_normalized = 'TRANSFER' THEN v_total_transfer := v_total_transfer + v_item.amount;
        END IF;
    END LOOP;

    -- Dispatch
    UPDATE logistica.route_guides SET
        status = 'DISPATCHED',
        dispatched_at = now(),
        updated_at = now(),
        total_invoices = v_total_invoices,
        total_amount = v_total_amount,
        total_cash_expected = v_total_cash,
        total_check_expected = v_total_check,
        total_credit = v_total_credit,
        total_transfer = v_total_transfer,
        total_unknown_payment = 0,
        error_count = 0,
        duplicate_count = 0
    WHERE id = p_guide_id;

    -- Audit log
    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES ('logistica', 'LOGISTICA', 'route_guides', p_guide_id, 'UPDATE', '{}', p_user_id, 'ROUTE_GUIDE_DISPATCHED', 'INFO');

    RETURN jsonb_build_object('success', true, 'id', p_guide_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
