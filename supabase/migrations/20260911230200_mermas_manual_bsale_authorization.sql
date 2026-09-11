-- MERMAS: ingest Bsale consumptions first; associate them only during manual authorization.

ALTER TABLE mermas.requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE mermas.requests ADD CONSTRAINT requests_status_check
  CHECK (status IN ('PENDIENTE', 'PARCIAL', 'CUMPLIDA', 'FINALIZADA', 'CANCELADA'));

CREATE OR REPLACE FUNCTION mermas.process_bsale_consumption(
  p_company_id uuid, p_user_id uuid, p_header jsonb, p_details jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
  v_consumption_id bigint := NULLIF(p_header->>'id', '')::bigint;
  v_type integer := NULLIF(p_header->>'consumptionTypeId', '')::integer;
  v_consumption mermas.bsale_consumptions%ROWTYPE;
  v_detail jsonb;
  v_detail_id bigint;
  v_variant_id integer;
  v_quantity numeric;
  v_new_details integer := 0;
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.sync') THEN
    RAISE EXCEPTION 'No autorizado para sincronizar Mermas';
  END IF;
  IF v_consumption_id IS NULL OR v_type IS DISTINCT FROM 2 THEN
    RETURN jsonb_build_object('accepted', false, 'new_details', 0, 'new_movements', 0, 'request_id', NULL, 'request_status', NULL);
  END IF;

  INSERT INTO mermas.bsale_consumptions (
    company_id, consumption_id, consumption_date, note, consumption_type_id,
    office_id, user_id, raw_json, processed_at
  ) VALUES (
    p_company_id, v_consumption_id,
    CASE
      WHEN NULLIF(p_header->>'consumptionDate', '') IS NULL THEN NULL
      WHEN p_header->>'consumptionDate' ~ '^[-]?[0-9]+(\.[0-9]+)?$'
        THEN to_timestamp((p_header->>'consumptionDate')::numeric)
      ELSE (p_header->>'consumptionDate')::timestamptz
    END,
    p_header->>'note', v_type,
    NULLIF(p_header->'office'->>'id', '')::integer,
    NULLIF(p_header->'user'->>'id', '')::integer,
    p_header, now()
  ) ON CONFLICT (company_id, consumption_id) DO UPDATE SET
    consumption_date = EXCLUDED.consumption_date,
    note = EXCLUDED.note,
    consumption_type_id = EXCLUDED.consumption_type_id,
    office_id = EXCLUDED.office_id,
    user_id = EXCLUDED.user_id,
    raw_json = EXCLUDED.raw_json,
    processed_at = now()
  RETURNING * INTO v_consumption;

  FOR v_detail IN SELECT value FROM jsonb_array_elements(COALESCE(p_details, '[]'::jsonb)) LOOP
    v_detail_id := NULLIF(v_detail->>'id', '')::bigint;
    v_variant_id := COALESCE(
      NULLIF(v_detail->'variant'->>'id', '')::integer,
      NULLIF(v_detail->>'variant_id', '')::integer
    );
    v_quantity := NULLIF(v_detail->>'quantity', '')::numeric;
    IF v_detail_id IS NULL OR v_variant_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      CONTINUE;
    END IF;
    INSERT INTO mermas.bsale_consumption_details (
      company_id, consumption_id, detail_id, variant_id, quantity, cost, variant_stock, raw_json
    ) VALUES (
      p_company_id, v_consumption_id, v_detail_id, v_variant_id, v_quantity,
      NULLIF(v_detail->>'cost', '')::numeric,
      NULLIF(v_detail->>'variantStock', '')::numeric,
      v_detail
    ) ON CONFLICT (company_id, consumption_id, detail_id) DO NOTHING;
    IF FOUND THEN v_new_details := v_new_details + 1; END IF;
  END LOOP;

  IF v_new_details > 0 THEN
    INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
    VALUES ('mermas.bsale_consumptions', v_consumption.id, 'BSALE_CONSUMPTION_INGESTED',
      jsonb_build_object('consumption_id', v_consumption_id, 'type_id', v_type, 'new_details', v_new_details), p_user_id);
  END IF;
  RETURN jsonb_build_object(
    'accepted', true, 'new_details', v_new_details, 'new_movements', 0,
    'request_id', v_consumption.request_id, 'request_status', NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.process_bsale_consumption(uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.process_bsale_consumption(uuid, uuid, jsonb, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION mermas.authorize_request_with_consumption(
  p_request_id uuid, p_consumption_id bigint, p_company_id uuid, p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
  v_request mermas.requests%ROWTYPE;
  v_consumption mermas.bsale_consumptions%ROWTYPE;
  v_detail record;
  v_line record;
  v_allocation_id uuid;
  v_has_evidence boolean;
  v_mismatch boolean;
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.authorize') THEN
    RAISE EXCEPTION 'No autorizado para autorizar ingresos de Mermas';
  END IF;
  SELECT * INTO v_request FROM mermas.requests
    WHERE id = p_request_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud no encontrada'; END IF;
  IF v_request.status <> 'PENDIENTE' THEN RAISE EXCEPTION 'La solicitud ya no está pendiente'; END IF;

  SELECT bool_and(EXISTS (
    SELECT 1 FROM mermas.evidence e WHERE e.company_id = p_company_id AND e.request_line_id = rl.id
  )) INTO v_has_evidence
  FROM mermas.request_lines rl WHERE rl.request_id = p_request_id;
  IF NOT COALESCE(v_has_evidence, false) THEN RAISE EXCEPTION 'Todas las líneas requieren evidencia fotográfica'; END IF;
  IF EXISTS (SELECT 1 FROM mermas.request_lines WHERE request_id = p_request_id AND expiration_date IS NULL) THEN
    RAISE EXCEPTION 'Todas las líneas requieren vencimiento';
  END IF;

  SELECT * INTO v_consumption FROM mermas.bsale_consumptions
    WHERE company_id = p_company_id AND consumption_id = p_consumption_id FOR UPDATE;
  IF NOT FOUND OR v_consumption.consumption_type_id <> 2 THEN
    RAISE EXCEPTION 'El consumo Bsale no es una Merma válida';
  END IF;
  IF v_consumption.request_id IS NOT NULL AND v_consumption.request_id <> p_request_id THEN
    RAISE EXCEPTION 'El consumo Bsale ya está asociado a otra solicitud';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mermas.bsale_detail_allocations a
    JOIN mermas.bsale_consumption_details d ON d.id = a.consumption_detail_id
    WHERE d.company_id = p_company_id AND d.consumption_id = p_consumption_id
      AND a.request_id IS DISTINCT FROM p_request_id
  ) THEN
    RAISE EXCEPTION 'Un detalle Bsale ya está asociado a otra solicitud';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT bsale_variant_id AS variant_id, sum(quantity) AS qty
      FROM mermas.request_lines WHERE request_id = p_request_id GROUP BY bsale_variant_id
    ) rq FULL JOIN (
      SELECT variant_id, sum(quantity) AS qty
      FROM mermas.bsale_consumption_details
      WHERE company_id = p_company_id AND consumption_id = p_consumption_id GROUP BY variant_id
    ) bs USING (variant_id)
    WHERE COALESCE(rq.qty, 0) <> COALESCE(bs.qty, 0)
  ) INTO v_mismatch;
  IF v_mismatch THEN RAISE EXCEPTION 'Los productos y cantidades no coinciden con el consumo Bsale'; END IF;

  FOR v_detail IN
    SELECT d.* FROM mermas.bsale_consumption_details d
    WHERE d.company_id = p_company_id AND d.consumption_id = p_consumption_id
    ORDER BY d.detail_id
  LOOP
    SELECT rl.* INTO v_line FROM mermas.request_lines rl
    WHERE rl.request_id = p_request_id AND rl.bsale_variant_id = v_detail.variant_id
      AND v_detail.quantity <= rl.quantity - COALESCE((
        SELECT sum(a.quantity) FROM mermas.bsale_detail_allocations a WHERE a.request_line_id = rl.id
      ), 0)
    ORDER BY rl.created_at, rl.id LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'No se pudo asignar el detalle Bsale % a una línea', v_detail.detail_id; END IF;

    INSERT INTO mermas.bsale_detail_allocations(
      company_id, consumption_detail_id, request_line_id, request_id,
      quantity, expiration_date, lot
    ) VALUES (
      p_company_id, v_detail.id, v_line.id, p_request_id,
      v_detail.quantity, v_line.expiration_date, v_line.lot
    ) RETURNING id INTO v_allocation_id;

    INSERT INTO mermas.movements(
      company_id, movement_type, variant_id, quantity, expiration_date, lot,
      consumption_id, detail_id, allocation_id, request_id, request_line_id,
      source, authorization_status, authorized_by, authorized_at
    ) VALUES (
      p_company_id, 'ENTRADA_BSALE', v_detail.variant_id, v_detail.quantity,
      v_line.expiration_date, v_line.lot, p_consumption_id, v_detail.detail_id,
      v_allocation_id, p_request_id, v_line.id, 'BSALE', 'AUTORIZADA', p_user_id, now()
    );
  END LOOP;

  UPDATE mermas.bsale_consumptions
  SET request_id = p_request_id, match_method = 'MANUAL_AUTHORIZATION', processed_at = now()
  WHERE company_id = p_company_id AND consumption_id = p_consumption_id;
  UPDATE mermas.requests SET status = 'FINALIZADA', updated_at = now()
  WHERE id = p_request_id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  VALUES ('mermas.requests', p_request_id, 'MANUAL_BSALE_AUTHORIZATION',
    jsonb_build_object('status', v_request.status),
    jsonb_build_object('status', 'FINALIZADA', 'consumption_id', p_consumption_id), p_user_id);
  RETURN jsonb_build_object('success', true, 'status', 'FINALIZADA', 'consumption_id', p_consumption_id);
END;
$$;

REVOKE ALL ON FUNCTION mermas.authorize_request_with_consumption(uuid, bigint, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.authorize_request_with_consumption(uuid, bigint, uuid, uuid) TO service_role;

-- Revert only legacy, non-terminal pending associations. Historical authorized/rejected rows are untouched.
DO $$
DECLARE
  legacy record;
BEGIN
  FOR legacy IN
    SELECT DISTINCT r.id AS request_id, r.status
    FROM mermas.requests r
    JOIN mermas.bsale_detail_allocations a ON a.request_id = r.id
    JOIN mermas.movements m ON m.allocation_id = a.id
    WHERE r.status <> 'CANCELADA'
      AND m.authorization_status = 'PENDIENTE_AUTORIZACION'
  LOOP
    DELETE FROM mermas.movements
    WHERE request_id = legacy.request_id AND authorization_status = 'PENDIENTE_AUTORIZACION';
    DELETE FROM mermas.bsale_detail_allocations allocation
    WHERE request_id = legacy.request_id
      AND NOT EXISTS (SELECT 1 FROM mermas.movements m WHERE m.allocation_id = allocation.id);
    UPDATE mermas.requests SET status = 'PENDIENTE', updated_at = now()
    WHERE id = legacy.request_id AND status IN ('PARCIAL', 'CUMPLIDA');
    INSERT INTO portal.audit_logs(table_name, record_id, action, new_data)
    VALUES ('mermas.requests', legacy.request_id, 'LEGACY_AUTO_ASSOCIATION_REPAIRED',
      jsonb_build_object('restored_status', 'PENDIENTE'));
  END LOOP;
END;
$$;
