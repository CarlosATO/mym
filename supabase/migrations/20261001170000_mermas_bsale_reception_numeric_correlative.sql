-- Use a numeric, year-scoped document number for new Bsale receptions.

CREATE TABLE IF NOT EXISTS mermas.bsale_reception_correlatives (
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  reception_year integer NOT NULL CHECK (reception_year >= 2000),
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (company_id, reception_year)
);

ALTER TABLE mermas.bsale_reception_operations
  ADD COLUMN IF NOT EXISTS reception_year integer,
  ADD COLUMN IF NOT EXISTS reception_sequence bigint,
  ADD COLUMN IF NOT EXISTS document_number bigint;

CREATE UNIQUE INDEX IF NOT EXISTS mermas_bsale_reception_company_year_sequence_uq
  ON mermas.bsale_reception_operations(company_id, reception_year, reception_sequence)
  WHERE reception_year IS NOT NULL AND reception_sequence IS NOT NULL;

CREATE OR REPLACE FUNCTION mermas.prepare_bsale_reception_operation(
  p_company_id uuid, p_user_id uuid, p_idempotency_key uuid, p_office_id integer,
  p_reason text, p_observation text, p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, integraciones, mermas
AS $$
DECLARE
  v_existing mermas.bsale_reception_operations%ROWTYPE;
  v_result jsonb; v_operation_id uuid; v_snapshot jsonb;
  v_observation text := nullif(btrim(p_observation), '');
  v_year integer := extract(year from timezone('America/Santiago', now()))::integer;
  v_sequence bigint; v_code text; v_document_number bigint;
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
    RETURN jsonb_build_object('operation_id', v_existing.id, 'status', v_existing.status,
      'reception_id', v_existing.reception_id, 'error', v_existing.error_message,
      'local_applied_at', v_existing.local_applied_at, 'payload', v_existing.payload_snapshot);
  END IF;

  INSERT INTO mermas.bsale_reception_correlatives(company_id, reception_year, next_value)
  VALUES (p_company_id, v_year, 2)
  ON CONFLICT (company_id, reception_year)
  DO UPDATE SET next_value = mermas.bsale_reception_correlatives.next_value + 1
  RETURNING next_value - 1 INTO v_sequence;
  IF v_sequence > 999999 THEN RAISE EXCEPTION 'Se agotó el correlativo anual de recepciones de Mermas'; END IF;
  v_code := 'REG-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0');
  v_document_number := v_year::bigint * 1000000 + v_sequence;

  v_result := mermas.prepare_bsale_reception_operation(p_company_id, p_user_id, NULL::uuid, p_office_id, p_reason, p_items);
  v_operation_id := (v_result->>'operation_id')::uuid;

  UPDATE mermas.bsale_reception_operation_lines line
  SET request_line_id = movement.request_line_id
  FROM mermas.movements movement
  WHERE line.operation_id = v_operation_id AND line.request_line_id IS NULL
    AND line.source_movement_id = movement.id;

  SELECT jsonb_build_object(
    'correlationCode', operation.correlation_code, 'officeId', operation.office_id,
    'reason', operation.reason, 'observation', v_observation,
    'lines', coalesce(jsonb_agg(jsonb_build_object(
      'variantId', line.variant_id, 'quantity', line.quantity,
      'expirationDate', line.expiration_date, 'lot', line.lot,
      'requestId', line.request_id, 'requestLineId', line.request_line_id,
      'sourceMovementId', line.source_movement_id, 'sourceConsumptionId', line.source_consumption_id,
      'sourceDetailId', line.source_detail_id, 'unitCost', line.unit_cost
    ) ORDER BY line.variant_id, line.expiration_date NULLS LAST, line.lot), '[]'::jsonb)
  ) INTO v_snapshot
  FROM mermas.bsale_reception_operations operation
  JOIN mermas.bsale_reception_operation_lines line ON line.operation_id = operation.id
  WHERE operation.id = v_operation_id
  GROUP BY operation.id;
  v_snapshot := jsonb_set(v_snapshot, '{correlationCode}', to_jsonb(v_code), true);
  v_snapshot := jsonb_set(v_snapshot, '{documentNumber}', to_jsonb(v_document_number), true);

  UPDATE mermas.bsale_reception_operations
  SET idempotency_key = p_idempotency_key,
      request_id = NULL,
      correlation_code = v_code,
      reception_year = v_year,
      reception_sequence = v_sequence,
      document_number = v_document_number,
      observation = v_observation,
      payload_snapshot = v_snapshot
  WHERE id = v_operation_id;
  RETURN jsonb_build_object('operation_id', v_operation_id, 'status', 'PREPARED',
    'reception_id', NULL, 'error', NULL, 'local_applied_at', NULL, 'payload', v_snapshot);
END;
$$;

CREATE OR REPLACE FUNCTION mermas.confirm_reconciled_bsale_reception(
  p_operation_id uuid, p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, mermas
AS $$
DECLARE v_operation mermas.bsale_reception_operations%ROWTYPE;
BEGIN
  SELECT * INTO v_operation
  FROM mermas.bsale_reception_operations
  WHERE id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Operación de recepción no encontrada'; END IF;
  IF v_operation.status <> 'RECONCILIATION_REQUIRED' OR v_operation.reception_id IS NULL THEN
    RAISE EXCEPTION 'La operación no está lista para reconciliación';
  END IF;
  IF NOT core.has_company_access(p_user_id, v_operation.company_id)
     OR NOT core.has_permission_for_company(p_user_id, v_operation.company_id, 'logistica.mermas.request.create') THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;
  UPDATE mermas.bsale_reception_operations
  SET status = 'CONFIRMED', error_message = NULL, confirmed_at = coalesce(confirmed_at, now())
  WHERE id = p_operation_id AND status = 'RECONCILIATION_REQUIRED' AND reception_id IS NOT NULL;
  RETURN (SELECT jsonb_build_object('operation_id', id, 'status', status, 'reception_id', reception_id)
    FROM mermas.bsale_reception_operations WHERE id = p_operation_id);
END;
$$;

REVOKE ALL ON FUNCTION mermas.prepare_bsale_reception_operation(uuid, uuid, uuid, integer, text, text, jsonb),
  mermas.confirm_reconciled_bsale_reception(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.prepare_bsale_reception_operation(uuid, uuid, uuid, integer, text, text, jsonb),
  mermas.confirm_reconciled_bsale_reception(uuid, uuid) TO service_role;
