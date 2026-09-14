-- MERMAS: align the normal request RPC with request.create.
-- This corrective migration is required because the applied profile migration
-- cannot edit the already-applied create_request definition.

CREATE OR REPLACE FUNCTION mermas.create_request(
  p_request_id uuid, p_company_id uuid, p_user_id uuid, p_lines jsonb, p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas, storage
AS $$
DECLARE
  v_code text;
  v_year integer := EXTRACT(YEAR FROM timezone('America/Santiago', now()))::integer;
  v_sequence bigint;
  v_line jsonb;
  v_photo jsonb;
  v_variant record;
  v_quantity numeric;
  v_reason text;
  v_expiration date;
  v_line_count integer := 0;
  v_line_id uuid;
  v_requested jsonb := '{}'::jsonb;
  v_stock_key text;
  v_requested_quantity numeric;
  v_stock_count integer;
  v_stock numeric;
  v_photo_count integer;
  v_casa_matriz_office_id integer;
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL OR p_company_id IS NULL
    OR NOT core.has_company_access(p_user_id, p_company_id)
    OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.request.create') THEN
    RAISE EXCEPTION 'No autorizado para crear solicitudes de Merma';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN RAISE EXCEPTION 'La solicitud debe contener al menos una línea'; END IF;
  IF jsonb_typeof(COALESCE(p_evidence, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'La evidencia es inválida'; END IF;

  SELECT bo.bsale_id INTO v_casa_matriz_office_id
  FROM integraciones.bsale_offices bo
  WHERE bo.company_id = p_company_id
    AND (upper(coalesce(bo.name, '')) LIKE '%CASA MATRIZ%' OR upper(coalesce(bo.name, '')) LIKE '%MATRIZ%')
  ORDER BY bo.bsale_id
  LIMIT 1;
  IF v_casa_matriz_office_id IS NULL THEN
    SELECT s.office_id INTO v_casa_matriz_office_id
    FROM integraciones.bsale_stock_current s
    WHERE s.company_id = p_company_id
      AND s.office_id IS NOT NULL
      AND (upper(coalesce(s.raw_json->'office'->>'name', '')) LIKE '%CASA MATRIZ%' OR upper(coalesce(s.raw_json->'office'->>'name', '')) LIKE '%MATRIZ%')
    ORDER BY s.office_id
    LIMIT 1;
  END IF;
  IF v_casa_matriz_office_id IS NULL THEN
    SELECT min(s.office_id)::integer INTO v_casa_matriz_office_id
    FROM integraciones.bsale_stock_current s
    WHERE s.company_id = p_company_id AND s.office_id IS NOT NULL
    HAVING count(DISTINCT s.office_id) = 1;
  END IF;
  IF v_casa_matriz_office_id IS NULL THEN RAISE EXCEPTION 'No se pudo identificar la oficina CASA MATRIZ en el stock Bsale'; END IF;

  INSERT INTO mermas.request_correlatives(company_id, request_year, next_value)
  VALUES (p_company_id, v_year, 2)
  ON CONFLICT (company_id, request_year) DO UPDATE SET next_value = mermas.request_correlatives.next_value + 1
  RETURNING next_value - 1 INTO v_sequence;
  v_code := 'MER-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0');
  INSERT INTO mermas.requests(id, company_id, request_code, status, created_by)
  VALUES (p_request_id, p_company_id, v_code, 'PENDIENTE', p_user_id);

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT bv.bsale_id, bv.code, bp.name, bv.description INTO v_variant
    FROM integraciones.bsale_variants bv
    JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
    WHERE bv.id = NULLIF(v_line->>'variant_id', '')::uuid AND bv.company_id = p_company_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Producto no encontrado en el catálogo Bsale'; END IF;
    v_quantity := NULLIF(v_line->>'quantity', '')::numeric;
    v_reason := btrim(COALESCE(v_line->>'reason', ''));
    v_expiration := NULLIF(v_line->>'expiration_date', '')::date;
    IF v_quantity IS NULL OR v_quantity <= 0 OR v_reason = '' OR v_expiration IS NULL THEN RAISE EXCEPTION 'Completa producto, cantidad, motivo y vencimiento en todas las líneas'; END IF;
    v_stock_key := v_variant.bsale_id::text;
    v_requested := jsonb_set(v_requested, ARRAY[v_stock_key], to_jsonb(COALESCE((v_requested->>v_stock_key)::numeric, 0) + v_quantity), true);
    INSERT INTO mermas.request_lines(request_id, company_id, bsale_variant_id, sku, product_name, variant_description, quantity, reason, expiration_date, lot, observation)
    VALUES (p_request_id, p_company_id, v_variant.bsale_id, COALESCE(v_variant.code, ''), COALESCE(v_variant.name, v_variant.code, 'Producto Bsale'), v_variant.description, v_quantity, v_reason, v_expiration, NULLIF(btrim(v_line->>'lot'), ''), NULLIF(btrim(v_line->>'observation'), ''))
    RETURNING id INTO v_line_id;
    SELECT count(*)::integer INTO v_photo_count FROM jsonb_array_elements(COALESCE(p_evidence, '[]'::jsonb)) e WHERE (e->>'line_index')::integer = v_line_count;
    IF v_photo_count < 1 THEN RAISE EXCEPTION 'Debes adjuntar al menos una fotografía en la línea %', v_line_count + 1; END IF;
    FOR v_photo IN SELECT value FROM jsonb_array_elements(p_evidence) WHERE (value->>'line_index')::integer = v_line_count LOOP
      IF v_photo->>'storage_path' IS NULL OR split_part(v_photo->>'storage_path', '/', 1) <> p_company_id::text OR NOT EXISTS (SELECT 1 FROM storage.objects so WHERE so.bucket_id = 'mermas-evidence' AND so.name = v_photo->>'storage_path') THEN
        RAISE EXCEPTION 'La evidencia de la línea % no está disponible', v_line_count + 1;
      END IF;
      INSERT INTO mermas.evidence(company_id, request_id, request_line_id, storage_path, file_name, mime_type, file_size, uploaded_by)
      VALUES (p_company_id, p_request_id, v_line_id, v_photo->>'storage_path', COALESCE(v_photo->>'file_name', 'evidencia'), COALESCE(v_photo->>'mime_type', 'image/jpeg'), COALESCE((v_photo->>'file_size')::bigint, 1), p_user_id);
    END LOOP;
    v_line_count := v_line_count + 1;
  END LOOP;

  FOR v_stock_key, v_requested_quantity IN SELECT key, value::numeric FROM jsonb_each_text(v_requested) LOOP
    SELECT count(*)::integer, COALESCE(sum(quantity_available), 0) INTO v_stock_count, v_stock
    FROM integraciones.bsale_stock_current
    WHERE company_id = p_company_id AND variant_id = v_stock_key::integer AND office_id = v_casa_matriz_office_id
      AND quantity_available IS NOT NULL AND quantity_available >= 0;
    IF v_stock_count = 0 THEN RAISE EXCEPTION 'Sin información de stock Bsale para la variante %', v_stock_key; END IF;
    IF v_stock <= 0 THEN RAISE EXCEPTION 'La variante % no tiene stock disponible en Bsale', v_stock_key; END IF;
    IF v_requested_quantity > v_stock THEN RAISE EXCEPTION 'La cantidad solicitada supera el stock disponible en Bsale (%) unidades', v_stock; END IF;
  END LOOP;
  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES ('mermas.requests', p_request_id, 'CREATE', jsonb_build_object('request_code', v_code, 'line_count', v_line_count, 'evidence_required', true), p_user_id);
  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'request_code', v_code, 'status', 'PENDIENTE');
END;
$$;

REVOKE ALL ON FUNCTION mermas.create_request(uuid, uuid, uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.create_request(uuid, uuid, uuid, jsonb, jsonb)
  TO service_role;
