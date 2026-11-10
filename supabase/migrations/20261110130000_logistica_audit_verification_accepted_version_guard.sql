-- Reject verification snapshots calculated against a superseded accepted version.
BEGIN;

CREATE OR REPLACE FUNCTION logistica.record_sales_order_audit_commercial_verification_v1(
  p_company_id uuid, p_card_id uuid, p_audit_id uuid, p_status text,
  p_current_bsale_nv_id bigint, p_canonical_bsale_token text, p_reason text,
  p_fingerprint text, p_snapshot jsonb, p_differences jsonb
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_card logistica.sales_order_preparation_cards%ROWTYPE;
  v_audit logistica.sales_order_audits%ROWTYPE;
  v_existing logistica.sales_order_audit_commercial_verifications%ROWTYPE;
  v_row logistica.sales_order_audit_commercial_verifications%ROWTYPE;
  v_latest logistica.sales_order_preparation_commercial_versions%ROWTYPE;
  v_reference jsonb;
  v_matches bigint;
  v_canonical_current bigint;
  v_current_version jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id)
       OR NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
      RAISE EXCEPTION 'AUDIT_COMMERCIAL_VERIFICATION_DENIED' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_status NOT IN ('READY_TO_INVOICE', 'INCIDENTS', 'BLOCKED') THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_STATUS_INVALID';
  END IF;
  IF NULLIF(btrim(p_fingerprint), '') IS NULL OR p_fingerprint !~ '^[0-9A-Fa-f]{64}$' THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_FINGERPRINT_INVALID';
  END IF;
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR jsonb_typeof(p_differences) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_SNAPSHOT_INVALID';
  END IF;
  IF p_snapshot->>'cardId' IS DISTINCT FROM p_card_id::text
     OR p_snapshot->>'auditId' IS DISTINCT FROM p_audit_id::text
     OR p_snapshot->>'status' IS DISTINCT FROM p_status THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_SNAPSHOT_INCOHERENT';
  END IF;
  IF p_status = 'READY_TO_INVOICE'
     AND (jsonb_array_length(p_differences) <> 0
       OR p_snapshot->'comparison'->>'status' IS DISTINCT FROM 'READY_TO_INVOICE'
       OR jsonb_typeof(p_snapshot->'comparison'->'differences') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_snapshot->'comparison'->'differences') <> 0) THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_READY_WITH_DIFFERENCES';
  END IF;
  IF p_status = 'INCIDENTS'
     AND (jsonb_array_length(p_differences) = 0
       OR p_snapshot->'comparison'->>'status' IS DISTINCT FROM 'INCIDENTS'
       OR p_snapshot->'comparison'->'differences' IS DISTINCT FROM p_differences) THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_INCIDENTS_INCOHERENT';
  END IF;
  IF p_status <> 'BLOCKED' AND (p_current_bsale_nv_id IS NULL OR p_canonical_bsale_token IS NULL) THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_CURRENT_IDENTITY_REQUIRED';
  END IF;

  -- Match finalize_sales_order_audit: session first, then card. Acceptance
  -- writers must also lock this card before appending a commercial version.
  SELECT * INTO v_audit FROM logistica.sales_order_audits
  WHERE id = p_audit_id AND card_id = p_card_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_audit.status <> 'OPEN' THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_AUDIT_NOT_OPEN';
  END IF;
  SELECT * INTO v_card FROM logistica.sales_order_preparation_cards
  WHERE id = p_card_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_card.status <> 'IN_AUDIT' THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_CARD_NOT_IN_AUDIT';
  END IF;
  IF p_canonical_bsale_token IS DISTINCT FROM v_card.canonical_bsale_token THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_CARD_IDENTITY_CHANGED';
  END IF;

  -- Current clients send the complete acceptedVersion, not its ID. Resolve it
  -- to exactly one persisted identity and require that identity to be latest.
  -- Reject ambiguous historical content rather than guessing its sequence.
  SELECT * INTO v_latest FROM logistica.sales_order_preparation_commercial_versions
  WHERE company_id = p_company_id AND card_id = p_card_id
  ORDER BY sequence_no DESC LIMIT 1;
  v_reference := p_snapshot->'acceptedVersion';
  IF NOT FOUND THEN
    IF v_reference IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'AUDIT_COMMERCIAL_ACCEPTED_VERSION_STALE';
    END IF;
  ELSE
    SELECT count(*) INTO v_matches FROM logistica.sales_order_preparation_commercial_versions
    WHERE company_id = p_company_id AND card_id = p_card_id AND version_snapshot = v_reference;
    IF jsonb_typeof(v_reference) IS DISTINCT FROM 'object'
       OR v_latest.version_snapshot IS DISTINCT FROM v_reference OR v_matches <> 1 THEN
      RAISE EXCEPTION 'AUDIT_COMMERCIAL_ACCEPTED_VERSION_STALE';
    END IF;
  END IF;

  SELECT current_bsale_id INTO v_canonical_current
  FROM integraciones.vw_bsale_sales_order_documents_canonical
  WHERE company_id = p_company_id AND canonical_bsale_token = p_canonical_bsale_token;
  IF p_current_bsale_nv_id IS NOT NULL AND v_canonical_current IS NOT NULL
     AND p_current_bsale_nv_id IS DISTINCT FROM v_canonical_current THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_STALE_VERSION';
  END IF;
  IF p_status <> 'BLOCKED' AND v_canonical_current IS NULL THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_STALE_VERSION';
  END IF;
  IF p_status <> 'BLOCKED' THEN
    v_current_version := p_snapshot->'currentVersion';
    IF jsonb_typeof(v_current_version) IS DISTINCT FROM 'object'
       OR v_current_version->>'physicalId' IS DISTINCT FROM p_current_bsale_nv_id::text
       OR v_current_version->'identity'->>'canonicalToken' IS DISTINCT FROM p_canonical_bsale_token
       OR v_current_version->'identity'->>'currentBsaleId' IS DISTINCT FROM p_current_bsale_nv_id::text THEN
      RAISE EXCEPTION 'AUDIT_COMMERCIAL_CURRENT_SNAPSHOT_INCOHERENT';
    END IF;
    IF p_current_bsale_nv_id IS DISTINCT FROM v_card.current_bsale_nv_id THEN
      UPDATE logistica.sales_order_preparation_cards
      SET current_bsale_nv_id = p_current_bsale_nv_id, updated_at = now()
      WHERE id = p_card_id AND company_id = p_company_id;
    END IF;
  END IF;
  SELECT * INTO v_existing FROM logistica.sales_order_audit_commercial_verifications
  WHERE company_id = p_company_id AND card_id = p_card_id AND audit_id = p_audit_id
    AND is_current AND fingerprint = p_fingerprint FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('id', v_existing.id, 'status', v_existing.status,
      'current_bsale_nv_id', v_existing.current_bsale_nv_id, 'canonical_bsale_token', v_existing.canonical_bsale_token,
      'reason', v_existing.reason, 'differences', v_existing.differences, 'verified_at', v_existing.verified_at);
  END IF;
  UPDATE logistica.sales_order_audit_commercial_verifications SET is_current = false
  WHERE company_id = p_company_id AND card_id = p_card_id AND audit_id = p_audit_id AND is_current;
  INSERT INTO logistica.sales_order_audit_commercial_verifications (
    company_id, card_id, audit_id, status, canonical_bsale_token, current_bsale_nv_id,
    reason, fingerprint, snapshot, differences
  ) VALUES (
    p_company_id, p_card_id, p_audit_id, p_status, p_canonical_bsale_token,
    p_current_bsale_nv_id, p_reason, p_fingerprint, p_snapshot, p_differences
  ) RETURNING * INTO v_row;
  RETURN jsonb_build_object('id', v_row.id, 'status', v_row.status,
    'current_bsale_nv_id', v_row.current_bsale_nv_id, 'canonical_bsale_token', v_row.canonical_bsale_token,
    'reason', v_row.reason, 'differences', v_row.differences, 'verified_at', v_row.verified_at);
END;
$function$;

REVOKE ALL ON FUNCTION logistica.record_sales_order_audit_commercial_verification_v1(uuid, uuid, uuid, text, bigint, text, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.record_sales_order_audit_commercial_verification_v1(uuid, uuid, uuid, text, bigint, text, text, text, jsonb, jsonb) TO authenticated, service_role;
COMMIT;
