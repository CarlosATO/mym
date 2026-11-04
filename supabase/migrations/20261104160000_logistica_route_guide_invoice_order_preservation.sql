-- Migración forward-only para preservar el orden explícito y predeterminado de facturas en Guías de Ruta.
-- Conserva las firmas existentes de logistica.get_route_invoice_draft_rows y logistica.create_route_guide_draft_from_invoices.
BEGIN;

CREATE OR REPLACE FUNCTION logistica.get_route_invoice_draft_rows(
  p_company_id uuid,
  p_invoice_bsale_ids bigint[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL
     OR NOT core.has_company_access(auth.uid(), p_company_id)
     OR NOT core.has_permission_for_company(auth.uid(), p_company_id, 'logistica.route_guides.create') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No autorizado');
  END IF;

  -- PostgreSQL no admite funciones de ventana dentro de los argumentos de un
  -- agregado: line_number se calcula primero en el CTE "numbered" y luego se
  -- agrega con jsonb_agg(... ORDER BY ord).
  WITH ordered_input AS (
    SELECT u.bsale_id, min(u.ord) AS ord
    FROM unnest(p_invoice_bsale_ids) WITH ORDINALITY AS u(bsale_id, ord)
    GROUP BY u.bsale_id
  ),
  eligible AS (
    SELECT
      oi.ord,
      d.bsale_id,
      d.number,
      d.total_amount,
      c.business_name,
      c.first_name,
      c.last_name,
      c.company,
      c.address,
      c.commune,
      c.city,
      c.payment_type_name
    FROM ordered_input oi
    JOIN integraciones.bsale_documents d
      ON d.company_id = p_company_id
     AND d.bsale_id = oi.bsale_id
     AND d.document_type_id = 5
     AND d.state = 0
     AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'
    LEFT JOIN integraciones.bsale_clients c
      ON c.company_id = d.company_id AND c.bsale_client_id = d.client_id
    WHERE EXISTS (
      SELECT 1
      FROM logistica.sales_order_invoice_attempts a
      JOIN logistica.sales_order_preparation_cards pc
        ON pc.id = a.card_id AND pc.company_id = a.company_id
      WHERE a.company_id = p_company_id
        AND a.bsale_invoice_id = d.bsale_id
        AND a.status = 'CONFIRMED'
        AND pc.status = 'INVOICED_READY_FOR_ROUTE'
        AND EXISTS (
          SELECT 1
          FROM integraciones.bsale_invoice_sales_order_links l
          WHERE l.company_id = p_company_id
            AND l.invoice_bsale_id = d.bsale_id
            AND l.sales_order_bsale_id = coalesce(pc.current_bsale_nv_id, pc.bsale_nv_id)
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM logistica.route_guide_items rgi
      JOIN logistica.route_guides rg ON rg.id = rgi.route_guide_id
      WHERE rgi.company_id = p_company_id
        AND rg.company_id = rgi.company_id
        AND rg.status IN ('DRAFT', 'DISPATCHED')
        AND (rgi.invoice_bsale_id = d.bsale_id
          OR (rgi.invoice_bsale_id IS NULL AND rgi.invoice_number = d.number::text))
    )
  ),
  numbered AS (
    SELECT e.*, row_number() OVER (ORDER BY e.ord)::integer AS line_number
    FROM eligible e
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'invoice_bsale_id', n.bsale_id,
    'line_number', n.line_number,
    'invoice_number', n.number::text,
    'customer_name', coalesce(
      nullif(n.business_name, ''),
      nullif(concat_ws(' ', n.first_name, n.last_name), ''),
      nullif(n.company, ''), 'Cliente sin nombre'
    ),
    'customer_address', coalesce(n.address, ''),
    'commune', coalesce(n.commune, n.city, ''),
    'amount', coalesce(n.total_amount, 0),
    'payment_method_original', coalesce(n.payment_type_name, ''),
    'payment_method_normalized', logistica.normalize_payment_method(n.payment_type_name),
    'requires_settlement', logistica.payment_requires_settlement(
      logistica.normalize_payment_method(n.payment_type_name)
    ),
    'validation_status', 'VALID', 'validation_errors', '[]'::jsonb,
    'notes', '', 'settlement_status', 'NOT_REQUIRED'
  ) ORDER BY n.ord), '[]'::jsonb)
  INTO v_rows
  FROM numbered n;

  RETURN jsonb_build_object('success', true, 'items', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION logistica.create_route_guide_draft_from_invoices(
  p_company_id uuid,
  p_guide_data jsonb,
  p_invoice_bsale_ids bigint[],
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_items jsonb;
  v_id bigint;
  v_card_id uuid;
  v_card_nv bigint;
  v_count integer;
  v_year integer;
  v_sequence integer;
  v_guide_number text;
  v_guide_id uuid;
  v_item record;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.route_guides.create') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No autorizado');
  END IF;
  IF p_invoice_bsale_ids IS NULL OR cardinality(p_invoice_bsale_ids) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Debe seleccionar al menos una factura.');
  END IF;

  -- Locks are company-scoped and acquired in canonical numerical order for deadlock prevention.
  FOR v_id IN SELECT DISTINCT x FROM unnest(p_invoice_bsale_ids) AS u(x) ORDER BY x LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_company_id::text || ':route-invoice:' || v_id::text, 0)
    );

    IF NOT EXISTS (
      SELECT 1 FROM integraciones.bsale_documents d
      WHERE d.company_id = p_company_id AND d.bsale_id = v_id
        AND d.document_type_id = 5 AND d.state = 0
        AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'
    ) THEN
      RAISE EXCEPTION 'La factura % no es una factura vigente tipo 5 de la empresa.', v_id;
    END IF;

    SELECT a.card_id, coalesce(c.current_bsale_nv_id, c.bsale_nv_id)
      INTO v_card_id, v_card_nv
    FROM logistica.sales_order_invoice_attempts a
    JOIN logistica.sales_order_preparation_cards c
      ON c.id = a.card_id AND c.company_id = a.company_id
    WHERE a.company_id = p_company_id AND a.bsale_invoice_id = v_id
      AND a.status = 'CONFIRMED'
      AND c.status = 'INVOICED_READY_FOR_ROUTE'
    ORDER BY a.confirmed_at DESC NULLS LAST, a.created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La factura % no tiene attempt CONFIRMED en una card elegible.', v_id;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM integraciones.bsale_invoice_sales_order_links l
      WHERE l.company_id = p_company_id
        AND l.invoice_bsale_id = v_id
        AND l.sales_order_bsale_id = v_card_nv
    ) THEN
      RAISE EXCEPTION 'La factura % no demuestra relación con la NV/card elegible.', v_id;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM logistica.route_guide_items rgi
      JOIN logistica.route_guides rg
        ON rg.id = rgi.route_guide_id
       AND rg.company_id = rgi.company_id
       AND rg.status IN ('DRAFT', 'DISPATCHED')
      WHERE rgi.company_id = p_company_id
         AND (rgi.invoice_bsale_id = v_id OR (
          rgi.invoice_bsale_id IS NULL
          AND rgi.invoice_number = (SELECT d.number::text FROM integraciones.bsale_documents d
                                    WHERE d.company_id = p_company_id AND d.bsale_id = v_id)
        ))
    ) THEN
      RAISE EXCEPTION 'La factura % ya está asociada a una guía activa.', v_id;
    END IF;
  END LOOP;

  -- Preservar la secuencia exacta del arreglo p_invoice_bsale_ids sin reordenar por bsale_id
  v_items := (logistica.get_route_invoice_draft_rows(
    p_company_id,
    ARRAY(
      SELECT u.x
      FROM unnest(p_invoice_bsale_ids) WITH ORDINALITY AS u(x, ord)
      GROUP BY u.x
      ORDER BY min(u.ord)
    )
  )->>'items')::jsonb;
  SELECT count(DISTINCT x) INTO v_count FROM unnest(p_invoice_bsale_ids) AS t(x);
  IF v_items IS NULL OR jsonb_array_length(v_items) <> v_count THEN
    RAISE EXCEPTION 'Una o más facturas dejaron de estar disponibles.';
  END IF;

  v_year := date_part('year', (p_guide_data->>'guide_date')::date);
  INSERT INTO logistica.route_guide_counters(company_id, guide_year, last_sequence)
  VALUES (p_company_id, v_year, 1)
  ON CONFLICT (company_id, guide_year) DO UPDATE
    SET last_sequence = logistica.route_guide_counters.last_sequence + 1,
        updated_at = pg_catalog.now()
  RETURNING last_sequence INTO v_sequence;
  v_guide_number := 'GR-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0');

  INSERT INTO logistica.route_guides(
    company_id, guide_year, guide_sequence, guide_number, guide_date,
    route_id, route_name_snapshot, vehicle_id, vehicle_name_snapshot,
    driver_id, driver_name_snapshot, seller_id, seller_name_snapshot,
    dispatcher_id, dispatcher_name_snapshot, notes, status, created_by
  ) VALUES (
    p_company_id, v_year, v_sequence, v_guide_number, (p_guide_data->>'guide_date')::date,
    NULLIF(p_guide_data->>'route_id', '')::uuid, p_guide_data->>'route_name_snapshot',
    NULLIF(p_guide_data->>'vehicle_id', '')::uuid, p_guide_data->>'vehicle_name_snapshot',
    NULLIF(p_guide_data->>'driver_id', '')::uuid, p_guide_data->>'driver_name_snapshot',
    NULLIF(p_guide_data->>'seller_id', '')::uuid, p_guide_data->>'seller_name_snapshot',
    NULLIF(p_guide_data->>'dispatcher_id', '')::uuid, p_guide_data->>'dispatcher_name_snapshot',
    p_guide_data->>'notes', 'DRAFT', p_user_id
  ) RETURNING id INTO v_guide_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) AS x(value) LOOP
    INSERT INTO logistica.route_guide_items(
      company_id, route_guide_id, line_number, invoice_bsale_id, invoice_number,
      customer_name, customer_address, commune, amount, payment_method_original,
      payment_method_normalized, requires_settlement, validation_status,
      validation_errors, notes, settlement_status
    ) VALUES (
      p_company_id, v_guide_id, (v_item.value->>'line_number')::integer,
      (v_item.value->>'invoice_bsale_id')::bigint, v_item.value->>'invoice_number',
      v_item.value->>'customer_name', v_item.value->>'customer_address',
      v_item.value->>'commune', (v_item.value->>'amount')::numeric,
      v_item.value->>'payment_method_original', v_item.value->>'payment_method_normalized',
      (v_item.value->>'requires_settlement')::boolean,
      v_item.value->>'validation_status', (v_item.value->>'validation_errors')::jsonb,
      v_item.value->>'notes', coalesce(v_item.value->>'settlement_status', 'NOT_REQUIRED')
    );
  END LOOP;

  UPDATE logistica.route_guides rg SET
    total_invoices = totals.total_invoices,
    total_amount = totals.total_amount,
    total_cash_expected = totals.total_cash,
    total_check_expected = totals.total_check,
    total_credit = totals.total_credit,
    total_transfer = totals.total_transfer,
    total_unknown_payment = totals.total_unknown
  FROM (
    SELECT count(*)::integer AS total_invoices,
      coalesce(sum(amount), 0) AS total_amount,
      coalesce(sum(amount) FILTER (WHERE payment_method_normalized = 'CASH'), 0) AS total_cash,
      coalesce(sum(amount) FILTER (WHERE payment_method_normalized = 'CHECK'), 0) AS total_check,
      coalesce(sum(amount) FILTER (WHERE payment_method_normalized = 'CREDIT'), 0) AS total_credit,
      coalesce(sum(amount) FILTER (WHERE payment_method_normalized = 'TRANSFER'), 0) AS total_transfer,
      coalesce(sum(amount) FILTER (WHERE payment_method_normalized = 'UNKNOWN'), 0) AS total_unknown
    FROM logistica.route_guide_items WHERE route_guide_id = v_guide_id
  ) totals
  WHERE rg.id = v_guide_id;

  INSERT INTO portal.audit_logs(
    schema_name, module_code, table_name, record_id, action, new_data,
    performed_by, event_type, severity
  ) VALUES (
    'logistica', 'LOGISTICA', 'route_guides', v_guide_id, 'INSERT',
    jsonb_build_object('guide_number', v_guide_number, 'source', 'invoice_selection'),
    p_user_id, 'ROUTE_GUIDE_CREATED', 'INFO'
  );

  RETURN jsonb_build_object('success', true, 'id', v_guide_id,
                            'guide_number', v_guide_number, 'status', 'DRAFT',
                            'warnings', '[]'::jsonb);
END;
$$;

ALTER FUNCTION logistica.get_route_invoice_draft_rows(uuid, bigint[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.get_route_invoice_draft_rows(uuid, bigint[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.get_route_invoice_draft_rows(uuid, bigint[]) TO authenticated;

ALTER FUNCTION logistica.create_route_guide_draft_from_invoices(uuid, jsonb, bigint[], uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.create_route_guide_draft_from_invoices(uuid, jsonb, bigint[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.create_route_guide_draft_from_invoices(uuid, jsonb, bigint[], uuid) TO authenticated;

COMMIT;

