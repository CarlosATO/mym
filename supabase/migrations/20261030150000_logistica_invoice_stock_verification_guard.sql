-- FAC-STOCK-01D1: evidencia inmutable y guarda SQL para nuevas confirmaciones.
-- Esta migracion no consulta ni escribe Bsale. FAC-STOCK-01D2 debe registrar
-- evidencia mediante la RPC de servicio antes de confirmar un intento nuevo.
BEGIN;

CREATE TABLE logistica.sales_order_invoice_stock_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  attempt_id uuid NOT NULL REFERENCES logistica.sales_order_invoice_attempts(id),
  invoice_bsale_id bigint NOT NULL,
  sales_id text NOT NULL,
  attempt_fingerprint text NOT NULL,
  office_id integer NOT NULL,
  verification_status text NOT NULL DEFAULT 'VERIFIED'
    CHECK (verification_status = 'VERIFIED'),
  source text NOT NULL DEFAULT 'BSALE_GET'
    CHECK (source = 'BSALE_GET'),
  shipping_ids bigint[] NOT NULL,
  active_shipping_ids bigint[] NOT NULL,
  raw_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_invoice_stock_verifications_shipping_ids_ck
    CHECK (cardinality(shipping_ids) > 0 AND cardinality(active_shipping_ids) > 0),
  CONSTRAINT sales_order_invoice_stock_verifications_identity_uk
    UNIQUE (company_id, attempt_id)
);

CREATE TABLE logistica.sales_order_invoice_stock_verification_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id uuid NOT NULL REFERENCES logistica.sales_order_invoice_stock_verifications(id) ON DELETE RESTRICT,
  line_key text NOT NULL,
  variant_id bigint,
  sku text,
  expected_quantity numeric NOT NULL CHECK (expected_quantity > 0),
  dispatched_quantity numeric NOT NULL CHECK (dispatched_quantity > 0),
  shipping_ids bigint[] NOT NULL,
  CONSTRAINT sales_order_invoice_stock_verification_lines_product_ck
    CHECK (variant_id IS NOT NULL OR nullif(btrim(sku), '') IS NOT NULL),
  CONSTRAINT sales_order_invoice_stock_verification_lines_quantity_ck
    CHECK (expected_quantity = dispatched_quantity),
  CONSTRAINT sales_order_invoice_stock_verification_lines_shipping_ck
    CHECK (cardinality(shipping_ids) > 0),
  CONSTRAINT sales_order_invoice_stock_verification_lines_key_uk
    UNIQUE (verification_id, line_key)
);

CREATE INDEX sales_order_invoice_stock_verifications_invoice_idx
  ON logistica.sales_order_invoice_stock_verifications(company_id, invoice_bsale_id);

CREATE INDEX sales_order_invoice_stock_verification_lines_verification_idx
  ON logistica.sales_order_invoice_stock_verification_lines(verification_id);

ALTER TABLE logistica.sales_order_invoice_stock_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.sales_order_invoice_stock_verification_lines ENABLE ROW LEVEL SECURITY;

-- La evidencia sólo se escribe mediante record_...(), nunca por DML directo.
REVOKE ALL ON TABLE logistica.sales_order_invoice_stock_verifications
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE logistica.sales_order_invoice_stock_verification_lines
  FROM PUBLIC, anon, authenticated, service_role;

-- The application reads attempts directly, but all attempt writes already go
-- through SECURITY DEFINER RPCs. Remove the direct authenticated DML path.
REVOKE INSERT, UPDATE, DELETE ON TABLE logistica.sales_order_invoice_attempts
  FROM authenticated;

CREATE OR REPLACE FUNCTION logistica.prevent_invoice_stock_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, logistica
AS $function$
BEGIN
  RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_IMMUTABLE';
END;
$function$;

CREATE TRIGGER sales_order_invoice_stock_verifications_immutable
BEFORE UPDATE OR DELETE ON logistica.sales_order_invoice_stock_verifications
FOR EACH ROW EXECUTE FUNCTION logistica.prevent_invoice_stock_evidence_mutation();

CREATE TRIGGER sales_order_invoice_stock_verification_lines_immutable
BEFORE UPDATE OR DELETE ON logistica.sales_order_invoice_stock_verification_lines
FOR EACH ROW EXECUTE FUNCTION logistica.prevent_invoice_stock_evidence_mutation();

