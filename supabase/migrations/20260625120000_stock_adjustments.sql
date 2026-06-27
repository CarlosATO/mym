-- Migration: Stock Adjustments

-- 1. Cabecera de Ajustes
CREATE TABLE IF NOT EXISTS logistica.stock_adjustments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    adjustment_number varchar(50) NOT NULL,
    adjustment_type varchar(30) NOT NULL CHECK (adjustment_type IN ('INITIAL', 'POSITIVE', 'NEGATIVE')),
    reason varchar(100) NOT NULL,
    adjustment_date timestamptz NOT NULL DEFAULT now(),
    warehouse_id uuid NOT NULL REFERENCES adquisiciones.warehouses(id) ON DELETE RESTRICT,
    notes text,
    status varchar(30) NOT NULL CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED')),
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_stock_adjustments_company_number UNIQUE (company_id, adjustment_number)
);

-- 2. Líneas de Ajustes
CREATE TABLE IF NOT EXISTS logistica.stock_adjustment_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    adjustment_id uuid NOT NULL REFERENCES logistica.stock_adjustments(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES adquisiciones.products(id) ON DELETE RESTRICT,
    warehouse_id uuid NOT NULL REFERENCES adquisiciones.warehouses(id) ON DELETE RESTRICT,
    location_id uuid NOT NULL REFERENCES logistica.locations(id) ON DELETE RESTRICT,
    lot_number varchar(100),
    expiration_date date,
    quantity numeric(14,4) NOT NULL,
    unit_cost numeric(14,4),
    total_cost numeric(14,4),
    notes text,
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Habilitar RLS
ALTER TABLE logistica.stock_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.stock_adjustment_items ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE logistica.stock_adjustments TO authenticated, service_role;
GRANT ALL ON TABLE logistica.stock_adjustment_items TO authenticated, service_role;

-- Políticas usando has_company_access
CREATE POLICY rls_adjustments_select ON logistica.stock_adjustments FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_adjustments_insert ON logistica.stock_adjustments FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_adjustment_items_select ON logistica.stock_adjustment_items FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_adjustment_items_insert ON logistica.stock_adjustment_items FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));


-- 3. RPC Transaccional
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
    v_audit_id uuid;
BEGIN
    -- 1. Validar Permisos del Usuario (debe ser SUPER_USUARIO, GERENCIA o BODEGA)
    IF NOT portal.has_permission('system.admin') THEN
        IF NOT EXISTS (
            SELECT 1 FROM portal.users u
            JOIN portal.user_roles ur ON ur.user_id = u.id
            JOIN portal.roles r ON r.id = ur.role_id
            WHERE u.id = p_user_id AND r.name IN ('SUPER_USUARIO', 'GERENCIA', 'BODEGA')
        ) THEN
            RETURN jsonb_build_object('success', false, 'error', 'Usuario no tiene permisos para emitir ajustes de inventario (Requerido: BODEGA, GERENCIA o SUPER_USUARIO)');
        END IF;
    END IF;

    -- Validar que la empresa sea activa y el usuario pertenezca
    IF NOT core.has_company_access(p_user_id, p_company_id) AND NOT portal.has_permission('system.admin') THEN
        RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a esta empresa');
    END IF;

    -- 2. Generar correlativo AJ-YYYY-000001
    v_year := to_char(now(), 'YYYY');
    
    SELECT COALESCE(MAX(CAST(SUBSTRING(adjustment_number FROM 9) AS integer)), 0) + 1 
    INTO v_seq
    FROM logistica.stock_adjustments 
    WHERE company_id = p_company_id AND adjustment_number LIKE 'AJ-' || v_year || '-%';

    v_adjustment_number := 'AJ-' || v_year || '-' || LPAD(v_seq::text, 6, '0');

    -- 3. Crear cabecera
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

    -- 4. Procesar líneas
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

        -- Determinar delta de stock basado en tipo
        IF p_adjustment_type = 'NEGATIVE' THEN
            v_delta := -v_item.qty;
            
            -- Validar stock suficiente
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

        -- Insertar línea de ajuste
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

        -- Insertar movimiento en Kardex
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
            v_delta, -- Positivo o Negativo
            v_item.cost,
            v_delta * COALESCE(v_item.cost, 0),
            v_item.lot,
            v_item.exp_date,
            v_item.note,
            p_user_id
        );
    END LOOP;

    -- 5. Registrar evento de auditoría si la tabla portal.audit_logs existe
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
        -- Ignorar error de inserción de auditoría (por si la tabla no existe o cambió)
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
