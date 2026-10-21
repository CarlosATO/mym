-- Allows an UNKNOWN invoice attempt to be explicitly classified as retryable
-- after a read-only Bsale reconciliation finds no created document.

BEGIN;

CREATE OR REPLACE FUNCTION logistica.mark_sales_order_invoice_retryable(
  p_attempt_id uuid,
  p_error text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica AS $$
DECLARE
  a record;
BEGIN
  SELECT * INTO a
  FROM logistica.sales_order_invoice_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'ATTEMPT_NOT_FOUND');
  END IF;

  IF auth.role() IS DISTINCT FROM 'service_role' AND (
    auth.uid() IS NULL OR NOT core.has_company_access(auth.uid(), a.company_id)
    OR NOT core.has_permission_for_company(auth.uid(), a.company_id, 'logistica.preparation.manage')
  ) THEN
    RAISE EXCEPTION 'COMPANY_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  IF a.status NOT IN ('UNKNOWN', 'RECONCILIATION_REQUIRED') THEN
    RETURN jsonb_build_object('status', a.status, 'attempt_id', a.id);
  END IF;

  UPDATE logistica.sales_order_invoice_attempts
  SET status = 'FAILED_RETRYABLE',
      last_error = left(coalesce(p_error, last_error, 'RETRYABLE_AFTER_RECONCILIATION'), 1000),
      updated_at = now()
  WHERE id = a.id;

  RETURN jsonb_build_object(
    'status', 'FAILED_RETRYABLE',
    'attempt_id', a.id,
    'sales_id', a.sales_id,
    'fingerprint', a.fingerprint,
    'retry_count', a.retry_count
  );
END; $$;

GRANT EXECUTE ON FUNCTION logistica.mark_sales_order_invoice_retryable(uuid, text) TO authenticated, service_role;

COMMIT;
