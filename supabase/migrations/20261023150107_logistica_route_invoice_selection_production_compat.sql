-- Selección explícita de facturas elegibles para crear una Guía de Ruta.
-- Esta migration conserva las firmas públicas y la edición avanzada histórica.
BEGIN;

-- Never replace or drop the preparation board view blindly. A future version of
-- this migration must stop before DROP if another object depends on the view.
-- This migration is additive and therefore keeps the existing view contract.
DO $$
DECLARE
  v_dependency text;
BEGIN
  SELECT dependent_ns.nspname || '.' || dependent.relname
    INTO v_dependency
  FROM pg_catalog.pg_depend dep
  JOIN pg_catalog.pg_class view_rel ON view_rel.oid = dep.refobjid
  JOIN pg_catalog.pg_namespace view_ns ON view_ns.oid = view_rel.relnamespace
  JOIN pg_catalog.pg_class dependent ON dependent.oid = dep.objid
  JOIN pg_catalog.pg_namespace dependent_ns ON dependent_ns.oid = dependent.relnamespace
  WHERE view_ns.nspname = 'logistica'
    AND view_rel.relname = 'vw_sales_order_preparation_board'
    AND dependent.oid <> view_rel.oid
  LIMIT 1;

  IF v_dependency IS NOT NULL THEN
    RAISE EXCEPTION 'migration stopped before DROP: preparation board has dependent object %', v_dependency;
  END IF;

  EXECUTE 'ALTER VIEW logistica.vw_sales_order_preparation_board OWNER TO postgres';
END;
$$;

-- PostgreSQL no permite agregar columnas a una vista existente con
-- CREATE OR REPLACE VIEW. La vista del Kanban conserva aquí sus 28 columnas,
-- filtros, owner, grants y security_invoker. La selección nueva resuelve sus
-- datos directamente desde el read model de attempts/documentos.

CREATE OR REPLACE FUNCTION logistica.populate_route_invoice_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_candidates integer;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.invoice_bsale_id IS NOT NULL
     AND (
       NEW.invoice_bsale_id IS DISTINCT FROM OLD.invoice_bsale_id
       OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
     ) THEN
    RAISE EXCEPTION 'invoice_bsale_id is immutable for an existing Bsale line';
  END IF;

  IF NEW.invoice_bsale_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM integraciones.bsale_documents d
      WHERE d.company_id = NEW.company_id
        AND d.bsale_id = NEW.invoice_bsale_id
        AND d.document_type_id = 5
        AND d.state = 0
        AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'
        AND (NEW.invoice_number IS NULL OR d.number::text = NEW.invoice_number)
    ) THEN
      RAISE EXCEPTION 'invoice_bsale_id % is not a valid invoice for company %',
        NEW.invoice_bsale_id, NEW.company_id;
    END IF;
  END IF;

  -- Historical rows may use the folio only, but ambiguity must remain NULL.
  IF (
    SELECT count(*)
    FROM integraciones.bsale_documents d
    WHERE d.company_id = NEW.company_id
      AND d.document_type_id = 5
      AND d.number::text = NEW.invoice_number
      AND d.state = 0
      AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'
  ) = 1 THEN
    SELECT min(d.bsale_id) INTO NEW.invoice_bsale_id
    FROM integraciones.bsale_documents d
    WHERE d.company_id = NEW.company_id
      AND d.document_type_id = 5
      AND d.number::text = NEW.invoice_number
      AND d.state = 0
      AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0';
  END IF;

  IF NEW.invoice_bsale_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM logistica.route_guide_items rgi
    JOIN logistica.route_guides rg
      ON rg.id = rgi.route_guide_id
     AND rg.company_id = rgi.company_id
     AND rg.status IN ('DRAFT', 'DISPATCHED')
    WHERE rgi.company_id = NEW.company_id
      AND rgi.id IS DISTINCT FROM NEW.id
      AND rgi.route_guide_id IS DISTINCT FROM NEW.route_guide_id
      AND (
        rgi.invoice_bsale_id = NEW.invoice_bsale_id
        OR (
          rgi.invoice_bsale_id IS NULL
          AND rgi.invoice_number = NEW.invoice_number
        )
      )
  ) THEN
    RAISE EXCEPTION 'invoice % is already associated with another active route guide line',
      coalesce(NEW.invoice_bsale_id::text, NEW.invoice_number);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS populate_route_invoice_identity ON logistica.route_guide_items;
