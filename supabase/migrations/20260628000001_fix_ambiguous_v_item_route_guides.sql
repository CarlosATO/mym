-- MIGRATION: 20260628000001_fix_ambiguous_v_item_route_guides.sql
-- Purpose: Fix ambiguous column reference v_item.value in jsonb_array_elements queries.

-- ============================================================
-- REWRITE: create_route_guide_draft
-- Guarda con warnings si hay duplicados históricos (no bloquea)
-- ============================================================
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
    v_invoice_numbers text[];
    v_duplicates jsonb;
    v_warnings jsonb;
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
        total_invoices, total_amount, total_cash_expected, total_check_expected,
        total_credit, total_transfer, total_unknown_payment,
        error_count, duplicate_count, created_by
    ) VALUES (
        p_company_id, v_year, v_sequence, v_guide_number, (p_guide_data->>'guide_date')::date,
        (p_guide_data->>'route_id')::uuid, p_guide_data->>'route_name_snapshot',
        (p_guide_data->>'vehicle_id')::uuid, p_guide_data->>'vehicle_name_snapshot',
        (p_guide_data->>'driver_id')::uuid, p_guide_data->>'driver_name_snapshot',
        NULLIF(p_guide_data->>'seller_id', '')::uuid, p_guide_data->>'seller_name_snapshot',
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
            v_item.value->>'customer_name', v_item.value->>'customer_address', v_item.value->>'commune',
            (v_item.value->>'amount')::numeric,
            v_item.value->>'payment_method_original', v_item.value->>'payment_method_normalized',
            COALESCE((v_item.value->>'requires_settlement')::boolean, false),
            v_item.value->>'validation_status',
            COALESCE((v_item.value->>'validation_errors')::jsonb, '[]'::jsonb),
            v_item.value->>'notes',
            COALESCE(v_item.value->>'settlement_status', 'NOT_REQUIRED')
        );
    END LOOP;

    -- 4. Check historical duplicates (warning only, does NOT block)
    SELECT array_agg(item_elem.value->>'invoice_number')
    INTO v_invoice_numbers
    FROM jsonb_array_elements(p_items_data) AS item_elem(value)
    WHERE (item_elem.value->>'invoice_number') IS NOT NULL AND TRIM(item_elem.value->>'invoice_number') <> '';

    v_duplicates := '[]'::jsonb;
    IF v_invoice_numbers IS NOT NULL AND array_length(v_invoice_numbers, 1) > 0 THEN
        v_duplicates := logistica.find_historical_duplicate_invoices(p_company_id, v_invoice_numbers, v_guide_id);
    END IF;

    IF jsonb_array_length(v_duplicates) > 0 THEN
        v_warnings := jsonb_build_array(
            jsonb_build_object('type', 'DUPLICATE_INVOICES', 'duplicates', v_duplicates)
        );
    ELSE
        v_warnings := '[]'::jsonb;
    END IF;

    -- 5. Audit log
    INSERT INTO portal.audit_logs (table_name, record_id, action, event_type, module_code, schema_name, performed_by, new_data)
    VALUES ('route_guides', v_guide_id, 'INSERT', 'ROUTE_GUIDE_CREATED', 'logistica', 'logistica', p_user_id,
        jsonb_build_object('guide_number', v_guide_number, 'guide_id', v_guide_id));

    RETURN jsonb_build_object(
        'success', true,
        'id', v_guide_id,
        'guide_number', v_guide_number,
        'status', 'DRAFT',
        'warnings', v_warnings
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;


-- ============================================================
-- REWRITE: update_route_guide_draft
-- Guarda con warnings, EXCLUYE LA MISMA GUIA de la validación
-- ============================================================
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
    v_invoice_numbers text[];
    v_duplicates jsonb;
    v_warnings jsonb;
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
        seller_id = NULLIF(p_guide_data->>'seller_id', '')::uuid,
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
            v_item.value->>'customer_name', v_item.value->>'customer_address', v_item.value->>'commune',
            (v_item.value->>'amount')::numeric,
            v_item.value->>'payment_method_original', v_item.value->>'payment_method_normalized',
            COALESCE((v_item.value->>'requires_settlement')::boolean, false),
            v_item.value->>'validation_status',
            COALESCE((v_item.value->>'validation_errors')::jsonb, '[]'::jsonb),
            v_item.value->>'notes',
            COALESCE(v_item.value->>'settlement_status', 'NOT_REQUIRED')
        );
    END LOOP;

    -- Check historical duplicates, EXCLUDING CURRENT GUIDE (key fix)
    SELECT array_agg(item_elem.value->>'invoice_number')
    INTO v_invoice_numbers
    FROM jsonb_array_elements(p_items_data) AS item_elem(value)
    WHERE (item_elem.value->>'invoice_number') IS NOT NULL AND TRIM(item_elem.value->>'invoice_number') <> '';

    v_duplicates := '[]'::jsonb;
    IF v_invoice_numbers IS NOT NULL AND array_length(v_invoice_numbers, 1) > 0 THEN
        -- Pass p_guide_id as exclude_id so we never flag our own invoices
        v_duplicates := logistica.find_historical_duplicate_invoices(p_company_id, v_invoice_numbers, p_guide_id);
    END IF;

    IF jsonb_array_length(v_duplicates) > 0 THEN
        v_warnings := jsonb_build_array(
            jsonb_build_object('type', 'DUPLICATE_INVOICES', 'duplicates', v_duplicates)
        );
    ELSE
        v_warnings := '[]'::jsonb;
    END IF;

    -- Audit log
    INSERT INTO portal.audit_logs (table_name, record_id, action, event_type, module_code, schema_name, performed_by, new_data)
    VALUES ('route_guides', p_guide_id, 'UPDATE', 'ROUTE_GUIDE_UPDATED', 'logistica', 'logistica', p_user_id, '{}'::jsonb);

    RETURN jsonb_build_object(
        'success', true,
        'id', p_guide_id,
        'status', 'DRAFT',
        'warnings', v_warnings
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
