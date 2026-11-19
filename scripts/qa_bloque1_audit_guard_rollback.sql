-- QA transaccional (ROLLBACK) para Bloque 1:
-- Verifica logistica.move_sales_order_preparation_card(IN_PREPARATION -> IN_AUDIT)
-- sobre fixtures sintéticos que cumplen todas las restricciones reales de PostgreSQL
-- (CHECK, NOT NULL, FK, UNIQUE, vista canónica Bsale y materialize_sales_order_preparation_snapshot)
-- sin tocar datos reales.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/qa_bloque1_audit_guard_rollback.sql

BEGIN;

DO $$
DECLARE
  v_company_id uuid;
  v_user_id uuid;
  v_now timestamptz := now();

  -- Tarjeta A: escenarios de bloqueo + reconciliación parcial completa
  v_card_id uuid := gen_random_uuid();
  v_line_1 uuid := gen_random_uuid();
  v_line_2 uuid := gen_random_uuid();
  v_nv_id_v1 int := 999888771;
  v_nv_id_v2 int := 999888772;
  v_folio_a int := 999001;
  v_token_a text := 'qa-bloque1-token-a-' || replace(gen_random_uuid()::text, '-', '');

  -- Tarjeta B: pedido completamente válido sin incidencias
  v_card_clean_id uuid := gen_random_uuid();
  v_line_clean_1 uuid := gen_random_uuid();
  v_nv_id_clean int := 999888773;
  v_folio_b int := 999002;
  v_token_b text := 'qa-bloque1-token-b-' || replace(gen_random_uuid()::text, '-', '');

  -- Tarjeta C: fail-closed (sin identidad canónica / sin documento o detalles en espejo Bsale)
  v_card_fc_id uuid := gen_random_uuid();
  v_line_fc_1 uuid := gen_random_uuid();
  v_nv_id_fc int := 999888774;
  v_folio_c int := 999003;
  v_token_c text := 'qa-bloque1-token-c-' || replace(gen_random_uuid()::text, '-', '');

  -- Tarjeta D: recreación en Bsale con nuevo ID físico y contenido comercial idéntico
  v_card_rec_id uuid := gen_random_uuid();
  v_line_rec_1 uuid := gen_random_uuid();
  v_nv_id_rec_v1 int := 999888775;
  v_nv_id_rec_v2 int := 999888776;
  v_folio_d int := 999004;
  v_token_d text := 'qa-bloque1-token-d-' || replace(gen_random_uuid()::text, '-', '');

  -- Tarjeta E: recreación en Bsale con nuevo ID físico y mismas cantidades pero distinto precio/total
  v_card_rec_diff_id uuid := gen_random_uuid();
  v_line_rec_diff_1 uuid := gen_random_uuid();
  v_nv_id_recd_v1 int := 999888777;
  v_nv_id_recd_v2 int := 999888778;
  v_folio_e int := 999005;
  v_token_e text := 'qa-bloque1-token-e-' || replace(gen_random_uuid()::text, '-', '');

  v_err text;
  v_res jsonb;