CREATE TRIGGER populate_route_invoice_identity
  BEFORE INSERT OR UPDATE OF invoice_number, invoice_bsale_id
  ON logistica.route_guide_items
  FOR EACH ROW EXECUTE FUNCTION logistica.populate_route_invoice_identity();

COMMENT ON FUNCTION logistica.populate_route_invoice_identity() IS
  'Explicit invoice_bsale_id is authoritative; historical folio fallback is unique-only. Existing technical identity is immutable.';

-- Preserve the historical manual writer and its audit/error behavior. The only
-- additive change is carrying an explicit technical invoice identity.
CREATE OR REPLACE FUNCTION logistica.create_route_guide_draft_unchecked(
  p_company_id uuid,
  p_guide_data jsonb,
  p_items_data jsonb,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_year integer := date_part('year', (p_guide_data->>'guide_date')::date);
  v_sequence integer;
  v_guide_number text;
  v_guide_id uuid;
  v_item record;
  v_invoice_numbers text[];
  v_duplicates jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  INSERT INTO logistica.route_guide_counters (company_id, guide_year, last_sequence)
  VALUES (p_company_id, v_year, 1)
  ON CONFLICT (company_id, guide_year) DO UPDATE
  SET last_sequence = logistica.route_guide_counters.last_sequence + 1,
      updated_at = pg_catalog.now()
  RETURNING last_sequence INTO v_sequence;

  v_guide_number := 'GR-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0');
  INSERT INTO logistica.route_guides (
    company_id, guide_year, guide_sequence, guide_number, guide_date,
    route_id, route_name_snapshot, vehicle_id, vehicle_name_snapshot,
    driver_id, driver_name_snapshot, seller_id, seller_name_snapshot,
    dispatcher_id, dispatcher_name_snapshot, notes, status,
    total_invoices, total_amount, total_cash_expected, total_check_expected,
    total_credit, total_transfer, total_unknown_payment, error_count,
    duplicate_count, created_by
  ) VALUES (
    p_company_id, v_year, v_sequence, v_guide_number, (p_guide_data->>'guide_date')::date,
    (p_guide_data->>'route_id')::uuid, p_guide_data->>'route_name_snapshot',
    (p_guide_data->>'vehicle_id')::uuid, p_guide_data->>'vehicle_name_snapshot',
    (p_guide_data->>'driver_id')::uuid, p_guide_data->>'driver_name_snapshot',
    NULLIF(p_guide_data->>'seller_id', '')::uuid, p_guide_data->>'seller_name_snapshot',
    (p_guide_data->>'dispatcher_id')::uuid, p_guide_data->>'dispatcher_name_snapshot',
    p_guide_data->>'notes', 'DRAFT',
    coalesce((p_guide_data->>'total_invoices')::integer, 0),
    coalesce((p_guide_data->>'total_amount')::numeric, 0),
    coalesce((p_guide_data->>'total_cash_expected')::numeric, 0),
    coalesce((p_guide_data->>'total_check_expected')::numeric, 0),
    coalesce((p_guide_data->>'total_credit')::numeric, 0),
    coalesce((p_guide_data->>'total_transfer')::numeric, 0),
    coalesce((p_guide_data->>'total_unknown_payment')::numeric, 0),
    coalesce((p_guide_data->>'error_count')::integer, 0),
    coalesce((p_guide_data->>'duplicate_count')::integer, 0), p_user_id
  ) RETURNING id INTO v_guide_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items_data) AS x(value) LOOP
    INSERT INTO logistica.route_guide_items (
      company_id, route_guide_id, line_number, invoice_bsale_id, invoice_number,
      customer_name, customer_address, commune, amount,
      payment_method_original, payment_method_normalized, requires_settlement,
      validation_status, validation_errors, notes, settlement_status
    ) VALUES (
      p_company_id, v_guide_id, (v_item.value->>'line_number')::integer,
      NULLIF(v_item.value->>'invoice_bsale_id', '')::bigint,
      v_item.value->>'invoice_number', v_item.value->>'customer_name',
      v_item.value->>'customer_address', v_item.value->>'commune',
       (v_item.value->>'amount')::numeric,
       v_item.value->>'payment_method_original',
       v_item.value->>'payment_method_normalized',
       coalesce((v_item.value->>'requires_settlement')::boolean, false),
       v_item.value->>'validation_status',
       coalesce((v_item.value->>'validation_errors')::jsonb, '[]'::jsonb),
      v_item.value->>'notes', coalesce(v_item.value->>'settlement_status', 'NOT_REQUIRED')
    );
  END LOOP;

  SELECT array_agg(item_elem.value->>'invoice_number')
    INTO v_invoice_numbers
  FROM jsonb_array_elements(p_items_data) AS item_elem(value)
  WHERE item_elem.value->>'invoice_number' IS NOT NULL
    AND btrim(item_elem.value->>'invoice_number') <> '';

  IF v_invoice_numbers IS NOT NULL AND cardinality(v_invoice_numbers) > 0 THEN
    v_duplicates := logistica.find_historical_duplicate_invoices(
      p_company_id, v_invoice_numbers, v_guide_id
    );
  END IF;
  IF jsonb_array_length(v_duplicates) > 0 THEN
    v_warnings := jsonb_build_array(
      jsonb_build_object('type', 'DUPLICATE_INVOICES', 'duplicates', v_duplicates)
    );
  END IF;

  INSERT INTO portal.audit_logs (
    schema_name, module_code, table_name, record_id, action, new_data,
    performed_by, event_type, severity
  ) VALUES (
    'logistica', 'LOGISTICA', 'route_guides', v_guide_id, 'INSERT',
    jsonb_build_object('guide_number', v_guide_number, 'guide_id', v_guide_id), p_user_id,
    'ROUTE_GUIDE_CREATED', 'INFO'
  );

  RETURN jsonb_build_object(
    'success', true, 'id', v_guide_id, 'guide_number', v_guide_number,
    'status', 'DRAFT', 'warnings', v_warnings
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Preserve update_route_guide_draft_unchecked's historical contract, including
-- its header behavior, dependency checks, audit event and error handling. Local
-- identity snapshots prevent DELETE + INSERT from losing an ID; line_number is
-- used only to reject an ambiguous reload, never to assign an identity.

-- edit_route_guide_unsettled keeps its historical contract; identidad técnica de una línea existente es inmutable through the trigger above.
CREATE OR REPLACE FUNCTION logistica.update_route_guide_draft_unchecked(
  p_company_id uuid,
  p_guide_id uuid,
  p_guide_data jsonb,
  p_items_data jsonb,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_status text;
  v_item record;
  v_row_id uuid;
  v_existing_invoice bigint;
  v_explicit_invoice bigint;
  v_kept_ids uuid[] := '{}'::uuid[];
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'No autorizado');
  END IF;

  SELECT status INTO v_status
  FROM logistica.route_guides
  WHERE id = p_guide_id AND company_id = p_company_id;
  IF v_status IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'Guia no encontrada');
  END IF;
  IF NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.route_guides.edit_unsettled') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'No tienes permisos para editar guias de ruta');
  END IF;
  IF v_status <> 'DRAFT' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'Solo se pueden editar guias en borrador');
  END IF;
  IF EXISTS (SELECT 1 FROM adquisiciones.route_settlements WHERE route_guide_id = p_guide_id)
     OR EXISTS (SELECT 1 FROM adquisiciones.route_fund_closure_items WHERE route_guide_id = p_guide_id)
     OR EXISTS (SELECT 1 FROM adquisiciones.route_fund_closure_expenses WHERE route_guide_id = p_guide_id) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'La guia tiene rendicion o evidencia financiera asociada');
  END IF;

  -- Rehydrate identities from the existing rows; line_number is only
  -- Validate stable identities before changing the guide. line_number is only
  -- a presentation/order field and is never used to recover an invoice ID.
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items_data) AS x(value) LOOP
    v_row_id := NULLIF(v_item.value->>'id', '')::uuid;
    IF v_row_id IS NOT NULL THEN
      IF v_row_id = ANY(v_kept_ids) THEN
        RAISE EXCEPTION 'La línea % fue enviada más de una vez.', v_row_id;
      END IF;
      v_kept_ids := array_append(v_kept_ids, v_row_id);
      SELECT invoice_bsale_id INTO v_existing_invoice
      FROM logistica.route_guide_items
      WHERE id = v_row_id AND route_guide_id = p_guide_id AND company_id = p_company_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'La línea % no pertenece a la guía.', v_row_id;
      END IF;
      v_explicit_invoice := NULLIF(v_item.value->>'invoice_bsale_id', '')::bigint;
      IF v_existing_invoice IS NOT NULL AND v_explicit_invoice IS NOT NULL
         AND v_existing_invoice IS DISTINCT FROM v_explicit_invoice THEN
        RAISE EXCEPTION 'La identidad técnica de la línea % es inmutable.', v_row_id;
      END IF;
    ELSIF EXISTS (
      SELECT 1 FROM logistica.route_guide_items rgi
      WHERE rgi.route_guide_id = p_guide_id AND rgi.company_id = p_company_id
        AND rgi.line_number = (v_item.value->>'line_number')::integer
        AND rgi.invoice_bsale_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'La línea % requiere su id estable para conservar la identidad técnica.',
        v_item.value->>'line_number';
    END IF;
  END LOOP;

  v_kept_ids := '{}'::uuid[];

  UPDATE logistica.route_guides SET
    guide_date = (p_guide_data->>'guide_date')::date,
    route_id = (p_guide_data->>'route_id')::uuid,
    route_name_snapshot = p_guide_data->>'route_name_snapshot',
    vehicle_id = (p_guide_data->>'vehicle_id')::uuid,
    vehicle_name_snapshot = p_guide_data->>'vehicle_name_snapshot',
    driver_id = (p_guide_data->>'driver_id')::uuid,
    driver_name_snapshot = p_guide_data->>'driver_name_snapshot',
    dispatcher_id = (p_guide_data->>'dispatcher_id')::uuid,
    dispatcher_name_snapshot = p_guide_data->>'dispatcher_name_snapshot',
    notes = p_guide_data->>'notes', version_number = version_number + 1,
    updated_at = pg_catalog.now()
  WHERE id = p_guide_id AND company_id = p_company_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items_data) AS x(value) LOOP
    v_row_id := NULLIF(v_item.value->>'id', '')::uuid;
    v_explicit_invoice := NULLIF(v_item.value->>'invoice_bsale_id', '')::bigint;
    IF v_row_id IS NULL THEN
      INSERT INTO logistica.route_guide_items (
        company_id, route_guide_id, line_number, invoice_bsale_id, invoice_number,
        customer_name, customer_address, commune, amount,
        payment_method_original, payment_method_normalized, requires_settlement,
        validation_status, validation_errors, notes, settlement_status
      ) VALUES (
        p_company_id, p_guide_id, (v_item.value->>'line_number')::integer,
        v_explicit_invoice, v_item.value->>'invoice_number', v_item.value->>'customer_name',
        v_item.value->>'customer_address', v_item.value->>'commune',
        (v_item.value->>'amount')::numeric, v_item.value->>'payment_method_original',
        v_item.value->>'payment_method_normalized',
        coalesce((v_item.value->>'requires_settlement')::boolean, false),
        v_item.value->>'validation_status', coalesce((v_item.value->>'validation_errors')::jsonb, '[]'::jsonb),
        v_item.value->>'notes', coalesce(v_item.value->>'settlement_status', 'NOT_REQUIRED')
      ) RETURNING id INTO v_row_id;
    ELSE
      SELECT invoice_bsale_id INTO v_existing_invoice
      FROM logistica.route_guide_items
      WHERE id = v_row_id AND route_guide_id = p_guide_id AND company_id = p_company_id;
      UPDATE logistica.route_guide_items SET
        line_number = (v_item.value->>'line_number')::integer,
        invoice_bsale_id = coalesce(v_explicit_invoice, v_existing_invoice),
        invoice_number = v_item.value->>'invoice_number',
        customer_name = v_item.value->>'customer_name',
        customer_address = v_item.value->>'customer_address',
        commune = v_item.value->>'commune',
        amount = (v_item.value->>'amount')::numeric,
        payment_method_original = v_item.value->>'payment_method_original',
        payment_method_normalized = v_item.value->>'payment_method_normalized',
        requires_settlement = coalesce((v_item.value->>'requires_settlement')::boolean, false),
        validation_status = v_item.value->>'validation_status',
        validation_errors = coalesce((v_item.value->>'validation_errors')::jsonb, '[]'::jsonb),
        notes = v_item.value->>'notes',
        settlement_status = coalesce(v_item.value->>'settlement_status', 'NOT_REQUIRED'),
        updated_at = pg_catalog.now()
      WHERE id = v_row_id AND route_guide_id = p_guide_id AND company_id = p_company_id;
    END IF;
    v_kept_ids := array_append(v_kept_ids, v_row_id);
  END LOOP;

  DELETE FROM logistica.route_guide_items
  WHERE route_guide_id = p_guide_id
    AND NOT (id = ANY(v_kept_ids));

  INSERT INTO portal.audit_logs (
    schema_name, module_code, table_name, record_id, action, old_data, new_data,
    performed_by, event_type, severity
  ) VALUES (
    'logistica', 'LOGISTICA', 'route_guides', p_guide_id, 'UPDATE', '{}', '{}',
    p_user_id, 'ROUTE_GUIDE_UPDATED', 'INFO'
  );
  RETURN pg_catalog.jsonb_build_object('success', true, 'id', p_guide_id);
