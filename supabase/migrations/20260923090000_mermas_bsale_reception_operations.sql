-- Durable Bsale reception operations for warehouse-to-reception regularization.

CREATE TABLE mermas.bsale_reception_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  correlation_code text NOT NULL,
  request_id uuid REFERENCES mermas.requests(id) ON DELETE RESTRICT,
  office_id integer NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  status text NOT NULL DEFAULT 'PREPARED' CHECK (status IN ('PREPARED', 'SENDING', 'CONFIRMED', 'FAILED', 'RECONCILIATION_REQUIRED')),
  reception_id bigint,
  payload_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  sending_at timestamptz,
  confirmed_at timestamptz,
  local_applied_at timestamptz,
  stock_exit_operation_id uuid,
  UNIQUE (company_id, correlation_code)
);

CREATE TABLE mermas.bsale_reception_operation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL REFERENCES mermas.bsale_reception_operations(id) ON DELETE RESTRICT,
  variant_id integer NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  expiration_date date,
  lot text,
  request_id uuid REFERENCES mermas.requests(id) ON DELETE RESTRICT,
  request_line_id uuid REFERENCES mermas.request_lines(id) ON DELETE RESTRICT,
  source_movement_id uuid REFERENCES mermas.movements(id) ON DELETE RESTRICT,
  source_consumption_id bigint,
  source_detail_id bigint,
  unit_cost numeric(14,3) NOT NULL CHECK (unit_cost > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mermas.stock_exit_operations
  ADD COLUMN IF NOT EXISTS bsale_reception_operation_id uuid
    REFERENCES mermas.bsale_reception_operations(id) ON DELETE RESTRICT;

ALTER TABLE mermas.movements
  ADD COLUMN IF NOT EXISTS bsale_reception_operation_id uuid
    REFERENCES mermas.bsale_reception_operations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS bsale_reception_line_id uuid
    REFERENCES mermas.bsale_reception_operation_lines(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_movement_id uuid
    REFERENCES mermas.movements(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX mermas_bsale_reception_company_code_uq
  ON mermas.bsale_reception_operations(company_id, correlation_code);
CREATE UNIQUE INDEX mermas_bsale_reception_exit_uq
  ON mermas.stock_exit_operations(company_id, bsale_reception_operation_id)
  WHERE bsale_reception_operation_id IS NOT NULL;
CREATE UNIQUE INDEX mermas_bsale_reception_movement_line_uq
  ON mermas.movements(company_id, bsale_reception_line_id)
  WHERE bsale_reception_line_id IS NOT NULL;
CREATE INDEX mermas_bsale_reception_status_idx
  ON mermas.bsale_reception_operations(company_id, status, created_at DESC);
CREATE INDEX mermas_bsale_reception_lines_operation_idx
  ON mermas.bsale_reception_operation_lines(company_id, operation_id);

ALTER TABLE mermas.bsale_reception_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mermas.bsale_reception_operation_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY bsale_reception_operations_select ON mermas.bsale_reception_operations
  FOR SELECT TO authenticated
  USING (core.has_company_access(auth.uid(), company_id) AND portal.has_permission('logistica.mermas.view'));
CREATE POLICY bsale_reception_lines_select ON mermas.bsale_reception_operation_lines
  FOR SELECT TO authenticated
  USING (core.has_company_access(auth.uid(), company_id) AND portal.has_permission('logistica.mermas.view'));
GRANT SELECT ON mermas.bsale_reception_operations, mermas.bsale_reception_operation_lines TO authenticated, service_role;
GRANT ALL ON mermas.bsale_reception_operations, mermas.bsale_reception_operation_lines TO service_role;

CREATE OR REPLACE VIEW mermas.stock_current AS
WITH ledger AS (
  SELECT company_id, variant_id, expiration_date, lot, request_id,
    sum(quantity) AS available, min(source) AS source, min(created_at) AS entered_at
  FROM mermas.movements
  WHERE authorization_status = 'AUTORIZADA'
  GROUP BY company_id, variant_id, expiration_date, lot, request_id
), reserved AS (
  SELECT l.company_id, l.variant_id, l.expiration_date, l.lot, l.request_id, sum(l.quantity) AS quantity
  FROM mermas.bsale_reception_operation_lines l
  JOIN mermas.bsale_reception_operations o ON o.id = l.operation_id AND o.company_id = l.company_id
  WHERE o.status IN ('PREPARED', 'SENDING', 'RECONCILIATION_REQUIRED')
     OR (o.status = 'CONFIRMED' AND o.local_applied_at IS NULL)
  GROUP BY l.company_id, l.variant_id, l.expiration_date, l.lot, l.request_id
)
SELECT ledger.company_id, ledger.variant_id, ledger.expiration_date, ledger.lot,
  ledger.available - coalesce(reserved.quantity, 0) AS available,
  ledger.source, ledger.request_id, ledger.entered_at
FROM ledger
LEFT JOIN reserved ON reserved.company_id = ledger.company_id
  AND reserved.variant_id = ledger.variant_id
  AND reserved.expiration_date IS NOT DISTINCT FROM ledger.expiration_date
  AND reserved.lot IS NOT DISTINCT FROM ledger.lot
  AND reserved.request_id IS NOT DISTINCT FROM ledger.request_id
WHERE ledger.available - coalesce(reserved.quantity, 0) <> 0;

CREATE OR REPLACE FUNCTION mermas.prepare_bsale_reception_operation(
  p_company_id uuid, p_user_id uuid, p_request_id uuid, p_office_id integer,
  p_reason text, p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, integraciones, mermas
AS $$
DECLARE
  v_operation_id uuid := gen_random_uuid(); v_item jsonb; v_key text; v_variant_id integer;
  v_requested jsonb := '{}'::jsonb; v_request_lines jsonb := '{}'::jsonb; v_remaining numeric; v_piece numeric; v_lot record; v_request_line_id uuid;
  v_code text; v_snapshot jsonb; v_today date := timezone('America/Santiago', now())::date;
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.create') THEN
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
    IF nullif(v_item->>'request_line_id', '') IS NOT NULL THEN
      v_request_lines := jsonb_set(v_request_lines, ARRAY[v_variant_id::text], to_jsonb(v_item->>'request_line_id'), true);
    END IF;
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
      v_request_line_id := nullif(v_request_lines->>v_key, '')::uuid;
      INSERT INTO mermas.bsale_reception_operation_lines(company_id, operation_id, variant_id, quantity, expiration_date, lot, request_id, request_line_id, source_movement_id, source_consumption_id, source_detail_id, unit_cost)
      VALUES (p_company_id, v_operation_id, v_variant_id, v_piece, v_lot.expiration_date, v_lot.lot, v_lot.request_id, v_request_line_id, v_lot.source_movement_id, v_lot.source_consumption_id, v_lot.source_detail_id, v_lot.unit_cost);
      v_remaining := v_remaining - v_piece;
    END LOOP;
    IF v_remaining > 0 THEN RAISE EXCEPTION 'Stock elegible insuficiente para la variante %', v_variant_id; END IF;
  END LOOP;
  SELECT jsonb_build_object('correlationCode', v_code, 'officeId', p_office_id, 'reason', btrim(p_reason), 'lines', coalesce(jsonb_agg(jsonb_build_object('variantId', variant_id, 'quantity', quantity, 'expirationDate', expiration_date, 'lot', lot, 'requestId', request_id, 'requestLineId', request_line_id, 'sourceMovementId', source_movement_id, 'sourceConsumptionId', source_consumption_id, 'sourceDetailId', source_detail_id, 'unitCost', unit_cost) ORDER BY variant_id, expiration_date NULLS LAST, lot), '[]'::jsonb))
  INTO v_snapshot FROM mermas.bsale_reception_operation_lines WHERE operation_id = v_operation_id;
  UPDATE mermas.bsale_reception_operations SET payload_snapshot = v_snapshot WHERE id = v_operation_id;
  RETURN jsonb_build_object('operation_id', v_operation_id, 'status', 'PREPARED', 'payload', v_snapshot);
END;
$$;

CREATE OR REPLACE FUNCTION mermas.claim_bsale_reception_operation(p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, mermas AS $$
DECLARE v_operation mermas.bsale_reception_operations%ROWTYPE;
BEGIN
  SELECT * INTO v_operation FROM mermas.bsale_reception_operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Operación de recepción no encontrada'; END IF;
  IF v_operation.status = 'PREPARED' THEN
    UPDATE mermas.bsale_reception_operations SET status = 'SENDING', attempt_count = attempt_count + 1, sending_at = now() WHERE id = p_operation_id;
    RETURN jsonb_build_object('claimed', true, 'status', 'SENDING');
  END IF;
  RETURN jsonb_build_object('claimed', false, 'status', v_operation.status, 'reception_id', v_operation.reception_id, 'error', v_operation.error_message);
END;
$$;

CREATE OR REPLACE FUNCTION mermas.finish_bsale_reception_operation(p_operation_id uuid, p_status text, p_reception_id bigint, p_error text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, mermas AS $$
BEGIN
  IF p_status NOT IN ('CONFIRMED', 'FAILED', 'RECONCILIATION_REQUIRED') THEN RAISE EXCEPTION 'Estado de cierre inválido'; END IF;
  UPDATE mermas.bsale_reception_operations SET status = p_status, reception_id = p_reception_id, error_message = nullif(btrim(p_error), ''), confirmed_at = CASE WHEN p_status = 'CONFIRMED' THEN now() ELSE confirmed_at END WHERE id = p_operation_id AND status = 'SENDING';
  IF NOT FOUND THEN RAISE EXCEPTION 'La operación no está en SENDING'; END IF;
  RETURN (SELECT jsonb_build_object('operation_id', id, 'status', status, 'reception_id', reception_id, 'error', error_message) FROM mermas.bsale_reception_operations WHERE id = p_operation_id);
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
     OR NOT core.has_permission_for_company(p_user_id, v_operation.company_id, 'logistica.mermas.request.create') THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;
  INSERT INTO mermas.stock_exit_operations(id, company_id, operation_type, reason, observation, created_by, bsale_reception_operation_id)
  VALUES (v_exit_id, v_operation.company_id, 'REGULACION', v_operation.reason, 'Aplicación confirmada de recepción Bsale ' || v_operation.reception_id, p_user_id, p_operation_id);
  FOR v_line IN SELECT * FROM mermas.bsale_reception_operation_lines WHERE operation_id = p_operation_id LOOP
    INSERT INTO mermas.movements(company_id, movement_type, variant_id, quantity, expiration_date, lot, request_id, source, authorization_status, created_by, reason, observation, movement_group_id, bsale_reception_operation_id, bsale_reception_line_id, source_movement_id)
    VALUES (v_operation.company_id, 'SALIDA_REGULACION', v_line.variant_id, -v_line.quantity, v_line.expiration_date, v_line.lot, v_line.request_id, 'BSALE_RECEPTION', 'AUTORIZADA', p_user_id, v_operation.reason, 'Recepción Bsale ' || v_operation.reception_id, v_exit_id, p_operation_id, v_line.id, v_line.source_movement_id);
  END LOOP;
  UPDATE mermas.bsale_reception_operations SET local_applied_at = now(), stock_exit_operation_id = v_exit_id WHERE id = p_operation_id;
  RETURN jsonb_build_object('success', true, 'stock_exit_operation_id', v_exit_id);
END;
$$;

REVOKE ALL ON FUNCTION mermas.prepare_bsale_reception_operation(uuid, uuid, uuid, integer, text, jsonb), mermas.claim_bsale_reception_operation(uuid), mermas.finish_bsale_reception_operation(uuid, text, bigint, text), mermas.apply_confirmed_bsale_reception(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.prepare_bsale_reception_operation(uuid, uuid, uuid, integer, text, jsonb), mermas.claim_bsale_reception_operation(uuid), mermas.finish_bsale_reception_operation(uuid, text, bigint, text), mermas.apply_confirmed_bsale_reception(uuid, uuid) TO service_role;
