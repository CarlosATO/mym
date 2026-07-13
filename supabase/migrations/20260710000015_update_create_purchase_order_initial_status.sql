-- ============================================================================
-- Migration: Update create_purchase_order initial status
-- Description: Modifica el RPC adquisiciones.create_purchase_order para aceptar
--              un estado inicial opcional (p_data->>'status'). 
--              Por defecto usa 'EMITIDA' para mantener compatibilidad hacia atrás.
--              Solo permite crear en 'EMITIDA' o 'BORRADOR'.
-- ============================================================================

CREATE OR REPLACE FUNCTION adquisiciones.create_purchase_order(
    p_data jsonb,
    p_user_id uuid,
    p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_po_id uuid;
    v_corr text;
    v_item jsonb;
    v_net numeric(14,2) := 0;
    v_disc numeric(14,2) := 0;
    v_tax numeric(14,2) := 0;
    v_exempt numeric(14,2) := 0;
    v_total numeric(14,2) := 0;
    v_line_total numeric(14,2);
    v_line_disc numeric(14,2);
    v_line_tax numeric(14,2);
    v_line_num integer := 0;
    v_po_type varchar(20);
    v_has_product boolean := false;
    v_has_service boolean := false;
    v_wh_id uuid;
    v_initial_status varchar(30);
BEGIN
    -- Validar acceso a la empresa
    IF NOT core.has_company_access(p_user_id, p_company_id) AND NOT portal.has_permission('system.admin') THEN
        RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a la empresa especificada');
    END IF;

    -- Validar y resolver estado inicial
    v_initial_status := COALESCE(p_data->>'status', 'EMITIDA');
    IF v_initial_status NOT IN ('BORRADOR', 'EMITIDA') THEN
        RETURN jsonb_build_object('success', false, 'error', 'El estado inicial de la OC debe ser BORRADOR o EMITIDA.');
    END IF;

    -- Generar correlativo
    v_corr := adquisiciones.generate_po_correlative(p_company_id);

    -- Determinar tipo de OC
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_data->'items')
    LOOP
        IF v_item->>'item_type' = 'PRODUCT' THEN v_has_product := true;
        ELSIF v_item->>'item_type' = 'SERVICE' THEN v_has_service := true;
        END IF;
    END LOOP;

    v_po_type := CASE
        WHEN v_has_product AND v_has_service THEN 'MIXTA'
        WHEN v_has_service THEN 'SERVICIOS'
        ELSE 'PRODUCTOS'
    END;

    v_wh_id := (p_data->>'warehouse_id')::uuid;

    -- Insertar Cabecera
    INSERT INTO adquisiciones.purchase_orders (
        company_id, correlative, issue_date, required_date, supplier_id, warehouse_id,
        po_type, currency, payment_terms, requested_by, authorized_by,
        notes, net_total, discount_total, tax_total, exempt_total, grand_total,
        status, receipt_status, invoice_status, created_by, updated_by
    ) VALUES (
        p_company_id,
        v_corr,
        CURRENT_DATE,
        (p_data->>'required_date')::date,
        (p_data->>'supplier_id')::uuid,
        v_wh_id,
        v_po_type,
        COALESCE(p_data->>'currency', 'CLP'),
        p_data->>'payment_terms',
        p_user_id,
        (p_data->>'authorized_by')::uuid,
        p_data->>'notes',
        0, 0, 0, 0, 0,
        v_initial_status, 'PENDIENTE', 'PENDIENTE',
        p_user_id, p_user_id
    ) RETURNING id INTO v_po_id;

    -- Insertar Líneas y calcular totales
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_data->'items')
    LOOP
        v_line_num := v_line_num + 1;
        v_line_total := COALESCE((v_item->>'quantity')::numeric, 0) * COALESCE((v_item->>'unit_price')::numeric, 0);
        v_line_disc := v_line_total * COALESCE((v_item->>'discount_percent')::numeric, 0) / 100;
        v_line_tax := (v_line_total - v_line_disc) * COALESCE((v_item->>'tax_rate')::numeric, 19) / 100;

        INSERT INTO adquisiciones.purchase_order_items (
            company_id, po_id, line_number, item_type, product_id, product_description,
            unit, quantity, unit_price, discount_percent, discount_amount,
            tax_rate, tax_amount, line_total, warehouse_id, cost_center,
            required_date, notes, created_by, updated_by
        ) VALUES (
            p_company_id,
            v_po_id, v_line_num,
            v_item->>'item_type',
            (v_item->>'product_id')::uuid,
            v_item->>'product_description',
            v_item->>'unit',
            (v_item->>'quantity')::numeric,
            (v_item->>'unit_price')::numeric,
            COALESCE((v_item->>'discount_percent')::numeric, 0),
            v_line_disc,
            COALESCE((v_item->>'tax_rate')::numeric, 19),
            v_line_tax,
            v_line_total - v_line_disc + v_line_tax,
            COALESCE((v_item->>'warehouse_id')::uuid, v_wh_id),
            v_item->>'cost_center',
            (v_item->>'required_date')::date,
            v_item->>'notes',
            p_user_id, p_user_id
        );

        v_net := v_net + (v_line_total - v_line_disc);
        v_disc := v_disc + v_line_disc;
        v_tax := v_tax + v_line_tax;
    END LOOP;

    v_total := v_net + v_tax;

    -- Actualizar totales en la cabecera
    UPDATE adquisiciones.purchase_orders SET
        net_total = ROUND(v_net, 2),
        discount_total = ROUND(v_disc, 2),
        tax_total = ROUND(v_tax, 2),
        exempt_total = ROUND(v_exempt, 2),
        grand_total = ROUND(v_total, 2),
        updated_by = p_user_id
    WHERE id = v_po_id;

    -- Insertar historial de estado inicial
    INSERT INTO adquisiciones.purchase_order_status_history (company_id, po_id, from_status, to_status, changed_by)
    VALUES (p_company_id, v_po_id, NULL, v_initial_status, p_user_id);

    RETURN jsonb_build_object('success', true, 'po_id', v_po_id, 'correlative', v_corr);
END;
$$;
