-- Requests are written only by the trusted server after explicit user approval.
-- This function does not fetch Bsale: the server must independently re-read it
-- and confirm the approved fingerprint immediately before creating a request.
BEGIN;

CREATE TABLE logistica.sales_order_audit_commercial_acceptance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id),
  audit_id uuid NOT NULL REFERENCES logistica.sales_order_audits(id),
  actor_id uuid NOT NULL REFERENCES portal.users(id),
  previous_version_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_commercial_versions(id),
  previous_fingerprint text NOT NULL,
  approved_fingerprint text NOT NULL CHECK (length(btrim(approved_fingerprint)) > 0),
  -- Existing commercial-version consumers use the canonical content fingerprint,
  -- which differs from the SHA-256 approval token checked by this function.
  version_fingerprint text NOT NULL CHECK (length(btrim(version_fingerprint)) > 0),
  version_snapshot jsonb NOT NULL,
  approval_evidence jsonb NOT NULL,
  approved_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  applied_version_id uuid REFERENCES logistica.sales_order_preparation_commercial_versions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE logistica.sales_order_audit_commercial_acceptance_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE logistica.sales_order_audit_commercial_acceptance_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE logistica.sales_order_audit_commercial_acceptance_requests TO service_role;

-- PostgreSQL jsonb has its own canonical text representation. Only the trusted
-- server can ask for this token; it must never be supplied by the browser as
-- evidence without comparing it with an independently fetched Bsale snapshot.
CREATE OR REPLACE FUNCTION logistica.audit_commercial_snapshot_fingerprint_v1(p_snapshot jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
SET search_path = pg_catalog
AS $$ SELECT encode(sha256(convert_to(p_snapshot::text, 'UTF8')), 'hex') $$;
REVOKE ALL ON FUNCTION logistica.audit_commercial_snapshot_fingerprint_v1(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.audit_commercial_snapshot_fingerprint_v1(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION logistica.accept_sales_order_audit_commercial_changes_v1(
  p_company_id uuid, p_card_id uuid, p_audit_id uuid, p_request_id uuid,
  p_actor_id uuid, p_approved_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, logistica, integraciones
AS $function$
DECLARE
  v_audit logistica.sales_order_audits%ROWTYPE;
  v_card logistica.sales_order_preparation_cards%ROWTYPE;
  v_request logistica.sales_order_audit_commercial_acceptance_requests%ROWTYPE;
  v_previous logistica.sales_order_preparation_commercial_versions%ROWTYPE;
  v_existing logistica.sales_order_preparation_commercial_versions%ROWTYPE;
  v_current_id bigint;
  v_version_id uuid;
  v_old jsonb;
  v_new jsonb;
  v_audit_line logistica.sales_order_audit_lines%ROWTYPE;
  v_old_qty numeric;
  v_new_qty numeric;
  v_field text;
  v_old_amount numeric;
  v_new_amount numeric;
  v_old_discount numeric;
  v_new_discount numeric;
  v_key text;
  v_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' OR p_actor_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM portal.users WHERE id = p_actor_id AND is_active = true AND deleted_at IS NULL)
     OR core.has_company_access(p_actor_id, p_company_id) IS DISTINCT FROM true
     OR core.has_permission_for_company(p_actor_id, p_company_id, 'logistica.audit.manage') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_audit FROM logistica.sales_order_audits
  WHERE id = p_audit_id AND card_id = p_card_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_audit.status <> 'OPEN' THEN RAISE EXCEPTION 'AUDIT_ACCEPTANCE_AUDIT_NOT_OPEN'; END IF;
  SELECT * INTO v_card FROM logistica.sales_order_preparation_cards
  WHERE id = p_card_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_card.status <> 'IN_AUDIT' THEN RAISE EXCEPTION 'AUDIT_ACCEPTANCE_CARD_NOT_IN_AUDIT'; END IF;
  SELECT * INTO v_request FROM logistica.sales_order_audit_commercial_acceptance_requests
  WHERE id = p_request_id AND company_id = p_company_id AND card_id = p_card_id
    AND audit_id = p_audit_id AND actor_id = p_actor_id FOR UPDATE;
  -- Contract for the future server: SHA-256 of PostgreSQL's UTF-8 jsonb text.
  -- The trusted writer must derive this value from precisely this snapshot.
  IF NOT FOUND OR p_approved_fingerprint IS NULL
     OR v_request.approved_fingerprint IS DISTINCT FROM p_approved_fingerprint
     OR p_approved_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_approved_fingerprint IS DISTINCT FROM logistica.audit_commercial_snapshot_fingerprint_v1(v_request.version_snapshot) THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_REQUEST_INVALID';
  END IF;

  -- Idempotent retries return before touching a newer commercial verification.
  IF v_request.applied_version_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM logistica.sales_order_preparation_commercial_versions
    WHERE id = v_request.applied_version_id AND company_id = p_company_id AND card_id = p_card_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'AUDIT_ACCEPTANCE_RESULT_MISSING'; END IF;
    RETURN jsonb_build_object('status', 'ALREADY_ACCEPTED', 'versionId', v_existing.id);
  END IF;
  IF v_request.approved_at > now() OR v_request.verified_at > now()
     OR v_request.verified_at < now() - interval '5 minutes'
     OR v_request.verified_at < v_request.approved_at
     OR jsonb_typeof(v_request.approval_evidence) IS DISTINCT FROM 'object'
     OR v_request.approval_evidence->>'actorId' IS DISTINCT FROM p_actor_id::text
     OR v_request.approval_evidence->>'auditId' IS DISTINCT FROM p_audit_id::text
     OR v_request.approval_evidence->>'fingerprint' IS DISTINCT FROM p_approved_fingerprint
     OR v_request.approval_evidence->>'versionFingerprint' IS DISTINCT FROM v_request.version_fingerprint
     OR v_request.approval_evidence->>'approved' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_APPROVAL_INVALID';
  END IF;
  IF v_audit.package_count IS NULL OR v_audit.package_count < 1 THEN RAISE EXCEPTION 'AUDIT_ACCEPTANCE_PACKAGES_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM logistica.sales_order_audit_lines WHERE company_id = p_company_id AND card_id = p_card_id AND audit_id = p_audit_id)
     OR EXISTS (SELECT 1 FROM logistica.sales_order_audit_lines WHERE company_id = p_company_id AND card_id = p_card_id AND audit_id = p_audit_id
                AND (line_status <> 'CONFIRMED' OR audit_quantity IS NULL OR audit_quantity IS DISTINCT FROM prepared_quantity_snapshot OR excluded_from_dispatch_snapshot)) THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_PHYSICAL_LINES_NOT_CONFORMING';
  END IF;
  IF EXISTS (SELECT 1 FROM logistica.sales_order_preparation_incidents WHERE company_id = p_company_id AND card_id = p_card_id AND status = 'OPEN')
     OR EXISTS (SELECT 1 FROM logistica.sales_order_audit_incidents WHERE company_id = p_company_id AND audit_id = p_audit_id AND status = 'OPEN') THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_OPEN_INCIDENTS';
  END IF;
  SELECT current_bsale_id INTO v_current_id FROM integraciones.vw_bsale_sales_order_documents_canonical
  WHERE company_id = p_company_id AND canonical_bsale_token = v_card.canonical_bsale_token;
  IF v_card.canonical_bsale_token IS NULL OR v_current_id IS NULL OR v_card.current_bsale_nv_id IS DISTINCT FROM v_current_id
     OR v_request.version_snapshot->'identity'->>'canonicalToken' IS DISTINCT FROM v_card.canonical_bsale_token
     OR v_request.version_snapshot->'identity'->>'currentBsaleId' IS DISTINCT FROM v_current_id::text
     OR v_request.version_snapshot->>'physicalId' IS DISTINCT FROM v_current_id::text THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_IDENTITY_CHANGED';
  END IF;
  SELECT * INTO v_previous FROM logistica.sales_order_preparation_commercial_versions
  WHERE company_id = p_company_id AND card_id = p_card_id ORDER BY sequence_no DESC LIMIT 1;
  IF NOT FOUND OR v_previous.id IS DISTINCT FROM v_request.previous_version_id
     OR v_previous.fingerprint IS DISTINCT FROM v_request.previous_fingerprint
     OR v_previous.canonical_bsale_token IS DISTINCT FROM v_card.canonical_bsale_token THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_PREVIOUS_VERSION_STALE';
  END IF;
  IF jsonb_typeof(v_previous.version_snapshot->'lines') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_request.version_snapshot->'lines') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_previous.version_snapshot->'sourceDetails') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_request.version_snapshot->'sourceDetails') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_previous.version_snapshot->'lines') = 0
     OR jsonb_array_length(v_previous.version_snapshot->'lines') <> jsonb_array_length(v_request.version_snapshot->'lines') THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_SNAPSHOT_INCOMPLETE';
  END IF;

  -- Strictly require unique variant identities, unchanged unit prices and
  -- proportional line amounts and source discounts. Missing evidence fails closed.
  FOR v_old IN SELECT value FROM jsonb_array_elements(v_previous.version_snapshot->'lines') LOOP
    v_key := v_old->>'variantId';
    IF v_key IS NULL OR v_key !~ '^[0-9]+$' THEN RAISE EXCEPTION 'AUDIT_ACCEPTANCE_PRODUCT_IDENTITY_INVALID'; END IF;
    SELECT count(*) INTO v_count FROM jsonb_array_elements(v_previous.version_snapshot->'lines') x WHERE x->>'variantId' = v_key;
    IF v_count <> 1 THEN RAISE EXCEPTION 'AUDIT_ACCEPTANCE_PRODUCT_IDENTITY_AMBIGUOUS'; END IF;
    SELECT count(*) INTO v_count FROM jsonb_array_elements(v_request.version_snapshot->'lines') x WHERE x->>'variantId' = v_key;
    IF v_count <> 1 THEN RAISE EXCEPTION 'AUDIT_ACCEPTANCE_PRODUCT_IDENTITY_AMBIGUOUS'; END IF;
    SELECT value INTO v_new FROM jsonb_array_elements(v_request.version_snapshot->'lines') x WHERE x->>'variantId' = v_key;
    IF btrim(COALESCE(v_old->>'sku', '')) IS DISTINCT FROM btrim(COALESCE(v_new->>'sku', '')) THEN
      RAISE EXCEPTION 'AUDIT_ACCEPTANCE_PRODUCT_IDENTITY_CHANGED';
    END IF;
    SELECT count(*) INTO v_count FROM logistica.sales_order_audit_lines
    WHERE company_id = p_company_id AND card_id = p_card_id AND audit_id = p_audit_id AND bsale_variant_id::text = v_key;
    IF v_count <> 1 THEN RAISE EXCEPTION 'AUDIT_ACCEPTANCE_PHYSICAL_IDENTITY_AMBIGUOUS'; END IF;
    SELECT * INTO v_audit_line FROM logistica.sales_order_audit_lines
    WHERE company_id = p_company_id AND card_id = p_card_id AND audit_id = p_audit_id AND bsale_variant_id::text = v_key;
    IF jsonb_typeof(v_old->'quantity') IS DISTINCT FROM 'number' OR jsonb_typeof(v_new->'quantity') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_old->'unitNetValue') IS DISTINCT FROM 'number' OR jsonb_typeof(v_new->'unitNetValue') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'AUDIT_ACCEPTANCE_VALUES_MISSING';
    END IF;
    v_old_qty := (v_old->>'quantity')::numeric; v_new_qty := (v_new->>'quantity')::numeric;
    IF v_old_qty <= 0 OR v_new_qty <= 0 OR v_new_qty > v_old_qty OR v_new_qty IS DISTINCT FROM v_audit_line.audit_quantity
       OR (v_old->>'unitNetValue')::numeric IS DISTINCT FROM (v_new->>'unitNetValue')::numeric THEN
      RAISE EXCEPTION 'AUDIT_ACCEPTANCE_QUANTITY_OR_PRICE_CHANGED';
    END IF;
    FOREACH v_field IN ARRAY ARRAY['lineNetAmount', 'lineTaxAmount', 'lineGrossAmount'] LOOP
      IF jsonb_typeof(v_old->v_field) IS DISTINCT FROM 'number' OR jsonb_typeof(v_new->v_field) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'AUDIT_ACCEPTANCE_VALUES_MISSING';
      END IF;
      v_old_amount := (v_old->>v_field)::numeric; v_new_amount := (v_new->>v_field)::numeric;
      IF v_old_amount * v_new_qty IS DISTINCT FROM v_new_amount * v_old_qty THEN
        RAISE EXCEPTION 'AUDIT_ACCEPTANCE_UNEXPLAINED_VALUE_CHANGE';
      END IF;
    END LOOP;
    SELECT count(*), min((x->>'netDiscount')::numeric) INTO v_count, v_old_discount
    FROM jsonb_array_elements(v_previous.version_snapshot->'sourceDetails') x WHERE x->>'id' = v_old->>'detailId' AND jsonb_typeof(x->'netDiscount') = 'number';
    IF v_count <> 1 THEN RAISE EXCEPTION 'AUDIT_ACCEPTANCE_DISCOUNT_EVIDENCE_MISSING'; END IF;
    SELECT count(*), min((x->>'netDiscount')::numeric) INTO v_count, v_new_discount
    FROM jsonb_array_elements(v_request.version_snapshot->'sourceDetails') x WHERE x->>'id' = v_new->>'detailId' AND jsonb_typeof(x->'netDiscount') = 'number';
    IF v_count <> 1 OR v_old_discount * v_new_qty IS DISTINCT FROM v_new_discount * v_old_qty THEN
      RAISE EXCEPTION 'AUDIT_ACCEPTANCE_DISCOUNT_CHANGED';
    END IF;
  END LOOP;
  SELECT count(*) INTO v_count FROM logistica.sales_order_audit_lines WHERE company_id = p_company_id AND card_id = p_card_id AND audit_id = p_audit_id;
  IF v_count <> jsonb_array_length(v_request.version_snapshot->'lines') THEN RAISE EXCEPTION 'AUDIT_ACCEPTANCE_PHYSICAL_LINE_COUNT_MISMATCH'; END IF;
  FOREACH v_field IN ARRAY ARRAY['netAmount', 'taxAmount', 'totalAmount'] LOOP
    IF jsonb_typeof(v_request.version_snapshot->v_field) IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_previous.version_snapshot->v_field) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'AUDIT_ACCEPTANCE_TOTALS_MISSING';
    END IF;
    IF (v_request.version_snapshot->>v_field)::numeric IS DISTINCT FROM (
      SELECT sum((line->>CASE v_field WHEN 'netAmount' THEN 'lineNetAmount' WHEN 'taxAmount' THEN 'lineTaxAmount' ELSE 'lineGrossAmount' END)::numeric)
      FROM jsonb_array_elements(v_request.version_snapshot->'lines') line
    ) OR (v_previous.version_snapshot->>v_field)::numeric IS DISTINCT FROM (
      SELECT sum((line->>CASE v_field WHEN 'netAmount' THEN 'lineNetAmount' WHEN 'taxAmount' THEN 'lineTaxAmount' ELSE 'lineGrossAmount' END)::numeric)
      FROM jsonb_array_elements(v_previous.version_snapshot->'lines') line
    ) THEN
      RAISE EXCEPTION 'AUDIT_ACCEPTANCE_TOTALS_INCONSISTENT';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM logistica.sales_order_preparation_commercial_versions WHERE company_id = p_company_id AND card_id = p_card_id AND fingerprint = v_request.version_fingerprint) THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_FINGERPRINT_ALREADY_EXISTS';
  END IF;
  INSERT INTO logistica.sales_order_preparation_commercial_versions (
    company_id, card_id, sequence_no, canonical_bsale_token, historical_bsale_nv_id, current_bsale_nv_id,
    previous_fingerprint, fingerprint, version_snapshot, applied_actions, accepted_by
  ) VALUES (
    p_company_id, p_card_id, v_previous.sequence_no + 1, v_card.canonical_bsale_token, v_card.bsale_nv_id, v_current_id,
    v_previous.fingerprint, v_request.version_fingerprint, v_request.version_snapshot,
    jsonb_build_array(jsonb_build_object('event', 'AUDIT_COMMERCIAL_ACCEPTANCE', 'auditId', p_audit_id, 'requestId', p_request_id, 'approval', v_request.approval_evidence)), p_actor_id
  ) RETURNING id INTO v_version_id;
  UPDATE logistica.sales_order_audit_commercial_verifications SET is_current = false
  WHERE company_id = p_company_id AND card_id = p_card_id AND audit_id = p_audit_id AND is_current;
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET applied_version_id = v_version_id WHERE id = p_request_id;
  RETURN jsonb_build_object('status', 'ACCEPTED', 'versionId', v_version_id);
END;
$function$;
REVOKE ALL ON FUNCTION logistica.accept_sales_order_audit_commercial_changes_v1(uuid, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.accept_sales_order_audit_commercial_changes_v1(uuid, uuid, uuid, uuid, uuid, text) TO service_role;
COMMIT;
