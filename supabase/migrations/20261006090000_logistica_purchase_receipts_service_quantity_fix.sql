-- Count accepted service lines on the purchase order without creating stock movements.

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
  p_user_id uuid,
  p_idempotency_key uuid,
  p_attachment jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, logistica, adquisiciones
AS $$
DECLARE
  v_po adquisiciones.purchase_orders%ROWTYPE;
  v_existing logistica.purchase_receipts%ROWTYPE;
  v_receipt_id uuid;
  v_receipt_number text;
  v_sequence bigint;
  v_item jsonb;
  v_po_item adquisiciones.purchase_order_items%ROWTYPE;
  v_receipt_item_id uuid;
  v_accounted_before numeric;
  v_incoming_accounted numeric;
  v_pending_after numeric;
  v_item_type text;
  v_condition text;
  v_qty_received numeric;
  v_qty_rejected numeric;
  v_qty_missing numeric;
  v_location_id uuid;
  v_unit_price numeric;
  v_net numeric(14,4);
  v_tax numeric(14,4);
  v_gross numeric(14,4);
  v_net_unit_cost numeric(14,4);
  v_total_net numeric(14,4) := 0;
  v_total_tax numeric(14,4) := 0;
  v_total_gross numeric(14,4) := 0;
  v_has_pending boolean;
  v_attachment_type text;
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS NULL OR auth.uid() <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'No autorizado');
  END IF;
  IF p_company_id IS NULL OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.receptions.create') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para registrar recepciones');
  END IF;
  IF p_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'La clave de idempotencia es obligatoria');
  END IF;
  IF p_receiving_type NOT IN ('WAREHOUSE', 'OFFICE') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tipo de recepción inválido');
  END IF;
  IF p_document_type NOT IN ('FA', 'GD') OR NULLIF(btrim(p_document_number), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tipo y número de documento son obligatorios');
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'La recepción debe contener líneas');
  END IF;

  SELECT * INTO v_po
  FROM adquisiciones.purchase_orders
  WHERE id = p_purchase_order_id
  FOR UPDATE;

  IF v_po.id IS NULL OR v_po.company_id <> p_company_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Orden de Compra no encontrada');
  END IF;

  SELECT * INTO v_existing
  FROM logistica.purchase_receipts
  WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'receipt_id', v_existing.id,
      'receipt_number', v_existing.receipt_number, 'idempotent', true);
  END IF;

  IF v_po.status NOT IN ('CONFIRMADA', 'RECEPCION_PARCIAL') THEN
    RETURN jsonb_build_object('success', false,
      'error', 'La Orden de Compra debe estar CONFIRMADA o RECEPCION_PARCIAL');
  END IF;

  INSERT INTO logistica.purchase_receipt_correlatives(company_id, next_value)
  VALUES (p_company_id, 2)
  ON CONFLICT (company_id)
  DO UPDATE SET next_value = logistica.purchase_receipt_correlatives.next_value + 1
  RETURNING next_value - 1 INTO v_sequence;
  v_receipt_number := 'REC-' || lpad(v_sequence::text, 6, '0');

  INSERT INTO logistica.purchase_receipts (
    company_id, purchase_order_id, receipt_number, receiving_type, warehouse_id,
    status, notes, document_type, document_number, document_date, idempotency_key, created_by
  ) VALUES (
    p_company_id, p_purchase_order_id, v_receipt_number, p_receiving_type,
    CASE WHEN p_receiving_type = 'WAREHOUSE' THEN p_warehouse_id ELSE NULL END,
    'COMPLETED', NULLIF(btrim(p_notes), ''), p_document_type,
    btrim(p_document_number), p_document_date, p_idempotency_key, p_user_id
  ) RETURNING id INTO v_receipt_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_po_item
    FROM adquisiciones.purchase_order_items
    WHERE id = NULLIF(v_item->>'purchase_order_item_id', '')::uuid
      AND po_id = p_purchase_order_id
    FOR UPDATE;
    IF v_po_item.id IS NULL THEN
      RAISE EXCEPTION 'Ítem de la Orden de Compra no encontrado';
    END IF;

    v_item_type := v_po_item.item_type;
    v_condition := coalesce(nullif(v_item->>'condition', ''), 'CONFORME');
    v_qty_received := coalesce(nullif(v_item->>'quantity_received', '')::numeric, 0);
    v_qty_rejected := coalesce(nullif(v_item->>'quantity_rejected', '')::numeric, 0);
    v_qty_missing := coalesce(nullif(v_item->>'quantity_missing', '')::numeric, 0);
    v_location_id := nullif(v_item->>'location_id', '')::uuid;

    IF v_condition NOT IN ('CONFORME', 'DANADO', 'RECHAZADO', 'FALTANTE')
       OR v_qty_received < 0 OR v_qty_rejected < 0 OR v_qty_missing < 0 THEN
      RAISE EXCEPTION 'Condición o cantidades inválidas';
    END IF;
    IF v_condition = 'CONFORME' AND (v_qty_received <= 0 OR v_qty_rejected <> 0 OR v_qty_missing <> 0) THEN
      RAISE EXCEPTION 'Una línea CONFORME requiere cantidad recibida';
    END IF;
    IF v_condition = 'DANADO' AND (v_qty_received <= 0 OR v_qty_rejected <> 0 OR v_qty_missing <> 0) THEN
      RAISE EXCEPTION 'Una línea DANADO requiere cantidad observada';
    END IF;
    IF v_condition = 'RECHAZADO' AND (v_qty_rejected <= 0 OR v_qty_received <> 0 OR v_qty_missing <> 0) THEN
      RAISE EXCEPTION 'Una línea RECHAZADO requiere cantidad rechazada';
    END IF;
    IF v_condition = 'FALTANTE' AND (v_qty_missing <= 0 OR v_qty_received <> 0 OR v_qty_rejected <> 0) THEN
      RAISE EXCEPTION 'Una línea FALTANTE requiere cantidad faltante';
    END IF;

    v_incoming_accounted := CASE
      WHEN v_condition IN ('CONFORME', 'DANADO') THEN v_qty_received
      ELSE 0
    END;
    SELECT coalesce(sum(i.quantity_received), 0)
    INTO v_accounted_before
    FROM logistica.purchase_receipt_items i
    JOIN logistica.purchase_receipts r ON r.id = i.receipt_id
    WHERE i.purchase_order_item_id = v_po_item.id
      AND i.company_id = p_company_id
      AND r.status = 'COMPLETED'
      AND i.condition IN ('CONFORME', 'DANADO');
    IF v_qty_received + v_qty_rejected + v_qty_missing <= 0
       OR v_accounted_before + v_incoming_accounted > v_po_item.quantity THEN
      RAISE EXCEPTION 'La cantidad supera el saldo pendiente de la línea';
    END IF;

    IF v_item_type = 'PRODUCT' AND v_po_item.product_id IS NULL THEN
      RAISE EXCEPTION 'La línea PRODUCT no tiene producto asociado';
    END IF;
    IF v_item_type = 'SERVICE' AND v_po_item.product_id IS NOT NULL THEN
      RAISE EXCEPTION 'La línea SERVICE no puede tener producto asociado';
    END IF;
    IF p_receiving_type = 'OFFICE' AND v_item_type = 'PRODUCT' THEN
      RAISE EXCEPTION 'Una línea PRODUCT requiere recepción de bodega';
    END IF;

    IF v_condition IN ('CONFORME', 'DANADO') AND v_item_type = 'PRODUCT' THEN
      IF v_location_id IS NULL OR p_warehouse_id IS NULL THEN
        RAISE EXCEPTION 'El producto conforme requiere bodega y ubicación';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM logistica.locations
        WHERE id = v_location_id AND company_id = p_company_id
          AND is_active AND warehouse_id = coalesce(v_po_item.warehouse_id, p_warehouse_id)
      ) THEN
        RAISE EXCEPTION 'La ubicación no corresponde a la bodega de la línea';
      END IF;
    ELSE
      v_location_id := NULL;
    END IF;

    v_net := 0; v_tax := 0; v_gross := 0; v_net_unit_cost := 0;
    IF v_condition IN ('CONFORME', 'DANADO') THEN
      v_unit_price := v_po_item.unit_price;
      v_net := greatest(0, v_qty_received * v_unit_price -
        CASE WHEN v_po_item.quantity > 0 THEN
          greatest(0, coalesce(v_po_item.discount_amount, 0)) * v_qty_received / v_po_item.quantity
        ELSE 0 END);
      IF coalesce(v_po_item.discount_amount, 0) = 0 THEN
        v_net := greatest(0, v_qty_received * v_unit_price *
          (1 - coalesce(v_po_item.discount_percent, 0) / 100));
      END IF;
      v_tax := v_net * coalesce(v_po_item.tax_rate, 19) / 100;
      v_gross := v_net + v_tax;
      v_net_unit_cost := CASE WHEN v_qty_received > 0 THEN v_net / v_qty_received ELSE 0 END;
      v_total_net := v_total_net + v_net;
      v_total_tax := v_total_tax + v_tax;
      v_total_gross := v_total_gross + v_gross;
    END IF;

    v_pending_after := v_po_item.quantity - v_accounted_before - v_incoming_accounted;
    INSERT INTO logistica.purchase_receipt_items (
      company_id, receipt_id, purchase_order_item_id, product_id, service_description,
      quantity_ordered, quantity_previously_received, quantity_received, quantity_rejected,
      quantity_missing, quantity_pending_after, unit_cost, net_amount, tax_amount, gross_amount,
      condition, rejection_reason, difference_reason, warehouse_id, location_id, lot_number,
      expiration_date, notes, created_by
    ) VALUES (
      p_company_id, v_receipt_id, v_po_item.id,
      CASE WHEN v_item_type = 'PRODUCT' THEN v_po_item.product_id ELSE NULL END,
      CASE WHEN v_item_type = 'SERVICE' THEN v_po_item.product_description ELSE NULL END,
      v_po_item.quantity, v_po_item.quantity_received, v_qty_received, v_qty_rejected,
      v_qty_missing, v_pending_after, v_net_unit_cost, v_net, v_tax, v_gross, v_condition,
      nullif(btrim(v_item->>'rejection_reason'), ''), nullif(btrim(v_item->>'difference_reason'), ''),
      CASE WHEN v_item_type = 'PRODUCT' THEN coalesce(v_po_item.warehouse_id, p_warehouse_id) ELSE NULL END,
      v_location_id, CASE WHEN v_item_type = 'PRODUCT' THEN nullif(v_item->>'lot_number', '') ELSE NULL END,
      CASE WHEN v_item_type = 'PRODUCT' THEN nullif(v_item->>'expiration_date', '')::date ELSE NULL END,
      nullif(btrim(v_item->>'notes'), ''), p_user_id
    ) RETURNING id INTO v_receipt_item_id;

    IF v_condition IN ('CONFORME', 'DANADO') THEN
      UPDATE adquisiciones.purchase_order_items
      SET quantity_received = quantity_received + v_qty_received, updated_at = now(), updated_by = p_user_id
      WHERE id = v_po_item.id;
    END IF;

    IF v_condition IN ('CONFORME', 'DANADO') AND v_item_type = 'PRODUCT' THEN
      INSERT INTO logistica.kardex_movements (
        company_id, product_id, warehouse_id, location_id, movement_type, source_type,
        source_id, source_line_id, quantity, unit_cost, total_cost, lot_number,
        expiration_date, notes, created_by
      ) VALUES (
        p_company_id, v_po_item.product_id, coalesce(v_po_item.warehouse_id, p_warehouse_id),
        v_location_id, 'IN', 'PURCHASE_RECEIPT', v_receipt_id, v_receipt_item_id,
        v_qty_received, v_net_unit_cost, v_net, nullif(v_item->>'lot_number', ''),
        nullif(v_item->>'expiration_date', '')::date, nullif(btrim(v_item->>'notes'), ''), p_user_id
      );
    END IF;
  END LOOP;

  UPDATE logistica.purchase_receipts
  SET receipt_total_net = v_total_net, receipt_total_tax = v_total_tax,
      receipt_total_gross = v_total_gross, received_by = p_user_id
  WHERE id = v_receipt_id;

  IF p_attachment IS NOT NULL AND jsonb_typeof(p_attachment) = 'object' THEN
    v_attachment_type := coalesce(nullif(p_attachment->>'document_type', ''), p_document_type);
    IF v_attachment_type NOT IN ('FA', 'GD', 'EVIDENCIA', 'OTRO') THEN
      RAISE EXCEPTION 'Tipo de documento adjunto inválido';
    END IF;
    INSERT INTO logistica.receipt_documents (
      company_id, receipt_id, document_type, document_number, file_url, storage_bucket,
      storage_path, document_date, file_name, file_size, mime_type, notes, created_by
    ) VALUES (
      p_company_id, v_receipt_id, v_attachment_type, btrim(p_document_number), NULL,
      coalesce(nullif(p_attachment->>'storage_bucket', ''), 'recepciones'),
      nullif(p_attachment->>'storage_path', ''), p_document_date,
      nullif(p_attachment->>'file_name', ''), nullif(p_attachment->>'file_size', '')::bigint,
      nullif(p_attachment->>'mime_type', ''), nullif(p_attachment->>'notes', ''), p_user_id
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM adquisiciones.purchase_order_items poi
    WHERE poi.po_id = p_purchase_order_id
      AND poi.quantity > (
        coalesce((
           SELECT sum(i.quantity_received)
           FROM logistica.purchase_receipt_items i
           JOIN logistica.purchase_receipts r ON r.id = i.receipt_id
           WHERE i.purchase_order_item_id = poi.id
             AND r.status = 'COMPLETED'
             AND i.condition IN ('CONFORME', 'DANADO')
        ), 0)
      )
  ) INTO v_has_pending;

  UPDATE adquisiciones.purchase_orders
  SET status = CASE WHEN v_has_pending THEN 'RECEPCION_PARCIAL' ELSE 'RECEPCION_TOTAL' END,
      receipt_status = CASE WHEN v_has_pending THEN 'RECEPCION_PARCIAL' ELSE 'RECEPCION_TOTAL' END,
      updated_at = now(), updated_by = p_user_id
  WHERE id = p_purchase_order_id;

  INSERT INTO adquisiciones.purchase_order_status_history (
    company_id, po_id, from_status, to_status, changed_by, reason
  ) VALUES (
    p_company_id, p_purchase_order_id, v_po.status,
    CASE WHEN v_has_pending THEN 'RECEPCION_PARCIAL' ELSE 'RECEPCION_TOTAL' END,
    p_user_id, 'Recepción local registrada - N° ' || v_receipt_number
  );

  RETURN jsonb_build_object('success', true, 'receipt_id', v_receipt_id,
    'receipt_number', v_receipt_number, 'idempotent', false);
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing
  FROM logistica.purchase_receipts
  WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'receipt_id', v_existing.id,
      'receipt_number', v_existing.receipt_number, 'idempotent', true);
  END IF;
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE EXECUTE ON FUNCTION logistica.create_purchase_receipt_db(uuid, uuid, text, uuid, text, text, text, date, jsonb, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.create_purchase_receipt_db(uuid, uuid, text, uuid, text, text, text, date, jsonb, uuid, uuid, jsonb) TO authenticated, service_role;
