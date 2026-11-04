-- MEJ-01C: protect invoice eligibility with the same full-card commercial
-- consistency contract used by MEJ-01B. This migration does not write Bsale,
-- change physical preparation, or close audits.
BEGIN;

CREATE OR REPLACE FUNCTION logistica.get_sales_order_preparation_commercial_consistency_v1(
  p_company_id uuid,
  p_card_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, logistica, integraciones
AS $function$
WITH card_scope AS (
  SELECT
    c.id AS card_id,
    c.company_id,
    c.status AS card_status,
    COALESCE(c.current_bsale_nv_id, c.bsale_nv_id) AS current_nv_id,
    c.canonical_bsale_token,
    GREATEST(
      c.updated_at,
      COALESCE((SELECT max(pl.updated_at) FROM logistica.sales_order_preparation_lines pl WHERE pl.company_id = c.company_id AND pl.card_id = c.id AND pl.retired_at IS NULL), c.updated_at),
      COALESCE((SELECT max(i.created_at) FROM logistica.sales_order_preparation_incidents i WHERE i.company_id = c.company_id AND i.card_id = c.id), c.updated_at),
      COALESCE((SELECT max(i.last_verified_at) FROM logistica.sales_order_preparation_incidents i WHERE i.company_id = c.company_id AND i.card_id = c.id), c.updated_at)
    ) AS relevant_at
  FROM logistica.sales_order_preparation_cards c
  WHERE c.company_id = p_company_id
    AND c.id = p_card_id
    AND (
      auth.role() = 'service_role'
      OR (
        auth.uid() IS NOT NULL
        AND core.has_company_access(auth.uid(), p_company_id)
        AND (
          core.has_permission_for_company(auth.uid(), p_company_id, 'module.logistica.view')
          OR core.has_permission_for_company(auth.uid(), p_company_id, 'logistica.preparation.manage')
        )
      )
    )
), current_document AS (
  SELECT
    cs.*,
    d.bsale_id AS document_id,
    d.state AS document_state,
    d.synced_at AS document_synced_at,
    d.bsale_sync_run_id,
    sr.status AS sync_status,
    sr.completed_at AS sync_completed_at
  FROM card_scope cs
  LEFT JOIN integraciones.bsale_documents d
    ON d.company_id = cs.company_id
   AND d.bsale_id = cs.current_nv_id
   AND d.document_type_id = 23
  LEFT JOIN integraciones.bsale_sync_runs sr
    ON sr.id = d.bsale_sync_run_id
   AND sr.company_id = d.company_id
), prepared_raw AS (
  SELECT
    cd.card_id,
    CASE
      WHEN NULLIF(btrim(pl.sku), '') IS NOT NULL THEN 'SKU:' || upper(btrim(pl.sku))
      WHEN pl.bsale_variant_id IS NOT NULL THEN 'VARIANT:' || pl.bsale_variant_id::text
      ELSE NULL
    END AS product_key,
    pl.prepared_quantity
  FROM current_document cd
  JOIN logistica.sales_order_preparation_lines pl
    ON pl.company_id = cd.company_id
   AND pl.card_id = cd.card_id
   AND pl.retired_at IS NULL
), prepared_keys AS (
  SELECT
    card_id,
    product_key,
    count(*)::integer AS line_count,
    count(*) FILTER (WHERE prepared_quantity IS NULL)::integer AS null_quantity_count,
    sum(coalesce(prepared_quantity, 0)) AS prepared_quantity
  FROM prepared_raw
  GROUP BY card_id, product_key
), current_raw AS (
  SELECT
    cd.card_id,
    CASE
      WHEN NULLIF(btrim(det.variant_code), '') IS NOT NULL THEN 'SKU:' || upper(btrim(det.variant_code))
      WHEN det.variant_id IS NOT NULL THEN 'VARIANT:' || det.variant_id::text
      ELSE NULL
    END AS product_key,
    det.quantity
  FROM current_document cd
  JOIN integraciones.bsale_document_details det
    ON det.company_id = cd.company_id
   AND det.bsale_document_id = cd.document_id
), current_keys AS (
  SELECT
    card_id,
    product_key,
    count(*)::integer AS line_count,
    count(*) FILTER (WHERE quantity IS NULL OR quantity < 0)::integer AS invalid_quantity_count,
    sum(coalesce(quantity, 0)) AS current_quantity
  FROM current_raw
  GROUP BY card_id, product_key
), key_comparison AS (
  SELECT
    coalesce(p.card_id, c.card_id) AS card_id,
    coalesce(p.product_key, c.product_key) AS product_key,
    CASE WHEN p.prepared_quantity > 0 THEN p.prepared_quantity END AS prepared_quantity,
    c.current_quantity
  FROM prepared_keys p
  FULL JOIN current_keys c
    ON c.card_id = p.card_id
   AND c.product_key = p.product_key
  WHERE p.prepared_quantity > 0
     OR c.current_quantity IS NOT NULL
), comparison AS (
  SELECT
    cd.*,
    (
      cd.document_id IS NOT NULL
      AND cd.document_state = 0
      AND cd.bsale_sync_run_id IS NOT NULL
      AND cd.sync_status = 'COMPLETED'
      AND cd.sync_completed_at IS NOT NULL
      AND cd.sync_completed_at >= cd.relevant_at
      AND cd.document_synced_at IS NOT NULL
      AND cd.document_synced_at >= cd.relevant_at
      AND NOT EXISTS (
        SELECT 1
        FROM integraciones.bsale_document_details stale_detail
        WHERE stale_detail.company_id = cd.company_id
          AND stale_detail.bsale_document_id = cd.document_id
          AND stale_detail.bsale_sync_run_id IS DISTINCT FROM cd.bsale_sync_run_id
      )
    ) AS sync_proven,
    EXISTS (SELECT 1 FROM prepared_keys p WHERE p.card_id = cd.card_id AND p.line_count > 1) AS duplicate_prepared_key,
    EXISTS (SELECT 1 FROM prepared_keys p WHERE p.card_id = cd.card_id AND (p.product_key IS NULL OR p.null_quantity_count > 0)) AS invalid_prepared_key,
    EXISTS (SELECT 1 FROM current_keys c WHERE c.card_id = cd.card_id AND c.line_count > 1) AS duplicate_current_key,
    EXISTS (SELECT 1 FROM current_keys c WHERE c.card_id = cd.card_id AND (c.product_key IS NULL OR c.invalid_quantity_count > 0)) AS invalid_current_key,
    EXISTS (
      SELECT 1
      FROM key_comparison k
      WHERE k.card_id = cd.card_id
        AND k.prepared_quantity IS DISTINCT FROM k.current_quantity
    ) AS quantity_mismatch,
    (SELECT count(*)::integer FROM prepared_raw p WHERE p.card_id = cd.card_id) AS prepared_line_count,
    (SELECT count(*)::integer FROM current_raw c WHERE c.card_id = cd.card_id) AS current_line_count
  FROM current_document cd
), result AS (
  SELECT
    c.*,
    CASE
      WHEN c.document_id IS NULL THEN 'NOT_FOUND'
      WHEN c.document_state IS DISTINCT FROM 0 THEN 'NV_CANCELLED'
      WHEN c.card_status IS DISTINCT FROM 'AUDITED' THEN 'NOT_AUDITED'
      WHEN NOT c.sync_proven THEN 'MISMATCHED'
      WHEN c.duplicate_prepared_key OR c.invalid_prepared_key OR c.duplicate_current_key OR c.invalid_current_key THEN 'MISMATCHED'
      WHEN c.prepared_line_count = 0 THEN 'MISMATCHED'
      WHEN c.quantity_mismatch THEN 'MISMATCHED'
      ELSE 'MATCHED'
    END AS status
  FROM comparison c
)
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM result) THEN jsonb_build_object('status', 'CARD_NOT_FOUND', 'ok', false)
  ELSE (
    SELECT jsonb_build_object(
      'status', r.status,
      'ok', r.status = 'MATCHED',
      'card_id', r.card_id,
      'card_status', r.card_status,
      'historical_nv_id', (SELECT c.bsale_nv_id FROM logistica.sales_order_preparation_cards c WHERE c.id = r.card_id),
      'current_nv_id', r.current_nv_id,
      'canonical_bsale_token', r.canonical_bsale_token,
      'document_id', r.document_id,
      'document_state', r.document_state,
      'sync_proven', r.sync_proven,
      'sync_run_id', r.bsale_sync_run_id,
      'sync_status', r.sync_status,
      'sync_completed_at', r.sync_completed_at,
      'relevant_at', r.relevant_at,
      'prepared_line_count', r.prepared_line_count,
      'current_line_count', r.current_line_count,
      'reason', CASE
        WHEN r.status = 'NOT_FOUND' THEN 'CURRENT_NV_NOT_FOUND'
        WHEN r.status = 'NV_CANCELLED' THEN 'CURRENT_NV_NOT_ACTIVE'
        WHEN r.status = 'NOT_AUDITED' THEN 'PHYSICAL_AUDIT_NOT_CLOSED'
        WHEN NOT r.sync_proven THEN 'COMMERCIAL_SYNC_NOT_VERIFIED'
        WHEN r.duplicate_prepared_key OR r.duplicate_current_key THEN 'DUPLICATE_COMMERCIAL_IDENTITY'
        WHEN r.invalid_prepared_key OR r.invalid_current_key THEN 'COMMERCIAL_IDENTITY_INCOMPLETE'
        WHEN r.prepared_line_count = 0 THEN 'PREPARATION_LINES_NOT_AVAILABLE'
        WHEN r.quantity_mismatch THEN 'PREPARED_QUANTITY_MISMATCH'
        ELSE NULL
      END
    )
    FROM result r
  )