BEGIN
  SELECT id INTO v_company_id FROM core.companies LIMIT 1;
  SELECT id INTO v_user_id FROM portal.users LIMIT 1;

  IF v_company_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'QA requiere al menos una empresa y un usuario existentes para referenciar FKs.';
  END IF;

  -- ==========================================================================
  -- Fixtures Bsale v1 para Tarjeta A (document_type_id = 23, state = 0)
  -- ==========================================================================
  INSERT INTO integraciones.bsale_documents (
    company_id, bsale_id, number, emission_date, generation_date,
    net_amount, tax_amount, total_amount, exempt_amount,
    document_type_id, state, raw_json
  ) VALUES (
    v_company_id, v_nv_id_v1, v_folio_a, CURRENT_DATE, v_now - interval '10 minutes',
    15000, 2850, 17850, 0,
    23, 0, jsonb_build_object('token', v_token_a)
  );

  INSERT INTO integraciones.bsale_document_details (
    company_id, bsale_id, bsale_document_id, line_number,
    quantity, net_unit_value, total_unit_value, net_amount, tax_amount, total_amount,
    variant_id, variant_code, variant_description
  ) VALUES
  (v_company_id, 991001, v_nv_id_v1, 1, 10, 1000, 1190, 10000, 1900, 11900, 881001, 'QA-SKU-1', 'Producto QA 1'),
  (v_company_id, 991002, v_nv_id_v1, 2,  5, 1000, 1190,  5000,  950,  5950, 881002, 'QA-SKU-2', 'Producto QA 2');

  -- Tarjeta A en IN_PREPARATION con lock asignado a v_user_id
  INSERT INTO logistica.sales_order_preparation_cards (
    id, company_id, bsale_nv_id, current_bsale_nv_id, bsale_nv_folio,
    canonical_bsale_token, status, assigned_user_id, locked_by_user_id, locked_at
  ) VALUES (
    v_card_id, v_company_id, v_nv_id_v1, v_nv_id_v1, v_folio_a::text,
    v_token_a, 'IN_PREPARATION', v_user_id, v_user_id, v_now
  );

  -- Líneas iniciales: línea 1 CONFIRMED (con confirmed_by/confirmed_at), línea 2 PENDING (NULLs)
  INSERT INTO logistica.sales_order_preparation_lines (
    id, company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id,
    sku, product_name, requested_quantity, prepared_quantity, line_status,
    excluded_from_dispatch, confirmed_by, confirmed_at
  ) VALUES
  (v_line_1, v_company_id, v_card_id, v_nv_id_v1, 991001, 881001, 'QA-SKU-1', 'Producto QA 1', 10, 10, 'CONFIRMED', false, v_user_id, v_now),
  (v_line_2, v_company_id, v_card_id, v_nv_id_v1, 991002, 881002, 'QA-SKU-2', 'Producto QA 2',  5, NULL, 'PENDING', false, NULL, NULL);

  -- ==========================================================================
  -- Caso 1: línea pendiente -> debe bloquear
  -- ==========================================================================
  BEGIN
    PERFORM logistica.move_sales_order_preparation_card(v_company_id, v_card_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
    RAISE EXCEPTION 'FAIL Caso 1: permitió avanzar con línea pendiente';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'Faltan % productos por confirmar.%' THEN
      RAISE EXCEPTION 'FAIL Caso 1: mensaje inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 1 (línea pendiente bloqueada): %', v_err;
  END;

  -- ==========================================================================
  -- Caso 2: faltante parcial -> debe bloquear
  -- ==========================================================================
  UPDATE logistica.sales_order_preparation_lines
     SET prepared_quantity = 3,
         line_status = 'INCIDENT',
         confirmed_by = v_user_id,
         confirmed_at = v_now
   WHERE id = v_line_2;

  BEGIN
    PERFORM logistica.move_sales_order_preparation_card(v_company_id, v_card_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
    RAISE EXCEPTION 'FAIL Caso 2: permitió avanzar con faltante parcial';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'Preparación con incidencias.%' THEN
      RAISE EXCEPTION 'FAIL Caso 2: mensaje inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 2 (faltante parcial bloqueado): %', v_err;
  END;

  -- ==========================================================================
  -- Caso 3: línea excluida (cantidad 0) -> debe bloquear
  -- ==========================================================================
  UPDATE logistica.sales_order_preparation_lines
     SET prepared_quantity = 0,
         line_status = 'INCIDENT',
         excluded_from_dispatch = true,
         confirmed_by = v_user_id,
         confirmed_at = v_now
   WHERE id = v_line_2;

  BEGIN
    PERFORM logistica.move_sales_order_preparation_card(v_company_id, v_card_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
    RAISE EXCEPTION 'FAIL Caso 3: permitió avanzar con línea excluida';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'Preparación con incidencias.%' THEN
      RAISE EXCEPTION 'FAIL Caso 3: mensaje inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 3 (línea excluida bloqueada): %', v_err;
  END;

  -- ==========================================================================
  -- Caso 4: líneas confirmadas pero incidencia OPEN -> debe bloquear
  -- ==========================================================================
  UPDATE logistica.sales_order_preparation_lines
     SET prepared_quantity = 5,
         line_status = 'CONFIRMED',
         excluded_from_dispatch = false,
         confirmed_by = v_user_id,
         confirmed_at = v_now
   WHERE id = v_line_2;

  INSERT INTO logistica.sales_order_preparation_incidents (
    company_id, card_id, preparation_line_id, bsale_nv_id, nv_folio, bsale_detail_id,
    bsale_variant_id, sku, product_name, incident_type, reason_code,
    requested_quantity, prepared_quantity, difference_quantity,
    required_bsale_action, expected_bsale_quantity, status, created_by
  ) VALUES (
    v_company_id, v_card_id, v_line_2, v_nv_id_v1, v_folio_a::text, 991002,
    881002, 'QA-SKU-2', 'Producto QA 2', 'QUANTITY_REDUCTION', 'STOCK_INSUFICIENTE',
    5, 3, -2, 'SET_QUANTITY', 3, 'OPEN', v_user_id
  );

  BEGIN
    PERFORM logistica.move_sales_order_preparation_card(v_company_id, v_card_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
    RAISE EXCEPTION 'FAIL Caso 4: permitió avanzar con incidencia OPEN';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'Preparación con incidencias.%' THEN
      RAISE EXCEPTION 'FAIL Caso 4: mensaje inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 4 (incidencia abierta bloqueada): %', v_err;
  END;

  -- ==========================================================================
  -- Caso 5: versión Bsale modificada (v2 en espejo canónico) sin aceptar -> debe bloquear
  -- ==========================================================================
  UPDATE logistica.sales_order_preparation_incidents
     SET status = 'RESOLVED',
         verification_status = 'MATCHED',
         last_verified_at = v_now
   WHERE card_id = v_card_id;

  INSERT INTO integraciones.bsale_documents (
    company_id, bsale_id, number, emission_date, generation_date,
    net_amount, tax_amount, total_amount, exempt_amount,
    document_type_id, state, raw_json
  ) VALUES (
    v_company_id, v_nv_id_v2, v_folio_a, CURRENT_DATE, v_now - interval '2 minutes',
    13000, 2470, 15470, 0,
    23, 0, jsonb_build_object('token', v_token_a)
  );

  INSERT INTO integraciones.bsale_document_details (
    company_id, bsale_id, bsale_document_id, line_number,
    quantity, net_unit_value, total_unit_value, net_amount, tax_amount, total_amount,
    variant_id, variant_code, variant_description
  ) VALUES
  (v_company_id, 992001, v_nv_id_v2, 1, 10, 1000, 1190, 10000, 1900, 11900, 881001, 'QA-SKU-1', 'Producto QA 1'),
  (v_company_id, 992002, v_nv_id_v2, 2,  3, 1000, 1190,  3000,  570,  3570, 881002, 'QA-SKU-2', 'Producto QA 2');

  UPDATE logistica.sales_order_preparation_cards
     SET current_bsale_nv_id = v_nv_id_v2
   WHERE id = v_card_id;

  BEGIN
    PERFORM logistica.move_sales_order_preparation_card(v_company_id, v_card_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
    RAISE EXCEPTION 'FAIL Caso 5: permitió avanzar con versión Bsale sin aceptar';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'La Nota de Venta fue modificada en Bsale%'
       AND v_err NOT LIKE 'Cambio comercial pendiente en Bsale%' THEN
      RAISE EXCEPTION 'FAIL Caso 5: mensaje inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 5 (versión Bsale sin aceptar bloqueada): %', v_err;
  END;

  -- ==========================================================================
  -- Caso 6: reconciliación parcial aceptada pero espejo Bsale difiere de lo preparado -> debe bloquear
  -- ==========================================================================
  UPDATE logistica.sales_order_preparation_lines
     SET requested_quantity = 3,
         prepared_quantity = 3,
         line_status = 'INCIDENT',
         excluded_from_dispatch = false,
         confirmed_by = v_user_id,
         confirmed_at = v_now
   WHERE id = v_line_2;

  -- Solicitud de aceptación previa (superseded por la versión aceptada posterior)
  INSERT INTO logistica.sales_order_preparation_commercial_acceptance_requests (
    company_id, card_id, expected_fingerprint, previous_fingerprint,
    verified_current_bsale_nv_id, version_snapshot, plan_snapshot,
    verified_at, requested_by, created_at
  ) VALUES (
    v_company_id, v_card_id, repeat('b', 64), NULL,
    v_nv_id_v2,
    jsonb_build_object(
      'identity', jsonb_build_object('canonicalToken', v_token_a),
      'physicalId', v_nv_id_v2,
      'lines', jsonb_build_array(
        jsonb_build_object('detailId', 992001, 'variantId', 881001, 'sku', 'QA-SKU-1', 'quantity', 10),
        jsonb_build_object('detailId', 992002, 'variantId', 881002, 'sku', 'QA-SKU-2', 'quantity', 3)
      )
    ),
    '{}'::jsonb,
    v_now - interval '2 minutes', v_user_id, v_now - interval '2 minutes'
  );

  -- Versión comercial v2 aceptada
  INSERT INTO logistica.sales_order_preparation_commercial_versions (
    company_id, card_id, sequence_no, canonical_bsale_token,
    historical_bsale_nv_id, current_bsale_nv_id, fingerprint,
    version_snapshot, applied_actions, accepted_by, accepted_at
  ) VALUES (
    v_company_id, v_card_id, 1, v_token_a,
    v_nv_id_v1, v_nv_id_v2, repeat('a', 64),
    jsonb_build_object(
      'identity', jsonb_build_object('canonicalToken', v_token_a),
      'physicalId', v_nv_id_v2,
      'lines', jsonb_build_array(
        jsonb_build_object('detailId', 992001, 'variantId', 881001, 'sku', 'QA-SKU-1', 'quantity', 10),
        jsonb_build_object('detailId', 992002, 'variantId', 881002, 'sku', 'QA-SKU-2', 'quantity', 3)
      )
    ),
    '[]'::jsonb, v_user_id, v_now - interval '1 minute'
  );

  -- Descalzar temporalmente el espejo Bsale (qty 4 en Bsale vs 3 preparado)
  UPDATE integraciones.bsale_document_details
     SET quantity = 4
   WHERE company_id = v_company_id
     AND bsale_id = 992002;

  BEGIN
    PERFORM logistica.move_sales_order_preparation_card(v_company_id, v_card_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
    RAISE EXCEPTION 'FAIL Caso 6: permitió avanzar con descalce contra espejo Bsale';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'Preparación con incidencias.%' THEN
      RAISE EXCEPTION 'FAIL Caso 6: mensaje inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 6 (descalce contra espejo Bsale bloqueado): %', v_err;
  END;

  -- ==========================================================================
  -- Caso 7: reconciliación parcial completa -> debe avanzar a IN_AUDIT sin bloqueo permanente
  -- ==========================================================================
  UPDATE integraciones.bsale_document_details
     SET quantity = 3
   WHERE company_id = v_company_id
     AND bsale_id = 992002;

  v_res := logistica.move_sales_order_preparation_card(v_company_id, v_card_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
  IF v_res->>'to_status' IS DISTINCT FROM 'IN_AUDIT' THEN
    RAISE EXCEPTION 'FAIL Caso 7: respuesta inesperada: %', v_res;
  END IF;
  RAISE NOTICE 'PASS Caso 7 (reconciliación parcial completa avanzó a IN_AUDIT): %', v_res;

  -- ==========================================================================
  -- Caso 8: pedido completamente válido sin incidencias -> debe avanzar a IN_AUDIT
  -- ==========================================================================
  INSERT INTO integraciones.bsale_documents (
    company_id, bsale_id, number, emission_date, generation_date,
    net_amount, tax_amount, total_amount, exempt_amount,
    document_type_id, state, raw_json
  ) VALUES (
    v_company_id, v_nv_id_clean, v_folio_b, CURRENT_DATE, v_now - interval '5 minutes',
    20000, 3800, 23800, 0,
    23, 0, jsonb_build_object('token', v_token_b)
  );

  INSERT INTO integraciones.bsale_document_details (
    company_id, bsale_id, bsale_document_id, line_number,
    quantity, net_unit_value, total_unit_value, net_amount, tax_amount, total_amount,
    variant_id, variant_code, variant_description
  ) VALUES (
    v_company_id, 993001, v_nv_id_clean, 1, 4, 5000, 5950, 20000, 3800, 23800, 883001, 'QA-SKU-CLEAN', 'Producto QA Limpio'
  );

  INSERT INTO logistica.sales_order_preparation_cards (
    id, company_id, bsale_nv_id, current_bsale_nv_id, bsale_nv_folio,
    canonical_bsale_token, status, assigned_user_id, locked_by_user_id, locked_at
  ) VALUES (
    v_card_clean_id, v_company_id, v_nv_id_clean, v_nv_id_clean, v_folio_b::text,
    v_token_b, 'IN_PREPARATION', v_user_id, v_user_id, v_now
  );

  INSERT INTO logistica.sales_order_preparation_lines (
    id, company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id,
    sku, product_name, requested_quantity, prepared_quantity, line_status,
    excluded_from_dispatch, confirmed_by, confirmed_at
  ) VALUES (
    v_line_clean_1, v_company_id, v_card_clean_id, v_nv_id_clean, 993001, 883001,
    'QA-SKU-CLEAN', 'Producto QA Limpio', 4, 4, 'CONFIRMED', false, v_user_id, v_now
  );

  v_res := logistica.move_sales_order_preparation_card(v_company_id, v_card_clean_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
  IF v_res->>'to_status' IS DISTINCT FROM 'IN_AUDIT' THEN
    RAISE EXCEPTION 'FAIL Caso 8: respuesta inesperada: %', v_res;
  END IF;
  RAISE NOTICE 'PASS Caso 8 (pedido válido sin incidencias avanzó a IN_AUDIT): %', v_res;

  -- ==========================================================================
  -- Caso 9: fail-closed cuando falta identidad canónica / documento vigente en espejo Bsale
  -- ==========================================================================
  INSERT INTO logistica.sales_order_preparation_cards (
    id, company_id, bsale_nv_id, current_bsale_nv_id, bsale_nv_folio,
    canonical_bsale_token, status, assigned_user_id, locked_by_user_id, locked_at
  ) VALUES (
    v_card_fc_id, v_company_id, v_nv_id_fc, v_nv_id_fc, v_folio_c::text,
    v_token_c, 'IN_PREPARATION', v_user_id, v_user_id, v_now
  );

  INSERT INTO logistica.sales_order_preparation_lines (
    id, company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id,
    sku, product_name, requested_quantity, prepared_quantity, line_status,
    excluded_from_dispatch, confirmed_by, confirmed_at
  ) VALUES (
    v_line_fc_1, v_company_id, v_card_fc_id, v_nv_id_fc, 994001, 884001,
    'QA-SKU-FC', 'Producto QA FailClosed', 2, 2, 'CONFIRMED', false, v_user_id, v_now
  );

  -- 9a) Sin canonical_bsale_token en tarjeta -> debe bloquear fail-closed
  INSERT INTO integraciones.bsale_document_details (
    company_id, bsale_id, bsale_document_id, line_number,
    quantity, net_unit_value, total_unit_value, net_amount, tax_amount, total_amount,
    variant_id, variant_code, variant_description
  ) VALUES (
    v_company_id, 994001, v_nv_id_fc, 1, 2, 1000, 1190, 2000, 380, 2380, 884001, 'QA-SKU-FC', 'Producto QA FailClosed'
  );

  UPDATE logistica.sales_order_preparation_cards
     SET canonical_bsale_token = NULL
   WHERE id = v_card_fc_id;

  BEGIN
    PERFORM logistica.move_sales_order_preparation_card(v_company_id, v_card_fc_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
    RAISE EXCEPTION 'FAIL Caso 9a: permitió avanzar sin canonical_bsale_token';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'No se pudo verificar la identidad canónica vigente%' THEN
      RAISE EXCEPTION 'FAIL Caso 9a: mensaje inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 9a (fail-closed sin canonical_bsale_token en tarjeta): %', v_err;
  END;

  DELETE FROM integraciones.bsale_document_details
   WHERE company_id = v_company_id AND bsale_id = 994001;

  UPDATE logistica.sales_order_preparation_cards
     SET canonical_bsale_token = v_token_c
   WHERE id = v_card_fc_id;

  -- Versión comercial aceptada para aislar específicamente el guard fail-closed del espejo Bsale
  INSERT INTO logistica.sales_order_preparation_commercial_versions (
    company_id, card_id, sequence_no, canonical_bsale_token,
    historical_bsale_nv_id, current_bsale_nv_id, fingerprint,
    version_snapshot, applied_actions, accepted_by, accepted_at
  ) VALUES (
    v_company_id, v_card_fc_id, 1, v_token_c,
    v_nv_id_fc, v_nv_id_fc, repeat('c', 64),
    jsonb_build_object(
      'identity', jsonb_build_object('canonicalToken', v_token_c),
      'physicalId', v_nv_id_fc,
      'lines', jsonb_build_array(
        jsonb_build_object('detailId', 994001, 'variantId', 884001, 'sku', 'QA-SKU-FC', 'quantity', 2)
      )
    ),
    '[]'::jsonb, v_user_id, v_now - interval '1 minute'
  );

  -- 9b) Con token pero sin documento en integraciones.bsale_documents -> debe bloquear fail-closed
  BEGIN
    PERFORM logistica.move_sales_order_preparation_card(v_company_id, v_card_fc_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
    RAISE EXCEPTION 'FAIL Caso 9b: permitió avanzar sin identidad canónica/documento en espejo Bsale';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'No se encontró la identidad canónica vigente%' THEN
      RAISE EXCEPTION 'FAIL Caso 9b: mensaje inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 9b (fail-closed sin documento vigente en espejo Bsale): %', v_err;
  END;

  -- ==========================================================================
  -- Caso 10: fail-closed cuando el documento vigente en espejo Bsale no tiene detalles
  -- ==========================================================================
  INSERT INTO integraciones.bsale_documents (
    company_id, bsale_id, number, emission_date, generation_date,
    net_amount, tax_amount, total_amount, exempt_amount,
    document_type_id, state, raw_json
  ) VALUES (
    v_company_id, v_nv_id_fc, v_folio_c, CURRENT_DATE, v_now - interval '5 minutes',
    2000, 380, 2380, 0,
    23, 0, jsonb_build_object('token', v_token_c)
  );

  BEGIN
    PERFORM logistica.move_sales_order_preparation_card(v_company_id, v_card_fc_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
    RAISE EXCEPTION 'FAIL Caso 10: permitió avanzar sin detalles verificables en espejo Bsale';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'La Nota de Venta vigente en Bsale no tiene detalles verificables.%' THEN
      RAISE EXCEPTION 'FAIL Caso 10: mensaje inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 10 (fail-closed sin detalles en espejo Bsale): %', v_err;
  END;

  -- ==========================================================================
  -- Caso 11: recreación de NV en Bsale con nuevo ID físico pero contenido comercial idéntico -> debe avanzar
  -- ==========================================================================
  INSERT INTO integraciones.bsale_documents (
    company_id, bsale_id, number, emission_date, generation_date,
    net_amount, tax_amount, total_amount, exempt_amount,
    document_type_id, client_id, office_id, state, raw_json
  ) VALUES
  (
    v_company_id, v_nv_id_rec_v1, v_folio_d, CURRENT_DATE, v_now - interval '15 minutes',
    10000, 1900, 11900, 0,
    23, 501, 1, 1, jsonb_build_object('token', v_token_d)
  ),
  (
    v_company_id, v_nv_id_rec_v2, v_folio_d, CURRENT_DATE, v_now - interval '2 minutes',
    10000, 1900, 11900, 0,
    23, 501, 1, 0, jsonb_build_object('token', v_token_d)
  );

  INSERT INTO integraciones.bsale_document_details (
    company_id, bsale_id, bsale_document_id, line_number,
    quantity, net_unit_value, total_unit_value, net_amount, tax_amount, total_amount, net_discount,
    variant_id, variant_code, variant_description
  ) VALUES
  (v_company_id, 995001, v_nv_id_rec_v1, 1, 5, 2000, 2380, 10000, 1900, 11900, 0, 885001, 'QA-SKU-REC', 'Producto QA Recreado'),
  (v_company_id, 995002, v_nv_id_rec_v2, 1, 5, 2000, 2380, 10000, 1900, 11900, 0, 885001, 'QA-SKU-REC', 'Producto QA Recreado');

  INSERT INTO logistica.sales_order_preparation_cards (
    id, company_id, bsale_nv_id, current_bsale_nv_id, bsale_nv_folio,
    canonical_bsale_token, status, assigned_user_id, locked_by_user_id, locked_at
  ) VALUES (
    v_card_rec_id, v_company_id, v_nv_id_rec_v1, v_nv_id_rec_v2, v_folio_d::text,
    v_token_d, 'IN_PREPARATION', v_user_id, v_user_id, v_now
  );

  INSERT INTO logistica.sales_order_preparation_lines (
    id, company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id,
    sku, product_name, requested_quantity, prepared_quantity, line_status,
    excluded_from_dispatch, confirmed_by, confirmed_at
  ) VALUES (
    v_line_rec_1, v_company_id, v_card_rec_id, v_nv_id_rec_v1, 995001, 885001,
    'QA-SKU-REC', 'Producto QA Recreado', 5, 5, 'CONFIRMED', false, v_user_id, v_now
  );

  v_res := logistica.move_sales_order_preparation_card(v_company_id, v_card_rec_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
  IF v_res->>'to_status' IS DISTINCT FROM 'IN_AUDIT' THEN
    RAISE EXCEPTION 'FAIL Caso 11: respuesta inesperada en recreación comercialmente idéntica: %', v_res;
  END IF;
  RAISE NOTICE 'PASS Caso 11 (recreación Bsale con nuevo ID físico y contenido comercial idéntico avanzó a IN_AUDIT): %', v_res;

  -- ==========================================================================
  -- Caso 12: recreación de NV en Bsale con nuevo ID físico, mismas cantidades pero distinto precio/total -> debe bloquear
  -- ==========================================================================
  INSERT INTO integraciones.bsale_documents (
    company_id, bsale_id, number, emission_date, generation_date,
    net_amount, tax_amount, total_amount, exempt_amount,
    document_type_id, client_id, office_id, state, raw_json
  ) VALUES
  (
    v_company_id, v_nv_id_recd_v1, v_folio_e, CURRENT_DATE, v_now - interval '15 minutes',
    10000, 1900, 11900, 0,
    23, 502, 1, 1, jsonb_build_object('token', v_token_e)
  ),
  (
    v_company_id, v_nv_id_recd_v2, v_folio_e, CURRENT_DATE, v_now - interval '2 minutes',
    12500, 2375, 14875, 0,
    23, 502, 1, 0, jsonb_build_object('token', v_token_e)
  );

  INSERT INTO integraciones.bsale_document_details (
    company_id, bsale_id, bsale_document_id, line_number,
    quantity, net_unit_value, total_unit_value, net_amount, tax_amount, total_amount, net_discount,
    variant_id, variant_code, variant_description
  ) VALUES
  (v_company_id, 996001, v_nv_id_recd_v1, 1, 5, 2000, 2380, 10000, 1900, 11900, 0, 886001, 'QA-SKU-RECD', 'Producto QA Cambio Precio'),
  (v_company_id, 996002, v_nv_id_recd_v2, 1, 5, 2500, 2975, 12500, 2375, 14875, 0, 886001, 'QA-SKU-RECD', 'Producto QA Cambio Precio');

  INSERT INTO logistica.sales_order_preparation_cards (
    id, company_id, bsale_nv_id, current_bsale_nv_id, bsale_nv_folio,
    canonical_bsale_token, status, assigned_user_id, locked_by_user_id, locked_at
  ) VALUES (
    v_card_rec_diff_id, v_company_id, v_nv_id_recd_v1, v_nv_id_recd_v1, v_folio_e::text,
    v_token_e, 'IN_PREPARATION', v_user_id, v_user_id, v_now
  );

  INSERT INTO logistica.sales_order_preparation_lines (
    id, company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id,
    sku, product_name, requested_quantity, prepared_quantity, line_status,
    excluded_from_dispatch, confirmed_by, confirmed_at
  ) VALUES (
    v_line_rec_diff_1, v_company_id, v_card_rec_diff_id, v_nv_id_recd_v1, 996001, 886001,
    'QA-SKU-RECD', 'Producto QA Cambio Precio', 5, 5, 'CONFIRMED', false, v_user_id, v_now
  );

  BEGIN
    PERFORM logistica.move_sales_order_preparation_card(v_company_id, v_card_rec_diff_id, 'IN_AUDIT', NULL, v_user_id, 'QA User');
    RAISE EXCEPTION 'FAIL Caso 12: permitió avanzar con cambio comercial (precio/total) en recreación Bsale';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'La Nota de Venta fue modificada en Bsale%'
       AND v_err NOT LIKE 'Cambio comercial pendiente en Bsale%' THEN
      RAISE EXCEPTION 'FAIL Caso 12: mensaje inesperado: %', v_err;
    END IF;
    RAISE NOTICE 'PASS Caso 12 (recreación Bsale con cambio comercial de precio/total bloqueada): %', v_err;
  END;
END;
$$;

ROLLBACK;
