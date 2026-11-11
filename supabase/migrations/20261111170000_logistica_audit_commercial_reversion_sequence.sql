BEGIN;

-- 1. Eliminar la restricción de unicidad dirigida exclusivamente a
-- sales_order_preparation_comme_company_id_card_id_fingerprin_key,
-- fallando explícitamente si no existe o si su definición no coincide
-- exactamente con UNIQUE (company_id, card_id, fingerprint).
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'logistica.sales_order_preparation_commercial_versions'::regclass
    AND conname = 'sales_order_preparation_comme_company_id_card_id_fingerprin_key'
    AND contype = 'u';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Restriccion sales_order_preparation_comme_company_id_card_id_fingerprin_key no encontrada en logistica.sales_order_preparation_commercial_versions';
  END IF;

  IF v_def IS DISTINCT FROM 'UNIQUE (company_id, card_id, fingerprint)' THEN
    RAISE EXCEPTION 'Restriccion sales_order_preparation_comme_company_id_card_id_fingerprin_key tiene definicion inesperada: %', v_def;
  END IF;

  ALTER TABLE logistica.sales_order_preparation_commercial_versions
    DROP CONSTRAINT sales_order_preparation_comme_company_id_card_id_fingerprin_key;
END $$;

-- 2. Asegurar la protección equivalente de unicidad física:
-- Un mismo documento físico Bsale (current_bsale_nv_id) no puede registrarse
-- más de una vez como versión comercial para la misma tarjeta.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'logistica.sales_order_preparation_commercial_versions'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%current_bsale_nv_id%'
  ) THEN
    ALTER TABLE logistica.sales_order_preparation_commercial_versions
      ADD CONSTRAINT sales_order_preparation_commercial_versions_company_card_bsale_id_key
      UNIQUE (company_id, card_id, current_bsale_nv_id);
  END IF;
END $$;

