-- Apply an already-confirmed PetGroup -> Bsale consumption locally.
-- This migration performs no remote calls and never creates a Bsale consumption.

ALTER TABLE mermas.bsale_outbound_operations
  ADD COLUMN IF NOT EXISTS local_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS local_apply_error text;

CREATE OR REPLACE FUNCTION mermas.apply_confirmed_bsale_merma_outbound(
  p_operation_id uuid,
  p_company_id uuid,
  p_user_id uuid,
  p_header jsonb,
  p_details jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
  v_operation mermas.bsale_outbound_operations%ROWTYPE;
  v_request mermas.requests%ROWTYPE;
  v_consumption mermas.bsale_consumptions%ROWTYPE;
  v_detail_payload jsonb;
  v_detail record;
  v_line record;
  v_header_id bigint;
  v_type integer;
  v_office_id integer;
  v_expected_office integer;
  v_office_count integer;
  v_variant_id integer;
  v_detail_id bigint;
  v_quantity numeric;
  v_remaining_detail numeric;
  v_remaining_line numeric;
  v_piece numeric;
  v_all_complete boolean;
  v_existing_request uuid;
  v_existing_method text;
  v_allocation_id uuid;
BEGIN
  IF p_operation_id IS NULL OR p_company_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Aplicación local inválida';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM portal.users
    WHERE id = p_user_id AND is_active AND deleted_at IS NULL
  ) OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.request.create') THEN
    RAISE EXCEPTION 'No autorizado para aplicar outbound de Mermas';
  END IF;

  SELECT * INTO v_operation
  FROM mermas.bsale_outbound_operations
  WHERE id = p_operation_id AND company_id = p_company_id
    AND operation_type = 'MERMAS_CONSUMPTION'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Operación outbound no encontrada'; END IF;
  IF v_operation.local_applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true,
      'status', 'FINALIZADA', 'operation_id', v_operation.id,
      'consumption_id', v_operation.bsale_consumption_id,
      'local_applied_at', v_operation.local_applied_at);
  END IF;
  IF v_operation.status <> 'CONFIRMED' OR v_operation.bsale_consumption_id IS NULL THEN
    RAISE EXCEPTION 'La operación outbound no está CONFIRMED con consumption_id';
  END IF;

  v_header_id := NULLIF(p_header->>'id', '')::bigint;
  v_type := NULLIF(p_header->>'consumptionTypeId', '')::integer;
  v_office_id := NULLIF(p_header->'office'->>'id', '')::integer;
  IF v_header_id IS DISTINCT FROM v_operation.bsale_consumption_id THEN
    RAISE EXCEPTION 'El header Bsale no corresponde a la operación outbound';
  END IF;
  IF v_type IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'El consumo Bsale no es tipo Mermas'; END IF;

  SELECT count(*)::integer, min(bo.bsale_id)::integer INTO v_office_count, v_expected_office
  FROM integraciones.bsale_offices bo
  WHERE bo.company_id = p_company_id
    AND (upper(btrim(coalesce(bo.name, ''))) LIKE '%CASA MATRIZ%'
      OR upper(btrim(coalesce(bo.name, ''))) LIKE '%MATRIZ%');
  IF v_office_count <> 1 OR v_office_id IS DISTINCT FROM v_expected_office THEN
    RAISE EXCEPTION 'La oficina Bsale no corresponde a CASA MATRIZ';
  END IF;
  IF jsonb_typeof(p_details) <> 'array' OR jsonb_array_length(p_details) = 0 THEN
    RAISE EXCEPTION 'El consumo Bsale no contiene detalles';
  END IF;

  SELECT request_id INTO v_existing_request
  FROM mermas.bsale_consumptions
  WHERE company_id = p_company_id AND consumption_id = v_operation.bsale_consumption_id
  FOR UPDATE;
  SELECT match_method INTO v_existing_method
  FROM mermas.bsale_consumptions
  WHERE company_id = p_company_id AND consumption_id = v_operation.bsale_consumption_id;
  IF v_existing_request IS NOT NULL AND v_existing_request IS DISTINCT FROM v_operation.request_id THEN
    RAISE EXCEPTION 'El consumo Bsale ya está asociado a otra solicitud';
  END IF;
  IF v_existing_method IN ('MULTI_REQUEST', 'MANUAL_AUTHORIZATION', 'DIRECTO_BSALE')
     AND v_existing_request IS DISTINCT FROM v_operation.request_id THEN
    RAISE EXCEPTION 'El consumo Bsale tiene una asociación incompatible';
  END IF;

  SELECT * INTO v_request FROM mermas.requests
  WHERE id = v_operation.request_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND OR v_request.status = 'CANCELADA' THEN RAISE EXCEPTION 'Solicitud de Merma no disponible'; END IF;

  -- Lock lines in deterministic order and validate evidence before writing any row.
  FOR v_line IN
    SELECT rl.* FROM mermas.request_lines rl
    WHERE rl.request_id = v_request.id AND rl.company_id = p_company_id
    ORDER BY rl.created_at, rl.id FOR UPDATE
  LOOP
    IF v_line.quantity <= 0 OR v_line.bsale_variant_id IS NULL OR v_line.bsale_variant_id <= 0
       OR v_line.expiration_date IS NULL THEN
      RAISE EXCEPTION 'La línea % no tiene cantidad, variante o vencimiento válido', v_line.id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM mermas.evidence e
      WHERE e.company_id = p_company_id AND e.request_line_id = v_line.id
    ) THEN
      RAISE EXCEPTION 'La línea % no tiene evidencia fotográfica', v_line.id;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM mermas.request_lines WHERE request_id = v_request.id AND company_id = p_company_id) THEN
    RAISE EXCEPTION 'La solicitud no contiene líneas';
  END IF;

  INSERT INTO mermas.bsale_consumptions(
    company_id, consumption_id, consumption_date, note, consumption_type_id,
    office_id, user_id, raw_json, processed_at
  ) VALUES (
    p_company_id, v_operation.bsale_consumption_id,
    CASE WHEN p_header->>'consumptionDate' ~ '^[0-9]+(\.[0-9]+)?$'
      THEN to_timestamp((p_header->>'consumptionDate')::numeric)
      WHEN NULLIF(p_header->>'consumptionDate', '') IS NULL THEN NULL
      ELSE (p_header->>'consumptionDate')::timestamptz END,
    p_header->>'note', 2, v_office_id,
    NULLIF(p_header->'user'->>'id', '')::integer, p_header, now()
  ) ON CONFLICT (company_id, consumption_id) DO UPDATE SET
    consumption_date = EXCLUDED.consumption_date,
    note = EXCLUDED.note,
    consumption_type_id = 2,
    office_id = EXCLUDED.office_id,
    user_id = EXCLUDED.user_id,
    raw_json = EXCLUDED.raw_json,
    processed_at = now()
  RETURNING * INTO v_consumption;

  FOR v_detail_payload IN SELECT value FROM jsonb_array_elements(p_details) LOOP
    v_detail_id := NULLIF(v_detail_payload->>'id', '')::bigint;
    v_variant_id := NULLIF(v_detail_payload->'variant'->>'id', '')::integer;
    v_quantity := NULLIF(v_detail_payload->>'quantity', '')::numeric;
    IF v_detail_id IS NULL OR v_variant_id IS NULL OR v_variant_id <= 0 OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Detalle Bsale inválido o sin identificador real';
    END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(p_details) x WHERE (x->>'id')::bigint = v_detail_id) > 1 THEN
      RAISE EXCEPTION 'Detalle Bsale duplicado: %', v_detail_id;
    END IF;
    INSERT INTO mermas.bsale_consumption_details(
      company_id, consumption_id, detail_id, variant_id, quantity, cost, variant_stock, raw_json
    ) VALUES (
      p_company_id, v_operation.bsale_consumption_id, v_detail_id, v_variant_id, v_quantity,
      NULLIF(v_detail_payload->>'cost', '')::numeric,
      NULLIF(v_detail_payload->>'variantStock', '')::numeric,
      v_detail_payload
    ) ON CONFLICT (company_id, consumption_id, detail_id) DO UPDATE SET
      variant_id = EXCLUDED.variant_id, quantity = EXCLUDED.quantity,
      cost = EXCLUDED.cost, variant_stock = EXCLUDED.variant_stock, raw_json = EXCLUDED.raw_json;
  END LOOP;

  -- Validate aggregate quantities by variant before creating allocations.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT rl.bsale_variant_id variant_id, sum(rl.quantity) quantity
      FROM mermas.request_lines rl WHERE rl.request_id = v_request.id AND rl.company_id = p_company_id
      GROUP BY rl.bsale_variant_id
    ) rq FULL JOIN (
      SELECT d.variant_id, sum(d.quantity) quantity
      FROM mermas.bsale_consumption_details d
      WHERE d.company_id = p_company_id AND d.consumption_id = v_operation.bsale_consumption_id
      GROUP BY d.variant_id
    ) bs USING (variant_id)
    WHERE coalesce(rq.quantity, 0) <> coalesce(bs.quantity, 0)
  ) THEN RAISE EXCEPTION 'Las cantidades Bsale no coinciden con la solicitud'; END IF;

  -- Deterministic detail -> line split, preserving existing allocations on retry.
  FOR v_detail IN
    SELECT d.* FROM mermas.bsale_consumption_details d
    WHERE d.company_id = p_company_id AND d.consumption_id = v_operation.bsale_consumption_id
    ORDER BY d.detail_id
  LOOP
    v_remaining_detail := v_detail.quantity - coalesce((
      SELECT sum(a.quantity) FROM mermas.bsale_detail_allocations a
      WHERE a.company_id = p_company_id AND a.consumption_detail_id = v_detail.id
    ), 0);
    IF v_remaining_detail < 0 THEN RAISE EXCEPTION 'Allocation excede el detalle Bsale %', v_detail.detail_id; END IF;
    FOR v_line IN
      SELECT rl.* FROM mermas.request_lines rl
      WHERE rl.request_id = v_request.id AND rl.company_id = p_company_id
        AND rl.bsale_variant_id = v_detail.variant_id
      ORDER BY rl.created_at, rl.id
    LOOP
      EXIT WHEN v_remaining_detail <= 0;
      v_remaining_line := v_line.quantity - coalesce((
        SELECT sum(a.quantity) FROM mermas.bsale_detail_allocations a
        WHERE a.company_id = p_company_id AND a.request_line_id = v_line.id
      ), 0);
      IF v_remaining_line < 0 THEN RAISE EXCEPTION 'Allocation excede la línea %', v_line.id; END IF;
      v_piece := least(v_remaining_detail, v_remaining_line);
      IF v_piece > 0 THEN
        INSERT INTO mermas.bsale_detail_allocations(
          company_id, consumption_detail_id, request_line_id, request_id,
          quantity, expiration_date, lot
        ) VALUES (
          p_company_id, v_detail.id, v_line.id, v_request.id,
          v_piece, v_line.expiration_date, v_line.lot
        ) ON CONFLICT (company_id, consumption_detail_id, request_line_id) DO UPDATE SET
          quantity = EXCLUDED.quantity, expiration_date = EXCLUDED.expiration_date, lot = EXCLUDED.lot
        RETURNING id INTO v_allocation_id;
        IF v_allocation_id IS NULL THEN
          SELECT id INTO v_allocation_id FROM mermas.bsale_detail_allocations
          WHERE company_id = p_company_id AND consumption_detail_id = v_detail.id AND request_line_id = v_line.id;
        END IF;
        INSERT INTO mermas.movements(
          company_id, movement_type, variant_id, quantity, expiration_date, lot,
          consumption_id, detail_id, allocation_id, request_id, request_line_id,
          source, authorization_status, authorized_by, authorized_at
        ) VALUES (
          p_company_id, 'ENTRADA_BSALE', v_detail.variant_id, v_piece, v_line.expiration_date, v_line.lot,
          v_operation.bsale_consumption_id, v_detail.detail_id, v_allocation_id, v_request.id, v_line.id,
          'BSALE', 'AUTORIZADA', p_user_id, now()
        ) ON CONFLICT DO NOTHING;
        IF NOT EXISTS (
          SELECT 1 FROM mermas.movements m
          WHERE m.company_id = p_company_id AND m.movement_type = 'ENTRADA_BSALE'
            AND m.consumption_id = v_operation.bsale_consumption_id
            AND m.detail_id = v_detail.detail_id AND m.allocation_id = v_allocation_id
        ) THEN RAISE EXCEPTION 'No se pudo asegurar el movimiento del detalle %', v_detail.detail_id; END IF;
        UPDATE mermas.movements
        SET authorization_status = 'AUTORIZADA', authorized_by = p_user_id, authorized_at = now()
        WHERE company_id = p_company_id AND movement_type = 'ENTRADA_BSALE'
          AND consumption_id = v_operation.bsale_consumption_id
          AND detail_id = v_detail.detail_id AND allocation_id = v_allocation_id;
        v_remaining_detail := v_remaining_detail - v_piece;
      END IF;
    END LOOP;
    IF v_remaining_detail > 0 THEN RAISE EXCEPTION 'Detalle Bsale % no pudo asignarse completamente', v_detail.detail_id; END IF;
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM mermas.request_lines rl
    WHERE rl.request_id = v_request.id
      AND rl.quantity <> coalesce((SELECT sum(a.quantity) FROM mermas.bsale_detail_allocations a WHERE a.company_id = p_company_id AND a.request_line_id = rl.id), 0)
  ) INTO v_all_complete;
  IF NOT v_all_complete THEN RAISE EXCEPTION 'La solicitud no quedó completamente asignada'; END IF;
  IF EXISTS (
    SELECT 1 FROM mermas.request_lines rl
    WHERE rl.request_id = v_request.id AND NOT EXISTS (
      SELECT 1 FROM mermas.movements m
      WHERE m.company_id = p_company_id AND m.request_line_id = rl.id
        AND m.consumption_id = v_operation.bsale_consumption_id AND m.movement_type = 'ENTRADA_BSALE'
    )
  ) THEN RAISE EXCEPTION 'Falta movimiento ENTRADA_BSALE para una línea'; END IF;

  UPDATE mermas.bsale_consumptions
  SET request_id = v_request.id, match_method = 'PETGROUP_OUTBOUND', processed_at = now()
  WHERE company_id = p_company_id AND consumption_id = v_operation.bsale_consumption_id;
  UPDATE mermas.requests SET status = 'FINALIZADA', updated_at = now() WHERE id = v_request.id;
  UPDATE mermas.bsale_outbound_operations
  SET local_applied_at = now(), local_apply_error = NULL, updated_at = now()
  WHERE id = v_operation.id AND company_id = p_company_id;

  RETURN jsonb_build_object('success', true, 'status', 'FINALIZADA',
    'operation_id', v_operation.id, 'consumption_id', v_operation.bsale_consumption_id,
    'request_id', v_request.id, 'match_method', 'PETGROUP_OUTBOUND');
END;
$$;

REVOKE ALL ON FUNCTION mermas.apply_confirmed_bsale_merma_outbound(uuid, uuid, uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.apply_confirmed_bsale_merma_outbound(uuid, uuid, uuid, jsonb, jsonb)
  TO service_role;
