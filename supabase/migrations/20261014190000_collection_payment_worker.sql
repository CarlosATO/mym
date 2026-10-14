-- Durable collection worker claim. The worker endpoint is intentionally not scheduled.

CREATE OR REPLACE FUNCTION comercial.claim_collection_payment_batch(
  p_lease_seconds integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, comercial, public
AS $$
DECLARE
  v_batch comercial.collection_payment_batches%ROWTYPE;
  v_token uuid := gen_random_uuid();
  v_now timestamptz := now();
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLECTION_PAYMENT_INVALID_LEASE';
  END IF;

  -- One durable ASYNC_V1 worker claim may be active globally. This does not
  -- constrain the legacy synchronous batches.
  PERFORM pg_advisory_xact_lock(hashtextextended('collection-payment-worker', 0));

  IF EXISTS (
    SELECT 1 FROM comercial.collection_payment_batches
    WHERE status = 'PROCESSING'
      AND metadata->>'execution_mode' = 'ASYNC_V1'
      AND worker_token IS NOT NULL
      AND lease_expires_at > v_now
  ) THEN
    RETURN jsonb_build_object('processed', false, 'reason', 'BUSY');
  END IF;

  SELECT * INTO v_batch
  FROM comercial.collection_payment_batches
  WHERE metadata->>'execution_mode' = 'ASYNC_V1'
    AND (
      status = 'CREATED'
      OR (status = 'PROCESSING' AND (lease_expires_at IS NULL OR lease_expires_at <= v_now OR worker_token IS NULL))
    )
  ORDER BY created_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('processed', false, 'reason', 'NO_WORK');
  END IF;

  UPDATE comercial.collection_payment_batches
  SET status = 'PROCESSING',
      worker_token = v_token,
      processing_started_at = COALESCE(processing_started_at, v_now),
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      completed_at = NULL,
      updated_at = v_now
  WHERE id = v_batch.id;

  INSERT INTO portal.audit_logs (
    table_name, record_id, action, performed_by, schema_name, module_code,
    event_type, severity, metadata
  ) VALUES (
    'collection_payment_batches', v_batch.id, 'STATUS_CHANGE', v_batch.created_by,
    'comercial', 'ANALISIS_COMERCIAL_COBRANZA', 'COLLECTION_PAYMENT_BATCH_CLAIMED',
    'INFO', jsonb_build_object('batch_id', v_batch.id, 'worker_token', v_token,
      'lease_expires_at', v_now + make_interval(secs => p_lease_seconds))
  );

  RETURN jsonb_build_object('processed', true, 'batchId', v_batch.id,
    'workerToken', v_token, 'batchStatus', 'PROCESSING');
END;
$$;

REVOKE ALL ON FUNCTION comercial.claim_collection_payment_batch(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION comercial.claim_collection_payment_batch(integer) TO service_role;

CREATE OR REPLACE FUNCTION comercial.mark_collection_payment_attempt_submitting(
  p_batch_id uuid,
  p_attempt_id uuid,
  p_worker_token uuid,
  p_preflight_balance numeric,
  p_request_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, comercial, public
AS $$
DECLARE
  v_now timestamptz := now();
  v_attempt_id uuid;
BEGIN
  UPDATE comercial.collection_payment_attempts AS a
  SET preflight_balance = p_preflight_balance,
      request_payload = p_request_payload,
      status = 'SUBMITTING',
      post_started_at = v_now,
      updated_at = v_now
  WHERE a.id = p_attempt_id
    AND a.batch_id = p_batch_id
    AND a.status = 'CREATED'
    AND EXISTS (
      SELECT 1
      FROM comercial.collection_payment_batches AS b
      WHERE b.id = p_batch_id
        AND b.status = 'PROCESSING'
        AND b.worker_token = p_worker_token
        AND b.lease_expires_at > v_now
    )
  RETURNING a.id INTO v_attempt_id;

  IF v_attempt_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'STALE_LEASE_OR_ATTEMPT_CHANGED');
  END IF;

  RETURN jsonb_build_object('ok', true, 'attemptId', v_attempt_id, 'postStartedAt', v_now);
END;
$$;

REVOKE ALL ON FUNCTION comercial.mark_collection_payment_attempt_submitting(uuid, uuid, uuid, numeric, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION comercial.mark_collection_payment_attempt_submitting(uuid, uuid, uuid, numeric, jsonb)
  TO service_role;
