-- Migration: 20261112100000_logistica_bsale_purchase_receipt_zero_cost_bonification.sql
-- Description: Allow 100% bonification lines with legitimate discount to process with zero cost ($0) into BSale, while strictly rejecting non-positive quantities, negative costs, and non-bonified zero costs.

BEGIN;

CREATE OR REPLACE FUNCTION integraciones.prepare_bsale_purchase_receipt_operation(
  p_purchase_receipt_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, logistica, adquisiciones, integraciones
AS $$
DECLARE
  r logistica.purchase_receipts%ROWTYPE;
  s integraciones.bsale_purchase_receipt_settings%ROWTYPE;
  o integraciones.bsale_purchase_receipt_operations%ROWTYPE;
  v_doc text;
  v_number bigint;
  v_note text;
  v_details jsonb := '[]'::jsonb;
  v_service numeric := 0;
  x record;
BEGIN
  SELECT * INTO r
  FROM logistica.purchase_receipts
  WHERE id = p_purchase_receipt_id
  FOR SHARE;

  IF NOT FOUND
     OR NOT core.has_company_access(p_user_id, r.company_id)
     OR NOT core.has_permission_for_company(p_user_id, r.company_id, 'logistica.receptions.create') THEN
    RAISE EXCEPTION 'Recepción no encontrada o no autorizada';
  END IF;

  SELECT * INTO o
  FROM integraciones.bsale_purchase_receipt_operations
  WHERE purchase_receipt_id = r.id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'operation_id', o.id,
      'status', o.status,
      'reception_id', o.bsale_reception_id,
      'error', o.error_message,
      'payload', o.payload_snapshot
    );
  END IF;

  SELECT * INTO s
  FROM integraciones.bsale_purchase_receipt_settings
  WHERE company_id = r.company_id;

  IF NOT FOUND THEN
    INSERT INTO integraciones.bsale_purchase_receipt_operations(
      company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by
    ) VALUES (
      r.company_id, r.id, r.receipt_number, NULL, 'FAILED', 'La empresa no tiene configuración de Recepciones BSale', p_user_id
    ) RETURNING * INTO o;

    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END IF;

  IF NOT s.enabled THEN
    INSERT INTO integraciones.bsale_purchase_receipt_operations(
      company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by
    ) VALUES (
      r.company_id, r.id, r.receipt_number, s.office_id, 'FAILED', 'La integración de Recepciones BSale está deshabilitada', p_user_id
    ) RETURNING * INTO o;

    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END IF;

  IF r.document_type = 'FA' THEN
    v_doc := 'FACTURA';
  ELSIF r.document_type = 'GD' THEN
    v_doc := 'GUÍA';
  ELSE
    INSERT INTO integraciones.bsale_purchase_receipt_operations(
      company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by
    ) VALUES (
      r.company_id, r.id, r.receipt_number, s.office_id, 'FAILED', 'Documento no soportado por BSale', p_user_id
    ) RETURNING * INTO o;

    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END IF;

  BEGIN
    v_number := btrim(r.document_number)::bigint;
  EXCEPTION WHEN invalid_text_representation THEN
    INSERT INTO integraciones.bsale_purchase_receipt_operations(
      company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by
    ) VALUES (
      r.company_id, r.id, r.receipt_number, s.office_id, 'FAILED', 'El número de documento debe ser numérico para BSale', p_user_id
    ) RETURNING * INTO o;

    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END;

  IF v_number <= 0 THEN
    INSERT INTO integraciones.bsale_purchase_receipt_operations(
      company_id, purchase_receipt_id, correlation_code, office_id, status, error_message, created_by
    ) VALUES (
      r.company_id, r.id, r.receipt_number, s.office_id, 'FAILED', 'El número de documento debe ser positivo para BSale', p_user_id
    ) RETURNING * INTO o;

    RETURN jsonb_build_object('operation_id', o.id, 'status', o.status, 'reception_id', NULL, 'error', o.error_message, 'payload', o.payload_snapshot);
  END IF;

  v_note := r.receipt_number || ' | ' || (SELECT po.correlative FROM adquisiciones.purchase_orders po WHERE po.id = r.purchase_order_id);
  IF r.notes IS NOT NULL AND char_length(v_note) < 100 THEN
    v_note := v_note || ' | ' || left(r.notes, greatest(0, 100 - char_length(v_note) - 3));
  END IF;

  INSERT INTO integraciones.bsale_purchase_receipt_operations(
    company_id, purchase_receipt_id, correlation_code, office_id, created_by
  ) VALUES (
    r.company_id, r.id, v_note, s.office_id, p_user_id
  ) RETURNING * INTO o;

  FOR x IN SELECT
      p.bsale_variant_id AS variant_id,
      sum(i.quantity_received) AS quantity,
      sum(i.net_amount) AS net_amount,
      bool_and(
        poi.unit_price > 0 AND (
          coalesce(poi.discount_percent, 0) = 100
          OR coalesce(poi.discount_unit_amount, 0) >= poi.unit_price
          OR coalesce(poi.discount_amount, 0) >= (poi.unit_price * poi.quantity)
        )
      ) AS is_legitimate_bonus
    FROM logistica.purchase_receipt_items i
    JOIN adquisiciones.purchase_order_items poi ON poi.id = i.purchase_order_item_id
    JOIN adquisiciones.products p ON p.id = i.product_id
    WHERE i.receipt_id = r.id
      AND poi.item_type = 'PRODUCT'
      AND i.condition IN ('CONFORME','DANADO')
    GROUP BY p.bsale_variant_id LOOP

    IF x.variant_id IS NULL THEN
      RAISE EXCEPTION 'Una línea PRODUCT no tiene bsale_variant_id';
    END IF;

    IF x.quantity <= 0 OR x.net_amount < 0 OR (x.net_amount = 0 AND NOT coalesce(x.is_legitimate_bonus, false)) THEN
      RAISE EXCEPTION 'Línea PRODUCT sin cantidad o costo neto válido';
    END IF;

    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'quantity', x.quantity,
      'variantId', x.variant_id,
      'cost', CASE WHEN x.quantity > 0 THEN x.net_amount / x.quantity ELSE 0 END
    ));
  END LOOP;

  SELECT coalesce(sum(i.net_amount), 0) INTO v_service
  FROM logistica.purchase_receipt_items i
  JOIN adquisiciones.purchase_order_items poi ON poi.id = i.purchase_order_item_id
  WHERE i.receipt_id = r.id
    AND poi.item_type = 'SERVICE'
    AND i.condition IN ('CONFORME','DANADO');

  IF v_service > 0 THEN
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'quantity', 1,
      'variantId', s.service_variant_id,
      'cost', v_service
    ));
  END IF;

  IF jsonb_array_length(v_details) = 0 THEN
    RAISE EXCEPTION 'La recepción no tiene líneas aceptadas para BSale';
  END IF;

  UPDATE integraciones.bsale_purchase_receipt_operations
  SET payload_snapshot = jsonb_build_object(
        'document', v_doc,
        'officeId', s.office_id,
        'documentNumber', v_number,
        'note', left(v_note, 100),
        'details', v_details
      ),
      correlation_code = left(v_note, 100)
  WHERE id = o.id
  RETURNING * INTO o;

  RETURN jsonb_build_object(
    'operation_id', o.id,
    'status', o.status,
    'reception_id', o.bsale_reception_id,
    'error', o.error_message,
    'payload', o.payload_snapshot
  );