EXCEPTION WHEN OTHERS THEN
  RETURN pg_catalog.jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- New read contract. It uses only columns present in the Bsale mirror.
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

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'invoice_bsale_id', d.bsale_id,
     'line_number', d.selected_line_number,
    'invoice_number', d.number::text,
    'customer_name', coalesce(
      nullif(c.business_name, ''),
      nullif(concat_ws(' ', c.first_name, c.last_name), ''),
      nullif(c.company, ''), 'Cliente sin nombre'
    ),
    'customer_address', coalesce(c.address, ''),
    'commune', coalesce(c.commune, c.city, ''),
    'amount', coalesce(d.total_amount, 0),
    'payment_method_original', coalesce(c.payment_type_name, ''),
    'payment_method_normalized', logistica.normalize_payment_method(c.payment_type_name),
    'requires_settlement', logistica.payment_requires_settlement(
      logistica.normalize_payment_method(c.payment_type_name)
    ),
    'validation_status', 'VALID', 'validation_errors', '[]'::jsonb,
    'notes', '', 'settlement_status', 'NOT_REQUIRED'
  ) ORDER BY d.bsale_id), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT d.*,
           row_number() OVER (ORDER BY d.bsale_id)::integer AS selected_line_number
    FROM integraciones.bsale_documents d
    WHERE d.company_id = p_company_id
      AND d.bsale_id = ANY(p_invoice_bsale_ids)
      AND d.document_type_id = 5
      AND d.state = 0
      AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'
  ) d
  LEFT JOIN integraciones.bsale_clients c
    ON c.company_id = d.company_id AND c.bsale_client_id = d.client_id
   WHERE EXISTS (
      SELECT 1
      FROM logistica.sales_order_invoice_attempts a
      JOIN logistica.sales_order_preparation_cards c
        ON c.id = a.card_id AND c.company_id = a.company_id
      WHERE a.company_id = p_company_id
        AND a.bsale_invoice_id = d.bsale_id
        AND a.status = 'CONFIRMED'
        AND c.status = 'INVOICED_READY_FOR_ROUTE'
        AND EXISTS (
          SELECT 1
          FROM integraciones.bsale_invoice_sales_order_links l
          WHERE l.company_id = p_company_id
            AND l.invoice_bsale_id = d.bsale_id
            AND l.sales_order_bsale_id = coalesce(c.current_bsale_nv_id, c.bsale_nv_id)
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
    );

  RETURN jsonb_build_object('success', true, 'items', v_rows);
END;
$$;

-- Additive alternative to changing the Kanban view. The UI can consume this
-- read RPC when it needs technical invoice IDs; the existing view remains
-- untouched because PostgreSQL cannot append output columns with OR REPLACE.
CREATE OR REPLACE FUNCTION logistica.get_route_invoice_selection_candidates(
  p_company_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_candidates jsonb;
BEGIN
  IF auth.uid() IS NULL
     OR NOT core.has_company_access(auth.uid(), p_company_id)
     OR NOT core.has_permission_for_company(auth.uid(), p_company_id, 'logistica.route_guides.create') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No autorizado');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'card_id', q.card_id,
    'company_id', q.company_id,
    'status', q.card_status,
    'nv_bsale_id', q.nv_bsale_id,
    'invoice_bsale_id', q.invoice_bsale_id,
    'invoice_number', q.invoice_number,
    'amount', q.amount
  ) ORDER BY q.invoice_bsale_id), '[]'::jsonb)
  INTO v_candidates
  FROM (
    SELECT DISTINCT ON (c.id, d.bsale_id)
      c.id AS card_id, c.company_id, c.status AS card_status,
      coalesce(c.current_bsale_nv_id, c.bsale_nv_id) AS nv_bsale_id,
      d.bsale_id AS invoice_bsale_id, d.number::text AS invoice_number,
      coalesce(d.total_amount, 0) AS amount
    FROM logistica.sales_order_preparation_cards c
    JOIN logistica.sales_order_invoice_attempts a
      ON a.card_id = c.id AND a.company_id = c.company_id
     AND a.status = 'CONFIRMED'
    JOIN integraciones.bsale_documents d
      ON d.company_id = a.company_id AND d.bsale_id = a.bsale_invoice_id
     AND d.document_type_id = 5 AND d.state = 0
     AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'
    WHERE c.company_id = p_company_id
      AND c.status = 'INVOICED_READY_FOR_ROUTE'
      AND EXISTS (
        SELECT 1
        FROM integraciones.bsale_invoice_sales_order_links l
        WHERE l.company_id = p_company_id
          AND l.invoice_bsale_id = d.bsale_id
          AND l.sales_order_bsale_id = coalesce(c.current_bsale_nv_id, c.bsale_nv_id)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM logistica.route_guide_items rgi
        JOIN logistica.route_guides rg ON rg.id = rgi.route_guide_id
         AND rg.company_id = rgi.company_id
         AND rg.status IN ('DRAFT', 'DISPATCHED')
        WHERE rgi.company_id = p_company_id
          AND (rgi.invoice_bsale_id = d.bsale_id
            OR (rgi.invoice_bsale_id IS NULL AND rgi.invoice_number = d.number::text))
      )
    ORDER BY c.id, d.bsale_id, a.confirmed_at DESC NULLS LAST, a.created_at DESC
  ) q;

  RETURN jsonb_build_object('success', true, 'items', v_candidates);
