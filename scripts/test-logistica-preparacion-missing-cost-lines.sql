-- Prueba transaccional A-I para:
-- logistica.get_sales_order_preparation_missing_cost_lines_v1
--
-- Requiere que la migración 20261020180000 esté aplicada.
-- Ejecutar y luego ROLLBACK. No deja datos ni cambios.
BEGIN;

DO $block$
DECLARE
  v_company uuid := 'd1000000-0000-0000-0000-000000000001';
  v_rows jsonb;
  v_count integer;
  v_nv_ids bigint[];
  v_permission_rejected boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  INSERT INTO integraciones.bsale_variants (company_id, bsale_id, bsale_product_id, code, description)
  VALUES
    (v_company, 88001, 88001, 'FIX-V1', 'FIXTURE PRODUCT 1'),
    (v_company, 88002, 88002, 'FIX-V2', 'FIXTURE PRODUCT 2'),
    (v_company, 88003, 88003, 'FIX-V3', 'FIXTURE PRODUCT 3'),
    (v_company, 88004, 88004, 'FIX-V4', 'FIXTURE PRODUCT 4'),
    (v_company, 88005, 88005, 'FIX-V5', 'FIXTURE PRODUCT 5'),
    (v_company, 88006, 88006, 'FIX-V6', 'FIXTURE PRODUCT 6');

  INSERT INTO integraciones.bsale_documents (company_id, bsale_id, number, emission_date, document_type_id, state)
  VALUES
    (v_company, 990001, 980001, '2026-06-01', 23, 0),
    (v_company, 990002, 980002, '2026-06-01', 23, 0),
    (v_company, 990003, 980003, '2026-06-01', 23, 0),
    (v_company, 990004, 980004, '2026-06-01', 23, 0),
    (v_company, 990005, 980005, '2026-06-01', 23, 0),
    (v_company, 990006, 980006, '2026-06-01', 23, 0),
    (v_company, 990007, 980007, '2026-06-01', 23, 0);

  INSERT INTO integraciones.bsale_document_details (company_id, bsale_id, bsale_document_id, variant_id, variant_code, variant_description, quantity, net_amount)
  VALUES
    (v_company, 970001, 990001, 88001, 'FIX-V1', 'FIXTURE PRODUCT 1', 1, 1000),
    (v_company, 970002, 990002, 88002, 'FIX-V2', 'FIXTURE PRODUCT 2', 1, 2000),
    (v_company, 970003, 990003, 88003, 'FIX-V3', 'FIXTURE PRODUCT 3', 1, 3000),
    (v_company, 970004, 990004, 88004, 'FIX-V4', 'FIXTURE PRODUCT 4', 1, 4000),
    (v_company, 970005, 990005, 88005, 'FIX-V5', 'FIXTURE PRODUCT 5', 1, 5000),
    (v_company, 970006, 990006, 88006, 'FIX-V6', 'FIXTURE PRODUCT 6', 1, 6000),
    (v_company, 970007, 990007, 5729, 'FIX-V5729', 'FIXTURE SPECIAL 5729', 1, 7000);

  INSERT INTO integraciones.bsale_receptions (company_id, bsale_id, admission_date, document, raw_json)
  VALUES
    (v_company, 960001, '2026-01-01', 'FACTURA COMPRA 1', '{"cancellationStatus":0}'::jsonb),
    (v_company, 960003, '2026-12-01', 'FACTURA COMPRA 3', '{"cancellationStatus":0}'::jsonb),
    (v_company, 960004, '2026-01-01', 'FACTURA COMPRA 4', '{"cancellationStatus":1}'::jsonb),
    (v_company, 960005, '2026-01-01', 'NOTA DE CREDITO 5', '{"cancellationStatus":0}'::jsonb),
    (v_company, 960006, '2026-01-01', 'FACTURA COMPRA 6 CANCELADA', '{"cancellationStatus":1}'::jsonb),
    (v_company, 960007, '2026-02-01', 'FACTURA COMPRA 6 VALIDA', '{"cancellationStatus":0}'::jsonb);

  INSERT INTO integraciones.bsale_reception_details (company_id, bsale_id, bsale_reception_id, variant_id, cost)
  VALUES
    (v_company, 950001, 960001, 88001, 100),
    (v_company, 950003, 960003, 88003, 100),
    (v_company, 950004, 960004, 88004, 100),
    (v_company, 950005, 960005, 88005, 100),
    (v_company, 950006, 960006, 88006, 100),
    (v_company, 950007, 960007, 88006, 100);

  v_nv_ids := ARRAY[990001,990002,990003,990004,990005,990006,990007]::bigint[];
  SELECT jsonb_agg(to_jsonb(x)), count(*) INTO v_rows, v_count
  FROM logistica.get_sales_order_preparation_missing_cost_lines_v1(v_company, v_nv_ids) x;

  IF v_count <> 4 THEN
    RAISE EXCEPTION 'FIXTURE_FAIL expected 4 missing lines, got %', v_count;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e WHERE (e->>'bsale_nv_id')::bigint IN (990001,990006,990007)) THEN
    RAISE EXCEPTION 'FIXTURE_FAIL costed NV leaked into missing lines';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e WHERE (e->>'bsale_nv_id')::bigint = 990002) THEN
    RAISE EXCEPTION 'FIXTURE_FAIL B missing line not returned';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e WHERE (e->>'bsale_nv_id')::bigint = 990003) THEN
    RAISE EXCEPTION 'FIXTURE_FAIL C future cost not rejected';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e WHERE (e->>'bsale_nv_id')::bigint = 990004) THEN
    RAISE EXCEPTION 'FIXTURE_FAIL D cancelled reception not rejected';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e WHERE (e->>'bsale_nv_id')::bigint = 990005) THEN
    RAISE EXCEPTION 'FIXTURE_FAIL E credit note not rejected';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM * FROM logistica.get_sales_order_preparation_missing_cost_lines_v1(v_company, ARRAY[990001]::bigint[]);
  EXCEPTION WHEN OTHERS THEN
    v_permission_rejected := true;
  END;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  IF NOT v_permission_rejected THEN
    RAISE EXCEPTION 'FIXTURE_FAIL permission guard did not reject';
  END IF;

  RAISE NOTICE 'FIXTURE_OK count=% permission_rejected=%', v_count, v_permission_rejected;
END;
$block$;

ROLLBACK;
