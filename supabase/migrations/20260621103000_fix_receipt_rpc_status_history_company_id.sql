-- Corrección de restricción NOT NULL: agregar company_id 
-- al insertar en adquisiciones.purchase_order_status_history

CREATE OR REPLACE FUNCTION logistica.create_purchase_receipt_db(
    p_company_id uuid,
    p_purchase_order_id uuid,
    p_receiving_type text,
    p_warehouse_id uuid,
    p_notes text,
    p_document_type text,
    p_document_number text,
    p_document_date date,
    p_items jsonb,
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, adquisiciones, core, public
AS $$
DECLARE
    v_receipt_id uuid;
    v_receipt_number text;
    v_item record;
    v_locations_count integer;
    v_po_status text;
    v_has_pending boolean;
    v_po_company_id uuid;
    
    -- Variables para cálculos financieros de la recepción
    v_total_net numeric(14,4) := 0;
    v_total_tax numeric(14,4) := 0;
    v_total_gross numeric(14,4) := 0;
BEGIN
    -- 1. Validar autenticación y permisos de acceso del usuario
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'No autenticado');
    END IF;

    IF auth.uid() <> p_user_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'El ID de usuario no coincide con la sesión activa');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM core.user_company_access
        WHERE user_id = auth.uid()
          AND company_id = p_company_id
          AND is_active = true
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'El usuario no tiene acceso activo a la empresa seleccionada');
    END IF;

    -- 2. Validar existencia y pertenencia de la OC
    SELECT company_id, status INTO v_po_company_id, v_po_status
    FROM adquisiciones.purchase_orders
    WHERE id = p_purchase_order_id;

    IF v_po_company_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Orden de Compra no encontrada');
    END IF;

    IF v_po_company_id <> p_company_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'La Orden de Compra pertenece a otra empresa');
    END IF;

    IF v_po_status NOT IN ('EMITIDA', 'RECEPCION_PARCIAL') THEN
        RETURN jsonb_build_object('success', false, 'error', 'La Orden de Compra no se encuentra en un estado válido para recibir');
    END IF;

    -- 3. Validar pre-agrupación de cantidades para evitar sobre-recepciones
    DECLARE
        v_check record;
    BEGIN
        FOR v_check IN 
            SELECT 
                (val->>'purchase_order_item_id')::uuid AS po_item_id,
                SUM(COALESCE((val->>'quantity_received')::numeric, 0)) AS sum_received,
                SUM(COALESCE((val->>'quantity_rejected')::numeric, 0)) AS sum_rejected,
                SUM(COALESCE((val->>'quantity_missing')::numeric, 0)) AS sum_missing
            FROM jsonb_array_elements(p_items) val
            GROUP BY (val->>'purchase_order_item_id')::uuid
        LOOP
            DECLARE
                v_qty_pending numeric;
                v_desc text;
            BEGIN
                SELECT quantity - quantity_received, product_description 
                INTO v_qty_pending, v_desc
                FROM adquisiciones.purchase_order_items
                WHERE id = v_check.po_item_id AND po_id = p_purchase_order_id;

                IF v_qty_pending IS NULL THEN
                    RAISE EXCEPTION 'Ítem de la OC no encontrado';
                END IF;

                -- Validación de no negatividad
                IF v_check.sum_received < 0 OR v_check.sum_rejected < 0 OR v_check.sum_missing < 0 THEN
                    RAISE EXCEPTION 'No se admiten cantidades negativas para %', v_desc;
                END IF;

                -- Validación de suma no exceda el saldo pendiente
                IF (v_check.sum_received + v_check.sum_rejected + v_check.sum_missing) > v_qty_pending THEN
                    RAISE EXCEPTION 'La suma total solicitada para % (% unidades) supera el saldo pendiente de % unidades', 
                        v_desc, (v_check.sum_received + v_check.sum_rejected + v_check.sum_missing), v_qty_pending;
                END IF;
            END;
        END LOOP;
    END;

    -- 4. Generar número correlativo
    SELECT COALESCE(COUNT(*), 0) + 1 INTO v_locations_count
    FROM logistica.purchase_receipts
    WHERE company_id = p_company_id;

    v_receipt_number := 'REC-' || LPAD(v_locations_count::text, 6, '0');

    -- 5. Insertar Cabecera de Recepción
    INSERT INTO logistica.purchase_receipts (
        company_id,
        purchase_order_id,
        receipt_number,
        receiving_type,
        warehouse_id,
        status,
        notes,
        document_type,
        document_number,
        document_date,
        created_by
    )
    VALUES (
        p_company_id,
        p_purchase_order_id,
        v_receipt_number,
        p_receiving_type,
        CASE WHEN p_receiving_type = 'WAREHOUSE' THEN p_warehouse_id ELSE NULL END,
        'COMPLETED',
        p_notes,
        p_document_type,
        p_document_number,
        p_document_date,
        p_user_id
    )
    RETURNING id INTO v_receipt_id;

    -- 6. Procesar Partidas (Splits)
    FOR v_item IN 
        SELECT 
            (value->>'purchase_order_item_id')::uuid AS po_item_id,
            COALESCE((value->>'quantity_received')::numeric, 0) AS qty_rec,
            COALESCE((value->>'quantity_rejected')::numeric, 0) AS qty_rej,
            COALESCE((value->>'quantity_missing')::numeric, 0) AS qty_mis,
            (value->>'location_id')::uuid AS loc_id,
            value->>'lot_number' AS lot,
            (value->>'expiration_date')::date AS exp_date,
            COALESCE(NULLIF(value->>'condition', ''), 'CONFORME') AS cond,
            value->>'notes' AS note,
            value->>'rejection_reason' AS rej_reason,
            value->>'difference_reason' AS diff_reason
        FROM jsonb_array_elements(p_items)
    LOOP
        -- Validar condición permitida
        IF v_item.cond NOT IN ('CONFORME', 'DANADO', 'RECHAZADO', 'FALTANTE') THEN
            RAISE EXCEPTION 'Condición de recepción no válida: %', v_item.cond;
        END IF;

        -- Validaciones de cantidades por condición y de no negatividad
        IF v_item.qty_rec < 0 OR v_item.qty_rej < 0 OR v_item.qty_mis < 0 THEN
            RAISE EXCEPTION 'No se admiten cantidades negativas';
        END IF;

        IF v_item.cond IN ('CONFORME', 'DANADO') THEN
            IF v_item.qty_rec <= 0 THEN
                RAISE EXCEPTION 'La cantidad recibida debe ser mayor a 0 para partidas CONFORME o DANADO';
            END IF;
            IF v_item.qty_rej > 0 OR v_item.qty_mis > 0 THEN
                RAISE EXCEPTION 'No se permite registrar cantidades rechazadas o faltantes en una partida CONFORME o DANADO';
            END IF;
        ELSIF v_item.cond = 'RECHAZADO' THEN
            IF v_item.qty_rej <= 0 THEN
                RAISE EXCEPTION 'La cantidad rechazada debe ser mayor a 0 para partidas RECHAZADAS';
            END IF;
            IF v_item.qty_rec > 0 OR v_item.qty_mis > 0 THEN
                RAISE EXCEPTION 'No se permite registrar cantidad recibida o faltante en una partida RECHAZADA';
            END IF;
            IF v_item.rej_reason IS NULL OR trim(v_item.rej_reason) = '' THEN
                RAISE EXCEPTION 'Debe especificar el motivo del rechazo obligatorio';
            END IF;
        ELSIF v_item.cond = 'FALTANTE' THEN
            IF v_item.qty_mis <= 0 THEN
                RAISE EXCEPTION 'La cantidad faltante debe ser mayor a 0 para partidas FALTANTES';
            END IF;
            IF v_item.qty_rec > 0 OR v_item.qty_rej > 0 THEN
                RAISE EXCEPTION 'No se permite registrar cantidad recibida o rechazada en una partida FALTANTE';
            END IF;
            IF v_item.diff_reason IS NULL OR trim(v_item.diff_reason) = '' THEN
                RAISE EXCEPTION 'Debe especificar el motivo del faltante obligatorio';
            END IF;
        END IF;

        -- Obtener precios y datos actuales del ítem de la OC
        DECLARE
            v_po_item_type varchar;
            v_product_id uuid;
            v_qty_ordered numeric;
            v_qty_current_received numeric;
            v_unit_price numeric;
            v_po_item_wh uuid;
            v_receipt_item_id uuid;
            
            -- Importes financieros para el split
            v_split_net numeric(14,4) := 0;
            v_split_tax numeric(14,4) := 0;
            v_split_gross numeric(14,4) := 0;
        BEGIN
            -- Consultamos dinámicamente en el bucle para tener el valor actualizado tras cada split anterior de la misma ejecución
            SELECT 
                item_type, product_id, quantity, quantity_received, unit_price, warehouse_id
            INTO 
                v_po_item_type, v_product_id, v_qty_ordered, v_qty_current_received, v_unit_price, v_po_item_wh
            FROM 
                adquisiciones.purchase_order_items
            WHERE 
                id = v_item.po_item_id AND po_id = p_purchase_order_id;

            -- Valorizar solo lo que entra a stock (CONFORME y DANADO)
            IF v_item.cond IN ('CONFORME', 'DANADO') THEN
                v_split_net := v_item.qty_rec * v_unit_price;
                v_split_tax := v_split_net * 0.19;
                v_split_gross := v_split_net + v_split_tax;
                
                v_total_net := v_total_net + v_split_net;
                v_total_tax := v_total_tax + v_split_tax;
                v_total_gross := v_total_gross + v_split_gross;
            END IF;

            -- Insertar detalle de recepción por split (RETURNING id)
            INSERT INTO logistica.purchase_receipt_items (
                company_id,
                receipt_id,
                purchase_order_item_id,
                product_id,
                quantity_ordered,
                quantity_previously_received,
                quantity_received,
                quantity_rejected,
                quantity_missing,
                quantity_pending_after,
                unit_cost,
                net_amount,
                tax_amount,
                gross_amount,
                condition,
                rejection_reason,
                difference_reason,
                warehouse_id,
                location_id,
                lot_number,
                expiration_date,
                notes,
                created_by
            )
            VALUES (
                p_company_id,
                v_receipt_id,
                v_item.po_item_id,
                v_product_id,
                v_qty_ordered,
                v_qty_current_received,
                v_item.qty_rec,
                v_item.qty_rej,
                v_item.qty_mis,
                v_qty_ordered - (v_qty_current_received + v_item.qty_rec),
                v_unit_price,
                v_split_net,
                v_split_tax,
                v_split_gross,
                v_item.cond,
                v_item.rej_reason,
                v_item.diff_reason,
                CASE WHEN v_po_item_type = 'PRODUCT' THEN COALESCE(v_po_item_wh, p_warehouse_id) ELSE NULL END,
                CASE WHEN p_receiving_type = 'WAREHOUSE' AND v_po_item_type = 'PRODUCT' AND v_item.cond IN ('CONFORME', 'DANADO') THEN v_item.loc_id ELSE NULL END,
                CASE WHEN v_po_item_type = 'PRODUCT' THEN v_item.lot ELSE NULL END,
                CASE WHEN v_po_item_type = 'PRODUCT' THEN v_item.exp_date ELSE NULL END,
                v_item.note,
                p_user_id
            )
            RETURNING id INTO v_receipt_item_id;

            -- Crear Kardex Movement solo si entra a stock (CONFORME y DANADO)
            IF p_receiving_type = 'WAREHOUSE' AND v_po_item_type = 'PRODUCT' AND v_item.cond IN ('CONFORME', 'DANADO') THEN
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
                    v_product_id,
                    COALESCE(v_po_item_wh, p_warehouse_id),
                    v_item.loc_id,
                    'IN',
                    'PURCHASE_RECEIPT',
                    v_receipt_id,
                    v_receipt_item_id, -- Relación directa a la línea partida (split)
                    v_item.qty_rec,
                    v_unit_price,
                    v_split_net,
                    v_item.lot,
                    v_item.exp_date,
                    v_item.note,
                    p_user_id
                );
            END IF;

            -- Actualizar cantidad_recibida en la OC original (solo CONFORME y DANADO)
            IF v_item.cond IN ('CONFORME', 'DANADO') AND v_item.qty_rec > 0 THEN
                UPDATE adquisiciones.purchase_order_items
                SET quantity_received = quantity_received + v_item.qty_rec
                WHERE id = v_item.po_item_id;
            END IF;
        END;
    END LOOP;

    -- 7. Actualizar totales financieros consolidados en la cabecera
    UPDATE logistica.purchase_receipts
    SET 
        receipt_total_net = v_total_net,
        receipt_total_tax = v_total_tax,
        receipt_total_gross = v_total_gross
    WHERE id = v_receipt_id;

    -- 8. Comprobar si quedan pendientes de recibir en la OC
    SELECT EXISTS (
        SELECT 1 FROM adquisiciones.purchase_order_items
        WHERE po_id = p_purchase_order_id AND (quantity - quantity_received) > 0
    ) INTO v_has_pending;

    -- Actualizar estado de la OC
    IF v_has_pending THEN
        UPDATE adquisiciones.purchase_orders
        SET status = 'RECEPCION_PARCIAL', receipt_status = 'RECEPCION_PARCIAL'
        WHERE id = p_purchase_order_id;

        INSERT INTO adquisiciones.purchase_order_status_history (
            company_id,
            po_id,
            from_status,
            to_status,
            changed_by,
            reason
        )
        VALUES (
            p_company_id,
            p_purchase_order_id,
            v_po_status,
            'RECEPCION_PARCIAL',
            p_user_id,
            'Recepción parcial - N° ' || v_receipt_number
        );
    ELSE
        UPDATE adquisiciones.purchase_orders
        SET status = 'RECEPCION_TOTAL', receipt_status = 'RECEPCION_TOTAL'
        WHERE id = p_purchase_order_id;

        INSERT INTO adquisiciones.purchase_order_status_history (
            company_id,
            po_id,
            from_status,
            to_status,
            changed_by,
            reason
        )
        VALUES (
            p_company_id,
            p_purchase_order_id,
            v_po_status,
            'RECEPCION_TOTAL',
            p_user_id,
            'Recepción total - N° ' || v_receipt_number
        );
    END IF;

    RETURN jsonb_build_object('success', true, 'receipt_id', v_receipt_id, 'receipt_number', v_receipt_number);
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
