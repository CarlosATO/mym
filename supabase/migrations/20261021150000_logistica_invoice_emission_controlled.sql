-- Facturación V1: submission controlada, idempotente y sin dispatch.

BEGIN;

ALTER TABLE logistica.sales_order_invoice_attempts
  DROP CONSTRAINT IF EXISTS sales_order_invoice_attempts_status_check;

ALTER TABLE logistica.sales_order_invoice_attempts
  ADD CONSTRAINT sales_order_invoice_attempts_status_check CHECK (status IN (
    'PREPARED', 'LOCKED', 'SUBMITTING', 'UNKNOWN', 'CONFIRMED',
    'RECONCILIATION_REQUIRED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'CANCELLED'
  ));

DROP INDEX IF EXISTS logistica.sales_order_invoice_attempts_active_key;
CREATE UNIQUE INDEX sales_order_invoice_attempts_active_key
  ON logistica.sales_order_invoice_attempts(company_id, canonical_bsale_token, fingerprint)
  WHERE status IN ('PREPARED', 'LOCKED', 'SUBMITTING', 'UNKNOWN', 'RECONCILIATION_REQUIRED', 'FAILED_RETRYABLE');

CREATE OR REPLACE FUNCTION logistica.begin_sales_order_invoice_submission(
  p_company_id uuid,
  p_card_id uuid,
  p_current_bsale_nv_id bigint,
  p_canonical_bsale_token text,
  p_sales_id text,
  p_fingerprint text,
  p_payload_snapshot jsonb,
  p_nv_snapshot jsonb,
  p_detail_snapshots jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones AS $$
DECLARE
  c record;
  existing record;
  incompatible record;
  open_count integer;
  billable_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND (
    auth.uid() IS NULL OR NOT core.has_company_access(auth.uid(), p_company_id)
    OR NOT core.has_permission_for_company(auth.uid(), p_company_id, 'logistica.preparation.manage')
  ) THEN
    RAISE EXCEPTION 'COMPANY_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO c
  FROM logistica.sales_order_preparation_cards
  WHERE id = p_card_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'CARD_NOT_FOUND'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':invoice:' || p_card_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':invoice-token:' || p_canonical_bsale_token, 0));

  IF c.status IS DISTINCT FROM 'AUDITED'
     OR c.current_bsale_nv_id IS DISTINCT FROM p_current_bsale_nv_id
     OR c.canonical_bsale_token IS DISTINCT FROM p_canonical_bsale_token THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PREVALIDATION_FAILED', 'reason', 'CARD_SNAPSHOT_CHANGED');
  END IF;

  SELECT count(*) INTO open_count
  FROM logistica.sales_order_preparation_incidents
  WHERE company_id = p_company_id AND card_id = p_card_id AND status = 'OPEN';
  IF open_count > 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'PREVALIDATION_FAILED', 'reason', 'OPEN_COMMERCIAL_INCIDENTS'); END IF;

  SELECT count(*) INTO billable_count
  FROM jsonb_array_elements(p_detail_snapshots) line
  WHERE coalesce((line->>'billable_quantity')::numeric, 0) > 0;
  IF billable_count = 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'PREVALIDATION_FAILED', 'reason', 'ZERO_BILLABLE_SALDO'); END IF;

  SELECT * INTO incompatible
  FROM logistica.sales_order_invoice_attempts
  WHERE company_id = p_company_id
    AND canonical_bsale_token = p_canonical_bsale_token
    AND fingerprint IS DISTINCT FROM p_fingerprint
    AND status IN ('PREPARED', 'LOCKED', 'SUBMITTING', 'UNKNOWN', 'RECONCILIATION_REQUIRED', 'FAILED_RETRYABLE')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PREVALIDATION_FAILED', 'reason', 'ACTIVE_INCOMPATIBLE_ATTEMPT', 'attempt_id', incompatible.id);
  END IF;

  SELECT * INTO existing
  FROM logistica.sales_order_invoice_attempts
  WHERE company_id = p_company_id AND canonical_bsale_token = p_canonical_bsale_token AND fingerprint = p_fingerprint
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    IF existing.status = 'CONFIRMED' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_INVOICED', 'attempt_id', existing.id, 'invoice_id', existing.bsale_invoice_id);
    END IF;
    IF existing.status IN ('SUBMITTING', 'UNKNOWN', 'RECONCILIATION_REQUIRED') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVOICE_IN_PROGRESS', 'attempt_id', existing.id, 'status', existing.status, 'sales_id', existing.sales_id);
    END IF;
    UPDATE logistica.sales_order_invoice_attempts
    SET status = 'SUBMITTING', sales_id = p_sales_id, payload_snapshot = p_payload_snapshot,
        nv_snapshot = p_nv_snapshot, detail_snapshots = p_detail_snapshots,
        submitted_at = now(), started_at = coalesce(started_at, now()), updated_at = now(), last_error = null
    WHERE id = existing.id;
    RETURN jsonb_build_object('ok', true, 'code', 'SUBMITTING', 'attempt_id', existing.id, 'sales_id', p_sales_id);
  END IF;

  INSERT INTO logistica.sales_order_invoice_attempts(
    company_id, card_id, canonical_bsale_token, historical_bsale_nv_id, current_bsale_nv_id,
    sales_id, fingerprint, status, payload_snapshot, nv_snapshot, detail_snapshots,
    requested_by, started_at, submitted_at
  ) VALUES (
    p_company_id, p_card_id, p_canonical_bsale_token, c.bsale_nv_id, p_current_bsale_nv_id,
    p_sales_id, p_fingerprint, 'SUBMITTING', p_payload_snapshot, p_nv_snapshot, p_detail_snapshots,
    auth.uid(), now(), now()
  ) RETURNING id INTO existing;

  RETURN jsonb_build_object('ok', true, 'code', 'SUBMITTING', 'attempt_id', existing.id, 'sales_id', p_sales_id);
