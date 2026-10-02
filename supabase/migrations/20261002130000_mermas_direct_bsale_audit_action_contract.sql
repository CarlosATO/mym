-- Keep the direct Bsale regularization audit action within audit_logs.action varchar(20).

CREATE OR REPLACE FUNCTION mermas.regularize_and_authorize_bsale_incident(
  p_consumption_id bigint,
  p_company_id uuid,
  p_user_id uuid,
  p_lines jsonb,
  p_evidence jsonb,
  p_confirmed_review boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas, storage
AS $$
DECLARE
  v_consumption mermas.bsale_consumptions%ROWTYPE;
  v_request mermas.requests%ROWTYPE;
  v_detail record;
  v_line jsonb;
  v_photo jsonb;
  v_request_id uuid;
  v_request_line_id uuid;
  v_allocation_id uuid;
  v_existing_movement mermas.movements%ROWTYPE;
  v_code text;
  v_year integer := EXTRACT(YEAR FROM timezone('America/Santiago', now()))::integer;
  v_sequence bigint;
  v_line_count integer := 0;
  v_line_index integer;
  v_evidence_count integer := 0;
  v_without_evidence integer := 0;
  v_total_quantity numeric := 0;
  v_line_quantity numeric;
  v_line_expiration date;
  v_reason text;
  v_observation text;
BEGIN
  IF p_user_id IS NULL OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.authorize') THEN
    RAISE EXCEPTION 'No autorizado para regularizar e ingresar Mermas';
  END IF;
  IF NOT COALESCE(p_confirmed_review, false) THEN
    RAISE EXCEPTION 'Debes confirmar la revisión de productos y cantidades';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0
     OR jsonb_typeof(COALESCE(p_evidence, '[]'::jsonb)) <> 'array' THEN
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
    SELECT * INTO v_request
    FROM mermas.requests
    WHERE company_id = p_company_id AND id = v_consumption.request_id
    FOR UPDATE;
    IF v_request.status = 'FINALIZADA' AND v_consumption.match_method = 'DIRECTO_BSALE_BULK' THEN
      RETURN jsonb_build_object('success', true, 'idempotent', true,
        'request_id', v_request.id, 'request_code', v_request.request_code, 'status', v_request.status);
    END IF;
    RAISE EXCEPTION 'El consumo Bsale ya está asociado a otra operación';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mermas.bsale_detail_allocations a
    JOIN mermas.bsale_consumption_details d ON d.id = a.consumption_detail_id
    WHERE d.company_id = p_company_id AND d.consumption_id = p_consumption_id
  ) THEN
    RAISE EXCEPTION 'El consumo Bsale tiene una asociación parcial y requiere revisión';
  END IF;

  IF jsonb_array_length(p_lines) <> (
    SELECT count(*) FROM mermas.bsale_consumption_details
    WHERE company_id = p_company_id AND consumption_id = p_consumption_id
  ) OR (
    SELECT count(DISTINCT (value->>'detail_id')::bigint) FROM jsonb_array_elements(p_lines)
  ) <> jsonb_array_length(p_lines) THEN
    RAISE EXCEPTION 'La cantidad de líneas no coincide con el consumo Bsale';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(p_evidence, '[]'::jsonb)) AS evidence(value)
    WHERE NULLIF(evidence.value->>'line_index', '') IS NULL
       OR (evidence.value->>'line_index')::integer < 0
       OR (evidence.value->>'line_index')::integer >= jsonb_array_length(p_lines)
       OR NULLIF(evidence.value->>'storage_path', '') IS NULL
       OR split_part(evidence.value->>'storage_path', '/', 1) <> p_company_id::text
       OR NOT EXISTS (
         SELECT 1 FROM storage.objects so
         WHERE so.bucket_id = 'mermas-evidence' AND so.name = evidence.value->>'storage_path'
       )
  ) THEN
    RAISE EXCEPTION 'La evidencia de la regularización no está disponible';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_evidence, '[]'::jsonb)) AS evidence(value)
    WHERE NULLIF(evidence.value->>'storage_path', '') IS NOT NULL
    GROUP BY evidence.value->>'storage_path'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'La evidencia contiene archivos duplicados';
  END IF;

  INSERT INTO mermas.request_correlatives(company_id, request_year, next_value)
  VALUES (p_company_id, v_year, 2)
  ON CONFLICT (company_id, request_year) DO UPDATE
    SET next_value = mermas.request_correlatives.next_value + 1
  RETURNING next_value - 1 INTO v_sequence;
  v_request_id := gen_random_uuid();
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
    IF v_line IS NULL THEN
      RAISE EXCEPTION 'Falta la línea Bsale %', v_detail.detail_id;
    END IF;
    IF (v_line->>'variant_id')::integer <> v_detail.variant_id
       OR (v_line->>'quantity')::numeric <> v_detail.quantity THEN
      RAISE EXCEPTION 'La línea Bsale % no coincide con su detalle', v_detail.detail_id;
    END IF;
    IF COALESCE((v_line->>'has_difference')::boolean, false) THEN
      RAISE EXCEPTION 'Existe una diferencia pendiente de revisión';
    END IF;
    SELECT ordinality - 1 INTO v_line_index
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS payload(value, ordinality)
    WHERE (payload.value->>'detail_id')::bigint = v_detail.detail_id;
    v_line_quantity := NULLIF(v_line->>'quantity', '')::numeric;
    v_line_expiration := NULLIF(v_line->>'expiration_date', '')::date;
    v_reason := btrim(COALESCE(v_line->>'reason', ''));
    v_observation := NULLIF(btrim(COALESCE(v_line->>'observation', '')), '');
    IF v_line_quantity IS NULL OR v_line_quantity <= 0 OR v_line_expiration IS NULL OR v_reason = '' THEN
      RAISE EXCEPTION 'Completa motivo y vencimiento en todas las líneas';
    END IF;

    INSERT INTO mermas.request_lines(
      request_id, company_id, bsale_variant_id, sku, product_name,
      variant_description, quantity, reason, expiration_date, lot, observation
    )
    SELECT v_request_id, p_company_id, bv.bsale_id, COALESCE(bv.code, ''),
      COALESCE(bp.name, bv.code, 'Producto Bsale'), bv.description,
      v_line_quantity, v_reason, v_line_expiration,
      NULLIF(btrim(v_line->>'lot'), ''), v_observation
    FROM integraciones.bsale_variants bv
    JOIN integraciones.bsale_products bp
      ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
    WHERE bv.company_id = p_company_id AND bv.bsale_id = v_detail.variant_id
    RETURNING id INTO v_request_line_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto Bsale % no encontrado', v_detail.variant_id;
    END IF;

    SELECT count(*)::integer INTO v_evidence_count
    FROM jsonb_array_elements(COALESCE(p_evidence, '[]'::jsonb)) e
    WHERE (e->>'line_index')::integer = v_line_index;
    IF v_evidence_count = 0 THEN v_without_evidence := v_without_evidence + 1; END IF;
    FOR v_photo IN
      SELECT value FROM jsonb_array_elements(COALESCE(p_evidence, '[]'::jsonb))
      WHERE (value->>'line_index')::integer = v_line_index
    LOOP
      INSERT INTO mermas.evidence(
        company_id, request_id, request_line_id, storage_path, file_name,
        mime_type, file_size, uploaded_by
      ) VALUES (
        p_company_id, v_request_id, v_request_line_id, v_photo->>'storage_path',
        COALESCE(v_photo->>'file_name', 'evidencia'), COALESCE(v_photo->>'mime_type', 'image/jpeg'),
        COALESCE((v_photo->>'file_size')::bigint, 1), p_user_id
      );
      v_evidence_count := v_evidence_count + 1;
    END LOOP;
    v_total_quantity := v_total_quantity + v_detail.quantity;

    INSERT INTO mermas.bsale_detail_allocations(
      company_id, consumption_detail_id, request_line_id, request_id,
      quantity, expiration_date, lot
    ) VALUES (
      p_company_id, v_detail.id, v_request_line_id, v_request_id,
      v_detail.quantity, v_line_expiration, NULLIF(btrim(v_line->>'lot'), '')
    ) RETURNING id INTO v_allocation_id;

    SELECT * INTO v_existing_movement
    FROM mermas.movements
    WHERE company_id = p_company_id AND consumption_id = p_consumption_id
      AND detail_id = v_detail.detail_id AND movement_type = 'ENTRADA_BSALE'
      AND allocation_id IS NULL
    ORDER BY created_at, id
    LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      UPDATE mermas.movements
      SET allocation_id = v_allocation_id, request_id = v_request_id,
          request_line_id = v_request_line_id, expiration_date = v_line_expiration,
          lot = NULLIF(btrim(v_line->>'lot'), ''), authorization_status = 'AUTORIZADA',
          authorized_by = p_user_id, authorized_at = now(),
          created_by = COALESCE(created_by, p_user_id), reason = v_reason,
          observation = v_observation
      WHERE id = v_existing_movement.id;
    ELSE
      INSERT INTO mermas.movements(
        company_id, movement_type, variant_id, quantity, expiration_date, lot,
        consumption_id, detail_id, allocation_id, request_id, request_line_id,
        source, authorization_status, authorized_by, authorized_at, created_by,
        reason, observation
      ) VALUES (
        p_company_id, 'ENTRADA_BSALE', v_detail.variant_id, v_detail.quantity,
        v_line_expiration, NULLIF(btrim(v_line->>'lot'), ''), p_consumption_id,
        v_detail.detail_id, v_allocation_id, v_request_id, v_request_line_id,
        'BSALE', 'AUTORIZADA', p_user_id, now(), p_user_id, v_reason, v_observation
      );
    END IF;
    v_line_count := v_line_count + 1;
  END LOOP;

  UPDATE mermas.bsale_consumptions
  SET request_id = v_request_id, match_method = 'DIRECTO_BSALE_BULK', processed_at = now()
  WHERE company_id = p_company_id AND consumption_id = p_consumption_id;
  UPDATE mermas.requests SET status = 'FINALIZADA', updated_at = now()
  WHERE id = v_request_id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES (
    'mermas.requests', v_request_id, 'MERMA_DIR_BSALE_REG',
    jsonb_build_object(
      'consumption_id', p_consumption_id,
      'request_code', v_code,
      'line_count', v_line_count,
      'total_quantity', v_total_quantity,
      'review_mode', 'DIRECT_BSALE_BULK',
      'evidence_required', false,
      'evidence_count', jsonb_array_length(COALESCE(p_evidence, '[]'::jsonb)),
      'lines_without_evidence', v_without_evidence,
      'reviewed_by', p_user_id,
      'final_status', 'FINALIZADA'
    ),
    p_user_id
  );
  RETURN jsonb_build_object(
    'success', true, 'request_id', v_request_id, 'request_code', v_code,
    'status', 'FINALIZADA', 'evidence_count', jsonb_array_length(COALESCE(p_evidence, '[]'::jsonb)),
    'lines_without_evidence', v_without_evidence
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.regularize_and_authorize_bsale_incident(bigint, uuid, uuid, jsonb, jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.regularize_and_authorize_bsale_incident(bigint, uuid, uuid, jsonb, jsonb, boolean)
  TO service_role;
