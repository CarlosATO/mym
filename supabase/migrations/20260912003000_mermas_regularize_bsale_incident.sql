-- MERMAS: atomically turn one unassociated Bsale consumption into one pending request.

CREATE OR REPLACE FUNCTION mermas.regularize_bsale_incident(
  p_consumption_id bigint,
  p_company_id uuid,
  p_user_id uuid,
  p_lines jsonb,
  p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas, storage
AS $$
DECLARE
  v_consumption mermas.bsale_consumptions%ROWTYPE;
  v_detail record;
  v_line jsonb;
  v_photo jsonb;
  v_request_id uuid := gen_random_uuid();
  v_request_line_id uuid;
  v_code text;
  v_year integer := EXTRACT(YEAR FROM timezone('America/Santiago', now()))::integer;
  v_sequence bigint;
  v_line_count integer := 0;
  v_photo_count integer;
  v_line_quantity numeric;
  v_line_expiration date;
BEGIN
  IF p_user_id IS NULL OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.create') THEN
    RAISE EXCEPTION 'No autorizado para crear solicitudes de Merma';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_typeof(COALESCE(p_evidence, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Las líneas o la evidencia son inválidas';
  END IF;

  SELECT * INTO v_consumption
  FROM mermas.bsale_consumptions
  WHERE company_id = p_company_id AND consumption_id = p_consumption_id
  FOR UPDATE;
  IF NOT FOUND OR v_consumption.consumption_type_id <> 2 THEN
    RAISE EXCEPTION 'El consumo Bsale no es una Merma válida';
  END IF;
  IF v_consumption.request_id IS NOT NULL THEN
    RAISE EXCEPTION 'Este consumo Bsale ya fue regularizado.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mermas.bsale_detail_allocations a
    JOIN mermas.bsale_consumption_details d ON d.id = a.consumption_detail_id
    WHERE d.company_id = p_company_id AND d.consumption_id = p_consumption_id
  ) THEN
    RAISE EXCEPTION 'El consumo Bsale tiene una asociación parcial y requiere revisión.';
  END IF;

  IF jsonb_array_length(p_lines) <> (
    SELECT count(*) FROM mermas.bsale_consumption_details
    WHERE company_id = p_company_id AND consumption_id = p_consumption_id
  ) OR (
    SELECT count(DISTINCT (value->>'detail_id')::bigint) FROM jsonb_array_elements(p_lines)
  ) <> jsonb_array_length(p_lines) THEN
    RAISE EXCEPTION 'La cantidad de líneas no coincide con el consumo Bsale';
  END IF;

  INSERT INTO mermas.request_correlatives(company_id, request_year, next_value)
  VALUES (p_company_id, v_year, 2)
  ON CONFLICT (company_id, request_year) DO UPDATE
    SET next_value = mermas.request_correlatives.next_value + 1
  RETURNING next_value - 1 INTO v_sequence;
  v_code := 'MER-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0');
  INSERT INTO mermas.requests(id, company_id, request_code, status, created_by)
  VALUES (v_request_id, p_company_id, v_code, 'PENDIENTE', p_user_id);

  FOR v_detail IN
    SELECT d.* FROM mermas.bsale_consumption_details d
    WHERE d.company_id = p_company_id AND d.consumption_id = p_consumption_id
    ORDER BY d.detail_id
  LOOP
    SELECT value INTO v_line
    FROM jsonb_array_elements(p_lines)
    WHERE (value->>'detail_id')::bigint = v_detail.detail_id;
    IF v_line IS NULL THEN RAISE EXCEPTION 'Falta la línea Bsale %', v_detail.detail_id; END IF;
    IF (v_line->>'variant_id')::integer <> v_detail.variant_id
       OR (v_line->>'quantity')::numeric <> v_detail.quantity THEN
      RAISE EXCEPTION 'La línea Bsale % no coincide con su detalle', v_detail.detail_id;
    END IF;
    v_line_quantity := NULLIF(v_line->>'quantity', '')::numeric;
    v_line_expiration := NULLIF(v_line->>'expiration_date', '')::date;
    IF v_line_quantity IS NULL OR v_line_quantity <= 0 OR v_line_expiration IS NULL OR btrim(COALESCE(v_line->>'reason', '')) = '' THEN
      RAISE EXCEPTION 'Completa motivo y vencimiento en todas las líneas';
    END IF;

    INSERT INTO mermas.request_lines(
      request_id, company_id, bsale_variant_id, sku, product_name,
      variant_description, quantity, reason, expiration_date, lot, observation
    )
    SELECT v_request_id, p_company_id, bv.bsale_id, COALESCE(bv.code, ''),
      COALESCE(bp.name, bv.code, 'Producto Bsale'), bv.description,
      v_line_quantity, btrim(v_line->>'reason'), v_line_expiration,
      NULLIF(btrim(v_line->>'lot'), ''), NULLIF(btrim(v_line->>'observation'), '')
    FROM integraciones.bsale_variants bv
    JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
    WHERE bv.company_id = p_company_id AND bv.bsale_id = v_detail.variant_id
    RETURNING id INTO v_request_line_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Producto Bsale % no encontrado', v_detail.variant_id; END IF;

    SELECT count(*)::integer INTO v_photo_count
    FROM jsonb_array_elements(COALESCE(p_evidence, '[]'::jsonb)) e
    WHERE (e->>'line_index')::integer = v_line_count;
    IF v_photo_count < 1 THEN RAISE EXCEPTION 'Debes adjuntar evidencia en la línea %', v_line_count + 1; END IF;
    FOR v_photo IN SELECT value FROM jsonb_array_elements(p_evidence) WHERE (value->>'line_index')::integer = v_line_count LOOP
      IF v_photo->>'storage_path' IS NULL
         OR split_part(v_photo->>'storage_path', '/', 1) <> p_company_id::text
         OR NOT EXISTS (SELECT 1 FROM storage.objects so WHERE so.bucket_id = 'mermas-evidence' AND so.name = v_photo->>'storage_path') THEN
        RAISE EXCEPTION 'La evidencia de la línea % no está disponible', v_line_count + 1;
      END IF;
      INSERT INTO mermas.evidence(company_id, request_id, request_line_id, storage_path, file_name, mime_type, file_size, uploaded_by)
      VALUES (p_company_id, v_request_id, v_request_line_id, v_photo->>'storage_path',
        COALESCE(v_photo->>'file_name', 'evidencia'), COALESCE(v_photo->>'mime_type', 'image/jpeg'),
        COALESCE((v_photo->>'file_size')::bigint, 1), p_user_id);
    END LOOP;
    INSERT INTO mermas.bsale_detail_allocations(
      company_id, consumption_detail_id, request_line_id, request_id, quantity, expiration_date, lot
    ) VALUES (
      p_company_id, v_detail.id, v_request_line_id, v_request_id, v_detail.quantity,
      v_line_expiration, NULLIF(btrim(v_line->>'lot'), '')
    );
    v_line_count := v_line_count + 1;
  END LOOP;

  UPDATE mermas.bsale_consumptions
  SET request_id = v_request_id, match_method = 'MANUAL_INCIDENT', processed_at = now()
  WHERE company_id = p_company_id AND consumption_id = p_consumption_id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES ('mermas.requests', v_request_id, 'MERMA_INCIDENT',
    jsonb_build_object('request_code', v_code, 'consumption_id', p_consumption_id, 'line_count', v_line_count), p_user_id);
  RETURN jsonb_build_object('success', true, 'request_id', v_request_id, 'request_code', v_code, 'status', 'PENDIENTE');
END;
$$;

REVOKE ALL ON FUNCTION mermas.regularize_bsale_incident(bigint, uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.regularize_bsale_incident(bigint, uuid, uuid, jsonb, jsonb) TO service_role;

-- Authorization reuses allocations created during incident regularization.
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
  v_existing_line_id uuid;
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
  IF NOT FOUND OR v_consumption.consumption_type_id <> 2 THEN RAISE EXCEPTION 'El consumo Bsale no es una Merma válida'; END IF;
  IF v_consumption.request_id IS NOT NULL AND v_consumption.request_id <> p_request_id THEN RAISE EXCEPTION 'El consumo Bsale ya está asociado a otra solicitud'; END IF;
  IF EXISTS (
    SELECT 1 FROM mermas.bsale_detail_allocations a
    JOIN mermas.bsale_consumption_details d ON d.id = a.consumption_detail_id
    WHERE d.company_id = p_company_id AND d.consumption_id = p_consumption_id AND a.request_id IS DISTINCT FROM p_request_id
  ) THEN RAISE EXCEPTION 'Un detalle Bsale ya está asociado a otra solicitud'; END IF;
  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT bsale_variant_id AS variant_id, sum(quantity) AS qty FROM mermas.request_lines WHERE request_id = p_request_id GROUP BY bsale_variant_id
    ) rq FULL JOIN (
      SELECT variant_id, sum(quantity) AS qty FROM mermas.bsale_consumption_details WHERE company_id = p_company_id AND consumption_id = p_consumption_id GROUP BY variant_id
    ) bs USING (variant_id) WHERE COALESCE(rq.qty, 0) <> COALESCE(bs.qty, 0)
  ) INTO v_mismatch;
  IF v_mismatch THEN RAISE EXCEPTION 'Los productos y cantidades no coinciden con el consumo Bsale'; END IF;

  FOR v_detail IN SELECT d.* FROM mermas.bsale_consumption_details d WHERE d.company_id = p_company_id AND d.consumption_id = p_consumption_id ORDER BY d.detail_id LOOP
    SELECT a.id, a.request_line_id INTO v_allocation_id, v_existing_line_id
    FROM mermas.bsale_detail_allocations a
    WHERE a.company_id = p_company_id AND a.consumption_detail_id = v_detail.id AND a.request_id = p_request_id;
    IF FOUND THEN
      SELECT rl.* INTO v_line FROM mermas.request_lines rl WHERE rl.id = v_existing_line_id;
    ELSE
      SELECT rl.* INTO v_line FROM mermas.request_lines rl
      WHERE rl.request_id = p_request_id AND rl.bsale_variant_id = v_detail.variant_id
        AND v_detail.quantity <= rl.quantity - COALESCE((SELECT sum(a.quantity) FROM mermas.bsale_detail_allocations a WHERE a.request_line_id = rl.id), 0)
      ORDER BY rl.created_at, rl.id LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'No se pudo asignar el detalle Bsale % a una línea', v_detail.detail_id; END IF;
      INSERT INTO mermas.bsale_detail_allocations(company_id, consumption_detail_id, request_line_id, request_id, quantity, expiration_date, lot)
      VALUES (p_company_id, v_detail.id, v_line.id, p_request_id, v_detail.quantity, v_line.expiration_date, v_line.lot)
      RETURNING id INTO v_allocation_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM mermas.movements m WHERE m.company_id = p_company_id AND m.detail_id = v_detail.detail_id AND m.allocation_id = v_allocation_id AND m.movement_type = 'ENTRADA_BSALE') THEN
      INSERT INTO mermas.movements(company_id, movement_type, variant_id, quantity, expiration_date, lot, consumption_id, detail_id, allocation_id, request_id, request_line_id, source, authorization_status, authorized_by, authorized_at)
      VALUES (p_company_id, 'ENTRADA_BSALE', v_detail.variant_id, v_detail.quantity, v_line.expiration_date, v_line.lot, p_consumption_id, v_detail.detail_id, v_allocation_id, p_request_id, v_line.id, 'BSALE', 'AUTORIZADA', p_user_id, now());
    END IF;
  END LOOP;
  UPDATE mermas.bsale_consumptions SET request_id = p_request_id, match_method = 'MANUAL_AUTHORIZATION', processed_at = now()
  WHERE company_id = p_company_id AND consumption_id = p_consumption_id;
  UPDATE mermas.requests SET status = 'FINALIZADA', updated_at = now() WHERE id = p_request_id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  VALUES ('mermas.requests', p_request_id, 'MERMAS_AUTH', jsonb_build_object('status', v_request.status), jsonb_build_object('status', 'FINALIZADA', 'consumption_id', p_consumption_id), p_user_id);
  RETURN jsonb_build_object('success', true, 'status', 'FINALIZADA', 'consumption_id', p_consumption_id);
END;
$$;

REVOKE ALL ON FUNCTION mermas.authorize_request_with_consumption(uuid, bigint, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.authorize_request_with_consumption(uuid, bigint, uuid, uuid) TO service_role;