END;
$$;

-- New selection writer. Existing manual create, update, dispatch and advanced
-- edit functions retain their signatures and bodies. This path writes its own
-- DRAFT atomically so the legacy writer's error-return contract is untouched.
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

  -- Locks are company-scoped and acquired in one canonical order.
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

  v_items := (logistica.get_route_invoice_draft_rows(
    p_company_id,
    ARRAY(SELECT DISTINCT x FROM unnest(p_invoice_bsale_ids) AS u(x) ORDER BY x)
  )->>'items')::jsonb;
  SELECT count(DISTINCT x) INTO v_count FROM unnest(p_invoice_bsale_ids) AS t(x);
   IF v_items IS NULL OR jsonb_array_length(v_items) <> v_count THEN
    RAISE EXCEPTION 'Una o más facturas dejaron de estar disponibles.';
  END IF;

  -- Do not delegate to the historical writer here: it intentionally catches
  -- exceptions for its legacy API. The new path must abort the transaction if
  -- any header/item/audit write fails, including the counter increment.
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

-- Dispatch must preserve the technical invoice identity. The historical
-- implementation remains the final writer, but it is reached only after this
-- read-only preflight validates IDs and active-guide uniqueness.
ALTER FUNCTION logistica.dispatch_route_guide_unchecked(
  uuid, uuid, uuid
) RENAME TO dispatch_route_guide_unchecked_legacy;