EXCEPTION WHEN unique_violation THEN
  SELECT id, status, sales_id, bsale_invoice_id INTO existing
  FROM logistica.sales_order_invoice_attempts
  WHERE company_id = p_company_id AND canonical_bsale_token = p_canonical_bsale_token AND fingerprint = p_fingerprint
  ORDER BY created_at DESC LIMIT 1;
  RETURN jsonb_build_object('ok', false, 'code', 'INVOICE_IN_PROGRESS', 'attempt_id', existing.id, 'status', existing.status, 'sales_id', existing.sales_id, 'invoice_id', existing.bsale_invoice_id);
END; $$;

CREATE OR REPLACE FUNCTION logistica.mark_sales_order_invoice_unknown(p_attempt_id uuid, p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica AS $$
BEGIN
  UPDATE logistica.sales_order_invoice_attempts
  SET status = 'UNKNOWN', last_error = left(p_error, 1000), last_reconciliation_at = now(), updated_at = now()
  WHERE id = p_attempt_id AND status = 'SUBMITTING';
  RETURN jsonb_build_object('status', (SELECT status FROM logistica.sales_order_invoice_attempts WHERE id = p_attempt_id));
END; $$;

CREATE OR REPLACE FUNCTION logistica.mark_sales_order_invoice_reconciliation_required(p_attempt_id uuid, p_error text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica AS $$
BEGIN
  UPDATE logistica.sales_order_invoice_attempts
  SET status = 'RECONCILIATION_REQUIRED', last_error = left(p_error, 1000), last_reconciliation_at = now(), updated_at = now()
  WHERE id = p_attempt_id AND status IN ('SUBMITTING', 'UNKNOWN');
  RETURN jsonb_build_object('status', (SELECT status FROM logistica.sales_order_invoice_attempts WHERE id = p_attempt_id));
END; $$;

CREATE OR REPLACE FUNCTION logistica.confirm_sales_order_invoice_attempt(
  p_attempt_id uuid,
  p_invoice_id bigint,
  p_invoice_number text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones AS $$
DECLARE
  a record;
  inv record;
  expected record;
  actual record;
  matched integer := 0;
BEGIN
  SELECT * INTO a FROM logistica.sales_order_invoice_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'ATTEMPT_NOT_FOUND'); END IF;
  IF a.status NOT IN ('SUBMITTING', 'UNKNOWN') THEN RETURN jsonb_build_object('status', a.status, 'invoice_id', a.bsale_invoice_id); END IF;

  SELECT * INTO inv
  FROM integraciones.bsale_documents
  WHERE company_id = a.company_id AND bsale_id = p_invoice_id
    AND document_type_id = 5 AND state = 0;
  IF NOT FOUND THEN
    UPDATE logistica.sales_order_invoice_attempts SET status = 'RECONCILIATION_REQUIRED', last_error = 'INVOICE_DOCUMENT_NOT_CONFIRMED', updated_at = now() WHERE id = a.id;
    RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'INVOICE_DOCUMENT_NOT_CONFIRMED');
  END IF;
  IF inv.client_id IS DISTINCT FROM (a.nv_snapshot->>'client_id')::bigint
     OR inv.office_id IS DISTINCT FROM (a.nv_snapshot->>'office_id')::integer
     OR inv.net_amount IS DISTINCT FROM (a.nv_snapshot->'totals'->>'net')::numeric
     OR inv.tax_amount IS DISTINCT FROM (a.nv_snapshot->'totals'->>'tax')::numeric
     OR inv.total_amount IS DISTINCT FROM (a.nv_snapshot->'totals'->>'total')::numeric
     OR inv.raw_json->>'salesId' IS DISTINCT FROM a.sales_id THEN
    UPDATE logistica.sales_order_invoice_attempts SET status = 'RECONCILIATION_REQUIRED', last_error = 'INVOICE_SNAPSHOT_MISMATCH', updated_at = now() WHERE id = a.id;
    RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'INVOICE_SNAPSHOT_MISMATCH');
  END IF;

  FOR expected IN SELECT * FROM jsonb_to_recordset(a.detail_snapshots) AS x(detail_id bigint, billable_quantity numeric) LOOP
    SELECT * INTO actual FROM integraciones.bsale_document_details
    WHERE company_id = a.company_id AND bsale_document_id = inv.bsale_id AND related_detail_bsale_id = expected.detail_id;
    IF NOT FOUND OR actual.quantity IS DISTINCT FROM expected.billable_quantity THEN
      UPDATE logistica.sales_order_invoice_attempts SET status = 'RECONCILIATION_REQUIRED', last_error = 'RELATED_DETAIL_ID_NOT_PROVABLE', updated_at = now() WHERE id = a.id;
      RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'RELATED_DETAIL_ID_NOT_PROVABLE', 'detail_id', expected.detail_id);
    END IF;
    matched := matched + 1;
    INSERT INTO integraciones.bsale_invoice_sales_order_links(company_id, invoice_bsale_id, invoice_detail_bsale_id, sales_order_bsale_id, sales_order_detail_bsale_id)
    VALUES (a.company_id, inv.bsale_id, actual.bsale_id, a.current_bsale_nv_id, expected.detail_id)
    ON CONFLICT DO NOTHING;
  END LOOP;
  IF matched = 0 THEN RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'reason', 'NO_RELATED_DETAILS'); END IF;

  UPDATE logistica.sales_order_invoice_attempts
  SET status = 'CONFIRMED', bsale_invoice_id = inv.bsale_id, bsale_invoice_number = coalesce(p_invoice_number, inv.number::text), confirmed_at = now(), last_reconciliation_at = now(), updated_at = now()
  WHERE id = a.id;
  UPDATE logistica.sales_order_preparation_cards
  SET status = 'INVOICED_READY_FOR_ROUTE', updated_at = now()
  WHERE id = a.card_id AND status = 'AUDITED' AND current_bsale_nv_id = a.current_bsale_nv_id;
  RETURN jsonb_build_object('status', 'CONFIRMED', 'invoice_id', inv.bsale_id, 'invoice_number', inv.number, 'matched_details', matched);
END; $$;

GRANT EXECUTE ON FUNCTION logistica.begin_sales_order_invoice_submission(uuid, uuid, bigint, text, text, text, jsonb, jsonb, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.mark_sales_order_invoice_unknown(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.mark_sales_order_invoice_reconciliation_required(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.confirm_sales_order_invoice_attempt(uuid, bigint, text) TO authenticated, service_role;

COMMIT;
