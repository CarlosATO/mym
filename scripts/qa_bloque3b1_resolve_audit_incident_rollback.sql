-- QA transaccional (ROLLBACK) para Bloque 3B.1:
-- Verifica logistica.resolve_sales_order_audit_incident(...) en entorno aislado
-- sin tocar datos reales:
--   Caso 1: falta observación -> bloqueado
--   Caso 2: DAMAGED_PRODUCT sin fotografía -> bloqueado
--   Caso 3: 5 preparadas -> 3 auditadas con verificación comercial OBSOLETA (anterior a updated_at o Bsale descalzado) -> bloqueado
--   Caso 4: 5 preparadas -> 3 auditadas -> Bsale 3 + verificación READY_TO_INVOICE vigente -> RESUELTA (OPEN -> RESOLVED),
--           conservando cantidades originales, fotos, metadata de trazabilidad y sesión OPEN (sin auto-finalizar)
--   Caso 5: intento de resolución duplicada sobre la misma incidencia ya RESOLVED -> bloqueado
--   Caso 6: DAMAGED_PRODUCT con fotografía + cantidad 5 = 5 (corrección física) -> RESUELTA conservando foto
--   Caso 7: cantidad auditada 0 o sobrante (6 > 5) fuera del alcance 3B.1 -> bloqueado

BEGIN;

DO $$
DECLARE
  v_company_id uuid;
  v_preparer_id uuid;
  v_auditor_id uuid;
  v_now timestamptz := now();

  v_card_id uuid := gen_random_uuid();
  v_audit_id uuid := gen_random_uuid();
  v_prep_line_1 uuid := gen_random_uuid();
  v_prep_line_2 uuid := gen_random_uuid();
  v_audit_line_1 uuid := gen_random_uuid();
  v_audit_line_2 uuid := gen_random_uuid();
  v_inc_qty uuid := gen_random_uuid();
  v_inc_dmg uuid := gen_random_uuid();
  v_verif_id uuid := gen_random_uuid();

  v_nv_v1 int := 99887701;
  v_nv_v2 int := 99887702;
  v_folio int := 889001;
  v_token text := 'qa-3b1-token-' || replace(gen_random_uuid()::text, '-', '');
  v_err text;
  v_res jsonb;
  v_line_after record;
  v_inc_after record;
  v_audit_status text;
  v_photo_count integer;
