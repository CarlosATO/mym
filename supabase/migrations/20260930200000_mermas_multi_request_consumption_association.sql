-- Mermas: associate one Bsale consumption with several existing requests.

CREATE OR REPLACE FUNCTION mermas.preview_bsale_consumption_request_matches(
  p_consumption_id bigint,
  p_company_id uuid,
  p_user_id uuid
)
RETURNS TABLE (
  consumption_id bigint,
  detail_id bigint,
  variant_id integer,
  sku text,
  product text,
  quantity numeric,
  request_id uuid,
  request_code text,
  request_line_id uuid,
  requested_quantity numeric,
  remaining_quantity numeric,
  match_status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
  WITH details AS (
    SELECT d.consumption_id, d.detail_id, d.variant_id, d.quantity
    FROM mermas.bsale_consumption_details d
    JOIN mermas.bsale_consumptions c
      ON c.company_id = d.company_id AND c.consumption_id = d.consumption_id
    WHERE d.company_id = p_company_id
      AND d.consumption_id = p_consumption_id
      AND c.consumption_type_id = 2
  ),
  candidates AS (
    SELECT d.detail_id, rl.id AS request_line_id, r.id AS request_id,
      r.request_code, rl.quantity AS requested_quantity,
      rl.quantity - COALESCE(SUM(a.quantity), 0) AS remaining_quantity
    FROM details d
    JOIN mermas.request_lines rl
      ON rl.company_id = p_company_id
     AND rl.bsale_variant_id = d.variant_id
    JOIN mermas.requests r
      ON r.id = rl.request_id
     AND r.company_id = p_company_id
     AND r.status IN ('PENDIENTE', 'PARCIAL')
    LEFT JOIN mermas.bsale_detail_allocations a ON a.request_line_id = rl.id
    GROUP BY d.detail_id, rl.id, r.id, r.request_code, rl.quantity, d.quantity
    HAVING rl.quantity - COALESCE(SUM(a.quantity), 0) = d.quantity
  ),
  candidate_counts AS (
    SELECT detail_id, COUNT(*)::integer AS candidate_count
    FROM candidates
    GROUP BY detail_id
  ),
  chosen AS (
    SELECT c.*
    FROM candidates c
    JOIN candidate_counts cc USING (detail_id)
    WHERE cc.candidate_count = 1
  )
  SELECT d.consumption_id, d.detail_id, d.variant_id,
    COALESCE(v.code, 'BS-' || d.variant_id::text) AS sku,
    COALESCE(p.name, v.code, 'Producto Bsale') AS product,
    d.quantity, ch.request_id, ch.request_code, ch.request_line_id,
    ch.requested_quantity, ch.remaining_quantity,
    CASE COALESCE(cc.candidate_count, 0)
      WHEN 0 THEN 'NO_MATCH'
      WHEN 1 THEN 'MATCHED'
      ELSE 'AMBIGUOUS'
    END AS match_status
  FROM details d
  LEFT JOIN candidate_counts cc ON cc.detail_id = d.detail_id
  LEFT JOIN chosen ch ON ch.detail_id = d.detail_id
  LEFT JOIN integraciones.bsale_variants v
    ON v.company_id = p_company_id AND v.bsale_id = d.variant_id
  LEFT JOIN integraciones.bsale_products p
    ON p.company_id = p_company_id AND p.bsale_id = v.bsale_product_id
  WHERE core.has_company_access(p_user_id, p_company_id)
    AND core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.create')
  ORDER BY d.detail_id;
$$;

CREATE OR REPLACE FUNCTION mermas.associate_bsale_consumption_requests(
  p_consumption_id bigint,
  p_company_id uuid,
  p_user_id uuid,
  p_matches jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
  v_consumption mermas.bsale_consumptions%ROWTYPE;
  v_detail record;
  v_match jsonb;
  v_line mermas.request_lines%ROWTYPE;
  v_request mermas.requests%ROWTYPE;
  v_allocation_id uuid;
  v_expected_count integer;
  v_match_count integer;
  v_request_ids uuid[];
  v_request_id uuid;
  v_all_complete boolean;
  v_status_before text;
BEGIN
  IF p_user_id IS NULL OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.authorize') THEN
    RAISE EXCEPTION 'No autorizado para asociar solicitudes de Merma';
  END IF;
  IF jsonb_typeof(p_matches) <> 'array' THEN
    RAISE EXCEPTION 'El mapping de asociación es inválido';
  END IF;

  SELECT * INTO v_consumption
  FROM mermas.bsale_consumptions
  WHERE company_id = p_company_id AND consumption_id = p_consumption_id
  FOR UPDATE;
  IF NOT FOUND OR v_consumption.consumption_type_id <> 2 THEN
    RAISE EXCEPTION 'El consumo Bsale no es una Merma válida';
  END IF;
  IF v_consumption.request_id IS NOT NULL
     OR v_consumption.match_method = 'MULTI_REQUEST' THEN
    RAISE EXCEPTION 'El consumo Bsale ya está asociado';
  END IF;

  SELECT COUNT(*)::integer INTO v_expected_count
  FROM mermas.bsale_consumption_details
  WHERE company_id = p_company_id AND consumption_id = p_consumption_id;
  SELECT COUNT(*)::integer INTO v_match_count
  FROM jsonb_array_elements(p_matches);
  IF v_expected_count = 0 OR v_match_count <> v_expected_count THEN
    RAISE EXCEPTION 'El mapping no contiene exactamente todos los detalles Bsale';
  END IF;
  IF (SELECT COUNT(DISTINCT (value->>'detail_id')::bigint) FROM jsonb_array_elements(p_matches)) <> v_match_count THEN
    RAISE EXCEPTION 'Cada detalle Bsale debe aparecer una sola vez';
  END IF;

  SELECT ARRAY_AGG(DISTINCT (value->>'request_id')::uuid ORDER BY (value->>'request_id')::uuid)
    INTO v_request_ids
  FROM jsonb_array_elements(p_matches);
  IF v_request_ids IS NULL OR array_position(v_request_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Cada detalle debe tener una solicitud inequívoca';
  END IF;

  -- Lock affected requests in a stable order before validating their lines.
  FOR v_request IN
    SELECT r.* FROM mermas.requests r
    WHERE r.company_id = p_company_id AND r.id = ANY(v_request_ids)
    ORDER BY r.id FOR UPDATE
  LOOP
    IF v_request.status NOT IN ('PENDIENTE', 'PARCIAL') THEN
      RAISE EXCEPTION 'Una solicitud ya no está disponible';
    END IF;
  END LOOP;
  IF (SELECT COUNT(*) FROM mermas.requests WHERE company_id = p_company_id AND id = ANY(v_request_ids)) <> cardinality(v_request_ids) THEN
    RAISE EXCEPTION 'Una solicitud no pertenece a la empresa activa';
  END IF;

  FOR v_detail IN
    SELECT d.* FROM mermas.bsale_consumption_details d
    WHERE d.company_id = p_company_id AND d.consumption_id = p_consumption_id
    ORDER BY d.detail_id
  LOOP
    SELECT value INTO v_match
    FROM jsonb_array_elements(p_matches)
    WHERE (value->>'detail_id')::bigint = v_detail.detail_id;
    IF v_match IS NULL OR v_match->>'request_id' IS NULL OR v_match->>'request_line_id' IS NULL THEN
      RAISE EXCEPTION 'El detalle Bsale % no tiene asociación inequívoca', v_detail.detail_id;
    END IF;
    SELECT * INTO v_line FROM mermas.request_lines
    WHERE id = (v_match->>'request_line_id')::uuid
      AND company_id = p_company_id
      AND request_id = (v_match->>'request_id')::uuid
    FOR UPDATE;
    IF NOT FOUND OR v_line.bsale_variant_id <> v_detail.variant_id
       OR v_line.expiration_date IS NULL
       OR NOT EXISTS (SELECT 1 FROM mermas.evidence e WHERE e.company_id = p_company_id AND e.request_line_id = v_line.id)
       OR v_line.quantity - COALESCE((SELECT SUM(a.quantity) FROM mermas.bsale_detail_allocations a WHERE a.request_line_id = v_line.id), 0) <> v_detail.quantity THEN
      RAISE EXCEPTION 'La línea de solicitud para el detalle Bsale % ya no es compatible o carece de evidencia/vencimiento', v_detail.detail_id;
    END IF;
    IF EXISTS (
      SELECT 1 FROM mermas.bsale_detail_allocations a
      WHERE a.company_id = p_company_id AND a.consumption_detail_id = v_detail.id
    ) OR EXISTS (
      SELECT 1 FROM mermas.movements m
      WHERE m.company_id = p_company_id AND m.consumption_id = p_consumption_id
        AND m.detail_id = v_detail.detail_id AND m.movement_type = 'ENTRADA_BSALE'
    ) THEN
      RAISE EXCEPTION 'El detalle Bsale % ya tiene una asociación o movimiento', v_detail.detail_id;
    END IF;
    INSERT INTO mermas.bsale_detail_allocations(
      company_id, consumption_detail_id, request_line_id, request_id,
      quantity, expiration_date, lot
    ) VALUES (
      p_company_id, v_detail.id, v_line.id, v_line.request_id,
      v_detail.quantity, v_line.expiration_date, v_line.lot
    ) RETURNING id INTO v_allocation_id;
    INSERT INTO mermas.movements(
      company_id, movement_type, variant_id, quantity, expiration_date, lot,
      consumption_id, detail_id, allocation_id, request_id, request_line_id,
      source, authorization_status, authorized_by, authorized_at
    ) VALUES (
      p_company_id, 'ENTRADA_BSALE', v_detail.variant_id, v_detail.quantity,
      v_line.expiration_date, v_line.lot, p_consumption_id, v_detail.detail_id,
      v_allocation_id, v_line.request_id, v_line.id, 'BSALE', 'AUTORIZADA', p_user_id, now()
    );
  END LOOP;

  FOREACH v_request_id IN ARRAY v_request_ids LOOP
    SELECT status INTO v_status_before FROM mermas.requests WHERE id = v_request_id;
    SELECT NOT EXISTS (
      SELECT 1 FROM mermas.request_lines rl
      WHERE rl.request_id = v_request_id
        AND rl.quantity > COALESCE((SELECT SUM(a.quantity) FROM mermas.bsale_detail_allocations a WHERE a.request_line_id = rl.id), 0)
    ) INTO v_all_complete;
    UPDATE mermas.requests
    SET status = CASE WHEN v_all_complete THEN 'FINALIZADA' ELSE 'PARCIAL' END, updated_at = now()
    WHERE id = v_request_id;
    IF v_status_before IS DISTINCT FROM CASE WHEN v_all_complete THEN 'FINALIZADA' ELSE 'PARCIAL' END THEN
      INSERT INTO portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
      VALUES ('mermas.requests', v_request_id, 'STATUS_CHANGE',
        jsonb_build_object('status', v_status_before),
        jsonb_build_object('status', CASE WHEN v_all_complete THEN 'FINALIZADA' ELSE 'PARCIAL' END,
          'consumption_id', p_consumption_id), p_user_id);
    END IF;
  END LOOP;

  UPDATE mermas.bsale_consumptions
  SET request_id = NULL, match_method = 'MULTI_REQUEST', processed_at = now()
  WHERE company_id = p_company_id AND consumption_id = p_consumption_id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES ('mermas.bsale_consumptions', v_consumption.id, 'MERMAS_MULTI_REQ',
    jsonb_build_object('consumption_id', p_consumption_id, 'request_ids', v_request_ids,
      'detail_ids', (SELECT jsonb_agg((value->>'detail_id')::bigint) FROM jsonb_array_elements(p_matches)),
      'quantities', (SELECT jsonb_agg((value->>'quantity')::numeric) FROM jsonb_array_elements(p_matches))), p_user_id);
  RETURN jsonb_build_object('success', true, 'consumption_id', p_consumption_id,
    'request_ids', to_jsonb(v_request_ids), 'status', 'MULTI_REQUEST');
END;
$$;

REVOKE ALL ON FUNCTION mermas.preview_bsale_consumption_request_matches(bigint, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.preview_bsale_consumption_request_matches(bigint, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION mermas.associate_bsale_consumption_requests(bigint, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.associate_bsale_consumption_requests(bigint, uuid, uuid, jsonb) TO service_role;