CREATE OR REPLACE FUNCTION logistica.record_sales_order_invoice_stock_evidence(
  p_company_id uuid,
  p_attempt_id uuid,
  p_invoice_bsale_id bigint,
  p_sales_id text,
  p_attempt_fingerprint text,
  p_office_id integer,
  p_shipping_ids bigint[],
  p_active_shipping_ids bigint[],
  p_lines jsonb,
  p_raw_evidence jsonb DEFAULT '{}'::jsonb,
  p_verified_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones
AS $function$
DECLARE
  a record;
  inv record;
  existing record;
  line_count integer;
  operational_conflict boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_SERVICE_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_lines) = 0
     OR coalesce(cardinality(p_shipping_ids), 0) = 0
     OR coalesce(cardinality(p_active_shipping_ids), 0) = 0 THEN
    RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_INCOMPLETE';
  END IF;
  IF p_verified_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_FUTURE_DATE';
  END IF;
  IF EXISTS (
       SELECT 1
       FROM unnest(p_shipping_ids) AS u(shipping_id)
       WHERE shipping_id IS NULL OR shipping_id <= 0
     )
     OR EXISTS (
       SELECT shipping_id
       FROM unnest(p_shipping_ids) AS u(shipping_id)
       GROUP BY shipping_id
       HAVING count(*) > 1
     )
     OR EXISTS (
       SELECT 1
       FROM unnest(p_active_shipping_ids) AS u(shipping_id)
       WHERE shipping_id IS NULL OR shipping_id <= 0
     )
     OR EXISTS (
       SELECT shipping_id
       FROM unnest(p_active_shipping_ids) AS u(shipping_id)
       GROUP BY shipping_id
       HAVING count(*) > 1
     )
     OR EXISTS (
       SELECT 1
       FROM unnest(p_active_shipping_ids) AS u(shipping_id)
       WHERE NOT (shipping_id = ANY(p_shipping_ids))
     ) THEN
    RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_SHIPPING_SET_INVALID';
  END IF;

  SELECT * INTO a
  FROM logistica.sales_order_invoice_attempts
  WHERE id = p_attempt_id
  -- Serialize evidence writers for the same attempt. The unique constraint
  -- remains the final database invariant, while this lock makes equivalent
  -- concurrent calls return the same existing verification deterministically.
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ATTEMPT_NOT_FOUND'; END IF;
  IF a.company_id IS DISTINCT FROM p_company_id
     OR a.sales_id IS DISTINCT FROM p_sales_id
     OR a.fingerprint IS DISTINCT FROM p_attempt_fingerprint THEN
    RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_ATTEMPT_IDENTITY_MISMATCH';
  END IF;

  SELECT d.* INTO inv
  FROM integraciones.bsale_documents d
  WHERE d.company_id = p_company_id
    AND d.bsale_id = p_invoice_bsale_id
    AND d.document_type_id = 5
    AND d.state = 0
    AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'
    AND d.raw_json->>'salesId' = p_sales_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_INVOICE_NOT_VALID'; END IF;
  IF inv.office_id IS DISTINCT FROM p_office_id
     OR p_office_id IS DISTINCT FROM NULLIF(a.nv_snapshot->>'office_id', '')::integer THEN
    RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_OFFICE_MISMATCH';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_lines) AS x(
      line_key text, variant_id bigint, sku text,
      expected_quantity numeric, dispatched_quantity numeric, shipping_ids jsonb
    )
    WHERE nullif(btrim(x.line_key), '') IS NULL
       OR (x.variant_id IS NULL AND nullif(btrim(x.sku), '') IS NULL)
       OR x.line_key IS DISTINCT FROM coalesce('variant:' || x.variant_id::text, 'sku:' || upper(btrim(x.sku)))
       OR x.expected_quantity IS NULL OR x.expected_quantity <= 0
       OR x.dispatched_quantity IS NULL OR x.dispatched_quantity <> x.expected_quantity
       OR jsonb_typeof(x.shipping_ids) IS DISTINCT FROM 'array'
       OR jsonb_array_length(x.shipping_ids) = 0
  ) THEN RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_LINES_INVALID'; END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_lines) AS x(
      line_key text, variant_id bigint, sku text,
      expected_quantity numeric, dispatched_quantity numeric, shipping_ids jsonb
    )
    CROSS JOIN LATERAL jsonb_array_elements_text(x.shipping_ids) AS s(value)
    WHERE s.value !~ '^[1-9][0-9]*$'
       OR CASE
            WHEN s.value ~ '^[1-9][0-9]*$' THEN s.value::numeric
            ELSE 0
          END > 9223372036854775807::numeric
       OR NOT (
         CASE
           WHEN s.value ~ '^[1-9][0-9]*$' THEN
             CASE
               WHEN s.value::numeric <= 9223372036854775807::numeric THEN s.value::numeric
               ELSE 0
             END
           ELSE 0
         END = ANY (
           SELECT active_shipping_id::numeric
           FROM unnest(p_active_shipping_ids) AS a(active_shipping_id)
         )
       )
  )
  OR EXISTS (
    SELECT x.line_key, s.value
    FROM jsonb_to_recordset(p_lines) AS x(
      line_key text, variant_id bigint, sku text,
      expected_quantity numeric, dispatched_quantity numeric, shipping_ids jsonb
    )
    CROSS JOIN LATERAL jsonb_array_elements_text(x.shipping_ids) AS s(value)
    GROUP BY x.line_key, s.value
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_LINE_SHIPPING_SET_INVALID';
  END IF;

  IF EXISTS (
    SELECT x.line_key
    FROM jsonb_to_recordset(p_lines) AS x(line_key text)
    GROUP BY x.line_key
    HAVING count(*) <> 1
  ) THEN RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_DUPLICATE_LINE'; END IF;

  -- The submitted product/quantity set must equal the attempt snapshot,
  -- aggregating repeated products before comparison.
  IF EXISTS (
    WITH expected AS (
      SELECT coalesce('variant:' || e.variant_id::text, 'sku:' || upper(btrim(e.sku))) AS line_key,
             sum(coalesce(e.billable_quantity, e.quantity)) AS quantity
      FROM jsonb_to_recordset(
        CASE WHEN jsonb_typeof(a.detail_snapshots) = 'array' THEN a.detail_snapshots ELSE '[]'::jsonb END
      ) AS e(
        detail_id bigint, variant_id bigint, sku text,
        quantity numeric, billable_quantity numeric
      )
      GROUP BY 1
    ), submitted AS (
      SELECT x.line_key, sum(x.expected_quantity) AS quantity
      FROM jsonb_to_recordset(p_lines) AS x(
        line_key text, variant_id bigint, sku text,
        expected_quantity numeric, dispatched_quantity numeric, shipping_ids jsonb
      )
      GROUP BY x.line_key
    )
    SELECT 1 FROM expected e FULL JOIN submitted s USING (line_key)
    WHERE e.line_key IS NULL OR s.line_key IS NULL OR e.quantity IS DISTINCT FROM s.quantity
  ) THEN RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_PRODUCT_QUANTITY_MISMATCH'; END IF;

  SELECT * INTO existing
  FROM logistica.sales_order_invoice_stock_verifications
  WHERE company_id = p_company_id AND attempt_id = p_attempt_id
  FOR SHARE;
  IF FOUND THEN
    WITH incoming_lines AS (
      SELECT x.line_key, x.variant_id,
             upper(nullif(btrim(x.sku), '')) AS sku,
             x.expected_quantity, x.dispatched_quantity,
             ARRAY(
               SELECT value::bigint
               FROM jsonb_array_elements_text(x.shipping_ids)
               ORDER BY value::bigint
             ) AS shipping_ids
      FROM jsonb_to_recordset(p_lines) AS x(
        line_key text, variant_id bigint, sku text,
        expected_quantity numeric, dispatched_quantity numeric, shipping_ids jsonb
      )
    ), stored_lines AS (
      SELECT l.line_key, l.variant_id, upper(nullif(btrim(l.sku), '')) AS sku,
             l.expected_quantity, l.dispatched_quantity,
             ARRAY(SELECT id FROM unnest(l.shipping_ids) AS u(id) ORDER BY id) AS shipping_ids
      FROM logistica.sales_order_invoice_stock_verification_lines l
      WHERE l.verification_id = existing.id
    )
    SELECT
      existing.company_id IS DISTINCT FROM p_company_id
      OR existing.attempt_id IS DISTINCT FROM p_attempt_id
      OR existing.invoice_bsale_id IS DISTINCT FROM p_invoice_bsale_id
      OR existing.sales_id IS DISTINCT FROM p_sales_id
      OR existing.attempt_fingerprint IS DISTINCT FROM p_attempt_fingerprint
      OR existing.office_id IS DISTINCT FROM p_office_id
      OR ARRAY(SELECT id FROM unnest(existing.shipping_ids) AS u(id) ORDER BY id)
         IS DISTINCT FROM ARRAY(SELECT id FROM unnest(p_shipping_ids) AS u(id) ORDER BY id)
      OR ARRAY(SELECT id FROM unnest(existing.active_shipping_ids) AS u(id) ORDER BY id)
         IS DISTINCT FROM ARRAY(SELECT id FROM unnest(p_active_shipping_ids) AS u(id) ORDER BY id)
      OR EXISTS (
        SELECT 1
        FROM incoming_lines i
        FULL JOIN stored_lines s USING (line_key)
        WHERE i.line_key IS NULL
           OR s.line_key IS NULL
           OR i.variant_id IS DISTINCT FROM s.variant_id
           OR i.sku IS DISTINCT FROM s.sku
           OR i.expected_quantity IS DISTINCT FROM s.expected_quantity
           OR i.dispatched_quantity IS DISTINCT FROM s.dispatched_quantity
           OR i.shipping_ids IS DISTINCT FROM s.shipping_ids
      )
    INTO operational_conflict;

    IF operational_conflict THEN
      RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_CONFLICT';
    END IF;
    RETURN jsonb_build_object('status', 'VERIFIED', 'verification_id', existing.id, 'idempotent', true);
  END IF;

  INSERT INTO logistica.sales_order_invoice_stock_verifications(
    company_id, attempt_id, invoice_bsale_id, sales_id, attempt_fingerprint,
    office_id, shipping_ids, active_shipping_ids, raw_evidence, verified_at
  ) VALUES (
    p_company_id, p_attempt_id, p_invoice_bsale_id, p_sales_id, p_attempt_fingerprint,
    p_office_id, p_shipping_ids, p_active_shipping_ids, coalesce(p_raw_evidence, '{}'::jsonb), p_verified_at
  ) RETURNING id INTO existing;

  INSERT INTO logistica.sales_order_invoice_stock_verification_lines(
    verification_id, line_key, variant_id, sku, expected_quantity,
    dispatched_quantity, shipping_ids
  )
  SELECT existing.id, x.line_key, x.variant_id, nullif(btrim(x.sku), ''),
         x.expected_quantity, x.dispatched_quantity,
         ARRAY(SELECT value::bigint FROM jsonb_array_elements_text(x.shipping_ids))
  FROM jsonb_to_recordset(p_lines) AS x(
    line_key text, variant_id bigint, sku text,
    expected_quantity numeric, dispatched_quantity numeric, shipping_ids jsonb
  );

  GET DIAGNOSTICS line_count = ROW_COUNT;
  RETURN jsonb_build_object('status', 'VERIFIED', 'verification_id', existing.id, 'line_count', line_count, 'idempotent', false);
END;
$function$;

CREATE OR REPLACE FUNCTION logistica.invoice_stock_verification_is_valid(
  p_attempt_id uuid,
  p_invoice_bsale_id bigint DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, logistica, integraciones
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM logistica.sales_order_invoice_stock_verifications e
    JOIN logistica.sales_order_invoice_attempts a
      ON a.id = e.attempt_id AND a.company_id = e.company_id
    JOIN integraciones.bsale_documents d
      ON d.company_id = e.company_id AND d.bsale_id = e.invoice_bsale_id
     AND d.document_type_id = 5 AND d.state = 0
     AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'
     AND d.raw_json->>'salesId' = e.sales_id
    WHERE e.attempt_id = p_attempt_id
      AND (p_invoice_bsale_id IS NULL OR e.invoice_bsale_id = p_invoice_bsale_id)
      AND e.sales_id = a.sales_id
      AND e.attempt_fingerprint = a.fingerprint
      AND e.verification_status = 'VERIFIED'
      AND e.source = 'BSALE_GET'
      AND e.verified_at <= now() + interval '5 minutes'
      AND cardinality(e.shipping_ids) > 0
      AND cardinality(e.active_shipping_ids) > 0
      AND EXISTS (
        SELECT 1 FROM logistica.sales_order_invoice_stock_verification_lines l
        WHERE l.verification_id = e.id
          AND l.expected_quantity = l.dispatched_quantity
          AND cardinality(l.shipping_ids) > 0
      )
  );
$function$;

CREATE OR REPLACE FUNCTION logistica.guard_invoice_stock_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, logistica, integraciones
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'CONFIRMED' THEN
      RAISE EXCEPTION 'INVOICE_STOCK_CONFIRMATION_REQUIRES_EXISTING_ATTEMPT';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'CONFIRMED' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.card_id IS DISTINCT FROM OLD.card_id
       OR NEW.canonical_bsale_token IS DISTINCT FROM OLD.canonical_bsale_token
       OR NEW.historical_bsale_nv_id IS DISTINCT FROM OLD.historical_bsale_nv_id
       OR NEW.current_bsale_nv_id IS DISTINCT FROM OLD.current_bsale_nv_id
       OR NEW.sales_id IS DISTINCT FROM OLD.sales_id
       OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
       OR NEW.payload_snapshot IS DISTINCT FROM OLD.payload_snapshot
       OR NEW.effective_payload_snapshot IS DISTINCT FROM OLD.effective_payload_snapshot
       OR NEW.payload_history IS DISTINCT FROM OLD.payload_history
       OR NEW.nv_snapshot IS DISTINCT FROM OLD.nv_snapshot
       OR NEW.detail_snapshots IS DISTINCT FROM OLD.detail_snapshots
       OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.bsale_invoice_id IS DISTINCT FROM OLD.bsale_invoice_id
       OR NEW.bsale_invoice_number IS DISTINCT FROM OLD.bsale_invoice_number
       OR NEW.retry_count IS DISTINCT FROM OLD.retry_count THEN
      RAISE EXCEPTION 'CONFIRMED_ATTEMPT_IDENTITY_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM logistica.sales_order_invoice_stock_verifications e
    WHERE e.company_id = OLD.company_id AND e.attempt_id = OLD.id
  ) AND (
    NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.card_id IS DISTINCT FROM OLD.card_id
    OR NEW.canonical_bsale_token IS DISTINCT FROM OLD.canonical_bsale_token
    OR NEW.historical_bsale_nv_id IS DISTINCT FROM OLD.historical_bsale_nv_id
    OR NEW.current_bsale_nv_id IS DISTINCT FROM OLD.current_bsale_nv_id
    OR NEW.sales_id IS DISTINCT FROM OLD.sales_id
    OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
    OR NEW.payload_snapshot IS DISTINCT FROM OLD.payload_snapshot
    OR NEW.effective_payload_snapshot IS DISTINCT FROM OLD.effective_payload_snapshot
       OR NEW.payload_history IS DISTINCT FROM OLD.payload_history
       OR NEW.nv_snapshot IS DISTINCT FROM OLD.nv_snapshot
       OR NEW.detail_snapshots IS DISTINCT FROM OLD.detail_snapshots
       OR (
         (NEW.bsale_invoice_id IS DISTINCT FROM OLD.bsale_invoice_id
          OR NEW.bsale_invoice_number IS DISTINCT FROM OLD.bsale_invoice_number)
         AND NOT (
           NEW.status = 'CONFIRMED'
           AND OLD.bsale_invoice_id IS NULL
           AND OLD.bsale_invoice_number IS NULL
           AND NEW.bsale_invoice_id IS NOT NULL
           AND NEW.bsale_invoice_number IS NOT NULL
           AND logistica.invoice_stock_verification_is_valid(OLD.id, NEW.bsale_invoice_id)
           AND EXISTS (
             SELECT 1
             FROM logistica.sales_order_invoice_stock_verifications e
             JOIN integraciones.bsale_documents d
               ON d.company_id = e.company_id
              AND d.bsale_id = e.invoice_bsale_id
              AND d.document_type_id = 5
              AND d.state = 0
             WHERE e.company_id = NEW.company_id
               AND e.attempt_id = OLD.id
               AND e.invoice_bsale_id = NEW.bsale_invoice_id
               AND e.sales_id = NEW.sales_id
               AND e.attempt_fingerprint = NEW.fingerprint
               AND d.number::text = NEW.bsale_invoice_number
           )
         )
       )
     ) THEN
    RAISE EXCEPTION 'INVOICE_STOCK_EVIDENCE_IDENTITY_IMMUTABLE';
  END IF;

  IF NEW.status = 'CONFIRMED' THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.card_id IS DISTINCT FROM OLD.card_id
       OR NEW.canonical_bsale_token IS DISTINCT FROM OLD.canonical_bsale_token
       OR NEW.historical_bsale_nv_id IS DISTINCT FROM OLD.historical_bsale_nv_id
       OR NEW.current_bsale_nv_id IS DISTINCT FROM OLD.current_bsale_nv_id
       OR NEW.sales_id IS DISTINCT FROM OLD.sales_id
       OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
       OR NEW.payload_snapshot IS DISTINCT FROM OLD.payload_snapshot
       OR NEW.effective_payload_snapshot IS DISTINCT FROM OLD.effective_payload_snapshot
       OR NEW.payload_history IS DISTINCT FROM OLD.payload_history
       OR NEW.nv_snapshot IS DISTINCT FROM OLD.nv_snapshot
       OR NEW.detail_snapshots IS DISTINCT FROM OLD.detail_snapshots
       OR NEW.bsale_invoice_id IS NULL
       OR NEW.bsale_invoice_number IS NULL
       OR NOT logistica.invoice_stock_verification_is_valid(OLD.id, NEW.bsale_invoice_id)
       OR NOT EXISTS (
         SELECT 1
         FROM logistica.sales_order_invoice_stock_verifications e
         JOIN integraciones.bsale_documents d
           ON d.company_id = e.company_id
          AND d.bsale_id = e.invoice_bsale_id
          AND d.document_type_id = 5
          AND d.state = 0
         WHERE e.company_id = NEW.company_id
           AND e.attempt_id = OLD.id
           AND e.invoice_bsale_id = NEW.bsale_invoice_id
           AND e.sales_id = NEW.sales_id
           AND e.attempt_fingerprint = NEW.fingerprint
           AND d.number::text = NEW.bsale_invoice_number
       ) THEN
       RAISE EXCEPTION 'STOCK_VERIFICATION_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER sales_order_invoice_attempts_stock_confirmation_guard
