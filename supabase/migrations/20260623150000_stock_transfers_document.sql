-- Documento operacional de traspasos internos entre bodegas.
-- Stock sigue derivándose exclusivamente desde logistica.kardex_movements.

CREATE SEQUENCE IF NOT EXISTS logistica.stock_transfer_number_seq;

CREATE TABLE IF NOT EXISTS logistica.stock_transfers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    transfer_number text NOT NULL,
    from_warehouse_id uuid NOT NULL REFERENCES adquisiciones.warehouses(id),
    to_warehouse_id uuid NOT NULL REFERENCES adquisiciones.warehouses(id),
    to_location_id uuid NOT NULL REFERENCES logistica.locations(id),
    transfer_date timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED')),
    notes text,
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_stock_transfers_company_number UNIQUE (company_id, transfer_number),
    CONSTRAINT chk_stock_transfers_different_warehouses CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE IF NOT EXISTS logistica.stock_transfer_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id uuid NOT NULL REFERENCES logistica.stock_transfers(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES adquisiciones.products(id),
    from_location_id uuid NOT NULL REFERENCES logistica.locations(id),
    lot_number text,
    expiration_date date,
    quantity numeric(14,4) NOT NULL CHECK (quantity > 0),
    unit_cost numeric(14,4),
    total_cost numeric(14,4),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_company ON logistica.stock_transfers(company_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_from_wh ON logistica.stock_transfers(from_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to_wh ON logistica.stock_transfers(to_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_date ON logistica.stock_transfers(transfer_date DESC);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_transfer ON logistica.stock_transfer_items(transfer_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_company ON logistica.stock_transfer_items(company_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_product ON logistica.stock_transfer_items(product_id);

ALTER TABLE logistica.stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.stock_transfer_items ENABLE ROW LEVEL SECURITY;

GRANT ALL ON logistica.stock_transfers TO authenticated, service_role;
GRANT ALL ON logistica.stock_transfer_items TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE logistica.stock_transfer_number_seq TO authenticated, service_role;

DROP POLICY IF EXISTS rls_stock_transfers_select ON logistica.stock_transfers;
CREATE POLICY rls_stock_transfers_select ON logistica.stock_transfers FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

DROP POLICY IF EXISTS rls_stock_transfers_insert ON logistica.stock_transfers;
CREATE POLICY rls_stock_transfers_insert ON logistica.stock_transfers FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

DROP POLICY IF EXISTS rls_stock_transfer_items_select ON logistica.stock_transfer_items;
CREATE POLICY rls_stock_transfer_items_select ON logistica.stock_transfer_items FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

DROP POLICY IF EXISTS rls_stock_transfer_items_insert ON logistica.stock_transfer_items;
CREATE POLICY rls_stock_transfer_items_insert ON logistica.stock_transfer_items FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

CREATE OR REPLACE FUNCTION logistica.create_stock_transfer(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, adquisiciones, portal, core, public
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_company_id uuid;
    v_from_warehouse_id uuid;
    v_to_warehouse_id uuid;
    v_to_location_id uuid;
    v_notes text;
    v_transfer_id uuid;
    v_transfer_number text;
    v_line record;
    v_agg record;
    v_available numeric(14,4);
    v_cost_balance numeric(14,4);
    v_unit_cost numeric(14,4);
    v_total_cost numeric(14,4);
    v_item_id uuid;
    v_line_count integer;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'No autorizado');
    END IF;

    v_company_id := NULLIF(p_payload->>'company_id', '')::uuid;
    v_from_warehouse_id := NULLIF(p_payload->>'from_warehouse_id', '')::uuid;
    v_to_warehouse_id := NULLIF(p_payload->>'to_warehouse_id', '')::uuid;
    v_to_location_id := NULLIF(p_payload->>'to_location_id', '')::uuid;
    v_notes := NULLIF(trim(COALESCE(p_payload->>'notes', '')), '');

    IF v_company_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'No se ha seleccionado una empresa activa');
    END IF;

    IF NOT core.has_company_access(v_user_id, v_company_id) AND NOT portal.has_permission('system.admin') THEN
        RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a la empresa activa');
    END IF;

    IF v_from_warehouse_id IS NULL OR v_to_warehouse_id IS NULL OR v_to_location_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Debe seleccionar bodega origen, bodega destino y ubicación destino');
    END IF;

    IF v_from_warehouse_id = v_to_warehouse_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'El traspaso entre bodegas requiere una bodega destino distinta a la bodega origen');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM adquisiciones.warehouses
        WHERE id = v_from_warehouse_id AND company_id = v_company_id AND is_active = true AND status = 'ACTIVE'
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Bodega de origen no válida');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM adquisiciones.warehouses
        WHERE id = v_to_warehouse_id AND company_id = v_company_id AND is_active = true AND status = 'ACTIVE'
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Bodega de destino no válida');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM logistica.locations
        WHERE id = v_to_location_id AND company_id = v_company_id AND warehouse_id = v_to_warehouse_id AND is_active = true
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Ubicación destino no válida o no pertenece a la bodega destino');
    END IF;

    CREATE TEMP TABLE IF NOT EXISTS tmp_stock_transfer_lines (
        product_id uuid,
        from_location_id uuid,
        lot_number text,
        expiration_date date,
        quantity numeric(14,4),
        notes text
    ) ON COMMIT DROP;

    TRUNCATE tmp_stock_transfer_lines;

    INSERT INTO tmp_stock_transfer_lines (product_id, from_location_id, lot_number, expiration_date, quantity, notes)
    SELECT product_id, from_location_id, NULLIF(trim(lot_number), ''), expiration_date, quantity, NULLIF(trim(COALESCE(notes, '')), '')
    FROM jsonb_to_recordset(COALESCE(p_payload->'items', '[]'::jsonb)) AS x(
        product_id uuid,
        from_location_id uuid,
        lot_number text,
        expiration_date date,
        quantity numeric(14,4),
        notes text
    );

    SELECT count(*) INTO v_line_count FROM tmp_stock_transfer_lines;
    IF v_line_count = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Debe agregar al menos una línea al traspaso');
    END IF;

    IF EXISTS (
        SELECT 1 FROM tmp_stock_transfer_lines
        WHERE product_id IS NULL OR from_location_id IS NULL OR quantity IS NULL OR quantity <= 0
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Todas las líneas deben tener producto, ubicación origen y cantidad mayor a cero');
    END IF;

    IF EXISTS (
        SELECT 1
        FROM tmp_stock_transfer_lines l
        LEFT JOIN adquisiciones.products p ON p.id = l.product_id
        WHERE p.id IS NULL OR COALESCE(p.is_active, false) = false OR (p.company_id IS NOT NULL AND p.company_id <> v_company_id)
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Una o más líneas contienen productos no válidos');
    END IF;

    IF EXISTS (
        SELECT 1
        FROM tmp_stock_transfer_lines l
        LEFT JOIN logistica.locations loc ON loc.id = l.from_location_id
        WHERE loc.id IS NULL OR loc.company_id <> v_company_id OR loc.warehouse_id <> v_from_warehouse_id OR loc.is_active = false
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Una o más ubicaciones de origen no pertenecen a la bodega origen');
    END IF;

    FOR v_agg IN
        SELECT product_id, from_location_id, lot_number, expiration_date, sum(quantity)::numeric(14,4) AS requested_qty
        FROM tmp_stock_transfer_lines
        GROUP BY product_id, from_location_id, lot_number, expiration_date
    LOOP
        SELECT
            COALESCE(sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT') THEN km.quantity ELSE -km.quantity END), 0)::numeric(14,4),
            COALESCE(sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT') THEN COALESCE(km.total_cost, km.quantity * COALESCE(km.unit_cost, 0)) ELSE -COALESCE(km.total_cost, km.quantity * COALESCE(km.unit_cost, 0)) END), 0)::numeric(14,4)
        INTO v_available, v_cost_balance
        FROM logistica.kardex_movements km
        WHERE km.company_id = v_company_id
          AND km.product_id = v_agg.product_id
          AND km.warehouse_id = v_from_warehouse_id
          AND km.location_id = v_agg.from_location_id
          AND km.lot_number IS NOT DISTINCT FROM v_agg.lot_number
          AND km.expiration_date IS NOT DISTINCT FROM v_agg.expiration_date;

        IF v_available <= 0 THEN
            RETURN jsonb_build_object('success', false, 'error', 'Producto/lote no existe en stock disponible');
        END IF;

        IF v_agg.requested_qty > v_available THEN
            RETURN jsonb_build_object('success', false, 'error', 'La cantidad a mover (' || v_agg.requested_qty || ') supera el stock disponible (' || v_available || ') en la ubicación origen.');
        END IF;
    END LOOP;

    v_transfer_number := 'TR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('logistica.stock_transfer_number_seq')::text, 6, '0');

    INSERT INTO logistica.stock_transfers (
        company_id, transfer_number, from_warehouse_id, to_warehouse_id, to_location_id, transfer_date, status, notes, created_by
    ) VALUES (
        v_company_id, v_transfer_number, v_from_warehouse_id, v_to_warehouse_id, v_to_location_id, now(), 'COMPLETED', v_notes, v_user_id
    ) RETURNING id INTO v_transfer_id;

    FOR v_line IN SELECT * FROM tmp_stock_transfer_lines LOOP
        SELECT
            COALESCE(sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT') THEN km.quantity ELSE -km.quantity END), 0)::numeric(14,4),
            COALESCE(sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT') THEN COALESCE(km.total_cost, km.quantity * COALESCE(km.unit_cost, 0)) ELSE -COALESCE(km.total_cost, km.quantity * COALESCE(km.unit_cost, 0)) END), 0)::numeric(14,4)
        INTO v_available, v_cost_balance
        FROM logistica.kardex_movements km
        WHERE km.company_id = v_company_id
          AND km.product_id = v_line.product_id
          AND km.warehouse_id = v_from_warehouse_id
          AND km.location_id = v_line.from_location_id
          AND km.lot_number IS NOT DISTINCT FROM v_line.lot_number
          AND km.expiration_date IS NOT DISTINCT FROM v_line.expiration_date;

        v_unit_cost := CASE WHEN v_available > 0 AND v_cost_balance > 0 THEN v_cost_balance / v_available ELSE NULL END;
        v_total_cost := CASE WHEN v_unit_cost IS NULL THEN NULL ELSE v_unit_cost * v_line.quantity END;

        INSERT INTO logistica.stock_transfer_items (
            transfer_id, company_id, product_id, from_location_id, lot_number, expiration_date,
            quantity, unit_cost, total_cost, notes
        ) VALUES (
            v_transfer_id, v_company_id, v_line.product_id, v_line.from_location_id,
            v_line.lot_number, v_line.expiration_date, v_line.quantity, v_unit_cost, v_total_cost, v_line.notes
        ) RETURNING id INTO v_item_id;

        INSERT INTO logistica.kardex_movements (
            company_id, product_id, warehouse_id, location_id, movement_type, source_type, source_id, source_line_id,
            quantity, unit_cost, total_cost, lot_number, expiration_date, notes, created_by
        ) VALUES (
            v_company_id, v_line.product_id, v_from_warehouse_id, v_line.from_location_id, 'TRANSFER_OUT', 'TRANSFER', v_transfer_id, v_item_id,
            v_line.quantity, v_unit_cost, v_total_cost, v_line.lot_number, v_line.expiration_date, COALESCE(v_line.notes, v_notes), v_user_id
        ), (
            v_company_id, v_line.product_id, v_to_warehouse_id, v_to_location_id, 'TRANSFER_IN', 'TRANSFER', v_transfer_id, v_item_id,
            v_line.quantity, v_unit_cost, v_total_cost, v_line.lot_number, v_line.expiration_date, COALESCE(v_line.notes, v_notes), v_user_id
        );
    END LOOP;

    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES (
        'logistica',
        'LOGISTICA',
        'stock_transfers',
        v_transfer_id,
        'INSERT',
        jsonb_build_object(
            'transfer_number', v_transfer_number,
            'line_count', v_line_count,
            'from_warehouse_id', v_from_warehouse_id,
            'to_warehouse_id', v_to_warehouse_id,
            'to_location_id', v_to_location_id,
            'company_id', v_company_id
        ),
        v_user_id,
        'TRANSFER_CREATED',
        'INFO'
    );

    RETURN jsonb_build_object('success', true, 'transfer_id', v_transfer_id, 'transfer_number', v_transfer_number);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION logistica.create_stock_transfer(jsonb) TO authenticated, service_role;
