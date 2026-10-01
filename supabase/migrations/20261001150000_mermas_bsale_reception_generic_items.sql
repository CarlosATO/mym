-- Make Bsale reception preparation generic: selected stock items, not one MER.

ALTER TABLE mermas.bsale_reception_operations
  ADD COLUMN IF NOT EXISTS observation text;

CREATE OR REPLACE FUNCTION mermas.prepare_bsale_reception_operation(
  p_company_id uuid, p_user_id uuid, p_office_id integer,
  p_reason text, p_observation text, p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, integraciones, mermas
AS $$
DECLARE
  v_result jsonb;
  v_operation_id uuid;
  v_snapshot jsonb;
BEGIN
  -- The existing allocator performs the locked FEFO selection. Passing NULL here
  -- deliberately leaves the generic operation header without a fake MER id.
  v_result := mermas.prepare_bsale_reception_operation(
    p_company_id, p_user_id, NULL::uuid, p_office_id, p_reason, p_items
  );
  v_operation_id := (v_result->>'operation_id')::uuid;

  UPDATE mermas.bsale_reception_operation_lines line
  SET request_line_id = movement.request_line_id
  FROM mermas.movements movement
  WHERE line.operation_id = v_operation_id
    AND line.request_line_id IS NULL
    AND line.source_movement_id = movement.id;

  SELECT jsonb_build_object(
    'correlationCode', operation.correlation_code,
    'officeId', operation.office_id,
    'reason', operation.reason,
    'observation', operation.observation,
    'lines', coalesce(jsonb_agg(jsonb_build_object(
      'variantId', line.variant_id,
      'quantity', line.quantity,
      'expirationDate', line.expiration_date,
      'lot', line.lot,
      'requestId', line.request_id,
      'requestLineId', line.request_line_id,
      'sourceMovementId', line.source_movement_id,
      'sourceConsumptionId', line.source_consumption_id,
      'sourceDetailId', line.source_detail_id,
      'unitCost', line.unit_cost
    ) ORDER BY line.variant_id, line.expiration_date NULLS LAST, line.lot), '[]'::jsonb)
  )
  INTO v_snapshot
  FROM mermas.bsale_reception_operations operation
  JOIN mermas.bsale_reception_operation_lines line ON line.operation_id = operation.id
  WHERE operation.id = v_operation_id
  GROUP BY operation.id;

  UPDATE mermas.bsale_reception_operations
  SET request_id = NULL,
      observation = nullif(btrim(p_observation), ''),
      payload_snapshot = jsonb_set(v_snapshot, '{observation}', coalesce(to_jsonb(nullif(btrim(p_observation), '')), 'null'::jsonb), true)
  WHERE id = v_operation_id;

  RETURN v_result || jsonb_build_object('payload', jsonb_set(v_snapshot, '{observation}', coalesce(to_jsonb(nullif(btrim(p_observation), '')), 'null'::jsonb), true));
END;
$$;

CREATE OR REPLACE FUNCTION mermas.apply_confirmed_bsale_reception(p_operation_id uuid, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth, core, portal, mermas AS $$
DECLARE v_operation mermas.bsale_reception_operations%ROWTYPE; v_exit_id uuid := gen_random_uuid(); v_line record;
BEGIN
  SELECT * INTO v_operation FROM mermas.bsale_reception_operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.status <> 'CONFIRMED' THEN RAISE EXCEPTION 'La recepción no está CONFIRMED'; END IF;
  IF v_operation.stock_exit_operation_id IS NOT NULL THEN RETURN jsonb_build_object('success', true, 'already_applied', true, 'stock_exit_operation_id', v_operation.stock_exit_operation_id); END IF;
  IF NOT core.has_company_access(p_user_id, v_operation.company_id)
     OR NOT core.has_permission_for_company(p_user_id, v_operation.company_id, 'logistica.mermas.request.create') THEN RAISE EXCEPTION 'No autorizado'; END IF;
  INSERT INTO mermas.stock_exit_operations(id, company_id, operation_type, reason, observation, created_by, bsale_reception_operation_id)
  VALUES (v_exit_id, v_operation.company_id, 'REGULACION', v_operation.reason, coalesce(v_operation.observation, 'Aplicación confirmada de recepción Bsale ' || v_operation.reception_id), p_user_id, p_operation_id);
  FOR v_line IN SELECT * FROM mermas.bsale_reception_operation_lines WHERE operation_id = p_operation_id LOOP
    INSERT INTO mermas.movements(company_id, movement_type, variant_id, quantity, expiration_date, lot, request_id, source, authorization_status, created_by, reason, observation, movement_group_id, bsale_reception_operation_id, bsale_reception_line_id, source_movement_id)
    VALUES (v_operation.company_id, 'SALIDA_REGULACION', v_line.variant_id, -v_line.quantity, v_line.expiration_date, v_line.lot, v_line.request_id, 'BSALE_RECEPTION', 'AUTORIZADA', p_user_id, v_operation.reason, coalesce(v_operation.observation, 'Recepción Bsale ' || v_operation.reception_id), v_exit_id, p_operation_id, v_line.id, v_line.source_movement_id);
  END LOOP;
  UPDATE mermas.bsale_reception_operations SET local_applied_at = now(), stock_exit_operation_id = v_exit_id WHERE id = p_operation_id;
  RETURN jsonb_build_object('success', true, 'stock_exit_operation_id', v_exit_id);
END;
$$;

REVOKE ALL ON FUNCTION mermas.prepare_bsale_reception_operation(uuid, uuid, integer, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.prepare_bsale_reception_operation(uuid, uuid, integer, text, text, jsonb) TO service_role;