BEFORE INSERT OR UPDATE ON logistica.sales_order_invoice_attempts
FOR EACH ROW EXECUTE FUNCTION logistica.guard_invoice_stock_confirmation();

REVOKE ALL ON FUNCTION logistica.prevent_invoice_stock_evidence_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.record_sales_order_invoice_stock_evidence(uuid, uuid, bigint, text, text, integer, bigint[], bigint[], jsonb, jsonb, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.record_sales_order_invoice_stock_evidence(uuid, uuid, bigint, text, text, integer, bigint[], bigint[], jsonb, jsonb, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION logistica.invoice_stock_verification_is_valid(uuid, bigint) FROM PUBLIC, anon, authenticated, service_role;

-- Encapsulate the already deployed RPC bodies. The old names are private and
-- callable only by the guarded wrappers below, so there is no application bypass.
ALTER FUNCTION logistica.reconcile_sales_order_invoice_attempt(uuid)
  RENAME TO reconcile_sales_order_invoice_attempt_without_stock_guard;
ALTER FUNCTION logistica.confirm_sales_order_invoice_attempt(uuid, bigint, text)
  RENAME TO confirm_sales_order_invoice_attempt_without_stock_guard;

REVOKE ALL ON FUNCTION logistica.reconcile_sales_order_invoice_attempt_without_stock_guard(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.confirm_sales_order_invoice_attempt_without_stock_guard(uuid, bigint, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION logistica.reconcile_sales_order_invoice_attempt(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones
AS $function$
DECLARE a record;
BEGIN
  SELECT * INTO a FROM logistica.sales_order_invoice_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'ATTEMPT_NOT_FOUND'); END IF;
  IF auth.role() IS DISTINCT FROM 'service_role' AND (
    auth.uid() IS NULL OR NOT core.has_company_access(auth.uid(), a.company_id)
    OR NOT core.has_permission_for_company(auth.uid(), a.company_id, 'logistica.preparation.manage')
  ) THEN
    RAISE EXCEPTION 'COMPANY_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;
  IF a.status = 'CONFIRMED' THEN
    RETURN jsonb_build_object('status', 'CONFIRMED', 'attempt_id', a.id, 'invoice_id', a.bsale_invoice_id, 'idempotent', true);
  END IF;
  IF a.status IN ('UNKNOWN', 'RECONCILIATION_REQUIRED')
     AND NOT logistica.invoice_stock_verification_is_valid(a.id, NULL) THEN
    UPDATE logistica.sales_order_invoice_attempts
    SET status = 'RECONCILIATION_REQUIRED', last_error = 'STOCK_VERIFICATION_REQUIRED',
        last_reconciliation_at = now(), updated_at = now()
    WHERE id = a.id;
    RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'attempt_id', a.id, 'reason', 'STOCK_VERIFICATION_REQUIRED');
  END IF;
  RETURN logistica.reconcile_sales_order_invoice_attempt_without_stock_guard(a.id);
END;
$function$;

CREATE OR REPLACE FUNCTION logistica.confirm_sales_order_invoice_attempt(
  p_attempt_id uuid,
  p_invoice_id bigint,
  p_invoice_number text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones
AS $function$
DECLARE a record;
BEGIN
  SELECT * INTO a FROM logistica.sales_order_invoice_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'ATTEMPT_NOT_FOUND'); END IF;
  IF auth.role() IS DISTINCT FROM 'service_role' AND (
    auth.uid() IS NULL OR NOT core.has_company_access(auth.uid(), a.company_id)
    OR NOT core.has_permission_for_company(auth.uid(), a.company_id, 'logistica.preparation.manage')
  ) THEN
    RAISE EXCEPTION 'COMPANY_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;
  IF a.status = 'CONFIRMED' THEN
    RETURN jsonb_build_object('status', 'CONFIRMED', 'attempt_id', a.id, 'invoice_id', a.bsale_invoice_id, 'idempotent', true);
  END IF;
  IF a.status IN ('SUBMITTING', 'UNKNOWN')
     AND NOT logistica.invoice_stock_verification_is_valid(a.id, p_invoice_id) THEN
    UPDATE logistica.sales_order_invoice_attempts
    SET status = 'RECONCILIATION_REQUIRED', last_error = 'STOCK_VERIFICATION_REQUIRED', updated_at = now()
    WHERE id = a.id;
    RETURN jsonb_build_object('status', 'RECONCILIATION_REQUIRED', 'attempt_id', a.id, 'invoice_id', p_invoice_id, 'reason', 'STOCK_VERIFICATION_REQUIRED');
  END IF;
  RETURN logistica.confirm_sales_order_invoice_attempt_without_stock_guard(a.id, p_invoice_id, p_invoice_number);
END;
$function$;

REVOKE ALL ON FUNCTION logistica.reconcile_sales_order_invoice_attempt(uuid), logistica.confirm_sales_order_invoice_attempt(uuid, bigint, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.reconcile_sales_order_invoice_attempt(uuid), logistica.confirm_sales_order_invoice_attempt(uuid, bigint, text)
  TO authenticated, service_role;

COMMENT ON TABLE logistica.sales_order_invoice_stock_verifications IS
  'FAC-STOCK-01D1 immutable Bsale GET evidence required for new invoice confirmation.';
COMMENT ON FUNCTION logistica.record_sales_order_invoice_stock_evidence(uuid, uuid, bigint, text, text, integer, bigint[], bigint[], jsonb, jsonb, timestamptz) IS
  'FAC-STOCK-01D2 service-only writer. Caller must have completed Bsale GET verification.';

-- Safe full-migration dry run (never execute the committed migration file for
-- this test): make a temporary copy with only its final COMMIT replaced by
-- ROLLBACK, then run that copy in an isolated PostgreSQL transaction. Example:
--   perl -0pe 's/COMMIT;\s*\z/ROLLBACK;\n/' \
--     supabase/migrations/20261030150000_logistica_invoice_stock_verification_guard.sql \
--     > /tmp/fac-stock-01d1c-rollback.sql
--   psql "$DATABASE_URL" --single-transaction --file /tmp/fac-stock-01d1c-rollback.sql
-- Verify the transaction reports no SQL errors and that no objects remain
-- afterward. Do not run the original file with psql or Supabase migration
-- tooling during this test, because its final COMMIT is intentional.

COMMIT;
