-- Harden generic Bsale reception preparation for warehouse operators and retries.

ALTER TABLE mermas.bsale_reception_operations
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS mermas_bsale_reception_company_idempotency_uq
  ON mermas.bsale_reception_operations(company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The legacy allocator remains internal to the generic wrapper, but must use the
-- permission that actually authorizes warehouse request operations.
CREATE OR REPLACE FUNCTION mermas.prepare_bsale_reception_operation(
  p_company_id uuid, p_user_id uuid, p_request_id uuid, p_office_id integer,
  p_reason text, p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, integraciones, mermas
AS $$
DECLARE
  v_operation_id uuid := gen_random_uuid(); v_item jsonb; v_key text; v_variant_id integer;
  v_requested jsonb := '{}'::jsonb; v_remaining numeric; v_piece numeric; v_lot record;
  v_code text; v_snapshot jsonb;
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.request.create') THEN
    RAISE EXCEPTION 'No autorizado para preparar una recepción de Mermas';
  END IF;
  IF p_office_id IS NULL OR p_office_id <= 0 OR length(btrim(coalesce(p_reason, ''))) = 0
     OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Datos de recepción inválidos';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'Usuario inválido'; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_variant_id := nullif(v_item->>'variant_id', '')::integer;
    IF v_variant_id IS NULL OR v_variant_id <= 0 OR (v_item->>'quantity')::numeric <= 0 THEN RAISE EXCEPTION 'Producto o cantidad inválida'; END IF;
    v_requested := jsonb_set(v_requested, ARRAY[v_variant_id::text],
      to_jsonb(coalesce((v_requested->>v_variant_id::text)::numeric, 0) + (v_item->>'quantity')::numeric), true);
  END LOOP;
  INSERT INTO mermas.bsale_reception_operations(id, company_id, correlation_code, request_id, office_id, reason, created_by)
  VALUES (v_operation_id, p_company_id, 'MERMA-' || to_char(now(), 'YYYYMMDDHH24MISSMS') || '-' || substr(v_operation_id::text, 1, 8), p_request_id, p_office_id, btrim(p_reason), p_user_id)
  RETURNING correlation_code INTO v_code;
  FOR v_key IN SELECT key FROM jsonb_each(v_requested) ORDER BY key LOOP
    v_variant_id := v_key::integer; v_remaining := (v_requested->>v_key)::numeric;
    PERFORM pg_advisory_xact_lock(hashtextextended('mermas-reception:' || p_company_id::text || ':' || v_variant_id::text, 0));
    PERFORM 1 FROM mermas.movements WHERE company_id = p_company_id AND variant_id = v_variant_id FOR UPDATE;
    FOR v_lot IN
      SELECT sc.*, coalesce(cost.unit_cost, vc.average_cost) AS unit_cost,
        cost.source_movement_id, cost.source_consumption_id, cost.source_detail_id
      FROM mermas.stock_current sc
      LEFT JOIN LATERAL (
        SELECT sum(m.quantity * d.cost) / nullif(sum(m.quantity), 0) AS unit_cost,
          (array_agg(m.id ORDER BY m.created_at, m.id))[1] AS source_movement_id, min(m.consumption_id) AS source_consumption_id, min(m.detail_id) AS source_detail_id
        FROM mermas.movements m
        LEFT JOIN mermas.bsale_consumption_details d ON d.company_id = m.company_id
          AND d.consumption_id = m.consumption_id AND d.detail_id = m.detail_id AND d.variant_id = m.variant_id
        WHERE m.company_id = sc.company_id AND m.variant_id = sc.variant_id AND m.quantity > 0
          AND m.movement_type IN ('ENTRADA_BSALE', 'STOCK_INICIAL')
          AND m.expiration_date IS NOT DISTINCT FROM sc.expiration_date
          AND m.lot IS NOT DISTINCT FROM sc.lot AND m.request_id IS NOT DISTINCT FROM sc.request_id
          AND m.authorization_status = 'AUTORIZADA' AND d.cost IS NOT NULL AND d.cost > 0
      ) cost ON true
      LEFT JOIN integraciones.bsale_variant_costs vc ON vc.company_id = sc.company_id AND vc.variant_id = sc.variant_id
      WHERE sc.company_id = p_company_id AND sc.variant_id = v_variant_id AND sc.available > 0
      ORDER BY sc.expiration_date IS NULL, sc.expiration_date, sc.entered_at, sc.lot NULLS FIRST
    LOOP
      EXIT WHEN v_remaining <= 0;
      IF v_lot.unit_cost IS NULL OR v_lot.unit_cost <= 0 THEN RAISE EXCEPTION 'La variante % no tiene costo histórico confiable', v_variant_id; END IF;
      v_piece := least(v_remaining, v_lot.available);
      INSERT INTO mermas.bsale_reception_operation_lines(company_id, operation_id, variant_id, quantity, expiration_date, lot, request_id, request_line_id, source_movement_id, source_consumption_id, source_detail_id, unit_cost)
      VALUES (p_company_id, v_operation_id, v_variant_id, v_piece, v_lot.expiration_date, v_lot.lot, v_lot.request_id, NULL, v_lot.source_movement_id, v_lot.source_consumption_id, v_lot.source_detail_id, v_lot.unit_cost);
      v_remaining := v_remaining - v_piece;
    END LOOP;
    IF v_remaining > 0 THEN RAISE EXCEPTION 'Stock elegible insuficiente para la variante %', v_variant_id; END IF;
  END LOOP;
  SELECT jsonb_build_object('correlationCode', v_code, 'officeId', p_office_id, 'reason', btrim(p_reason), 'lines', coalesce(jsonb_agg(jsonb_build_object('variantId', variant_id, 'quantity', quantity, 'expirationDate', expiration_date, 'lot', lot, 'requestId', request_id, 'requestLineId', request_line_id, 'sourceMovementId', source_movement_id, 'sourceConsumptionId', source_consumption_id, 'sourceDetailId', source_detail_id, 'unitCost', unit_cost) ORDER BY variant_id, expiration_date NULLS LAST, lot), '[]'::jsonb))
  INTO v_snapshot FROM mermas.bsale_reception_operation_lines WHERE operation_id = v_operation_id;
  UPDATE mermas.bsale_reception_operations SET payload_snapshot = v_snapshot WHERE id = v_operation_id;
  RETURN jsonb_build_object('operation_id', v_operation_id, 'status', 'PREPARED', 'reception_id', NULL, 'error', NULL, 'local_applied_at', NULL, 'payload', v_snapshot);
END;
$$;

CREATE OR REPLACE FUNCTION mermas.prepare_bsale_reception_operation(
  p_company_id uuid, p_user_id uuid, p_idempotency_key uuid, p_office_id integer,
  p_reason text, p_observation text, p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, integraciones, mermas
AS $$
DECLARE
  v_existing mermas.bsale_reception_operations%ROWTYPE;
  v_result jsonb; v_operation_id uuid; v_snapshot jsonb; v_observation text := nullif(btrim(p_observation), '');
BEGIN
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'La idempotency_key es obligatoria'; END IF;
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.request.create') THEN
    RAISE EXCEPTION 'No autorizado para preparar una recepción de Mermas';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mermas-reception-idempotency:' || p_company_id::text || ':' || p_idempotency_key::text, 0));
  SELECT * INTO v_existing
  FROM mermas.bsale_reception_operations
  WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('operation_id', v_existing.id, 'status', v_existing.status, 'reception_id', v_existing.reception_id, 'error', v_existing.error_message, 'local_applied_at', v_existing.local_applied_at, 'payload', v_existing.payload_snapshot);
  END IF;

  v_result := mermas.prepare_bsale_reception_operation(p_company_id, p_user_id, NULL::uuid, p_office_id, p_reason, p_items);
  v_operation_id := (v_result->>'operation_id')::uuid;
  UPDATE mermas.bsale_reception_operation_lines line
  SET request_line_id = movement.request_line_id
  FROM mermas.movements movement
  WHERE line.operation_id = v_operation_id AND line.request_line_id IS NULL AND line.source_movement_id = movement.id;

  SELECT jsonb_build_object(
    'correlationCode', operation.correlation_code, 'officeId', operation.office_id,
    'reason', operation.reason, 'observation', v_observation,
    'lines', coalesce(jsonb_agg(jsonb_build_object(
      'variantId', line.variant_id, 'quantity', line.quantity, 'expirationDate', line.expiration_date,
      'lot', line.lot, 'requestId', line.request_id, 'requestLineId', line.request_line_id,
      'sourceMovementId', line.source_movement_id, 'sourceConsumptionId', line.source_consumption_id,
      'sourceDetailId', line.source_detail_id, 'unitCost', line.unit_cost
    ) ORDER BY line.variant_id, line.expiration_date NULLS LAST, line.lot), '[]'::jsonb)
  ) INTO v_snapshot
  FROM mermas.bsale_reception_operations operation
  JOIN mermas.bsale_reception_operation_lines line ON line.operation_id = operation.id
  WHERE operation.id = v_operation_id GROUP BY operation.id;

  UPDATE mermas.bsale_reception_operations
  SET idempotency_key = p_idempotency_key, request_id = NULL, observation = v_observation,
      payload_snapshot = jsonb_set(v_snapshot, '{observation}', coalesce(to_jsonb(v_observation), 'null'::jsonb), true)
  WHERE id = v_operation_id;
  RETURN jsonb_build_object('operation_id', v_operation_id, 'status', 'PREPARED', 'reception_id', NULL, 'error', NULL, 'local_applied_at', NULL, 'payload', jsonb_set(v_snapshot, '{observation}', coalesce(to_jsonb(v_observation), 'null'::jsonb), true));
END;
$$;

REVOKE ALL ON FUNCTION mermas.prepare_bsale_reception_operation(uuid, uuid, uuid, integer, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.prepare_bsale_reception_operation(uuid, uuid, uuid, integer, text, text, jsonb) TO service_role;
