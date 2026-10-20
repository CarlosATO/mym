-- Prueba DB transaccional del invariante:
--   prepared_quantity = 0 => LINE_EXCLUDED / REMOVE_LINE / excluded_from_dispatch = true
-- aunque el caller envíe p_excluded = false.
--
-- Ejecutar con:
--   supabase db query --linked --file scripts/test-logistica-preparacion-zero-exclusion-db.sql
--
-- Todo ocurre dentro de BEGIN/ROLLBACK. No toca NVs productivas.

BEGIN;

SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (SELECT user_id FROM core.user_company_access WHERE is_active ORDER BY user_id LIMIT 1),
    'role', 'authenticated'
  )::text,
  true
);

DO $$
DECLARE
  v_company uuid;
  v_line uuid;
  v_result logistica.sales_order_preparation_lines%ROWTYPE;
  v_incident logistica.sales_order_preparation_incidents%ROWTYPE;
  v_open_count integer;
  v_card constant uuid := '11111111-1111-4111-8111-111111111111';
  v_nv constant bigint := -910020013;
BEGIN
  SELECT company_id INTO v_company
  FROM core.user_company_access
  WHERE is_active = true
  ORDER BY user_id
  LIMIT 1;

  IF v_company IS NULL THEN
    RAISE EXCEPTION 'Fixture imposible: no hay user_company_access activo.';
  END IF;

  INSERT INTO logistica.sales_order_preparation_cards (
    id, company_id, bsale_nv_id, bsale_nv_folio, status
  ) VALUES (
    v_card, v_company, v_nv, 'QA-ZERO-INVARIANT', 'IN_PREPARATION'
  );

  -- Caso 1: caller envía prepared = 0 y excluded = false.
  INSERT INTO logistica.sales_order_preparation_lines (
    company_id, card_id, bsale_nv_id, bsale_detail_id, sku, product_name, requested_quantity
  ) VALUES (
    v_company, v_card, v_nv, -1, 'QA-ZERO', 'Producto QA invariante', 2
  ) RETURNING id INTO v_line;

  SELECT * INTO v_result
  FROM logistica.confirm_sales_order_preparation_line(
    v_company, v_line, 0, 'SIN_STOCK', NULL, false
  );

  IF v_result.prepared_quantity IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Fallo: prepared_quantity=%, esperado 0.', v_result.prepared_quantity;
  END IF;
  IF v_result.requested_quantity IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Fallo: requested_quantity=%, esperado 2.', v_result.requested_quantity;
  END IF;
  IF v_result.line_status IS DISTINCT FROM 'INCIDENT' THEN
    RAISE EXCEPTION 'Fallo: line_status=%, esperado INCIDENT.', v_result.line_status;
  END IF;
  IF v_result.excluded_from_dispatch IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Fallo: excluded_from_dispatch=%, esperado true.', v_result.excluded_from_dispatch;
  END IF;

  SELECT * INTO v_incident
  FROM logistica.sales_order_preparation_incidents
  WHERE preparation_line_id = v_line AND status = 'OPEN';

  IF v_incident.id IS NULL THEN
    RAISE EXCEPTION 'Fallo: no se creó incidencia OPEN.';
  END IF;
  IF v_incident.incident_type IS DISTINCT FROM 'LINE_EXCLUDED' THEN
    RAISE EXCEPTION 'Fallo: incident_type=%, esperado LINE_EXCLUDED.', v_incident.incident_type;
  END IF;
  IF v_incident.required_bsale_action IS DISTINCT FROM 'REMOVE_LINE' THEN
    RAISE EXCEPTION 'Fallo: required_bsale_action=%, esperado REMOVE_LINE.', v_incident.required_bsale_action;
  END IF;
  IF v_incident.expected_bsale_quantity IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Fallo: expected_bsale_quantity=%, esperado 0.', v_incident.expected_bsale_quantity;
  END IF;
  IF v_incident.prepared_quantity IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Fallo: incidencia prepared_quantity=%, esperado 0.', v_incident.prepared_quantity;
  END IF;
  IF v_incident.requested_quantity IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Fallo: incidencia requested_quantity=%, esperado 2.', v_incident.requested_quantity;
  END IF;

  -- Caso 2: cantidades > 0 conservan su semántica e historial.
  INSERT INTO logistica.sales_order_preparation_lines (
    company_id, card_id, bsale_nv_id, bsale_detail_id, sku, product_name, requested_quantity
  ) VALUES (
    v_company, v_card, v_nv, -2, 'QA-HISTORY', 'Producto QA historial', 2
  ) RETURNING id INTO v_line;

  SELECT * INTO v_result
  FROM logistica.confirm_sales_order_preparation_line(
    v_company, v_line, 1, 'SIN_STOCK', NULL, false
  );
  IF v_result.line_status IS DISTINCT FROM 'INCIDENT'
     OR v_result.excluded_from_dispatch IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Fallo: reducción parcial alterada (status=%, excluded=%).',
      v_result.line_status, v_result.excluded_from_dispatch;
  END IF;

  SELECT * INTO v_incident
  FROM logistica.sales_order_preparation_incidents
  WHERE preparation_line_id = v_line AND status = 'OPEN';
  IF v_incident.incident_type IS DISTINCT FROM 'QUANTITY_REDUCTION'
     OR v_incident.required_bsale_action IS DISTINCT FROM 'SET_QUANTITY'
     OR v_incident.expected_bsale_quantity IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Fallo: incidencia parcial incorrecta (%, %, %).',
      v_incident.incident_type, v_incident.required_bsale_action, v_incident.expected_bsale_quantity;
  END IF;

  SELECT * INTO v_result
  FROM logistica.confirm_sales_order_preparation_line(
    v_company, v_line, 2, NULL, NULL, false
  );
  IF v_result.line_status IS DISTINCT FROM 'CONFIRMED'
     OR v_result.excluded_from_dispatch IS DISTINCT FROM false
     OR v_result.requested_quantity IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Fallo: confirmación exacta alterada (status=%, excluded=%, requested=%).',
      v_result.line_status, v_result.excluded_from_dispatch, v_result.requested_quantity;
  END IF;

  SELECT count(*) INTO v_open_count
  FROM logistica.sales_order_preparation_incidents
  WHERE preparation_line_id = v_line AND status = 'OPEN';
  IF v_open_count <> 0 THEN
    RAISE EXCEPTION 'Fallo: quedaron % incidencias OPEN tras confirmar exacto.', v_open_count;
  END IF;
END;
$$;

SELECT
  l.bsale_detail_id AS detail_id,
  l.requested_quantity,
  l.prepared_quantity,
  l.line_status,
  l.excluded_from_dispatch,
  i.incident_type,
  i.required_bsale_action,
  i.expected_bsale_quantity,
  i.status AS incident_status
FROM logistica.sales_order_preparation_lines l
LEFT JOIN logistica.sales_order_preparation_incidents i
  ON i.preparation_line_id = l.id AND i.status = 'OPEN'
WHERE l.card_id = '11111111-1111-4111-8111-111111111111'
ORDER BY l.bsale_detail_id;

ROLLBACK;
