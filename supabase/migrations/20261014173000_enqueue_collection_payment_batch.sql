-- Atomic asynchronous enqueue only. This migration does not call Bsale or
-- change the existing synchronous collection payment flow.

CREATE OR REPLACE FUNCTION comercial.enqueue_collection_payment_batch(
  p_company_id uuid,
  p_client_id bigint,
  p_payment_type_id integer,
  p_record_date date,
  p_created_by uuid,
  p_documents jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, comercial, public
AS $$
DECLARE
  v_batch_id uuid;
  v_document_count integer;
  v_raw_expected_total numeric;
  v_expected_total numeric(14,2);
BEGIN
  IF p_company_id IS NULL OR p_client_id IS NULL OR p_client_id <= 0
     OR p_payment_type_id IS NULL OR p_record_date IS NULL OR p_created_by IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLECTION_PAYMENT_INVALID_CONTEXT';
  END IF;

  IF p_documents IS NULL OR jsonb_typeof(p_documents) <> 'array'
     OR jsonb_array_length(p_documents) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLECTION_PAYMENT_DOCUMENTS_EMPTY';
  END IF;

  -- Serialize the not-yet-enforced per-client batch invariant. A future
  -- cutover can replace this with a permanent database constraint.
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':' || p_client_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM comercial.collection_payment_batches
    WHERE company_id = p_company_id
      AND client_id = p_client_id
      AND status IN ('CREATED', 'PROCESSING', 'UNKNOWN')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLECTION_PAYMENT_CLIENT_BATCH_ACTIVE';
  END IF;

  SELECT count(*), sum(d.amount)
  INTO v_document_count, v_raw_expected_total
  FROM jsonb_to_recordset(p_documents) AS d(
    "documentId" bigint,
    amount numeric,
    "sequenceNumber" integer
  );

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_documents) AS d(
      "documentId" bigint,
      amount numeric,
      "sequenceNumber" integer
    )
    WHERE d."documentId" IS NULL OR d."documentId" <= 0
       OR d.amount IS NULL OR d.amount <= 0
       OR d."sequenceNumber" IS NULL OR d."sequenceNumber" <= 0
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLECTION_PAYMENT_DOCUMENT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_documents) AS d(
      "documentId" bigint,
      amount numeric,
      "sequenceNumber" integer
    )
    GROUP BY d."documentId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLECTION_PAYMENT_DOCUMENT_DUPLICATE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_documents) AS d(
      "documentId" bigint,
      amount numeric,
      "sequenceNumber" integer
    )
    GROUP BY d."sequenceNumber"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLECTION_PAYMENT_SEQUENCE_DUPLICATE';
  END IF;

  IF v_raw_expected_total IS NULL OR v_raw_expected_total <= 0
     OR v_raw_expected_total <> v_raw_expected_total::numeric(14,2) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLECTION_PAYMENT_TOTAL_INVALID';
  END IF;
  v_expected_total := v_raw_expected_total::numeric(14,2);

  IF (SELECT min(d."sequenceNumber") FROM jsonb_to_recordset(p_documents) AS d(
        "documentId" bigint, amount numeric, "sequenceNumber" integer
      )) <> 1
     OR (SELECT max(d."sequenceNumber") FROM jsonb_to_recordset(p_documents) AS d(
        "documentId" bigint, amount numeric, "sequenceNumber" integer
      )) <> v_document_count
     OR (SELECT count(DISTINCT d."sequenceNumber") FROM jsonb_to_recordset(p_documents) AS d(
        "documentId" bigint, amount numeric, "sequenceNumber" integer
      )) <> v_document_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLECTION_PAYMENT_SEQUENCE_GAP';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM comercial.collection_payment_attempts a
    JOIN jsonb_to_recordset(p_documents) AS d(
      "documentId" bigint,
      amount numeric,
      "sequenceNumber" integer
    ) ON d."documentId" = a.bsale_document_id
    WHERE a.company_id = p_company_id
      AND a.status IN ('CREATED', 'SUBMITTING', 'UNKNOWN', 'REQUIRES_REVIEW')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COLLECTION_PAYMENT_DOCUMENT_ACTIVE';
  END IF;

  INSERT INTO comercial.collection_payment_batches (
    company_id, client_id, payment_type_id, record_date, expected_total,
    confirmed_total, status, created_by, metadata, completed_at,
    processing_started_at, lease_expires_at, worker_token, updated_at
  ) VALUES (
    p_company_id, p_client_id, p_payment_type_id, p_record_date, v_expected_total,
    0, 'CREATED', p_created_by,
    jsonb_build_object('execution_mode', 'ASYNC_V1', 'expected_documents', v_document_count),
    NULL, NULL, NULL, NULL, pg_catalog.now()
  )
  RETURNING id INTO v_batch_id;

  INSERT INTO comercial.collection_payment_attempts (
    company_id, client_id, bsale_document_id, idempotency_key, amount,
    payment_type_id, record_date, status, batch_id, created_by, sequence_number,
    preflight_balance, post_balance, post_started_at, bsale_payment_id,
    confirmed_at
  )
  SELECT p_company_id, p_client_id, d."documentId",
    v_batch_id::text || ':' || d."sequenceNumber"::text,
    d.amount, p_payment_type_id, p_record_date, 'CREATED', v_batch_id,
    p_created_by, d."sequenceNumber", NULL, NULL, NULL, NULL, NULL
  FROM jsonb_to_recordset(p_documents) AS d(
    "documentId" bigint,
    amount numeric(14,2),
    "sequenceNumber" integer
  );

  INSERT INTO portal.audit_logs (
    table_name, record_id, action, performed_by, schema_name, module_code,
    event_type, severity, metadata
  ) VALUES (
    'collection_payment_batches', v_batch_id, 'INSERT', p_created_by,
    'comercial', 'ANALISIS_COMERCIAL_COBRANZA',
    'COLLECTION_PAYMENT_BATCH_QUEUED', 'INFO',
    jsonb_build_object(
      'company_id', p_company_id,
      'client_id', p_client_id,
      'batch_id', v_batch_id,
      'expected_total', v_expected_total,
      'expected_documents', v_document_count,
      'payment_type_id', p_payment_type_id
    )
  );

  RETURN jsonb_build_object(
    'batchId', v_batch_id,
    'clientId', p_client_id,
    'status', 'CREATED',
    'expectedTotal', v_expected_total,
    'expectedDocuments', v_document_count,
    'documents', (
      SELECT jsonb_agg(jsonb_build_object(
        'attemptId', a.id,
        'sequenceNumber', a.sequence_number,
        'documentId', a.bsale_document_id,
        'amount', a.amount,
        'status', a.status
      ) ORDER BY a.sequence_number)
      FROM comercial.collection_payment_attempts a
      WHERE a.batch_id = v_batch_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION comercial.enqueue_collection_payment_batch(uuid, bigint, integer, date, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION comercial.enqueue_collection_payment_batch(uuid, bigint, integer, date, uuid, jsonb)
  TO service_role;
