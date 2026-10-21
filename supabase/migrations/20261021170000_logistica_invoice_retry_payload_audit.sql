-- Retry audit: preserve the first payload and record the effective retry payload.

BEGIN;

ALTER TABLE logistica.sales_order_invoice_attempts
  ADD COLUMN IF NOT EXISTS effective_payload_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS payload_history jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE logistica.sales_order_invoice_attempts
SET effective_payload_snapshot = CASE
      WHEN effective_payload_snapshot = '{}'::jsonb THEN payload_snapshot
      ELSE effective_payload_snapshot
    END,
    payload_history = CASE
      WHEN payload_history = '[]'::jsonb THEN jsonb_build_array(jsonb_build_object(
        'phase', 'INITIAL',
        'payload', payload_snapshot,
        'captured_at', created_at
      ))
      ELSE payload_history
    END
WHERE effective_payload_snapshot = '{}'::jsonb OR payload_history = '[]'::jsonb;

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
  next_retry_count integer;
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
      RETURN jsonb_build_object('ok', false, 'code', 'INVOICE_IN_PROGRESS', 'attempt_id', existing.id, 'status', existing.status, 'sales_id', existing.sales_id, 'fingerprint', existing.fingerprint, 'retry_count', existing.retry_count);
    END IF;
    IF existing.status = 'FAILED_RETRYABLE' THEN
      IF existing.sales_id IS DISTINCT FROM p_sales_id OR existing.fingerprint IS DISTINCT FROM p_fingerprint THEN
        RETURN jsonb_build_object('ok', false, 'code', 'PREVALIDATION_FAILED', 'reason', 'ATTEMPT_IDENTITY_MISMATCH', 'attempt_id', existing.id, 'sales_id', existing.sales_id, 'fingerprint', existing.fingerprint);
      END IF;
      next_retry_count := existing.retry_count + 1;
      UPDATE logistica.sales_order_invoice_attempts
      SET status = 'SUBMITTING',
          effective_payload_snapshot = p_payload_snapshot,
          payload_history = payload_history || jsonb_build_array(jsonb_build_object('phase', 'RETRY', 'retry_count', next_retry_count, 'payload', p_payload_snapshot, 'captured_at', now())),
          nv_snapshot = p_nv_snapshot,
          detail_snapshots = p_detail_snapshots,
          retry_count = next_retry_count,
          submitted_at = now(),
          started_at = coalesce(started_at, now()),
          updated_at = now(),
          last_error = null
      WHERE id = existing.id;
      RETURN jsonb_build_object('ok', true, 'code', 'SUBMITTING', 'attempt_id', existing.id, 'sales_id', existing.sales_id, 'fingerprint', existing.fingerprint, 'retry_count', next_retry_count);
    END IF;
    UPDATE logistica.sales_order_invoice_attempts
    SET status = 'SUBMITTING',
        effective_payload_snapshot = p_payload_snapshot,
        payload_history = payload_history || jsonb_build_array(jsonb_build_object('phase', 'RETRY', 'retry_count', retry_count, 'payload', p_payload_snapshot, 'captured_at', now())),
        nv_snapshot = p_nv_snapshot,
        detail_snapshots = p_detail_snapshots,
        submitted_at = now(),
        started_at = coalesce(started_at, now()),
        updated_at = now(),
        last_error = null
    WHERE id = existing.id;
    RETURN jsonb_build_object('ok', true, 'code', 'SUBMITTING', 'attempt_id', existing.id, 'sales_id', existing.sales_id, 'fingerprint', existing.fingerprint, 'retry_count', existing.retry_count);
  END IF;

  INSERT INTO logistica.sales_order_invoice_attempts(
    company_id, card_id, canonical_bsale_token, historical_bsale_nv_id, current_bsale_nv_id,
    sales_id, fingerprint, status, payload_snapshot, effective_payload_snapshot, payload_history, nv_snapshot, detail_snapshots,
    requested_by, started_at, submitted_at
  ) VALUES (
    p_company_id, p_card_id, p_canonical_bsale_token, c.bsale_nv_id, p_current_bsale_nv_id,
    p_sales_id, p_fingerprint, 'SUBMITTING', p_payload_snapshot, p_payload_snapshot,
    jsonb_build_array(jsonb_build_object('phase', 'INITIAL', 'payload', p_payload_snapshot, 'captured_at', now())),
    p_nv_snapshot, p_detail_snapshots, auth.uid(), now(), now()
  ) RETURNING id INTO existing;

  RETURN jsonb_build_object('ok', true, 'code', 'SUBMITTING', 'attempt_id', existing.id, 'sales_id', p_sales_id, 'fingerprint', p_fingerprint, 'retry_count', 0);
EXCEPTION WHEN unique_violation THEN
  SELECT id, status, sales_id, fingerprint, bsale_invoice_id, retry_count INTO existing
  FROM logistica.sales_order_invoice_attempts
  WHERE company_id = p_company_id AND canonical_bsale_token = p_canonical_bsale_token AND fingerprint = p_fingerprint
  ORDER BY created_at DESC LIMIT 1;
  RETURN jsonb_build_object('ok', false, 'code', 'INVOICE_IN_PROGRESS', 'attempt_id', existing.id, 'status', existing.status, 'sales_id', existing.sales_id, 'fingerprint', existing.fingerprint, 'invoice_id', existing.bsale_invoice_id, 'retry_count', existing.retry_count);
END; $$;

GRANT EXECUTE ON FUNCTION logistica.begin_sales_order_invoice_submission(uuid, uuid, bigint, text, text, text, jsonb, jsonb, jsonb) TO authenticated, service_role;

COMMIT;