END;
$function$;

CREATE OR REPLACE VIEW logistica.vw_sales_order_route_readiness AS
SELECT
  c.id AS card_id,
  c.company_id,
  COALESCE(c.current_bsale_nv_id, c.bsale_nv_id) AS bsale_nv_id,
  c.bsale_nv_folio,
  (COALESCE(oc.open_count, 0) > 0) AS has_open_commercial_incidents,
  COALESCE(oc.open_count, 0)::integer AS open_commercial_incident_count,
  CASE
    WHEN d.bsale_id IS NULL OR d.state IS DISTINCT FROM 0 OR c.closed_at IS NOT NULL THEN 'BLOCKED'
    WHEN consistency.payload->>'status' IS DISTINCT FROM 'MATCHED' THEN 'BLOCKED'
    WHEN COALESCE(oc.open_count, 0) > 0 THEN 'INCIDENTS'
    ELSE 'READY_TO_INVOICE'
  END AS route_readiness,
  d.state AS bsale_nv_state,
  (d.bsale_id IS NOT NULL) AS bsale_nv_found
FROM logistica.sales_order_preparation_cards c
LEFT JOIN integraciones.bsale_documents d
  ON d.company_id = c.company_id
 AND d.bsale_id = COALESCE(c.current_bsale_nv_id, c.bsale_nv_id)
 AND d.document_type_id = 23