BEGIN
  SELECT id INTO v_company_id FROM core.companies LIMIT 1;
  SELECT id INTO v_preparer_id FROM portal.users ORDER BY id ASC LIMIT 1;
  SELECT id INTO v_auditor_id FROM portal.users ORDER BY id DESC LIMIT 1;

  IF v_company_id IS NULL OR v_preparer_id IS NULL OR v_auditor_id IS NULL OR v_preparer_id = v_auditor_id THEN
    RAISE EXCEPTION 'QA 3B.1 requiere 1 empresa y 2 usuarios distintos (preparador y auditor).';
  END IF;

  -- Simular auth.uid() = v_auditor_id
  PERFORM set_config('request.jwt.claim.sub', v_auditor_id::text, true);

  -- Espejo Bsale v2 con 3 unidades en SKU-1 (reducido de 5 -> 3) y 5 unidades en SKU-2
  INSERT INTO integraciones.bsale_documents (
    company_id, bsale_id, number, emission_date, generation_date,
    net_amount, tax_amount, total_amount, exempt_amount,
    document_type_id, state, raw_json
  ) VALUES (
    v_company_id, v_nv_v2, v_folio, CURRENT_DATE, v_now - interval '1 minute',
    8000, 1520, 9520, 0,
    23, 0, jsonb_build_object('token', v_token)
  );

  INSERT INTO integraciones.bsale_document_details (
    company_id, bsale_id, bsale_document_id, line_number,
    quantity, net_unit_value, total_unit_value, net_amount, tax_amount, total_amount,
    variant_id, variant_code, variant_description
  ) VALUES
  (v_company_id, 998001, v_nv_v2, 1, 3, 1000, 1190, 3000, 570, 3570, 771001, 'QA-3B1-SKU1', 'Producto 5 a 3'),
  (v_company_id, 998002, v_nv_v2, 2, 5, 1000, 1190, 5000, 950, 5950, 771002, 'QA-3B1-SKU2', 'Producto Danado');

  -- Tarjeta en IN_AUDIT apuntando a v2
  INSERT INTO logistica.sales_order_preparation_cards (
    id, company_id, bsale_nv_id, current_bsale_nv_id, bsale_nv_folio,
    canonical_bsale_token, status, assigned_user_id
  ) VALUES (
    v_card_id, v_company_id, v_nv_v1, v_nv_v2, v_folio::text,
    v_token, 'IN_AUDIT', v_preparer_id
  );

  -- Sesión de Auditoría OPEN tomada por v_auditor_id
  INSERT INTO logistica.sales_order_audits (
    id, company_id, card_id, bsale_nv_id, bsale_nv_folio, cycle_no, status,
    assigned_auditor_user_id, locked_by_user_id, locked_at,
    prepared_by_user_id_snapshot, package_count, created_by
  ) VALUES (
    v_audit_id, v_company_id, v_card_id, v_nv_v1, v_folio::text, 1, 'OPEN',
    v_auditor_id, v_auditor_id, v_now - interval '5 minutes',
    v_preparer_id, 2, v_auditor_id
  );

  -- Líneas auditadas: línea 1 (5 preparadas -> 3 auditadas), línea 2 (5 preparadas -> 5 auditadas con DAMAGED_PRODUCT)
  INSERT INTO logistica.sales_order_audit_lines (
    id, company_id, audit_id, card_id, preparation_line_id,
    bsale_detail_id, bsale_variant_id, sku, product_name,
    requested_quantity_snapshot, prepared_quantity_snapshot, audit_quantity,
    line_status, confirmed_by, confirmed_at, updated_at
  ) VALUES
  (v_audit_line_1, v_company_id, v_audit_id, v_card_id, v_prep_line_1, 998001, 771001, 'QA-3B1-SKU1', 'Producto 5 a 3', 5, 5, 3, 'INCIDENT', v_auditor_id, v_now - interval '3 minutes', v_now - interval '3 minutes'),
  (v_audit_line_2, v_company_id, v_audit_id, v_card_id, v_prep_line_2, 998002, 771002, 'QA-3B1-SKU2', 'Producto Danado', 5, 5, 5, 'INCIDENT', v_auditor_id, v_now - interval '3 minutes', v_now - interval '3 minutes');

  -- Incidencias OPEN
  INSERT INTO logistica.sales_order_audit_incidents (
    id, company_id, audit_id, audit_line_id, card_id, preparation_line_id,
    requested_quantity_snapshot, prepared_quantity_snapshot, audit_quantity, difference_vs_prepared,
    incident_type, observation, status, detected_by, detected_at, updated_at
  ) VALUES
  (v_inc_qty, v_company_id, v_audit_id, v_audit_line_1, v_card_id, v_prep_line_1, 5, 5, 3, -2, 'QUANTITY_LOWER_THAN_PREPARED', 'Solo 3 unidades físicas', 'OPEN', v_auditor_id, v_now - interval '3 minutes', v_now - interval '3 minutes'),
  (v_inc_dmg, v_company_id, v_audit_id, v_audit_line_2, v_card_id, v_prep_line_2, 5, 5, 5, 0, 'DAMAGED_PRODUCT', 'Caja golpeada', 'OPEN', v_auditor_id, v_now - interval '3 minutes', v_now - interval '3 minutes');

  -- Caso 1: observación vacía -> debe bloquear
  BEGIN
    PERFORM logistica.resolve_sales_order_audit_incident(v_company_id, v_card_id, v_audit_id, v_inc_qty, '   ');
    RAISE EXCEPTION 'FAIL Caso 1: permitió resolver sin observación';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%observación de resolución es obligatoria%' THEN
      RAISE EXCEPTION 'FAIL Caso 1 inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 1 (observación obligatoria): %', v_err;
  END;

  -- Caso 2: DAMAGED_PRODUCT sin fotografía -> debe bloquear
  BEGIN
    PERFORM logistica.resolve_sales_order_audit_incident(v_company_id, v_card_id, v_audit_id, v_inc_dmg, 'Reemplazada unidad dañada');
    RAISE EXCEPTION 'FAIL Caso 2: permitió resolver DAMAGED_PRODUCT sin fotografía';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%fotografía obligatoria%' THEN
      RAISE EXCEPTION 'FAIL Caso 2 inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 2 (foto obligatoria bloqueada): %', v_err;
  END;

  -- Caso 3: 5 -> 3 con verificación comercial OBSOLETA (verified_at anterior a line.updated_at) -> debe bloquear
  INSERT INTO logistica.sales_order_audit_commercial_verifications (
    id, company_id, card_id, audit_id, is_current, status,
    current_bsale_nv_id, canonical_bsale_token, reason, fingerprint,
    snapshot, differences, verified_at
  ) VALUES (
    v_verif_id, v_company_id, v_card_id, v_audit_id, true, 'READY_TO_INVOICE',
    v_nv_v2, v_token, 'COMMERCIAL_MATCHED', repeat('f', 64),
    jsonb_build_object(
      'cardId', v_card_id::text,
      'auditId', v_audit_id::text,
      'status', 'READY_TO_INVOICE',
      'identity', jsonb_build_object('companyId', v_company_id::text),
      'comparison', jsonb_build_object('status', 'READY_TO_INVOICE', 'differences', '[]'::jsonb),
      'currentVersion', jsonb_build_object('physicalId', v_nv_v2, 'identity', jsonb_build_object('canonicalToken', v_token, 'currentBsaleId', v_nv_v2)),
      'auditedLines', jsonb_build_array(
        jsonb_build_object('bsale_detail_id', 998001, 'audit_quantity', 3),
        jsonb_build_object('bsale_detail_id', 998002, 'audit_quantity', 5)
      )
    ),
    '[]'::jsonb,
    v_now - interval '4 minutes' -- ANTERIOR a updated_at (-3 min) -> OBSOLETA
  );

  BEGIN
    PERFORM logistica.resolve_sales_order_audit_incident(v_company_id, v_card_id, v_audit_id, v_inc_qty, 'Bsale rebajado a 3');
    RAISE EXCEPTION 'FAIL Caso 3: permitió resolver con verificación comercial obsoleta';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%verificación comercial quedó obsoleta%' THEN
      RAISE EXCEPTION 'FAIL Caso 3 inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 3 (verificación obsoleta bloqueada): %', v_err;
  END;

  -- Caso 4: 5 preparadas -> 3 auditadas -> Bsale 3 + verificación vigente -> RESUELTA conservando historial y sin auto-finalizar
  UPDATE logistica.sales_order_audit_commercial_verifications
     SET verified_at = v_now - interval '30 seconds'
   WHERE id = v_verif_id;

  v_res := logistica.resolve_sales_order_audit_incident(v_company_id, v_card_id, v_audit_id, v_inc_qty, 'NV rebajada en Bsale de 5 a 3 y verificada');
  IF v_res->>'status' IS DISTINCT FROM 'RESOLVED'
     OR v_res->>'commercial_verification_id' IS DISTINCT FROM v_verif_id::text THEN
    RAISE EXCEPTION 'FAIL Caso 4: respuesta inesperada: %', v_res;
  END IF;

  SELECT prepared_quantity_snapshot, audit_quantity INTO v_line_after
  FROM logistica.sales_order_audit_lines WHERE id = v_audit_line_1;
  SELECT status, metadata INTO v_inc_after
  FROM logistica.sales_order_audit_incidents WHERE id = v_inc_qty;
  SELECT status INTO v_audit_status
  FROM logistica.sales_order_audits WHERE id = v_audit_id;

  IF v_line_after.prepared_quantity_snapshot <> 5 OR v_line_after.audit_quantity <> 3
     OR v_inc_after.status <> 'RESOLVED'
     OR v_inc_after.metadata->>'resolution_note' <> 'NV rebajada en Bsale de 5 a 3 y verificada'
     OR v_audit_status <> 'OPEN' THEN
    RAISE EXCEPTION 'FAIL Caso 4: integridad de historial/estado alterada';
  END IF;
  RAISE NOTICE 'PASS Caso 4 (5 -> 3 -> Bsale 3 resuelta conservando historial y sesión OPEN): %', v_res;

  -- Caso 5: resolución duplicada -> bloqueada
  BEGIN
    PERFORM logistica.resolve_sales_order_audit_incident(v_company_id, v_card_id, v_audit_id, v_inc_qty, 'Segundo intento');
    RAISE EXCEPTION 'FAIL Caso 5: permitió resolución duplicada';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%ya no está abierta%' THEN
      RAISE EXCEPTION 'FAIL Caso 5 inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 5 (resolución duplicada bloqueada): %', v_err;
  END;

  -- Caso 6: DAMAGED_PRODUCT con fotografía adjunta -> RESUELTA conservando foto
  INSERT INTO logistica.sales_order_audit_attachments (
    company_id, audit_id, audit_line_id, incident_id, attachment_type,
    storage_bucket, storage_path, file_name, mime_type, file_size, uploaded_by
  ) VALUES (
    v_company_id, v_audit_id, v_audit_line_2, v_inc_dmg, 'INCIDENT_EVIDENCE',
    'audit-evidence', 'qa/damaged.jpg', 'damaged.jpg', 'image/jpeg', 12345, v_auditor_id
  );

  v_res := logistica.resolve_sales_order_audit_incident(v_company_id, v_card_id, v_audit_id, v_inc_dmg, 'Unidad dañada reemplazada en bodega');
  SELECT count(*) INTO v_photo_count FROM logistica.sales_order_audit_attachments WHERE incident_id = v_inc_dmg;
  IF v_res->>'status' IS DISTINCT FROM 'RESOLVED' OR v_photo_count <> 1 THEN
    RAISE EXCEPTION 'FAIL Caso 6: respuesta o foto alterada: % / %', v_res, v_photo_count;
  END IF;
  RAISE NOTICE 'PASS Caso 6 (DAMAGED_PRODUCT con foto resuelta conservando evidencia): %', v_res;

  -- Caso 7: fuera de alcance 3B.1 (cantidad 0 o sobrante > preparada) -> bloqueado
  UPDATE logistica.sales_order_audit_lines SET audit_quantity = 6 WHERE id = v_audit_line_1;
  UPDATE logistica.sales_order_audit_incidents SET status = 'OPEN' WHERE id = v_inc_qty;
  BEGIN
    PERFORM logistica.resolve_sales_order_audit_incident(v_company_id, v_card_id, v_audit_id, v_inc_qty, 'Intento sobrante');
    RAISE EXCEPTION 'FAIL Caso 7: permitió sobrante con aumento comercial';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%sobrantes con aumento comercial no está habilitada%' THEN
      RAISE EXCEPTION 'FAIL Caso 7 inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 7 (sobrante fuera de alcance bloqueado): %', v_err;
  END;
END;
$$;

ROLLBACK;
