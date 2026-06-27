CREATE OR REPLACE FUNCTION logistica.create_stock_adjustment_db(
    p_company_id uuid,
    p_adjustment_type text,
    p_reason text,
    p_warehouse_id uuid,
    p_notes text,
    p_items jsonb,
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_adjustment_id uuid;
    v_adjustment_number text;
    v_year text;
    v_seq integer;
    v_item record;
    v_current_stock numeric;
    v_delta numeric;
    v_auth_uid uuid;
    v_user_role text;
BEGIN
    v_auth_uid := auth.uid();

    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Usuario no informado');
    END IF;

    IF v_auth_uid IS NOT NULL AND v_auth_uid <> p_user_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'Usuario autenticado no coincide con el emisor del ajuste');
    END IF;

    SELECT r.name
    INTO v_user_role
    FROM portal.users u
    JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = p_user_id
      AND u.is_active = true
      AND u.deleted_at IS NULL;

    IF v_user_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Usuario no encontrado o inactivo');
    END IF;

    IF NOT core.has_company_access(p_user_id, p_company_id) AND NOT portal.user_has_permission(p_user_id, 'system.admin') THEN
        RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a esta empresa');
    END IF;

    IF NOT portal.user_has_permission(p_user_id, 'system.admin')
       AND v_user_role NOT IN ('SUPER_USUARIO', 'GERENCIA', 'BODEGA') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Usuario no tiene permisos para emitir ajustes de inventario (Requerido: BODEGA, GERENCIA o SUPER_USUARIO)');
    END IF;

    v_year := to_char(now(), 'YYYY');

    SELECT COALESCE(MAX(CAST(SUBSTRING(adjustment_number FROM 9) AS integer)), 0) + 1
    INTO v_seq
    FROM logistica.stock_adjustments
    WHERE company_id = p_company_id AND adjustment_number LIKE 'AJ-' || v_year || '-%';

    v_adjustment_number := 'AJ-' || v_year || '-' || LPAD(v_seq::text, 6, '0');

    INSERT INTO logistica.stock_adjustments (
        company_id,
        adjustment_number,
        adjustment_type,
        reason,
        warehouse_id,
        notes,
        status,
        created_by
    )
    VALUES (
        p_company_id,
        v_adjustment_number,
        p_adjustment_type,
        p_reason,
        p_warehouse_id,
        p_notes,
        'COMPLETED',
        p_user_id
    )
    RETURNING id INTO v_adjustment_id;

    FOR v_item IN
        SELECT
            (value->>'product_id')::uuid AS prod_id,
            (value->>'location_id')::uuid AS loc_id,
            value->>'lot_number' AS lot,
            (value->>'expiration_date')::date AS exp_date,
            (value->>'quantity')::numeric AS qty,
            (value->>'unit_cost')::numeric AS cost,
            value->>'notes' AS note
        FROM jsonb_array_elements(p_items)
    LOOP
        IF v_item.qty <= 0 THEN
            RAISE EXCEPTION 'La cantidad debe ser mayor a cero para todos los productos';
        END IF;

        IF p_adjustment_type = 'NEGATIVE' THEN
            v_delta := -v_item.qty;

            SELECT COALESCE(SUM(
                CASE WHEN movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT') THEN quantity ELSE -quantity END
            ), 0)
            INTO v_current_stock
            FROM logistica.kardex_movements
            WHERE company_id = p_company_id
              AND product_id = v_item.prod_id
              AND warehouse_id = p_warehouse_id
              AND (location_id = v_item.loc_id OR (location_id IS NULL AND v_item.loc_id IS NULL))
              AND (lot_number = v_item.lot OR (lot_number IS NULL AND v_item.lot IS NULL));

            IF v_current_stock < v_item.qty THEN
                RAISE EXCEPTION 'Stock insuficiente para ajuste negativo. Stock actual: %, Solicitado: %', v_current_stock, v_item.qty;
            END IF;
        ELSE
            v_delta := v_item.qty;
        END IF;

        INSERT INTO logistica.stock_adjustment_items (
            adjustment_id,
            company_id,
            product_id,
            warehouse_id,
            location_id,
            lot_number,
            expiration_date,
            quantity,
            unit_cost,
            total_cost,
            notes,
            created_by
        )
        VALUES (
            v_adjustment_id,
            p_company_id,
            v_item.prod_id,
            p_warehouse_id,
            v_item.loc_id,
            v_item.lot,
            v_item.exp_date,
            v_item.qty,
            v_item.cost,
            v_item.qty * COALESCE(v_item.cost, 0),
            v_item.note,
            p_user_id
        );

        INSERT INTO logistica.kardex_movements (
            company_id,
            product_id,
            warehouse_id,
            location_id,
            movement_type,
            source_type,
            source_id,
            source_line_id,
            quantity,
            unit_cost,
            total_cost,
            lot_number,
            expiration_date,
            notes,
            created_by
        )
        VALUES (
            p_company_id,
            v_item.prod_id,
            p_warehouse_id,
            v_item.loc_id,
            'ADJUSTMENT',
            'ADJUSTMENT',
            v_adjustment_id,
            NULL,
            v_delta,
            v_item.cost,
            v_delta * COALESCE(v_item.cost, 0),
            v_item.lot,
            v_item.exp_date,
            v_item.note,
            p_user_id
        );
    END LOOP;

    BEGIN
        INSERT INTO portal.audit_logs (
            id,
            company_id,
            user_id,
            action,
            entity_type,
            entity_id,
            details,
            ip_address,
            user_agent,
            created_at
        )
        VALUES (
            gen_random_uuid(),
            p_company_id,
            p_user_id,
            'STOCK_ADJUSTMENT_CREATED',
            'STOCK_ADJUSTMENT',
            v_adjustment_id,
            jsonb_build_object(
                'adjustment_number', v_adjustment_number,
                'adjustment_type', p_adjustment_type,
                'reason', p_reason,
                'total_lines', jsonb_array_length(p_items)
            ),
            '127.0.0.1',
            'RPC',
            now()
        );
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'adjustment_id', v_adjustment_id,
        'adjustment_number', v_adjustment_number
    );
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION logistica.create_stock_adjustment_db(uuid, text, text, uuid, text, jsonb, uuid) TO authenticated, service_role;
