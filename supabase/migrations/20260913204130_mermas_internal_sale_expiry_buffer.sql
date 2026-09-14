-- MERMAS: tope mensual inicial y buffer mínimo de vencimiento para ventas internas.

ALTER TABLE mermas.internal_sale_settings
  ALTER COLUMN worker_monthly_limit_amount SET DEFAULT 1000000;

UPDATE mermas.internal_sale_settings
SET worker_monthly_limit_amount = 1000000
WHERE worker_monthly_limit_amount IS NULL;

CREATE OR REPLACE FUNCTION mermas.create_internal_sale(
  p_company_id uuid,
  p_user_id uuid,
  p_employee_id uuid,
  p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, rrhh, integraciones, mermas
AS $$
DECLARE
  v_now timestamptz := now();
  v_today date := timezone('America/Santiago', v_now)::date;
  v_month_start date := date_trunc('month', v_today)::date;
  v_next_month date := (date_trunc('month', v_today) + interval '1 month')::date;
  v_month_start_ts timestamptz := timezone('America/Santiago', date_trunc('month', v_today)::timestamp);
  v_next_month_ts timestamptz := timezone('America/Santiago', (date_trunc('month', v_today) + interval '1 month')::timestamp);
  v_settings mermas.internal_sale_settings%ROWTYPE;
  v_employee rrhh.employees%ROWTYPE;
  v_item jsonb;
  v_variant_id integer;
  v_quantity numeric;
  v_requested jsonb := '{}'::jsonb;
  v_key text;
  v_requested_quantity numeric;
  v_cost numeric;
  v_markup numeric;
  v_unit_price numeric;
  v_line_total numeric;
  v_total numeric := 0;
  v_used numeric := 0;
  v_sale_id uuid;
  v_sale_number text;
  v_sale_year integer := extract(year from v_today)::integer;
  v_sequence bigint;
  v_line_id uuid;
  v_lot record;
  v_sku text;
  v_product_name text;
  v_piece numeric;
  v_remaining numeric;
  v_movement_id uuid;
  v_employee_json jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_lots jsonb := '[]'::jsonb;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_employee_id IS NULL THEN
    RAISE EXCEPTION 'Venta interna inválida';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Usuario inválido';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM portal.users u
    WHERE u.id = p_user_id AND u.is_active AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'El usuario responsable no está activo';
  END IF;
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.create') THEN
    RAISE EXCEPTION 'No autorizado para crear ventas internas de Mermas';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'La venta debe contener al menos un producto';
  END IF;

  SELECT * INTO v_employee FROM rrhh.employees WHERE id = p_employee_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trabajador no encontrado'; END IF;
  IF v_employee.estado <> 'ACTIVO' THEN RAISE EXCEPTION 'El trabajador no está ACTIVO'; END IF;

  -- Serializa el cupo del mismo trabajador y mes entre ventas concurrentes.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'mermas-worker-month:' || p_company_id::text || ':' || p_employee_id::text || ':' || v_month_start::text, 0));
  SELECT * INTO v_settings FROM mermas.internal_sale_settings
    WHERE company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_settings.worker_markup_percent IS NULL
     OR v_settings.worker_monthly_limit_amount IS NULL THEN
    RAISE EXCEPTION 'Debe configurar porcentaje y tope mensual antes de vender';
  END IF;
  v_markup := v_settings.worker_markup_percent;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_variant_id := NULLIF(v_item->>'bsale_variant_id', '')::integer;
    v_quantity := NULLIF(v_item->>'quantity', '')::numeric;
    IF v_variant_id IS NULL OR v_variant_id <= 0 OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Producto o cantidad inválida';
    END IF;
    v_requested := jsonb_set(v_requested, ARRAY[v_variant_id::text],
      to_jsonb(coalesce((v_requested->>v_variant_id::text)::numeric, 0) + v_quantity), true);
  END LOOP;

  FOR v_key, v_requested_quantity IN SELECT key, value::numeric FROM jsonb_each_text(v_requested) LOOP
    v_variant_id := v_key::integer;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'mermas-variant:' || p_company_id::text || ':' || v_variant_id::text, 0));
    -- Bloquea el saldo existente mientras se calcula la asignación FEFO.
    PERFORM 1 FROM mermas.movements m
      WHERE m.company_id = p_company_id AND m.variant_id = v_variant_id
      FOR UPDATE;
    IF NOT EXISTS (
      SELECT 1 FROM integraciones.bsale_variants v
      WHERE v.company_id = p_company_id AND v.bsale_id = v_variant_id AND v.state = 0
    ) THEN
      RAISE EXCEPTION 'Producto % no encontrado o inactivo en el catálogo', v_variant_id;
    END IF;
    SELECT c.average_cost INTO v_cost
    FROM integraciones.bsale_variant_costs c
    WHERE c.company_id = p_company_id AND c.variant_id = v_variant_id;
    IF v_cost IS NULL OR v_cost <= 0 THEN
      RAISE EXCEPTION 'El producto % no tiene un costo promedio válido', v_variant_id;
    END IF;
    v_unit_price := greatest(v_cost, round(v_cost * (1 + v_markup / 100)));
    v_total := v_total + round(v_unit_price * v_requested_quantity);
  END LOOP;

  SELECT coalesce(sum(s.total_amount), 0) INTO v_used
  FROM mermas.internal_sales s
  WHERE s.company_id = p_company_id AND s.employee_id = p_employee_id
    AND s.status <> 'REVERSED'
    AND s.created_at >= v_month_start_ts
    AND s.created_at < v_next_month_ts;
  IF v_used + v_total > v_settings.worker_monthly_limit_amount THEN
    RAISE EXCEPTION 'Tope mensual excedido. Límite: %, utilizado: %, disponible: %, solicitado: %',
      v_settings.worker_monthly_limit_amount, v_used,
      greatest(v_settings.worker_monthly_limit_amount - v_used, 0), v_total;
  END IF;

  INSERT INTO mermas.internal_sale_correlatives(company_id, sale_year, next_value)
  VALUES (p_company_id, v_sale_year, 2)
  ON CONFLICT (company_id, sale_year)
  DO UPDATE SET next_value = mermas.internal_sale_correlatives.next_value + 1
  RETURNING next_value - 1 INTO v_sequence;
  v_sale_number := 'VIT-' || v_sale_year::text || '-' || lpad(v_sequence::text, 6, '0');

  INSERT INTO mermas.internal_sales (
    company_id, sale_number, employee_id, employee_name_snapshot, employee_rut_snapshot,
    status, total_amount, responsible_user_id, created_by
  ) VALUES (
    p_company_id, v_sale_number, p_employee_id,
    btrim(v_employee.nombres || ' ' || v_employee.apellido_paterno || ' ' || coalesce(v_employee.apellido_materno, '')),
    v_employee.rut, 'PENDING_RENDITION', v_total, p_user_id, p_user_id
  ) RETURNING id INTO v_sale_id;

  FOR v_key, v_requested_quantity IN SELECT key, value::numeric FROM jsonb_each_text(v_requested) LOOP
    v_variant_id := v_key::integer;
    SELECT c.average_cost INTO v_cost FROM integraciones.bsale_variant_costs c
      WHERE c.company_id = p_company_id AND c.variant_id = v_variant_id;
    v_unit_price := greatest(v_cost, round(v_cost * (1 + v_markup / 100)));
    SELECT bv.code, bp.name INTO v_sku, v_product_name FROM integraciones.bsale_variants bv
      JOIN integraciones.bsale_products bp ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
      WHERE bv.company_id = p_company_id AND bv.bsale_id = v_variant_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Producto % no encontrado en el catálogo', v_variant_id; END IF;
    v_line_total := round(v_unit_price * v_requested_quantity);
    INSERT INTO mermas.internal_sale_lines (
      sale_id, company_id, bsale_variant_id, sku_snapshot, product_name_snapshot, quantity,
      average_cost_snapshot, markup_percent_snapshot, worker_unit_price_snapshot, line_total
    ) VALUES (
      v_sale_id, p_company_id, v_variant_id, coalesce(v_sku, ''),
      coalesce(v_product_name, 'Producto Bsale'), v_requested_quantity,
      v_cost, v_markup, v_unit_price, v_line_total
    ) RETURNING id INTO v_line_id;

    v_remaining := v_requested_quantity;
    FOR v_lot IN
      SELECT sc.variant_id, sc.expiration_date, sc.lot, sc.available, sc.entered_at, sc.request_id
      FROM mermas.stock_current sc
      WHERE sc.company_id = p_company_id AND sc.variant_id = v_variant_id
        AND sc.expiration_date >= v_today + 5
        AND sc.available > 0
      ORDER BY sc.expiration_date, sc.entered_at, sc.lot NULLS FIRST
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_piece := least(v_remaining, v_lot.available);
      INSERT INTO mermas.movements (
        company_id, movement_type, variant_id, quantity, expiration_date, lot,
        request_id, source, authorization_status, internal_sale_id, internal_sale_line_id
      ) VALUES (
        p_company_id, 'VENTA_INTERNA', v_variant_id, -v_piece, v_lot.expiration_date, v_lot.lot,
        v_lot.request_id, 'INTERNAL_SALE', 'AUTORIZADA', v_sale_id, v_line_id
      ) RETURNING id INTO v_movement_id;
      INSERT INTO mermas.internal_sale_lot_allocations (
        company_id, sale_id, sale_line_id, movement_id, variant_id, quantity, expiration_date, lot
      ) VALUES (
        p_company_id, v_sale_id, v_line_id, v_movement_id, v_variant_id,
        v_piece, v_lot.expiration_date, v_lot.lot
      );
      v_remaining := v_remaining - v_piece;
      v_lots := v_lots || jsonb_build_array(jsonb_build_object(
        'sale_line_id', v_line_id, 'variant_id', v_variant_id, 'quantity', v_piece,
        'expiration_date', v_lot.expiration_date, 'lot', v_lot.lot, 'movement_id', v_movement_id));
    END LOOP;
    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'Stock elegible insuficiente para la variante %', v_variant_id;
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'sale_line_id', v_line_id, 'bsale_variant_id', v_variant_id, 'quantity', v_requested_quantity,
      'worker_unit_price', v_unit_price, 'line_total', v_line_total));
  END LOOP;

  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES ('mermas.internal_sales', v_sale_id, 'MERMA_WORKER_SALE', jsonb_build_object(
    'company_id', p_company_id, 'employee_id', p_employee_id, 'sale_number', v_sale_number,
    'total_amount', v_total, 'status', 'PENDING_RENDITION', 'lines', v_lines, 'lots', v_lots
  ), p_user_id);

  v_employee_json := jsonb_build_object('id', v_employee.id, 'name',
    btrim(v_employee.nombres || ' ' || v_employee.apellido_paterno || ' ' || coalesce(v_employee.apellido_materno, '')),
    'rut', v_employee.rut);
  RETURN jsonb_build_object(
    'sale_id', v_sale_id, 'sale_number', v_sale_number, 'employee', v_employee_json,
    'total', v_total, 'monthly_limit', v_settings.worker_monthly_limit_amount,
    'monthly_used_before', v_used, 'monthly_used_after', v_used + v_total,
    'monthly_remaining', v_settings.worker_monthly_limit_amount - v_used - v_total,
    'status', 'PENDING_RENDITION', 'lines', v_lines, 'lots', v_lots,
    'responsible_user_id', p_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.create_internal_sale(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.create_internal_sale(uuid, uuid, uuid, jsonb) TO service_role;