END;
$$;

CREATE OR REPLACE FUNCTION integraciones.purchase_receipt_payload_is_valid(
  p_payload jsonb
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_detail jsonb;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object'
     OR p_payload->>'document' NOT IN ('FACTURA', 'GUÍA')
     OR jsonb_typeof(p_payload->'officeId') <> 'number'
     OR p_payload->>'officeId' !~ '^[0-9]+$'
     OR (p_payload->>'officeId')::bigint <= 0
     OR jsonb_typeof(p_payload->'documentNumber') <> 'number'
     OR p_payload->>'documentNumber' !~ '^[0-9]+$'
     OR (p_payload->>'documentNumber')::bigint <= 0
     OR jsonb_typeof(p_payload->'note') <> 'string'
     OR jsonb_typeof(p_payload->'details') <> 'array'
     OR jsonb_array_length(p_payload->'details') = 0 THEN
    RETURN false;
  END IF;

  FOR v_detail IN SELECT value FROM jsonb_array_elements(p_payload->'details') LOOP
    IF jsonb_typeof(v_detail) <> 'object'
       OR jsonb_typeof(v_detail->'variantId') <> 'number'
       OR v_detail->>'variantId' !~ '^[0-9]+$'
       OR (v_detail->>'variantId')::bigint <= 0
       OR jsonb_typeof(v_detail->'quantity') <> 'number'
       OR (v_detail->>'quantity')::numeric <= 0
       OR jsonb_typeof(v_detail->'cost') <> 'number'
       OR (v_detail->>'cost')::numeric < 0 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION integraciones.prepare_bsale_purchase_receipt_operation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.prepare_bsale_purchase_receipt_operation(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION integraciones.purchase_receipt_payload_is_valid(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION integraciones.purchase_receipt_payload_is_valid(jsonb) TO service_role;

COMMIT;

