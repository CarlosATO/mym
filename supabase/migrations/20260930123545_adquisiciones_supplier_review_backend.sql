-- Transactional backend for revising a purchase order sent to its supplier.

CREATE OR REPLACE FUNCTION adquisiciones.update_purchase_order_supplier_review(
    p_po_id uuid,
    p_data jsonb,
    p_user_id uuid,
    p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_po adquisiciones.purchase_orders%ROWTYPE;
    v_item jsonb;
    v_current_item adquisiciones.purchase_order_items%ROWTYPE;
    v_product adquisiciones.products%ROWTYPE;
    v_item_id uuid;
    v_product_id uuid;
    v_item_type text;
    v_quantity numeric;
    v_unit_price numeric;
    v_discount_percent numeric;
    v_tax_rate numeric;
    v_notes text;
    v_line_base numeric;
    v_discount_amount numeric;
    v_tax_amount numeric;
    v_line_total numeric;
    v_line_number integer := 0;
    v_seen_item_ids uuid[] := ARRAY[]::uuid[];
    v_has_product boolean := false;
    v_has_service boolean := false;
    v_net_total numeric := 0;
    v_discount_total numeric := 0;
    v_tax_total numeric := 0;
    v_exempt_total numeric := 0;
    v_grand_total numeric := 0;
    v_item_count integer := 0;
    v_is_admin boolean;
BEGIN
    IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION 'El usuario de la sesión no coincide con p_user_id';
    END IF;

    v_is_admin := portal.user_has_permission(p_user_id, 'system.admin');
    IF NOT (v_is_admin OR core.has_company_access(p_user_id, p_company_id)) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa';
    END IF;
    IF NOT (v_is_admin OR portal.user_has_permission(p_user_id, 'adquisiciones.po.update')) THEN
        RAISE EXCEPTION 'Permisos insuficientes para revisar la orden de compra';
    END IF;

    IF p_data IS NULL
       OR jsonb_typeof(p_data) <> 'object'
       OR COALESCE(jsonb_typeof(p_data->'items'), '') <> 'array'
       OR COALESCE(jsonb_array_length(p_data->'items'), 0) = 0 THEN
        RAISE EXCEPTION 'La revisión debe contener al menos una línea';
    END IF;

    SELECT * INTO v_po
    FROM adquisiciones.purchase_orders
    WHERE id = p_po_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'La OC no existe o no pertenece a la empresa';
    END IF;
    IF v_po.status <> 'ENVIADA_PROVEEDOR' THEN
        RAISE EXCEPTION 'Solo se puede revisar una OC ENVIADA_PROVEEDOR';
    END IF;
    IF v_po.receipt_status IS DISTINCT FROM 'PENDIENTE' THEN
        RAISE EXCEPTION 'No se puede revisar una OC con recepción iniciada';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM adquisiciones.purchase_order_items i
        WHERE i.po_id = p_po_id
          AND i.company_id = p_company_id
          AND COALESCE(i.quantity_received, 0) > 0
    ) THEN
        RAISE EXCEPTION 'No se puede revisar una OC con cantidades recibidas';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM adquisiciones.purchase_order_snapshots s
        WHERE s.po_id = p_po_id
          AND s.company_id = p_company_id
          AND s.snapshot_type = 'ORIGINAL_SENT'
    ) THEN
        RAISE EXCEPTION 'La OC no tiene snapshot ORIGINAL_SENT';
    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_data->'items')
    LOOP
        v_line_number := v_line_number + 1;
        v_item_count := v_item_count + 1;
        v_item_type := v_item->>'item_type';

        IF v_item_type NOT IN ('PRODUCT', 'SERVICE') THEN
            RAISE EXCEPTION 'Tipo de línea inválido en la posición %', v_line_number;
        END IF;
        IF v_item->>'quantity' IS NULL OR v_item->>'unit_price' IS NULL THEN
            RAISE EXCEPTION 'Cantidad y precio unitario son obligatorios en la línea %', v_line_number;
        END IF;

        v_item_id := NULLIF(v_item->>'item_id', '')::uuid;
        v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
        v_quantity := (v_item->>'quantity')::numeric;
        v_unit_price := (v_item->>'unit_price')::numeric;

        IF v_quantity <= 0 THEN
            RAISE EXCEPTION 'La cantidad debe ser mayor que cero en la línea %', v_line_number;
        END IF;
        IF v_unit_price < 0 THEN
            RAISE EXCEPTION 'El precio unitario no puede ser negativo en la línea %', v_line_number;
        END IF;

        IF v_item_id IS NULL THEN
            IF v_item_type <> 'PRODUCT' OR v_product_id IS NULL THEN
                RAISE EXCEPTION 'Las líneas nuevas deben ser productos existentes del catálogo';
            END IF;
            SELECT * INTO v_product
            FROM adquisiciones.products
            WHERE id = v_product_id
              AND company_id = p_company_id
              AND is_active = true;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'El producto nuevo no existe o no está activo en la empresa';
            END IF;
            v_discount_percent := COALESCE((v_item->>'discount_percent')::numeric, 0);
            v_tax_rate := COALESCE((v_item->>'tax_rate')::numeric, 19);
            v_notes := CASE WHEN v_item ? 'notes' THEN v_item->>'notes' ELSE NULL END;
        ELSE
            IF v_item_id = ANY(v_seen_item_ids) THEN
                RAISE EXCEPTION 'Una línea existente aparece más de una vez en el payload';
            END IF;
            v_seen_item_ids := array_append(v_seen_item_ids, v_item_id);

            SELECT * INTO v_current_item
            FROM adquisiciones.purchase_order_items
            WHERE id = v_item_id
              AND po_id = p_po_id
              AND company_id = p_company_id
            FOR UPDATE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'El item_id no pertenece a la OC y empresa indicadas';
            END IF;
            IF v_item_type <> v_current_item.item_type THEN
                RAISE EXCEPTION 'No se permite cambiar item_type de una línea existente';
            END IF;
            IF v_product_id IS DISTINCT FROM v_current_item.product_id THEN
                RAISE EXCEPTION 'No se permite cambiar product_id de una línea existente';
            END IF;
            IF v_item_type = 'SERVICE' AND v_product_id IS NOT NULL THEN
                RAISE EXCEPTION 'Una línea SERVICE no puede tener product_id';
            END IF;
            v_discount_percent := COALESCE((v_item->>'discount_percent')::numeric, v_current_item.discount_percent, 0);
            v_tax_rate := COALESCE((v_item->>'tax_rate')::numeric, v_current_item.tax_rate, 19);
            v_notes := CASE
                WHEN v_item ? 'notes' THEN v_item->>'notes'
                ELSE v_current_item.notes
            END;
        END IF;

        IF v_discount_percent < 0 OR v_discount_percent > 100 THEN
            RAISE EXCEPTION 'El descuento debe estar entre 0 y 100 en la línea %', v_line_number;
        END IF;
        IF v_tax_rate < 0 OR v_tax_rate > 100 THEN
            RAISE EXCEPTION 'El IVA debe estar entre 0 y 100 en la línea %', v_line_number;
        END IF;

        v_line_base := v_quantity * v_unit_price;
        v_discount_amount := v_line_base * v_discount_percent / 100;
        v_tax_amount := (v_line_base - v_discount_amount) * v_tax_rate / 100;
        v_line_total := v_line_base - v_discount_amount + v_tax_amount;
        v_net_total := v_net_total + (v_line_base - v_discount_amount);
        v_discount_total := v_discount_total + v_discount_amount;
        v_tax_total := v_tax_total + v_tax_amount;

        IF v_item_type = 'PRODUCT' THEN
            v_has_product := true;
        ELSE
            v_has_service := true;
        END IF;

        IF v_item_id IS NULL THEN
            INSERT INTO adquisiciones.purchase_order_items (
                company_id, po_id, line_number, item_type, product_id,
                product_description, unit, quantity, unit_price,
                discount_percent, discount_amount, tax_rate, tax_amount,
                line_total, warehouse_id, required_date, notes,
                quantity_received, created_by, updated_by
            ) VALUES (
                p_company_id, p_po_id, v_line_number, 'PRODUCT', v_product.id,
                v_product.description, v_product.unit_of_measure, v_quantity, v_unit_price,
                v_discount_percent, v_discount_amount, v_tax_rate, v_tax_amount,
                v_line_total, v_po.warehouse_id, v_po.required_date, v_notes,
                0, p_user_id, p_user_id
            );
        ELSE
            UPDATE adquisiciones.purchase_order_items
            SET line_number = v_line_number,
                quantity = v_quantity,
                unit_price = v_unit_price,
                discount_percent = v_discount_percent,
                discount_amount = v_discount_amount,
                tax_rate = v_tax_rate,
                tax_amount = v_tax_amount,
                line_total = v_line_total,
                notes = v_notes,
                updated_by = p_user_id,
                updated_at = now()
            WHERE id = v_item_id
              AND po_id = p_po_id
              AND company_id = p_company_id;
        END IF;
    END LOOP;

    IF cardinality(v_seen_item_ids) > 0 THEN
        DELETE FROM adquisiciones.purchase_order_items
        WHERE po_id = p_po_id
          AND company_id = p_company_id
          AND NOT (id = ANY(v_seen_item_ids));
    ELSE
        DELETE FROM adquisiciones.purchase_order_items
        WHERE po_id = p_po_id AND company_id = p_company_id;
    END IF;

    v_exempt_total := 0;
    v_grand_total := v_net_total + v_tax_total;

    UPDATE adquisiciones.purchase_orders
    SET po_type = CASE
            WHEN v_has_product AND v_has_service THEN 'MIXTA'
            WHEN v_has_service THEN 'SERVICIOS'
            ELSE 'PRODUCTOS'
        END,
        net_total = ROUND(v_net_total, 2),
        discount_total = ROUND(v_discount_total, 2),
        tax_total = ROUND(v_tax_total, 2),
        exempt_total = ROUND(v_exempt_total, 2),
        grand_total = ROUND(v_grand_total, 2),
        updated_by = p_user_id,
        updated_at = now()
    WHERE id = p_po_id AND company_id = p_company_id;

    RETURN jsonb_build_object(
        'success', true,
        'po_id', p_po_id,
        'status', 'ENVIADA_PROVEEDOR',
        'item_count', v_item_count,
        'net_total', ROUND(v_net_total, 2),
        'discount_total', ROUND(v_discount_total, 2),
        'tax_total', ROUND(v_tax_total, 2),
        'exempt_total', ROUND(v_exempt_total, 2),
        'grand_total', ROUND(v_grand_total, 2)
    );
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.update_purchase_order_supplier_review(uuid, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adquisiciones.update_purchase_order_supplier_review(uuid, jsonb, uuid, uuid) TO authenticated, service_role;
