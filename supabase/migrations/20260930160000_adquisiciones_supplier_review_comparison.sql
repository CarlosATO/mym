-- Read-only comparison between the ORIGINAL_SENT snapshot and the current PO.

CREATE OR REPLACE FUNCTION adquisiciones.get_purchase_order_supplier_review_comparison(
    p_po_id uuid,
    p_user_id uuid,
    p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_po adquisiciones.purchase_orders%ROWTYPE;
    v_snapshot adquisiciones.purchase_order_snapshots%ROWTYPE;
    v_original_item jsonb;
    v_current_item jsonb;
    v_comparison jsonb := '[]'::jsonb;
    v_current_items jsonb := '[]'::jsonb;
    v_original_ids uuid[] := ARRAY[]::uuid[];
    v_item_id uuid;
    v_field text;
    v_original_value jsonb;
    v_current_value jsonb;
    v_changed_fields jsonb;
    v_changed boolean;
    v_original_grand_total numeric;
    v_current_grand_total numeric;
    v_unchanged_count integer := 0;
    v_modified_count integer := 0;
    v_removed_count integer := 0;
    v_added_count integer := 0;
    v_is_admin boolean;
    v_supplier_name text;
    v_supplier_rut text;
    v_warehouse_name text;
    v_comparison_fields constant text[] := ARRAY[
        'item_type', 'product_id', 'product_description', 'unit',
        'quantity', 'unit_price', 'discount_percent', 'tax_rate', 'notes'
    ];
BEGIN
    IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION 'El usuario de la sesión no coincide con p_user_id';
    END IF;

    v_is_admin := portal.user_has_permission(p_user_id, 'system.admin');
    IF NOT (v_is_admin OR core.has_company_access(p_user_id, p_company_id)) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa';
    END IF;
    IF NOT (v_is_admin OR portal.user_has_permission(p_user_id, 'adquisiciones.po.view')) THEN
        RAISE EXCEPTION 'Permisos insuficientes para consultar la comparación de la orden de compra';
    END IF;

    SELECT * INTO v_po
    FROM adquisiciones.purchase_orders
    WHERE id = p_po_id AND company_id = p_company_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'La OC no existe o no pertenece a la empresa';
    END IF;

    SELECT * INTO v_snapshot
    FROM adquisiciones.purchase_order_snapshots
    WHERE po_id = p_po_id
      AND company_id = p_company_id
      AND snapshot_type = 'ORIGINAL_SENT';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'La OC no tiene snapshot ORIGINAL_SENT';
    END IF;

    SELECT
        COALESCE(NULLIF(s.business_name, ''), NULLIF(s.fantasy_name, '')),
        s.rut
    INTO v_supplier_name, v_supplier_rut
    FROM adquisiciones.suppliers s
    WHERE s.id = v_po.supplier_id
      AND s.company_id = p_company_id;

    SELECT w.name INTO v_warehouse_name
    FROM adquisiciones.warehouses w
    WHERE w.id = v_po.warehouse_id
      AND w.company_id = p_company_id;

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'item_id', i.id,
                'line_number', i.line_number,
                'item_type', i.item_type,
                'product_id', i.product_id,
                'sku', CASE WHEN i.item_type = 'SERVICE' THEN NULL ELSE pr.sku END,
                'product_description', i.product_description,
                'unit', i.unit,
                'quantity', i.quantity,
                'unit_price', i.unit_price,
                'discount_percent', i.discount_percent,
                'discount_amount', i.discount_amount,
                'tax_rate', i.tax_rate,
                'tax_amount', i.tax_amount,
                'line_total', i.line_total,
                'notes', i.notes
            ) ORDER BY i.line_number
        ),
        '[]'::jsonb
    ) INTO v_current_items
    FROM adquisiciones.purchase_order_items i
    LEFT JOIN adquisiciones.products pr
        ON pr.id = i.product_id
       AND pr.company_id = p_company_id
    WHERE i.po_id = p_po_id
      AND i.company_id = p_company_id;

    FOR v_original_item IN
        SELECT value
        FROM jsonb_array_elements(v_snapshot.items_snapshot)
        ORDER BY COALESCE((value->>'line_number')::integer, 2147483647)
    LOOP
        v_item_id := NULLIF(v_original_item->>'item_id', '')::uuid;
        v_original_ids := array_append(v_original_ids, v_item_id);

        SELECT jsonb_build_object(
            'item_id', i.id,
            'line_number', i.line_number,
            'item_type', i.item_type,
            'product_id', i.product_id,
            'sku', CASE WHEN i.item_type = 'SERVICE' THEN NULL ELSE pr.sku END,
            'product_description', i.product_description,
            'unit', i.unit,
            'quantity', i.quantity,
            'unit_price', i.unit_price,
            'discount_percent', i.discount_percent,
            'discount_amount', i.discount_amount,
            'tax_rate', i.tax_rate,
            'tax_amount', i.tax_amount,
            'line_total', i.line_total,
            'notes', i.notes
        ) INTO v_current_item
        FROM adquisiciones.purchase_order_items i
        LEFT JOIN adquisiciones.products pr
            ON pr.id = i.product_id
           AND pr.company_id = p_company_id
        WHERE i.id = v_item_id
          AND i.po_id = p_po_id
          AND i.company_id = p_company_id;

        IF v_current_item IS NULL THEN
            v_removed_count := v_removed_count + 1;
            v_comparison := v_comparison || jsonb_build_array(jsonb_build_object(
                'item_id', v_item_id,
                'comparison_status', 'ELIMINADA',
                'original_item', v_original_item,
                'current_item', NULL,
                'changed_fields', '[]'::jsonb
            ));
            CONTINUE;
        END IF;

        v_changed_fields := '[]'::jsonb;
        v_changed := false;
        FOREACH v_field IN ARRAY v_comparison_fields
        LOOP
            v_original_value := v_original_item->v_field;
            v_current_value := v_current_item->v_field;

            IF v_field IN ('quantity', 'unit_price', 'discount_percent', 'tax_rate') THEN
                IF NULLIF(v_original_value #>> '{}', '')::numeric IS DISTINCT FROM
                   NULLIF(v_current_value #>> '{}', '')::numeric THEN
                    v_changed := true;
                    v_changed_fields := v_changed_fields || jsonb_build_array(jsonb_build_object(
                        'field', v_field,
                        'original', v_original_value,
                        'current', v_current_value
                    ));
                END IF;
            ELSE
                IF NULLIF(v_original_value #>> '{}', '') IS DISTINCT FROM
                   NULLIF(v_current_value #>> '{}', '') THEN
                    v_changed := true;
                    v_changed_fields := v_changed_fields || jsonb_build_array(jsonb_build_object(
                        'field', v_field,
                        'original', v_original_value,
                        'current', v_current_value
                    ));
                END IF;
            END IF;
        END LOOP;

        IF v_changed THEN
            v_modified_count := v_modified_count + 1;
            v_comparison := v_comparison || jsonb_build_array(jsonb_build_object(
                'item_id', v_item_id,
                'comparison_status', 'MODIFICADA',
                'original_item', v_original_item,
                'current_item', v_current_item,
                'changed_fields', v_changed_fields
            ));
        ELSE
            v_unchanged_count := v_unchanged_count + 1;
            v_comparison := v_comparison || jsonb_build_array(jsonb_build_object(
                'item_id', v_item_id,
                'comparison_status', 'SIN_CAMBIOS',
                'original_item', v_original_item,
                'current_item', v_current_item,
                'changed_fields', '[]'::jsonb
            ));
        END IF;
    END LOOP;

    FOR v_current_item IN
        SELECT value
        FROM jsonb_array_elements(v_current_items)
        ORDER BY COALESCE((value->>'line_number')::integer, 2147483647)
    LOOP
        v_item_id := (v_current_item->>'item_id')::uuid;
        IF NOT (v_item_id = ANY(v_original_ids)) THEN
            v_added_count := v_added_count + 1;
            v_comparison := v_comparison || jsonb_build_array(jsonb_build_object(
                'item_id', v_item_id,
                'comparison_status', 'AGREGADA',
                'original_item', NULL,
                'current_item', v_current_item,
                'changed_fields', '[]'::jsonb
            ));
        END IF;
    END LOOP;

    v_original_grand_total := NULLIF(v_snapshot.header_snapshot->>'grand_total', '')::numeric;
    v_current_grand_total := v_po.grand_total;

    RETURN jsonb_build_object(
        'success', true,
        'po', jsonb_build_object(
            'id', v_po.id,
            'correlative', v_po.correlative,
            'status', v_po.status,
            'supplier_id', v_po.supplier_id,
            'supplier_name', v_supplier_name,
            'supplier_rut', v_supplier_rut,
            'warehouse_id', v_po.warehouse_id,
            'warehouse_name', v_warehouse_name,
            'currency', v_po.currency,
            'issue_date', v_po.issue_date,
            'required_date', v_po.required_date,
            'payment_terms', v_po.payment_terms,
            'net_total', v_po.net_total,
            'discount_total', v_po.discount_total,
            'tax_total', v_po.tax_total,
            'grand_total', v_po.grand_total
        ),
        'original', jsonb_build_object(
            'snapshot_id', v_snapshot.id,
            'created_at', v_snapshot.created_at,
            'header', v_snapshot.header_snapshot,
            'items', v_snapshot.items_snapshot
        ),
        'current', jsonb_build_object('items', v_current_items),
        'comparison', v_comparison,
        'summary', jsonb_build_object(
            'total_lines', v_unchanged_count + v_modified_count + v_removed_count + v_added_count,
            'unchanged_count', v_unchanged_count,
            'modified_count', v_modified_count,
            'removed_count', v_removed_count,
            'added_count', v_added_count,
            'original_grand_total', v_original_grand_total,
            'current_grand_total', v_current_grand_total,
            'total_difference', v_current_grand_total - v_original_grand_total
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_purchase_order_supplier_review_comparison(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adquisiciones.get_purchase_order_supplier_review_comparison(uuid, uuid, uuid) TO authenticated, service_role;