-- 3. Actualizar la función de aceptación comercial de Auditoría:
-- Reemplaza la restricción global de fingerprint histórico por:
-- a) Verificación de que el documento físico vigente no haya sido aceptado previamente.
-- b) Verificación de que la nueva versión presente un cambio real respecto a la versión previa activa.
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
  v_evidence jsonb;
  v_tax jsonb;
  v_doc jsonb;
  v_version jsonb;
  v_product jsonb;
  v_rate numeric;
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
  -- A table lock also protects against phantom INSERTs and DELETEs. In READ
  -- COMMITTED the subsequent statement sees writers that committed while we
  -- waited. Other isolation levels cannot safely use that fresh-snapshot rule.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_ISOLATION_UNSUPPORTED';
  END IF;
  LOCK TABLE logistica.sales_order_audit_lines IN SHARE MODE;
  PERFORM id FROM logistica.sales_order_audit_lines
    WHERE audit_id = p_audit_id
    ORDER BY id FOR UPDATE;
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
  IF jsonb_typeof(v_request.version_snapshot->'auditPhysical') IS DISTINCT FROM 'object'
     OR v_request.version_snapshot->'auditPhysical' IS DISTINCT FROM logistica.audit_commercial_physical_snapshot_v1(p_company_id, p_card_id, p_audit_id) THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_PHYSICAL_SNAPSHOT_CHANGED';
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

  -- Included in version_snapshot, hence covered by the approval fingerprint and
  -- retained in commercial history. Current associations do not certify the
  -- historical per-line rate.
  v_evidence := v_request.version_snapshot->'taxEvidence';
  v_tax := v_evidence->'tax';
  IF jsonb_typeof(v_evidence) IS DISTINCT FROM 'object'
     OR v_evidence->>'canonicalToken' IS DISTINCT FROM v_card.canonical_bsale_token
     OR jsonb_typeof(v_evidence->'fetchedAt') IS DISTINCT FROM 'string'
     OR COALESCE(v_evidence->>'fetchedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'
     OR jsonb_typeof(v_tax) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_tax->'id') IS DISTINCT FROM 'number'
     OR COALESCE(v_tax->>'id','') !~ '^[0-9]+$'
     OR (v_tax->>'id')::numeric NOT BETWEEN 1 AND 9007199254740991
     OR jsonb_typeof(v_tax->'code') IS DISTINCT FROM 'string' OR COALESCE(v_tax->>'code','') = ''
     OR v_tax->'active' IS DISTINCT FROM 'true'::jsonb
     OR jsonb_typeof(v_tax->'percentage') IS DISTINCT FROM 'number'
     OR (v_tax->>'percentage')::numeric NOT BETWEEN 0 AND 100
     OR v_tax->>'source' IS DISTINCT FROM '/taxes/' || (v_tax->>'id') || '.json'
     OR jsonb_typeof(v_evidence->'products') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID';
  END IF;
  BEGIN
    PERFORM (v_evidence->>'fetchedAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID';
  END;
  v_rate := (v_tax->>'percentage')::numeric;
  FOR v_doc, v_version IN SELECT * FROM (VALUES
    (v_evidence->'previousDocument', v_previous.version_snapshot),
    (v_evidence->'currentDocument', v_request.version_snapshot)) AS docs(doc, version)
  LOOP
    IF jsonb_typeof(v_doc) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_doc->'id') IS DISTINCT FROM 'number'
       OR COALESCE(v_doc->>'id','') !~ '^[0-9]+$'
       OR (v_doc->>'id')::numeric NOT BETWEEN 1 AND 9007199254740991
       OR v_doc->'id' IS DISTINCT FROM v_version->'physicalId'
       OR v_doc->>'source' IS DISTINCT FROM '/documents/' || (v_doc->>'id') || '/document_taxes.json'
       OR v_doc->'taxIds' IS DISTINCT FROM jsonb_build_array(v_tax->'id')
       OR v_doc->'exemptAmount' IS DISTINCT FROM '0'::jsonb
       OR v_doc->'taxAmount' IS DISTINCT FROM v_version->'taxAmount' THEN
      RAISE EXCEPTION 'AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID';
    END IF;
  END LOOP;
  IF v_previous.version_snapshot->'identity'->>'canonicalToken' IS DISTINCT FROM v_card.canonical_bsale_token
     OR jsonb_array_length(v_evidence->'products') <> jsonb_array_length(v_request.version_snapshot->'lines') THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID';
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
    SELECT count(*) INTO v_count FROM jsonb_array_elements(v_evidence->'products') x WHERE x->'variantId' = v_new->'variantId';
    IF v_count <> 1 THEN RAISE EXCEPTION 'AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID'; END IF;
    SELECT value INTO v_product FROM jsonb_array_elements(v_evidence->'products') x WHERE x->'variantId' = v_new->'variantId';
    IF jsonb_typeof(v_product->'productId') IS DISTINCT FROM 'number'
       OR COALESCE(v_product->>'productId','') !~ '^[0-9]+$'
       OR (v_product->>'productId')::numeric NOT BETWEEN 1 AND 9007199254740991
       OR v_product->>'source' IS DISTINCT FROM '/products/' || (v_product->>'productId') || '/product_taxes.json'
       OR v_product->'taxIds' IS DISTINCT FROM jsonb_build_array(v_tax->'id') THEN
      RAISE EXCEPTION 'AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID';
    END IF;
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
      IF v_field = 'lineNetAmount' AND v_old_amount * v_new_qty IS DISTINCT FROM v_new_amount * v_old_qty THEN
        RAISE EXCEPTION 'AUDIT_ACCEPTANCE_UNEXPLAINED_VALUE_CHANGE';
      END IF;
    END LOOP;
    FOR v_version IN SELECT * FROM (VALUES (v_old), (v_new)) AS lines(line) LOOP
      IF (v_version->>'unitNetValue')::numeric < 0
         OR (v_version->>'lineNetAmount')::numeric <> round((v_version->>'quantity')::numeric * (v_version->>'unitNetValue')::numeric)
         OR (v_version->>'lineTaxAmount')::numeric <> round((v_version->>'lineNetAmount')::numeric * v_rate / 100)
         OR (v_version->>'lineGrossAmount')::numeric <> (v_version->>'lineNetAmount')::numeric + (v_version->>'lineTaxAmount')::numeric THEN
        RAISE EXCEPTION 'AUDIT_ACCEPTANCE_UNEXPLAINED_VALUE_CHANGE';
      END IF;
    END LOOP;
    SELECT count(*), min((source->>'netDiscount')::numeric) INTO v_count, v_old_discount
    FROM jsonb_array_elements(v_previous.version_snapshot->'sourceDetails') x
    CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(x->'raw_json') = 'object' THEN x->'raw_json' ELSE x END AS source) normalized
    WHERE source->>'id' = v_old->>'detailId' AND jsonb_typeof(source->'netDiscount') = 'number';
    IF v_count <> 1 THEN RAISE EXCEPTION 'AUDIT_ACCEPTANCE_DISCOUNT_EVIDENCE_MISSING'; END IF;
    SELECT count(*), min((source->>'netDiscount')::numeric) INTO v_count, v_new_discount
    FROM jsonb_array_elements(v_request.version_snapshot->'sourceDetails') x
    CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(x->'raw_json') = 'object' THEN x->'raw_json' ELSE x END AS source) normalized
    WHERE source->>'id' = v_new->>'detailId' AND jsonb_typeof(source->'netDiscount') = 'number';
    IF v_count <> 1 OR v_old_discount <> 0 OR v_new_discount <> 0 THEN
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

  -- Rechazar duplicar la misma versión del mismo documento físico Bsale
  IF EXISTS (
    SELECT 1 FROM logistica.sales_order_preparation_commercial_versions
    WHERE company_id = p_company_id AND card_id = p_card_id AND current_bsale_nv_id = v_current_id
  ) THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_DOCUMENT_ALREADY_EXISTS';
  END IF;

  -- Rechazar transición si el fingerprint no cambia respecto a la versión activa inmediata
  IF v_request.version_fingerprint = v_previous.fingerprint THEN
    RAISE EXCEPTION 'AUDIT_ACCEPTANCE_FINGERPRINT_ALREADY_EXISTS';
  END IF;

  INSERT INTO logistica.sales_order_preparation_commercial_versions (
    company_id, card_id, sequence_no, canonical_bsale_token, historical_bsale_nv_id, current_bsale_nv_id,
    previous_fingerprint, fingerprint, version_snapshot, applied_actions, accepted_by
  ) VALUES (
    p_company_id, p_card_id, v_previous.sequence_no + 1, v_card.canonical_bsale_token, v_card.bsale_nv_id, v_current_id,
    v_previous.fingerprint, v_request.version_fingerprint, v_request.version_snapshot,
    jsonb_build_array(jsonb_build_object('event', 'AUDIT_COMMERCIAL_ACCEPTANCE', 'auditId', p_audit_id, 'requestId', p_request_id, 'approval', v_request.approval_evidence, 'historicalTaxRateCertified', false)), p_actor_id
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
