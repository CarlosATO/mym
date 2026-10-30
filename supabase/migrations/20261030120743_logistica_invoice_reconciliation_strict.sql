-- MEJ-03B: unified, idempotent confirmation of invoices already emitted by Bsale.
-- This replaces only invoice confirmation/reconciliation RPCs. It never writes Bsale.
BEGIN;

CREATE OR REPLACE FUNCTION logistica.validate_sales_order_invoice_document(
  p_attempt_id uuid,
  p_invoice_id bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, logistica, integraciones
AS $function$
DECLARE
  a record;
  inv record;
  matches integer;
  expected_count integer;
  actual_count integer;
  duplicate_expected boolean;
  duplicate_actual boolean;
  invalid_relation boolean;
  expected_total numeric;
  total_difference numeric;
BEGIN
  SELECT * INTO a
  FROM logistica.sales_order_invoice_attempts
  WHERE id = p_attempt_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'ATTEMPT_NOT_FOUND'); END IF;

  SELECT count(*) INTO matches
  FROM integraciones.bsale_documents d
  WHERE d.company_id = a.company_id
    AND d.document_type_id = 5
    AND d.state = 0
    AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'
    AND d.raw_json->>'salesId' = a.sales_id;
  IF matches = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'NO_VALID_INVOICE'); END IF;
  IF matches <> 1 THEN RETURN jsonb_build_object('ok', false, 'reason', 'AMBIGUOUS_SALES_ID_MATCH', 'matches', matches); END IF;

  SELECT * INTO inv
  FROM integraciones.bsale_documents d
  WHERE d.company_id = a.company_id
    AND d.bsale_id = coalesce(p_invoice_id, d.bsale_id)
    AND d.document_type_id = 5
    AND d.state = 0
    AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'
    AND d.raw_json->>'salesId' = a.sales_id
  LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'INVOICE_ID_MISMATCH'); END IF;
  IF a.bsale_invoice_id IS NOT NULL AND a.bsale_invoice_id IS DISTINCT FROM inv.bsale_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVOICE_ID_MISMATCH');
  END IF;

  IF inv.client_id IS DISTINCT FROM NULLIF(a.nv_snapshot->>'client_id', '')::bigint
     OR inv.office_id IS DISTINCT FROM NULLIF(a.nv_snapshot->>'office_id', '')::integer
     OR inv.raw_json->>'salesId' IS DISTINCT FROM a.sales_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVOICE_IDENTITY_MISMATCH');
  END IF;

  expected_total := NULLIF(a.nv_snapshot->'totals'->>'total', '')::numeric;
  total_difference := inv.total_amount - expected_total;
  IF inv.total_amount IS NULL OR expected_total IS NULL OR abs(total_difference) > 5 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'TOTALS_MISMATCH',
      'invoice_total', inv.total_amount, 'expected_total', expected_total,
      'difference', total_difference, 'limit', 5
    );
  END IF;

  SELECT count(*) INTO expected_count
  FROM jsonb_to_recordset(
    CASE WHEN jsonb_typeof(a.detail_snapshots) = 'array' THEN a.detail_snapshots ELSE '[]'::jsonb END
  ) AS e(detail_id bigint, billable_quantity numeric, quantity numeric);
  SELECT count(*) INTO actual_count
  FROM integraciones.bsale_document_details d
  WHERE d.company_id = a.company_id AND d.bsale_document_id = inv.bsale_id;
  IF expected_count = 0 OR actual_count <> expected_count THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'DETAIL_COUNT_MISMATCH');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(
      CASE WHEN jsonb_typeof(a.detail_snapshots) = 'array' THEN a.detail_snapshots ELSE '[]'::jsonb END
    ) AS e(detail_id bigint)
    GROUP BY e.detail_id
    HAVING count(*) <> 1
  ) INTO duplicate_expected;
  SELECT EXISTS (
    SELECT 1
    FROM integraciones.bsale_document_details d
    WHERE d.company_id = a.company_id AND d.bsale_document_id = inv.bsale_id
    GROUP BY d.related_detail_bsale_id
    HAVING d.related_detail_bsale_id IS NULL OR count(*) <> 1
  ) INTO duplicate_actual;
  IF duplicate_expected OR duplicate_actual THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'RELATED_DETAIL_ID_NOT_PROVABLE');
  END IF;

  SELECT EXISTS (
    WITH expected AS (
      SELECT *
      FROM jsonb_to_recordset(
        CASE WHEN jsonb_typeof(a.detail_snapshots) = 'array' THEN a.detail_snapshots ELSE '[]'::jsonb END
      ) AS e(detail_id bigint, billable_quantity numeric, quantity numeric, variant_id bigint, sku text)
    ), actual AS (
      SELECT d.*
      FROM integraciones.bsale_document_details d
      WHERE d.company_id = a.company_id AND d.bsale_document_id = inv.bsale_id
    )
    SELECT 1
    FROM expected e
    LEFT JOIN actual x ON x.related_detail_bsale_id = e.detail_id
    WHERE x.bsale_id IS NULL
       OR x.quantity IS DISTINCT FROM coalesce(e.billable_quantity, e.quantity)
       OR e.variant_id IS NULL
       OR x.variant_id IS DISTINCT FROM e.variant_id
       OR e.sku IS NULL
       OR x.variant_code IS DISTINCT FROM e.sku
  ) INTO invalid_relation;
  IF invalid_relation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'RELATED_DETAIL_ID_NOT_PROVABLE');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM integraciones.bsale_invoice_sales_order_links l
    JOIN integraciones.bsale_documents old_invoice
      ON old_invoice.company_id = l.company_id
     AND old_invoice.bsale_id = l.invoice_bsale_id
     AND old_invoice.document_type_id = 5
     AND old_invoice.state = 0
     AND coalesce(old_invoice.raw_json->>'cancellationStatus', '0') = '0'
    WHERE l.company_id = a.company_id
      AND l.sales_order_bsale_id = a.current_bsale_nv_id
      AND l.invoice_bsale_id IS DISTINCT FROM inv.bsale_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVOICE_ALREADY_LINKED');
  END IF;
  IF EXISTS (
    SELECT 1
    FROM integraciones.bsale_invoice_sales_order_links l
    JOIN integraciones.bsale_document_details d
      ON d.company_id = l.company_id
     AND d.bsale_document_id = inv.bsale_id
     AND d.bsale_id = l.invoice_detail_bsale_id
    WHERE l.company_id = a.company_id
      AND l.invoice_bsale_id = inv.bsale_id
      AND (
        l.sales_order_bsale_id IS DISTINCT FROM a.current_bsale_nv_id
        OR l.sales_order_detail_bsale_id IS DISTINCT FROM d.related_detail_bsale_id
      )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVOICE_LINK_CONFLICT');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'invoice_id', inv.bsale_id,
    'invoice_number', inv.number,
    'invoice_total', inv.total_amount,
    'expected_total', expected_total,
    'difference', total_difference,
    'limit', 5,
    'matched_details', actual_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION logistica.validate_sales_order_invoice_document(uuid, bigint) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION logistica.reconcile_sales_order_invoice_attempt(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones
AS $function$
DECLARE
  a record;
  card_row record;
  validation jsonb;
  invoice_id bigint;
  invoice_number text;
  difference numeric;
  previous_status text;
  previous_card_status text;
  new_card_status text;
  was_confirmed boolean;
  link_conflict boolean;
BEGIN
  SELECT * INTO a
  FROM logistica.sales_order_invoice_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ATTEMPT_NOT_FOUND'; END IF;
  IF auth.role() IS DISTINCT FROM 'service_role' AND (
    auth.uid() IS NULL
    OR NOT core.has_company_access(auth.uid(), a.company_id)
    OR NOT core.has_permission_for_company(auth.uid(), a.company_id, 'logistica.preparation.manage')
  ) THEN
    RAISE EXCEPTION 'COMPANY_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  previous_status := a.status;
  was_confirmed := a.status = 'CONFIRMED';
  IF a.status NOT IN ('UNKNOWN', 'RECONCILIATION_REQUIRED', 'CONFIRMED') THEN
    RETURN jsonb_build_object('status', a.status, 'attempt_id', a.id, 'invoice_id', a.bsale_invoice_id);
  END IF;

  SELECT * INTO card_row
  FROM logistica.sales_order_preparation_cards
  WHERE id = a.card_id AND company_id = a.company_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CARD_NOT_FOUND'); END IF;
  IF card_row.canonical_bsale_token IS DISTINCT FROM a.canonical_bsale_token THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CARD_TOKEN_MISMATCH'); END IF;
  IF card_row.current_bsale_nv_id IS DISTINCT FROM a.current_bsale_nv_id THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CURRENT_BSALE_NV_ID_MISMATCH'); END IF;
  IF card_row.status = 'CANCELLED' THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CARD_CANCELLED'); END IF;
  IF card_row.status NOT IN ('AUDITED', 'INVOICED_READY_FOR_ROUTE') THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CARD_STATUS_INCOMPATIBLE'); END IF;
  IF card_row.closed_at IS NOT NULL AND card_row.closure_reason IS DISTINCT FROM 'INVOICED' THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CARD_CLOSED_INCOMPATIBLE'); END IF;
  IF logistica.preparation_card_is_excluded(a.company_id, a.card_id) THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CARD_EXCLUDED'); END IF;
  previous_card_status := card_row.status;

  validation := logistica.validate_sales_order_invoice_document(a.id, NULL);
  IF coalesce((validation->>'ok')::boolean, false) IS NOT TRUE THEN
    UPDATE logistica.sales_order_invoice_attempts
    SET status = 'RECONCILIATION_REQUIRED', last_error = validation->>'reason',
        last_reconciliation_at = now(), updated_at = now()
    WHERE id = a.id;
    RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED') || validation - 'ok';
  END IF;
  invoice_id := (validation->>'invoice_id')::bigint;
  invoice_number := validation->>'invoice_number';
  difference := (validation->>'difference')::numeric;

  SELECT EXISTS (
    SELECT 1
    FROM integraciones.bsale_invoice_sales_order_links l
    JOIN integraciones.bsale_documents old_invoice
      ON old_invoice.company_id = l.company_id
     AND old_invoice.bsale_id = l.invoice_bsale_id
     AND old_invoice.document_type_id = 5
     AND old_invoice.state = 0
     AND coalesce(old_invoice.raw_json->>'cancellationStatus', '0') = '0'
    WHERE l.company_id = a.company_id
      AND l.sales_order_bsale_id = a.current_bsale_nv_id
      AND l.invoice_bsale_id IS DISTINCT FROM invoice_id
  ) INTO link_conflict;
  IF link_conflict THEN
    UPDATE logistica.sales_order_invoice_attempts
    SET status = 'RECONCILIATION_REQUIRED', last_error = 'INVOICE_ALREADY_LINKED',
        last_reconciliation_at = now(), updated_at = now()
    WHERE id = a.id;
    RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'INVOICE_ALREADY_LINKED');
  END IF;

  UPDATE logistica.sales_order_preparation_cards
  SET status = CASE WHEN status = 'AUDITED' THEN 'INVOICED_READY_FOR_ROUTE' ELSE status END,
      updated_at = now()
  WHERE id = a.card_id AND company_id = a.company_id
    AND current_bsale_nv_id = a.current_bsale_nv_id
    AND status IN ('AUDITED', 'INVOICED_READY_FOR_ROUTE')
    AND (closed_at IS NULL OR closure_reason = 'INVOICED')
  RETURNING status INTO new_card_status;
  IF NOT FOUND THEN RAISE EXCEPTION 'CARD_UPDATE_FAILED'; END IF;

  INSERT INTO integraciones.bsale_invoice_sales_order_links(
    company_id, invoice_bsale_id, invoice_detail_bsale_id,
    sales_order_bsale_id, sales_order_detail_bsale_id
  )
  SELECT a.company_id, invoice_id, d.bsale_id, a.current_bsale_nv_id, d.related_detail_bsale_id
  FROM integraciones.bsale_document_details d
  WHERE d.company_id = a.company_id AND d.bsale_document_id = invoice_id
  ON CONFLICT DO NOTHING;

  UPDATE logistica.sales_order_invoice_attempts
  SET status = 'CONFIRMED', bsale_invoice_id = invoice_id,
      bsale_invoice_number = invoice_number, confirmed_at = coalesce(confirmed_at, now()),
      last_reconciliation_at = now(), last_error = null, updated_at = now()
  WHERE id = a.id;

  IF (difference <> 0 OR NOT was_confirmed OR previous_card_status IS DISTINCT FROM new_card_status)
     AND NOT EXISTS (
       SELECT 1 FROM portal.audit_logs
       WHERE record_id = a.id AND event_type = 'INVOICE_RECONCILIATION_CONFIRMED'
     ) THEN
    INSERT INTO portal.audit_logs(
      schema_name, module_code, table_name, record_id, action, new_data,
      performed_by, event_type, severity
    ) VALUES (
      'logistica', 'LOGISTICA', 'sales_order_invoice_attempts', a.id, 'UPDATE',
      jsonb_build_object(
        'event', 'INVOICE_RECONCILIATION_CONFIRMED', 'attempt_id', a.id,
        'invoice_bsale_id', invoice_id, 'invoice_number', invoice_number,
        'previous_status', previous_status, 'card_id', a.card_id,
        'card_status', new_card_status, 'invoice_total', validation->'invoice_total',
        'expected_total', validation->'expected_total', 'difference', difference, 'limit', 5
      ),
      auth.uid(), 'INVOICE_RECONCILIATION_CONFIRMED', 'INFO'
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'CONFIRMED', 'attempt_id', a.id, 'invoice_id', invoice_id,
    'invoice_number', invoice_number, 'matched_details', (validation->>'matched_details')::integer,
    'card_status', new_card_status, 'idempotent', was_confirmed,
    'invoice_total', validation->'invoice_total', 'expected_total', validation->'expected_total',
    'difference', difference, 'limit', 5
  );
END;
$function$;

CREATE OR REPLACE FUNCTION logistica.confirm_sales_order_invoice_attempt(
  p_attempt_id uuid,
  p_invoice_id bigint,
  p_invoice_number text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones
AS $function$
DECLARE
  a record;
  card_row record;
  validation jsonb;
  previous_status text;
  previous_card_status text;
  new_card_status text;
  invoice_id bigint;
  invoice_number text;
  difference numeric;
  was_confirmed boolean;
BEGIN
  SELECT * INTO a FROM logistica.sales_order_invoice_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'ATTEMPT_NOT_FOUND'); END IF;
  IF auth.role() IS DISTINCT FROM 'service_role' AND (
    auth.uid() IS NULL
    OR NOT core.has_company_access(auth.uid(), a.company_id)
    OR NOT core.has_permission_for_company(auth.uid(), a.company_id, 'logistica.preparation.manage')
  ) THEN
    RAISE EXCEPTION 'COMPANY_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  previous_status := a.status;
  was_confirmed := a.status = 'CONFIRMED';
  IF a.status NOT IN ('SUBMITTING', 'UNKNOWN', 'CONFIRMED') THEN
    RETURN jsonb_build_object('status', a.status, 'invoice_id', a.bsale_invoice_id);
  END IF;

  SELECT * INTO card_row
  FROM logistica.sales_order_preparation_cards
  WHERE id = a.card_id AND company_id = a.company_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CARD_NOT_FOUND'); END IF;
  IF card_row.current_bsale_nv_id IS DISTINCT FROM a.current_bsale_nv_id THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CURRENT_BSALE_NV_ID_MISMATCH'); END IF;
  IF card_row.status = 'CANCELLED' THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CARD_CANCELLED'); END IF;
  IF card_row.status NOT IN ('AUDITED', 'INVOICED_READY_FOR_ROUTE') THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CARD_STATUS_INCOMPATIBLE'); END IF;
  IF card_row.closed_at IS NOT NULL AND card_row.closure_reason IS DISTINCT FROM 'INVOICED' THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CARD_CLOSED_INCOMPATIBLE'); END IF;
  IF logistica.preparation_card_is_excluded(a.company_id, a.card_id) THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'CARD_EXCLUDED'); END IF;
  previous_card_status := card_row.status;

  validation := logistica.validate_sales_order_invoice_document(a.id, p_invoice_id);
  IF coalesce((validation->>'ok')::boolean, false) IS NOT TRUE THEN
    UPDATE logistica.sales_order_invoice_attempts
    SET status = 'RECONCILIATION_REQUIRED', last_error = validation->>'reason', updated_at = now()
    WHERE id = a.id;
    RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED') || validation - 'ok';
  END IF;
  invoice_id := (validation->>'invoice_id')::bigint;
  invoice_number := validation->>'invoice_number';
  difference := (validation->>'difference')::numeric;
  IF p_invoice_number IS NOT NULL AND p_invoice_number IS DISTINCT FROM invoice_number THEN
    UPDATE logistica.sales_order_invoice_attempts
    SET status = 'RECONCILIATION_REQUIRED', last_error = 'INVOICE_NUMBER_MISMATCH', updated_at = now()
    WHERE id = a.id;
    RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'INVOICE_NUMBER_MISMATCH');
  END IF;

  UPDATE logistica.sales_order_preparation_cards
  SET status = CASE WHEN status = 'AUDITED' THEN 'INVOICED_READY_FOR_ROUTE' ELSE status END,
      updated_at = now()
  WHERE id = a.card_id AND company_id = a.company_id
    AND current_bsale_nv_id = a.current_bsale_nv_id
    AND status IN ('AUDITED', 'INVOICED_READY_FOR_ROUTE')
    AND (closed_at IS NULL OR closure_reason = 'INVOICED')
  RETURNING status INTO new_card_status;
  IF NOT FOUND THEN RAISE EXCEPTION 'CARD_UPDATE_FAILED'; END IF;

  INSERT INTO integraciones.bsale_invoice_sales_order_links(
    company_id, invoice_bsale_id, invoice_detail_bsale_id,
    sales_order_bsale_id, sales_order_detail_bsale_id
  )
  SELECT a.company_id, invoice_id, d.bsale_id, a.current_bsale_nv_id, d.related_detail_bsale_id
  FROM integraciones.bsale_document_details d
  WHERE d.company_id = a.company_id AND d.bsale_document_id = invoice_id
  ON CONFLICT DO NOTHING;

  UPDATE logistica.sales_order_invoice_attempts
  SET status = 'CONFIRMED', bsale_invoice_id = invoice_id,
      bsale_invoice_number = invoice_number, confirmed_at = coalesce(confirmed_at, now()),
      updated_at = now(), last_error = null
  WHERE id = a.id;

  IF difference <> 0 AND NOT EXISTS (
    SELECT 1 FROM portal.audit_logs
    WHERE record_id = a.id AND event_type = 'INVOICE_RECONCILIATION_CONFIRMED'
  ) THEN
    INSERT INTO portal.audit_logs(
      schema_name, module_code, table_name, record_id, action, new_data,
      performed_by, event_type, severity
    ) VALUES (
      'logistica', 'LOGISTICA', 'sales_order_invoice_attempts', a.id, 'UPDATE',
      jsonb_build_object(
        'event', 'INVOICE_RECONCILIATION_CONFIRMED', 'attempt_id', a.id,
        'invoice_bsale_id', invoice_id, 'invoice_number', invoice_number,
        'previous_status', previous_status, 'card_id', a.card_id,
        'card_status', new_card_status, 'invoice_total', validation->'invoice_total',
        'expected_total', validation->'expected_total', 'difference', difference, 'limit', 5
      ),
      auth.uid(), 'INVOICE_RECONCILIATION_CONFIRMED', 'INFO'
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'CONFIRMED', 'invoice_id', invoice_id, 'invoice_number', invoice_number,
    'matched_details', (validation->>'matched_details')::integer,
    'card_status', new_card_status, 'idempotent', was_confirmed,
    'invoice_total', validation->'invoice_total', 'expected_total', validation->'expected_total',
    'difference', difference, 'limit', 5
  );
END;
$function$;

REVOKE ALL ON FUNCTION logistica.reconcile_sales_order_invoice_attempt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.reconcile_sales_order_invoice_attempt(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.confirm_sales_order_invoice_attempt(uuid, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.confirm_sales_order_invoice_attempt(uuid, bigint, text) TO authenticated, service_role;

COMMIT;
