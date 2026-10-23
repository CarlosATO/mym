-- Recepciones-only hotfix: warehouse fallback, strict document numbers and
-- invalid BSale payload retry protection.
BEGIN;

-- Keep the already deployed implementation intact behind a private wrapper so
-- existing line and Kardex fallback semantics remain unchanged.
ALTER FUNCTION logistica.create_purchase_receipt_db(
  uuid, uuid, text, uuid, text, text, text, date, jsonb, uuid, uuid, jsonb
) RENAME TO create_purchase_receipt_db_pre_hotfix;

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
  v_effective_warehouse_id uuid;
BEGIN
  IF p_document_number IS NULL OR p_document_number !~ '^[0-9]+$' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Ingrese un solo número de documento, sin puntos, guiones ni espacios.'
    );
  END IF;

  IF p_receiving_type = 'WAREHOUSE' THEN
    SELECT * INTO v_po
    FROM adquisiciones.purchase_orders
    WHERE id = p_purchase_order_id
      AND company_id = p_company_id;

    IF v_po.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Orden de Compra no encontrada');
    END IF;

    v_effective_warehouse_id := coalesce(p_warehouse_id, v_po.warehouse_id);
    IF v_effective_warehouse_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Debe seleccionar una bodega de recepción.');
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM adquisiciones.warehouses w
      WHERE w.id = v_effective_warehouse_id
        AND w.company_id = p_company_id
        AND w.is_active = true
    ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'La bodega seleccionada no existe, está inactiva o no pertenece a la empresa.'
      );
    END IF;
  END IF;

  RETURN logistica.create_purchase_receipt_db_pre_hotfix(
    p_company_id,
    p_purchase_order_id,
    p_receiving_type,
    v_effective_warehouse_id,
    p_notes,
    p_document_type,
    p_document_number,
    p_document_date,
    p_items,
    p_user_id,
    p_idempotency_key,
    p_attachment
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
       OR (v_detail->>'cost')::numeric <= 0 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION integraciones.retry_failed_bsale_purchase_receipt_operation(
  p_operation_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones
AS $$
DECLARE
  o integraciones.bsale_purchase_receipt_operations%ROWTYPE;
BEGIN
  SELECT * INTO o
  FROM integraciones.bsale_purchase_receipt_operations
  WHERE id = p_operation_id
  FOR UPDATE;

  IF NOT FOUND
     OR NOT core.has_company_access(p_user_id, o.company_id)
     OR NOT core.has_permission_for_company(p_user_id, o.company_id, 'logistica.receptions.create') THEN
    RAISE EXCEPTION 'Operación no encontrada o no autorizada';
  END IF;

  IF o.status <> 'FAILED' THEN
    RETURN jsonb_build_object(
      'status', o.status,
      'operation_id', o.id,
      'reception_id', o.bsale_reception_id,
      'error', o.error_message,
      'payload', o.payload_snapshot
    );
  END IF;

  IF NOT integraciones.purchase_receipt_payload_is_valid(o.payload_snapshot) THEN
    RETURN jsonb_build_object(
      'status', 'FAILED',
      'operation_id', o.id,
      'reception_id', o.bsale_reception_id,
      'error', coalesce(o.error_message, 'La recepción no tiene un payload BSale válido; corrija los datos antes de sincronizar.'),
      'payload', o.payload_snapshot
    );
  END IF;

  UPDATE integraciones.bsale_purchase_receipt_operations
  SET status = 'PREPARED', error_message = NULL, bsale_reception_id = NULL
  WHERE id = o.id;

  RETURN jsonb_build_object(
    'status', 'PREPARED',
    'operation_id', o.id,
    'reception_id', NULL,
    'error', NULL,
    'payload', o.payload_snapshot
  );
END;
$$;

REVOKE ALL ON FUNCTION logistica.create_purchase_receipt_db_pre_hotfix(uuid, uuid, text, uuid, text, text, text, date, jsonb, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.create_purchase_receipt_db_pre_hotfix(uuid, uuid, text, uuid, text, text, text, date, jsonb, uuid, uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION logistica.create_purchase_receipt_db(uuid, uuid, text, uuid, text, text, text, date, jsonb, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.create_purchase_receipt_db(uuid, uuid, text, uuid, text, text, text, date, jsonb, uuid, uuid, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION integraciones.purchase_receipt_payload_is_valid(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION integraciones.purchase_receipt_payload_is_valid(jsonb) TO service_role;
REVOKE ALL ON FUNCTION integraciones.retry_failed_bsale_purchase_receipt_operation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.retry_failed_bsale_purchase_receipt_operation(uuid, uuid) TO service_role;

COMMIT;