LEFT JOIN LATERAL (
  SELECT logistica.get_sales_order_preparation_commercial_consistency_v1(c.company_id, c.id) AS payload
) consistency ON true
LEFT JOIN (
  SELECT i.card_id, count(*)::integer AS open_count
  FROM logistica.sales_order_preparation_incidents i
  WHERE i.status = 'OPEN'
  GROUP BY i.card_id
) oc ON oc.card_id = c.id
WHERE c.status = 'AUDITED';

ALTER VIEW logistica.vw_sales_order_route_readiness SET (security_invoker = true);
GRANT SELECT ON logistica.vw_sales_order_route_readiness TO authenticated, service_role;

CREATE OR REPLACE FUNCTION logistica.invoice_attempt_prevalidate(
  p_company_id uuid,
  p_card_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones
AS $function$
DECLARE
  card_row record;
  doc_row record;
  line_row record;
  line_count integer;
  open_count integer;
  consumed numeric;
  current_qty numeric;
  billable_lines integer := 0;
  document_sale_condition_raw text;
  document_sale_condition_id bigint;
  client_sale_condition_id bigint;
  blockers jsonb := '[]'::jsonb;
  consistency jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND (
    auth.uid() IS NULL
    OR NOT core.has_company_access(auth.uid(), p_company_id)
    OR NOT core.has_permission_for_company(auth.uid(), p_company_id, 'logistica.preparation.manage')
  ) THEN
    RAISE EXCEPTION 'COMPANY_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  SELECT card.*, canon.current_bsale_id AS resolved_current_bsale_nv_id,
         canon.canonical_bsale_token AS resolved_canonical_bsale_token
    INTO card_row
  FROM logistica.sales_order_preparation_cards card
  LEFT JOIN integraciones.vw_bsale_sales_order_documents_canonical canon
    ON canon.company_id = card.company_id
   AND canon.canonical_bsale_token = card.canonical_bsale_token
  WHERE card.id = p_card_id AND card.company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ready', false, 'blockers', jsonb_build_array('CARD_NOT_FOUND'));
  END IF;

  IF card_row.status IS DISTINCT FROM 'AUDITED' THEN blockers := blockers || jsonb_build_array('STATUS_NOT_AUDITED'); END IF;
  IF card_row.closed_at IS NOT NULL THEN blockers := blockers || jsonb_build_array('READINESS_NOT_READY_TO_INVOICE'); END IF;
  IF card_row.canonical_bsale_token IS NULL THEN blockers := blockers || jsonb_build_array('CANONICAL_TOKEN_INVALID'); END IF;
  IF card_row.resolved_current_bsale_nv_id IS NULL THEN blockers := blockers || jsonb_build_array('CURRENT_BSALE_NV_ID_REQUIRED'); END IF;

  SELECT doc.* INTO doc_row
  FROM integraciones.bsale_documents doc
  WHERE doc.company_id = p_company_id
    AND doc.bsale_id = card_row.resolved_current_bsale_nv_id;
  IF NOT FOUND THEN
    blockers := blockers || jsonb_build_array('CURRENT_DOCUMENT_NOT_FOUND');
  ELSE
    IF doc_row.document_type_id IS DISTINCT FROM 23 THEN blockers := blockers || jsonb_build_array('DOCUMENT_TYPE_NOT_SALES_ORDER'); END IF;
    IF doc_row.state IS DISTINCT FROM 0 THEN blockers := blockers || jsonb_build_array('BSALE_STATE_NOT_ACTIVE'); END IF;
    IF doc_row.client_id IS NULL OR NOT EXISTS (SELECT 1 FROM integraciones.bsale_clients x WHERE x.company_id = p_company_id AND x.bsale_id = doc_row.client_id) THEN blockers := blockers || jsonb_build_array('CLIENT_INVALID'); END IF;
    IF doc_row.office_id IS NULL THEN blockers := blockers || jsonb_build_array('OFFICE_INVALID'); END IF;

    document_sale_condition_raw := NULLIF(COALESCE(doc_row.raw_json->'saleCondition'->>'id', doc_row.raw_json->'sale_condition'->>'id'), '');
    IF document_sale_condition_raw IS NOT NULL THEN
      IF document_sale_condition_raw !~ '^[0-9]+$' OR NOT pg_input_is_valid(document_sale_condition_raw, 'bigint') THEN
        blockers := blockers || jsonb_build_array('NOT_READY_CONTRACT');
      ELSE
        document_sale_condition_id := document_sale_condition_raw::bigint;
        IF NOT EXISTS (
          SELECT 1 FROM integraciones.bsale_sale_conditions condition_row
          WHERE condition_row.company_id = p_company_id
            AND condition_row.bsale_id = document_sale_condition_id
            AND condition_row.state = 0
        ) THEN blockers := blockers || jsonb_build_array('NOT_READY_CONTRACT'); END IF;
      END IF;
    ELSE
      SELECT client_row.sale_condition_id INTO client_sale_condition_id
      FROM integraciones.bsale_clients client_row
      JOIN integraciones.bsale_sale_conditions condition_row
        ON condition_row.company_id = client_row.company_id
       AND condition_row.bsale_id = client_row.sale_condition_id
       AND condition_row.state = 0
      WHERE client_row.company_id = p_company_id
        AND client_row.bsale_id = doc_row.client_id;
      IF client_sale_condition_id IS NULL THEN blockers := blockers || jsonb_build_array('NOT_READY_CONTRACT'); END IF;
    END IF;
  END IF;

  consistency := logistica.get_sales_order_preparation_commercial_consistency_v1(p_company_id, p_card_id);
  IF consistency->>'status' IS DISTINCT FROM 'MATCHED' THEN
    blockers := blockers || jsonb_build_array('COMMERCIAL_RECONCILIATION_REQUIRED:' || COALESCE(consistency->>'reason', consistency->>'status', 'UNKNOWN'));
  END IF;

  SELECT count(*) INTO open_count
  FROM logistica.sales_order_preparation_incidents i
  WHERE i.company_id = p_company_id AND i.card_id = p_card_id AND i.status = 'OPEN';
  IF open_count > 0 THEN blockers := blockers || jsonb_build_array('OPEN_COMMERCIAL_INCIDENTS'); END IF;

  SELECT count(*) INTO line_count
  FROM integraciones.bsale_document_details x
  WHERE x.company_id = p_company_id AND x.bsale_document_id = card_row.resolved_current_bsale_nv_id;
  IF line_count = 0 THEN blockers := blockers || jsonb_build_array('DETAILS_MISSING'); END IF;
  FOR line_row IN SELECT x.* FROM integraciones.bsale_document_details x WHERE x.company_id = p_company_id AND x.bsale_document_id = card_row.resolved_current_bsale_nv_id LOOP
    SELECT coalesce(sum(invdet.quantity), 0) INTO consumed
    FROM integraciones.bsale_invoice_sales_order_links l
    JOIN integraciones.bsale_document_details invdet ON invdet.company_id = l.company_id AND invdet.bsale_id = l.invoice_detail_bsale_id
    JOIN integraciones.bsale_documents inv ON inv.company_id = l.company_id AND inv.bsale_id = l.invoice_bsale_id AND inv.document_type_id = 5
    WHERE l.company_id = p_company_id AND l.sales_order_bsale_id = card_row.resolved_current_bsale_nv_id AND l.sales_order_detail_bsale_id = line_row.bsale_id AND inv.state = 0;
    current_qty := coalesce(line_row.quantity, 0);
    IF current_qty <= 0 THEN blockers := blockers || jsonb_build_array('INVALID_QUANTITY:' || line_row.bsale_id); END IF;
    IF consumed > current_qty THEN blockers := blockers || jsonb_build_array('OVERCONSUMED:' || line_row.bsale_id); END IF;
    IF current_qty > consumed THEN billable_lines := billable_lines + 1; END IF;
  END LOOP;
  IF line_count > 0 AND billable_lines = 0 THEN blockers := blockers || jsonb_build_array('ZERO_BILLABLE_SALDO'); END IF;
  RETURN jsonb_build_object(
    'ready', jsonb_array_length(blockers) = 0,
    'card_id', p_card_id,
    'current_bsale_nv_id', card_row.resolved_current_bsale_nv_id,
    'historical_bsale_nv_id', card_row.bsale_nv_id,
    'commercial_consistency', consistency,
    'blockers', blockers
  );
END;
$function$;

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
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones
AS $function$
DECLARE
  c record;
  existing record;
  incompatible record;
  open_count integer;
  billable_count integer;
  next_retry_count integer;
  consistency jsonb;
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

  consistency := logistica.get_sales_order_preparation_commercial_consistency_v1(p_company_id, p_card_id);
  IF consistency->>'status' IS DISTINCT FROM 'MATCHED' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'PREVALIDATION_FAILED',
      'reason', 'COMMERCIAL_RECONCILIATION_REQUIRED',
      'commercial_consistency', consistency
    );
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
  IF FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'PREVALIDATION_FAILED', 'reason', 'ACTIVE_INCOMPATIBLE_ATTEMPT', 'attempt_id', incompatible.id); END IF;

  SELECT * INTO existing
  FROM logistica.sales_order_invoice_attempts
  WHERE company_id = p_company_id AND canonical_bsale_token = p_canonical_bsale_token AND fingerprint = p_fingerprint
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    IF existing.status = 'CONFIRMED' THEN RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_INVOICED', 'attempt_id', existing.id, 'invoice_id', existing.bsale_invoice_id); END IF;
    IF existing.status IN ('SUBMITTING', 'UNKNOWN', 'RECONCILIATION_REQUIRED') THEN RETURN jsonb_build_object('ok', false, 'code', 'INVOICE_IN_PROGRESS', 'attempt_id', existing.id, 'status', existing.status, 'sales_id', existing.sales_id, 'fingerprint', existing.fingerprint, 'retry_count', existing.retry_count); END IF;
    IF existing.status = 'FAILED_RETRYABLE' THEN
      IF existing.sales_id IS DISTINCT FROM p_sales_id OR existing.fingerprint IS DISTINCT FROM p_fingerprint THEN RETURN jsonb_build_object('ok', false, 'code', 'PREVALIDATION_FAILED', 'reason', 'ATTEMPT_IDENTITY_MISMATCH', 'attempt_id', existing.id, 'sales_id', existing.sales_id, 'fingerprint', existing.fingerprint); END IF;
      next_retry_count := existing.retry_count + 1;
      UPDATE logistica.sales_order_invoice_attempts
      SET status = 'SUBMITTING', effective_payload_snapshot = p_payload_snapshot,
          payload_history = payload_history || jsonb_build_array(jsonb_build_object('phase', 'RETRY', 'retry_count', next_retry_count, 'payload', p_payload_snapshot, 'captured_at', now())),
          nv_snapshot = p_nv_snapshot, detail_snapshots = p_detail_snapshots, retry_count = next_retry_count,
          submitted_at = now(), started_at = coalesce(started_at, now()), updated_at = now(), last_error = null
      WHERE id = existing.id;
      RETURN jsonb_build_object('ok', true, 'code', 'SUBMITTING', 'attempt_id', existing.id, 'sales_id', existing.sales_id, 'fingerprint', existing.fingerprint, 'retry_count', next_retry_count);
    END IF;
    UPDATE logistica.sales_order_invoice_attempts
    SET status = 'SUBMITTING', effective_payload_snapshot = p_payload_snapshot,
        payload_history = payload_history || jsonb_build_array(jsonb_build_object('phase', 'RETRY', 'retry_count', retry_count, 'payload', p_payload_snapshot, 'captured_at', now())),
        nv_snapshot = p_nv_snapshot, detail_snapshots = p_detail_snapshots, submitted_at = now(),
        started_at = coalesce(started_at, now()), updated_at = now(), last_error = null
    WHERE id = existing.id;
    RETURN jsonb_build_object('ok', true, 'code', 'SUBMITTING', 'attempt_id', existing.id, 'sales_id', existing.sales_id, 'fingerprint', existing.fingerprint, 'retry_count', existing.retry_count);
  END IF;

  INSERT INTO logistica.sales_order_invoice_attempts(
    company_id, card_id, canonical_bsale_token, historical_bsale_nv_id, current_bsale_nv_id,
    sales_id, fingerprint, status, payload_snapshot, effective_payload_snapshot, payload_history,
    nv_snapshot, detail_snapshots, requested_by, started_at, submitted_at
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
END;
$function$;

REVOKE ALL ON FUNCTION logistica.get_sales_order_preparation_commercial_consistency_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.get_sales_order_preparation_commercial_consistency_v1(uuid, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.invoice_attempt_prevalidate(uuid, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.begin_sales_order_invoice_submission(uuid, uuid, bigint, text, text, text, jsonb, jsonb, jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION logistica.get_sales_order_preparation_commercial_consistency_v1(uuid, uuid) IS
  'MEJ-01C read-only commercial gate shared by route readiness, invoice prevalidation, and invoice submission.';

COMMIT;
