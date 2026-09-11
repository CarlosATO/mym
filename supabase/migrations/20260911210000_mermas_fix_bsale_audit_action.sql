-- MERMAS: keep the shared audit contract and use a bounded action code.
CREATE OR REPLACE FUNCTION mermas.process_bsale_consumption(
  p_company_id uuid, p_user_id uuid, p_header jsonb, p_details jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
  v_consumption_id bigint := (p_header->>'id')::bigint;
  v_type integer := (p_header->>'consumptionTypeId')::integer;
  v_consumption mermas.bsale_consumptions%ROWTYPE;
  v_detail_id bigint;
  v_variant_id integer;
  v_quantity numeric;
  v_new_details integer := 0;
  v_request_id uuid;
  v_candidate uuid;
  v_candidate_count integer := 0;
  v_method text := NULL;
  v_reference text;
  v_mismatch boolean;
  v_remaining numeric;
  v_allocated numeric;
  v_piece numeric;
  v_line record;
  v_detail record;
  v_all_complete boolean;
  v_movements_before integer;
  v_new_movements integer;
  v_previous_status text;
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.sync') THEN
    RAISE EXCEPTION 'No autorizado para sincronizar Mermas';
  END IF;
  IF v_consumption_id IS NULL OR v_type IS DISTINCT FROM 2 THEN
    RETURN jsonb_build_object('accepted', false, 'new_details', 0, 'movements', 0);
  END IF;

  INSERT INTO mermas.bsale_consumptions (
    company_id, consumption_id, consumption_date, note, consumption_type_id,
    office_id, user_id, raw_json, processed_at
  ) VALUES (
    p_company_id, v_consumption_id,
    CASE WHEN NULLIF(p_header->>'consumptionDate', '') IS NULL THEN NULL
      ELSE to_timestamp((p_header->>'consumptionDate')::numeric) END,
    p_header->>'note', v_type,
    NULLIF(p_header->'office'->>'id', '')::integer,
    NULLIF(p_header->'user'->>'id', '')::integer,
    p_header, now()
  ) ON CONFLICT (company_id, consumption_id) DO UPDATE SET
    note = EXCLUDED.note, raw_json = EXCLUDED.raw_json, processed_at = now()
  RETURNING * INTO v_consumption;

  FOR v_detail IN SELECT value AS payload FROM jsonb_array_elements(COALESCE(p_details, '[]'::jsonb)) LOOP
    v_detail_id := (v_detail.payload->>'id')::bigint;
    v_variant_id := COALESCE(NULLIF(v_detail.payload->'variant'->>'id', '')::integer,
      NULLIF(v_detail.payload->>'variant_id', '')::integer);
    v_quantity := NULLIF(v_detail.payload->>'quantity', '')::numeric;
    IF v_detail_id IS NULL OR v_variant_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN CONTINUE; END IF;
    INSERT INTO mermas.bsale_consumption_details (
      company_id, consumption_id, detail_id, variant_id, quantity, cost, variant_stock, raw_json
    ) VALUES (
      p_company_id, v_consumption_id, v_detail_id, v_variant_id, v_quantity,
      NULLIF(v_detail.payload->>'cost', '')::numeric,
      NULLIF(v_detail.payload->>'variantStock', '')::numeric,
      v_detail.payload
    ) ON CONFLICT (company_id, consumption_id, detail_id) DO NOTHING;
    IF FOUND THEN v_new_details := v_new_details + 1; END IF;
  END LOOP;

  SELECT (regexp_match(upper(COALESCE(v_consumption.note, '')), '(MER-[0-9]{4}-[0-9]{6})'))[1]
    INTO v_reference;
  IF v_reference IS NOT NULL THEN
    SELECT r.id INTO v_candidate FROM mermas.requests r
    WHERE r.company_id = p_company_id AND r.request_code = v_reference
      AND r.status IN ('PENDIENTE', 'PARCIAL');
    IF v_candidate IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM (
          SELECT bsale_variant_id AS variant_id, sum(quantity) AS qty
          FROM mermas.request_lines WHERE request_id = v_candidate GROUP BY bsale_variant_id
        ) rq FULL JOIN (
          SELECT variant_id, sum(quantity) AS qty
          FROM mermas.bsale_consumption_details
          WHERE company_id = p_company_id AND consumption_id = v_consumption_id GROUP BY variant_id
        ) bs USING (variant_id)
        WHERE COALESCE(rq.qty, 0) <> COALESCE(bs.qty, 0)
      ) INTO v_mismatch;
      IF NOT v_mismatch THEN v_request_id := v_candidate; v_method := 'MATCH_MER_EXACT'; END IF;
    END IF;
  END IF;

  IF v_request_id IS NULL THEN
    FOR v_line IN SELECT r.id FROM mermas.requests r
      WHERE r.company_id = p_company_id AND r.status IN ('PENDIENTE', 'PARCIAL') LOOP
      SELECT EXISTS (
        SELECT 1 FROM (
          SELECT bsale_variant_id AS variant_id, sum(quantity) AS qty
          FROM mermas.request_lines WHERE request_id = v_line.id GROUP BY bsale_variant_id
        ) rq FULL JOIN (
          SELECT variant_id, sum(quantity) AS qty
          FROM mermas.bsale_consumption_details
          WHERE company_id = p_company_id AND consumption_id = v_consumption_id GROUP BY variant_id
        ) bs USING (variant_id)
        WHERE COALESCE(rq.qty, 0) <> COALESCE(bs.qty, 0)
      ) INTO v_mismatch;
      IF NOT v_mismatch THEN
        v_candidate := v_line.id; v_candidate_count := v_candidate_count + 1;
      END IF;
    END LOOP;
    IF v_candidate_count = 1 THEN v_request_id := v_candidate; v_method := 'AUTO_MATCH_EXACT'; END IF;
  END IF;

  IF v_request_id IS NULL THEN v_method := 'DIRECTO_BSALE'; END IF;
  SELECT count(*)::integer INTO v_movements_before FROM mermas.movements
    WHERE company_id = p_company_id AND consumption_id = v_consumption_id;
  UPDATE mermas.bsale_consumptions SET request_id = v_request_id, match_method = v_method, processed_at = now()
    WHERE company_id = p_company_id AND consumption_id = v_consumption_id;

  IF v_new_details > 0 THEN
    INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
    VALUES ('mermas.bsale_consumptions', v_consumption.id, 'MERMA_BSALE_DETECTED',
      jsonb_build_object('consumption_id', v_consumption_id, 'type_id', v_type, 'new_details', v_new_details), p_user_id);
  END IF;

  FOR v_detail IN SELECT d.* FROM mermas.bsale_consumption_details d
    WHERE d.company_id = p_company_id AND d.consumption_id = v_consumption_id LOOP
    IF v_request_id IS NULL THEN
      INSERT INTO mermas.movements(company_id, movement_type, variant_id, quantity, detail_id, consumption_id, source)
      VALUES (p_company_id, 'ENTRADA_BSALE', v_detail.variant_id, v_detail.quantity,
        v_detail.detail_id, v_consumption_id, 'BSALE')
      ON CONFLICT DO NOTHING;
    ELSE
      v_remaining := v_detail.quantity;
      FOR v_line IN SELECT rl.* FROM mermas.request_lines rl
        WHERE rl.request_id = v_request_id AND rl.bsale_variant_id = v_detail.variant_id ORDER BY rl.created_at, rl.id LOOP
        SELECT COALESCE(sum(a.quantity), 0) INTO v_allocated
          FROM mermas.bsale_detail_allocations a WHERE a.request_line_id = v_line.id;
        v_piece := LEAST(v_remaining, GREATEST(v_line.quantity - v_allocated, 0));
        IF v_piece > 0 THEN
          INSERT INTO mermas.bsale_detail_allocations(company_id, consumption_detail_id, request_line_id, request_id, quantity, expiration_date, lot)
          VALUES (p_company_id, v_detail.id, v_line.id, v_request_id, v_piece, v_line.expiration_date, v_line.lot)
          ON CONFLICT (company_id, consumption_detail_id, request_line_id) DO NOTHING;
          INSERT INTO mermas.movements(company_id, movement_type, variant_id, quantity, expiration_date, lot,
            consumption_id, detail_id, allocation_id, request_id, request_line_id, source)
          SELECT p_company_id, 'ENTRADA_BSALE', v_detail.variant_id, v_piece, v_line.expiration_date, v_line.lot,
            v_consumption_id, v_detail.detail_id, a.id, v_request_id, v_line.id, 'BSALE'
          FROM mermas.bsale_detail_allocations a
          WHERE a.company_id = p_company_id AND a.consumption_detail_id = v_detail.id AND a.request_line_id = v_line.id
          ON CONFLICT DO NOTHING;
          v_remaining := v_remaining - v_piece;
        END IF;
        EXIT WHEN v_remaining <= 0;
      END LOOP;
      IF v_remaining > 0 THEN
        INSERT INTO mermas.movements(company_id, movement_type, variant_id, quantity, detail_id, consumption_id, request_id, source)
        VALUES (p_company_id, 'ENTRADA_BSALE', v_detail.variant_id, v_remaining, v_detail.detail_id, v_consumption_id, v_request_id, 'BSALE')
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  IF v_request_id IS NOT NULL THEN
    SELECT status INTO v_previous_status FROM mermas.requests WHERE id = v_request_id;
    SELECT NOT EXISTS (
      SELECT 1 FROM mermas.request_lines rl
      WHERE rl.request_id = v_request_id
        AND COALESCE((SELECT sum(a.quantity) FROM mermas.bsale_detail_allocations a WHERE a.request_line_id = rl.id), 0) < rl.quantity
    ) INTO v_all_complete;
    UPDATE mermas.requests SET status = CASE WHEN v_all_complete THEN 'CUMPLIDA' ELSE 'PARCIAL' END, updated_at = now()
      WHERE id = v_request_id AND status IN ('PENDIENTE', 'PARCIAL');
    IF v_all_complete AND v_previous_status IS DISTINCT FROM 'CUMPLIDA' THEN
      INSERT INTO portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
      VALUES ('mermas.requests', v_request_id, 'STATUS_CHANGE',
        jsonb_build_object('status', v_previous_status), jsonb_build_object('status', 'CUMPLIDA'), p_user_id);
    END IF;
    IF v_new_details > 0 THEN
      INSERT INTO portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
      VALUES ('mermas.requests', v_request_id, 'MATCH_BSALE',
        jsonb_build_object('status', v_previous_status),
        jsonb_build_object('method', v_method, 'consumption_id', v_consumption_id), p_user_id);
    END IF;
  END IF;

  SELECT GREATEST((SELECT count(*)::integer FROM mermas.movements WHERE company_id = p_company_id AND consumption_id = v_consumption_id) - v_movements_before, 0)
    INTO v_new_movements;
  IF v_new_movements > 0 THEN
    INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
    VALUES ('mermas.movements', gen_random_uuid(), 'ENTRADA_BSALE',
      jsonb_build_object('consumption_id', v_consumption_id, 'new_movements', v_new_movements, 'request_id', v_request_id), p_user_id);
  END IF;
  RETURN jsonb_build_object('accepted', true, 'new_details', v_new_details,
    'request_id', v_request_id, 'match_method', v_method,
    'new_movements', v_new_movements,
    'request_status', (SELECT status FROM mermas.requests WHERE id = v_request_id));
END;
$$;

REVOKE ALL ON FUNCTION mermas.process_bsale_consumption(uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.process_bsale_consumption(uuid, uuid, jsonb, jsonb) TO service_role;