CREATE OR REPLACE FUNCTION logistica.dispatch_route_guide_unchecked(
  p_company_id uuid,
  p_guide_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'No autorizado');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM logistica.route_guide_items mine
    WHERE mine.company_id = p_company_id
      AND mine.route_guide_id = p_guide_id
      AND mine.invoice_bsale_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM integraciones.bsale_documents d
        WHERE d.company_id = mine.company_id
          AND d.bsale_id = mine.invoice_bsale_id
          AND d.document_type_id = 5
          AND d.state = 0
          AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'
          AND d.number::text = mine.invoice_number
      )
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La identidad técnica de una factura no coincide con Bsale.');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM logistica.route_guide_items mine
    JOIN logistica.route_guide_items theirs
      ON theirs.company_id = mine.company_id
     AND theirs.route_guide_id <> mine.route_guide_id
     AND (
       mine.invoice_bsale_id IS NOT NULL AND theirs.invoice_bsale_id = mine.invoice_bsale_id
       OR mine.invoice_bsale_id IS NULL AND theirs.invoice_bsale_id IS NULL AND theirs.invoice_number = mine.invoice_number
     )
    JOIN logistica.route_guides rg
      ON rg.id = theirs.route_guide_id
     AND rg.company_id = theirs.company_id
     AND rg.status IN ('DRAFT', 'DISPATCHED')
    WHERE mine.company_id = p_company_id
      AND mine.route_guide_id = p_guide_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Una factura ya está asociada a otra guía activa.');
  END IF;

  RETURN logistica.dispatch_route_guide_unchecked_legacy(p_company_id, p_guide_id, p_user_id);
