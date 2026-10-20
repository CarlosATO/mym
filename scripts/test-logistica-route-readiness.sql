-- Prueba transaccional de incidencias comerciales y readiness.
-- Requiere la migración 20261020190000 aplicada.
BEGIN;

DO $test$
DECLARE
  v_company uuid := 'd1000000-0000-0000-0000-000000000001';
  v_other_company uuid := 'd3000000-0000-0000-0000-000000000003';
  v_user uuid := 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa';
  v_card1 uuid := gen_random_uuid();
  v_card2 uuid := gen_random_uuid();
  v_card3 uuid := gen_random_uuid();
  v_card4 uuid := gen_random_uuid();
  v_card5 uuid := gen_random_uuid();
  v_line1 uuid := gen_random_uuid();
  v_line2 uuid := gen_random_uuid();
  v_line3 uuid := gen_random_uuid();
  v_line4 uuid := gen_random_uuid();
  v_line5 uuid := gen_random_uuid();
  v_inc1 uuid := gen_random_uuid();
  v_inc2 uuid := gen_random_uuid();
  v_inc3 uuid := gen_random_uuid();
  v_inc4 uuid := gen_random_uuid();
  v_inc5 uuid := gen_random_uuid();
  v_result jsonb;
  v_count integer;
  v_status text;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  INSERT INTO logistica.sales_order_preparation_cards (id, company_id, bsale_nv_id, bsale_nv_folio, status)
  VALUES
    (v_card1, v_company, 990101, 'F990101', 'AUDITED'),
    (v_card2, v_company, 990102, 'F990102', 'AUDITED'),
    (v_card3, v_company, 990103, 'F990103', 'AUDITED'),
    (v_card4, v_company, 990104, 'F990104', 'IN_AUDIT'),
    (v_card5, v_company, 990105, 'F990105', 'AUDITED');

  INSERT INTO logistica.sales_order_preparation_lines (
    id, company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id, sku, product_name,
    requested_quantity, prepared_quantity, line_status, confirmed_by, confirmed_at
  ) VALUES
    (v_line1, v_company, v_card1, 990101, 880101, 70001, 'A', 'PRODUCTO A', 2, 1, 'INCIDENT', v_user, now()),
    (v_line2, v_company, v_card1, 990101, 880102, 70002, 'B', 'PRODUCTO B', 1, 0, 'INCIDENT', v_user, now()),
    (v_line3, v_company, v_card2, 990102, 880103, 70003, 'C', 'PRODUCTO C', 2, 1, 'INCIDENT', v_user, now()),
    (v_line4, v_company, v_card3, 990103, 880104, 70004, 'D', 'PRODUCTO D', 1, 1, 'INCIDENT', v_user, now()),
    (v_line5, v_company, v_card5, 990105, 880105, 70005, 'E', 'PRODUCTO E', 1, 0, 'INCIDENT', v_user, now());

  INSERT INTO logistica.sales_order_preparation_incidents (
    id, company_id, card_id, preparation_line_id, bsale_nv_id, nv_folio, bsale_detail_id,
    bsale_variant_id, sku, product_name, incident_type, reason_code, requested_quantity,
    prepared_quantity, difference_quantity, required_bsale_action, expected_bsale_quantity,
    status, created_by
  ) VALUES
    (v_inc1, v_company, v_card1, v_line1, 990101, 'F990101', 880101, 70001, 'A', 'PRODUCTO A', 'QUANTITY_REDUCTION', 'SIN_STOCK', 2, 1, -1, 'SET_QUANTITY', 1, 'OPEN', v_user),
    (v_inc2, v_company, v_card1, v_line2, 990101, 'F990101', 880102, 70002, 'B', 'PRODUCTO B', 'LINE_EXCLUDED', 'SIN_STOCK', 1, 0, -1, 'REMOVE_LINE', 0, 'OPEN', v_user),
    (v_inc3, v_company, v_card2, v_line3, 990102, 'F990102', 880103, 70003, 'C', 'PRODUCTO C', 'QUANTITY_REDUCTION', 'STOCK_INSUFICIENTE', 2, 1, -1, 'SET_QUANTITY', 1, 'OPEN', v_user),
    (v_inc4, v_company, v_card3, v_line4, 990103, 'F990103', 880104, 70004, 'D', 'PRODUCTO D', 'QUANTITY_REDUCTION', 'ERROR_PEDIDO', 1, 1, 0, 'SET_QUANTITY', 1, 'RESOLVED', v_user),
    (v_inc5, v_company, v_card5, v_line5, 990105, 'F990105', 880105, 70005, 'E', 'PRODUCTO E', 'LINE_EXCLUDED', 'SIN_STOCK', 1, 0, -1, 'REMOVE_LINE', 0, 'OPEN', v_user);

  UPDATE logistica.sales_order_preparation_incidents
     SET verification_status = 'MATCHED', last_verified_at = now(), bsale_observed_quantity = 1
   WHERE id = v_inc4;

  INSERT INTO logistica.sales_order_preparation_incidents (
    company_id, card_id, preparation_line_id, bsale_nv_id, nv_folio, bsale_detail_id,
    bsale_variant_id, sku, product_name, incident_type, reason_code, requested_quantity,
    prepared_quantity, difference_quantity, required_bsale_action, expected_bsale_quantity,
    status, created_by
  ) VALUES (
    v_company, v_card2, v_line3, 990102, 'F990102', 880103, 70003, 'C', 'PRODUCTO C',
    'QUANTITY_REDUCTION', 'OTRO', 2, 1, -1, 'SET_QUANTITY', 1, 'SUPERSEDED', v_user
  );

  INSERT INTO integraciones.bsale_documents (company_id, bsale_id, number, emission_date, document_type_id, state)
  VALUES
    (v_company, 990101, 980101, '2026-10-01', 23, 0),
    (v_company, 990102, 980102, '2026-10-01', 23, 0),
    (v_company, 990103, 980103, '2026-10-01', 23, 0),
    (v_company, 990104, 980104, '2026-10-01', 23, 0),
    (v_company, 990105, 980105, '2026-10-01', 23, 1);

  INSERT INTO integraciones.bsale_document_details (
    company_id, bsale_id, bsale_document_id, variant_id, variant_code, variant_description, quantity, net_amount
  ) VALUES
    (v_company, 880101, 990101, 70001, 'A', 'PRODUCTO A', 2, 200),
    (v_company, 880102, 990101, 70002, 'B', 'PRODUCTO B', 1, 100),
    (v_company, 880103, 990102, 70003, 'C', 'PRODUCTO C', 2, 200),
    (v_company, 880104, 990103, 70004, 'D', 'PRODUCTO D', 1, 100);

  -- A/B/E: readiness inicial.
  SELECT route_readiness, open_commercial_incident_count INTO v_status, v_count
  FROM logistica.vw_sales_order_route_readiness WHERE card_id = v_card1;
  IF v_status <> 'INCIDENTS' OR v_count <> 2 THEN
    RAISE EXCEPTION 'FIXTURE_FAIL A expected INCIDENTS/2 got %/%', v_status, v_count;
  END IF;

  SELECT route_readiness, open_commercial_incident_count INTO v_status, v_count
  FROM logistica.vw_sales_order_route_readiness WHERE card_id = v_card2;
  IF v_status <> 'INCIDENTS' OR v_count <> 1 THEN
    RAISE EXCEPTION 'FIXTURE_FAIL B expected INCIDENTS/1 got %/%', v_status, v_count;
  END IF;

  SELECT route_readiness INTO v_status FROM logistica.vw_sales_order_route_readiness WHERE card_id = v_card3;
  IF v_status <> 'READY_TO_INVOICE' THEN
    RAISE EXCEPTION 'FIXTURE_FAIL C expected READY_TO_INVOICE got %', v_status;
  END IF;

  IF EXISTS (SELECT 1 FROM logistica.vw_sales_order_route_readiness WHERE card_id = v_card4) THEN
    RAISE EXCEPTION 'FIXTURE_FAIL D IN_AUDIT must not appear';
  END IF;

  SELECT route_readiness INTO v_status FROM logistica.vw_sales_order_route_readiness WHERE card_id = v_card5;
  IF v_status <> 'BLOCKED' THEN
    RAISE EXCEPTION 'FIXTURE_FAIL E cancelled NV expected BLOCKED got %', v_status;
  END IF;

  -- SET_QUANTITY mismatch + REMOVE_LINE pendiente + NV cancelada.
  v_result := logistica.verify_open_preparation_incidents_v1(v_company, ARRAY[990101,990102,990105]::bigint[]);
  IF (v_result->>'resolved')::integer <> 0 THEN
    RAISE EXCEPTION 'FIXTURE_FAIL verification unexpectedly resolved items: %', v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM logistica.sales_order_preparation_incidents WHERE id = v_inc1 AND status = 'OPEN' AND verification_status = 'MISMATCHED') THEN
    RAISE EXCEPTION 'FIXTURE_FAIL SET_QUANTITY mismatch did not stay OPEN/MISMATCHED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM logistica.sales_order_preparation_incidents WHERE id = v_inc2 AND status = 'OPEN' AND verification_status = 'MISMATCHED') THEN
    RAISE EXCEPTION 'FIXTURE_FAIL REMOVE_LINE pending did not stay OPEN/MISMATCHED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM logistica.sales_order_preparation_incidents WHERE id = v_inc5 AND status = 'OPEN' AND verification_status = 'NV_CANCELLED') THEN
    RAISE EXCEPTION 'FIXTURE_FAIL cancelled NV must stay OPEN/NV_CANCELLED';
  END IF;

  -- SET_QUANTITY matched.
  UPDATE integraciones.bsale_document_details SET quantity = 1 WHERE company_id = v_company AND bsale_id = 880101;
  v_result := logistica.verify_open_preparation_incidents_v1(v_company, ARRAY[990101]::bigint[]);
  IF (v_result->>'resolved')::integer <> 1 THEN
    RAISE EXCEPTION 'FIXTURE_FAIL SET_QUANTITY matched expected 1 resolved: %', v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM logistica.sales_order_preparation_incidents WHERE id = v_inc1 AND status = 'RESOLVED' AND verification_status = 'MATCHED') THEN
    RAISE EXCEPTION 'FIXTURE_FAIL SET_QUANTITY did not resolve';
  END IF;

  -- REMOVE_LINE resolved por cantidad 0.
  UPDATE integraciones.bsale_document_details SET quantity = 0 WHERE company_id = v_company AND bsale_id = 880102;
  v_result := logistica.verify_open_preparation_incidents_v1(v_company, ARRAY[990101]::bigint[]);
  IF (v_result->>'resolved')::integer <> 1 THEN
    RAISE EXCEPTION 'FIXTURE_FAIL REMOVE_LINE expected 1 resolved: %', v_result;
  END IF;

  -- Idempotencia: segunda ejecución no resuelve ni duplica.
  v_result := logistica.verify_open_preparation_incidents_v1(v_company, ARRAY[990101]::bigint[]);
  IF (v_result->>'verified')::integer <> 0 THEN
    RAISE EXCEPTION 'FIXTURE_FAIL idempotency expected 0 verified: %', v_result;
  END IF;
  IF (SELECT count(*) FROM logistica.sales_order_preparation_incidents WHERE company_id = v_company AND bsale_nv_id IN (990101,990102)) <> 4 THEN
    RAISE EXCEPTION 'FIXTURE_FAIL idempotency duplicated incidents';
  END IF;

  -- Readiness final y aislamiento de empresa.
  SELECT route_readiness, open_commercial_incident_count INTO v_status, v_count
  FROM logistica.vw_sales_order_route_readiness WHERE card_id = v_card1;
  IF v_status <> 'READY_TO_INVOICE' OR v_count <> 0 THEN
    RAISE EXCEPTION 'FIXTURE_FAIL final readiness expected READY/0 got %/%', v_status, v_count;
  END IF;
  IF EXISTS (SELECT 1 FROM logistica.vw_sales_order_route_readiness WHERE company_id = v_other_company) THEN
    RAISE EXCEPTION 'FIXTURE_FAIL company isolation';
  END IF;
  IF EXISTS (SELECT 1 FROM logistica.sales_order_preparation_incidents WHERE id = v_inc4 AND status <> 'RESOLVED') THEN
    RAISE EXCEPTION 'FIXTURE_FAIL SUPERSEDED/RESOLVED baseline altered';
  END IF;

  RAISE NOTICE 'ROUTE_READINESS_FIXTURE_OK';
END;
$test$;

ROLLBACK;
