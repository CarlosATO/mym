-- Recuperacion comercial de auditorias ya finalizadas.
--
-- Solo permite persistir una verificacion autentica para el par terminal
-- AUDITED + COMPLETED. No reabre la auditoria ni modifica cantidades, bultos,
-- evidencias o Bsale.

BEGIN;
CREATE OR REPLACE FUNCTION logistica.record_sales_order_audit_commercial_recovery_v1(
  p_company_id uuid,
  p_card_id uuid,
  p_audit_id uuid,
  p_status text,
  p_current_bsale_nv_id bigint,
  p_canonical_bsale_token text,
  p_reason text,
  p_fingerprint text,
  p_snapshot jsonb,
  p_differences jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_card logistica.sales_order_preparation_cards%ROWTYPE;
  v_audit logistica.sales_order_audits%ROWTYPE;
  v_existing logistica.sales_order_audit_commercial_verifications%ROWTYPE;
  v_row logistica.sales_order_audit_commercial_verifications%ROWTYPE;
  v_canonical_current bigint;
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
  IF NULLIF(btrim(p_fingerprint), '') IS NULL THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_FINGERPRINT_REQUIRED';
  END IF;
  IF p_status = 'READY_TO_INVOICE'
     AND (COALESCE(p_snapshot->>'status', '') <> 'READY_TO_INVOICE'
       OR COALESCE(p_snapshot->'comparison'->>'status', '') <> 'READY_TO_INVOICE'
       OR jsonb_array_length(COALESCE(p_differences, '[]'::jsonb)) <> 0
       OR jsonb_array_length(COALESCE(p_snapshot->'auditedLines', '[]'::jsonb)) = 0
       OR jsonb_typeof(p_snapshot->'currentVersion') <> 'object') THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_RECOVERY_READY_RESULT_INVALID';
  END IF;

  SELECT * INTO v_card
  FROM logistica.sales_order_preparation_cards
  WHERE id = p_card_id AND company_id = p_company_id;
  IF NOT FOUND OR v_card.status <> 'AUDITED' THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_RECOVERY_CARD_NOT_AUDITED';
  END IF;

  SELECT * INTO v_audit
  FROM logistica.sales_order_audits
  WHERE id = p_audit_id AND card_id = p_card_id AND company_id = p_company_id;
  IF NOT FOUND OR v_audit.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_RECOVERY_AUDIT_NOT_COMPLETED';
  END IF;
  IF p_canonical_bsale_token IS DISTINCT FROM v_card.canonical_bsale_token THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_CARD_IDENTITY_CHANGED';
  END IF;

  SELECT current_bsale_id INTO v_canonical_current
  FROM integraciones.vw_bsale_sales_order_documents_canonical
  WHERE company_id = p_company_id
    AND canonical_bsale_token = p_canonical_bsale_token;
  IF p_current_bsale_nv_id IS NULL OR v_canonical_current IS NULL
     OR p_current_bsale_nv_id IS DISTINCT FROM v_canonical_current THEN
    RAISE EXCEPTION 'AUDIT_COMMERCIAL_RECOVERY_STALE_VERSION';
  END IF;

  SELECT * INTO v_existing
  FROM logistica.sales_order_audit_commercial_verifications
  WHERE company_id = p_company_id AND card_id = p_card_id AND audit_id = p_audit_id
    AND is_current AND fingerprint = p_fingerprint
  FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'id', v_existing.id, 'status', v_existing.status,
      'current_bsale_nv_id', v_existing.current_bsale_nv_id,
      'canonical_bsale_token', v_existing.canonical_bsale_token,
      'reason', v_existing.reason, 'differences', v_existing.differences,
      'verified_at', v_existing.verified_at
    );
  END IF;

  UPDATE logistica.sales_order_audit_commercial_verifications
  SET is_current = false
  WHERE company_id = p_company_id AND card_id = p_card_id AND audit_id = p_audit_id AND is_current;

  INSERT INTO logistica.sales_order_audit_commercial_verifications (
    company_id, card_id, audit_id, status, canonical_bsale_token,
    current_bsale_nv_id, reason, fingerprint, snapshot, differences
  ) VALUES (
    p_company_id, p_card_id, p_audit_id, p_status, p_canonical_bsale_token,
    p_current_bsale_nv_id, p_reason, p_fingerprint,
    COALESCE(p_snapshot, '{}'::jsonb), COALESCE(p_differences, '[]'::jsonb)
  ) RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id', v_row.id, 'status', v_row.status,
    'current_bsale_nv_id', v_row.current_bsale_nv_id,
    'canonical_bsale_token', v_row.canonical_bsale_token,
    'reason', v_row.reason, 'differences', v_row.differences,
    'verified_at', v_row.verified_at
  );
END;
$function$;
REVOKE ALL ON FUNCTION logistica.record_sales_order_audit_commercial_recovery_v1(
  uuid, uuid, uuid, text, bigint, text, text, text, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.record_sales_order_audit_commercial_recovery_v1(
  uuid, uuid, uuid, text, bigint, text, text, text, jsonb, jsonb
) TO authenticated, service_role;
COMMIT;