END;
$$;

-- The existing advanced editor remains unchanged. Its writes pass through the
-- same trigger, so an existing technical identity cannot be replaced while
-- legacy rows with no identity can still be hydrated by a unique active folio.

ALTER FUNCTION logistica.populate_route_invoice_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.populate_route_invoice_identity() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION logistica.create_route_guide_draft_unchecked(uuid, jsonb, jsonb, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.create_route_guide_draft_unchecked(uuid, jsonb, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION logistica.update_route_guide_draft_unchecked(uuid, uuid, jsonb, jsonb, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.update_route_guide_draft_unchecked(uuid, uuid, jsonb, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION logistica.dispatch_route_guide_unchecked(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.dispatch_route_guide_unchecked(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION logistica.dispatch_route_guide_unchecked_legacy(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.dispatch_route_guide_unchecked_legacy(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION logistica.get_route_invoice_draft_rows(uuid, bigint[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.get_route_invoice_draft_rows(uuid, bigint[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.get_route_invoice_draft_rows(uuid, bigint[]) TO authenticated;
ALTER FUNCTION logistica.get_route_invoice_selection_candidates(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.get_route_invoice_selection_candidates(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.get_route_invoice_selection_candidates(uuid) TO authenticated;
ALTER FUNCTION logistica.create_route_guide_draft_from_invoices(uuid, jsonb, bigint[], uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.create_route_guide_draft_from_invoices(uuid, jsonb, bigint[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.create_route_guide_draft_from_invoices(uuid, jsonb, bigint[], uuid) TO authenticated;

COMMIT;
