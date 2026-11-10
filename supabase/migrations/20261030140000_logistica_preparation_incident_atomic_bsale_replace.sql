-- MEJ-01D1B: atomically replace one Bsale document projection.
-- The caller must fetch and validate the complete remote snapshot first.
BEGIN;

CREATE OR REPLACE FUNCTION integraciones.replace_bsale_document_snapshot_v1(
  p_company_id uuid,
  p_run_id uuid,
  p_document jsonb,
  p_details jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, integraciones
AS $function$
DECLARE
  v_document_id bigint;
  v_detail_count integer;
  v_run_status text;
BEGIN
  SELECT status INTO v_run_status
  FROM integraciones.bsale_sync_runs
  WHERE id = p_run_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND OR v_run_status IS DISTINCT FROM 'STARTED' THEN
    RAISE EXCEPTION 'BSALE_SYNC_RUN_INVALID' USING ERRCODE = '23514';
  END IF;

  v_document_id := NULLIF(p_document->>'bsale_id', '')::bigint;
  IF v_document_id IS NULL
     OR NULLIF(p_document->>'company_id', '')::uuid IS DISTINCT FROM p_company_id
     OR NULLIF(p_document->>'bsale_sync_run_id', '')::uuid IS DISTINCT FROM p_run_id
     OR (p_document->>'document_type_id')::integer IS DISTINCT FROM 23 THEN
    RAISE EXCEPTION 'BSALE_DOCUMENT_IDENTITY_INVALID' USING ERRCODE = '23514';
  END IF;

  CREATE TEMP TABLE mej_01d1b_details ON COMMIT DROP AS
  SELECT *
  FROM jsonb_to_recordset(COALESCE(p_details, '[]'::jsonb)) AS x(
    company_id uuid,
    bsale_id bigint,
    bsale_document_id bigint,
    related_detail_bsale_id bigint,
    line_number integer,
    quantity numeric,
    net_unit_value numeric,
    total_unit_value numeric,
    net_amount numeric,
    tax_amount numeric,
    total_amount numeric,
    net_discount numeric,
    variant_id bigint,
    variant_code text,
    variant_description text,
    raw_json jsonb,
    bsale_sync_run_id uuid,
    synced_at timestamptz
  );

  SELECT count(*)::integer INTO v_detail_count FROM pg_temp.mej_01d1b_details;
  IF EXISTS (SELECT 1 FROM pg_temp.mej_01d1b_details WHERE company_id IS DISTINCT FROM p_company_id OR bsale_document_id IS DISTINCT FROM v_document_id OR bsale_sync_run_id IS DISTINCT FROM p_run_id OR bsale_id IS NULL)
     OR EXISTS (SELECT 1 FROM pg_temp.mej_01d1b_details GROUP BY bsale_id HAVING count(*) > 1)
     OR EXISTS (
       SELECT 1
       FROM integraciones.bsale_document_details old_detail
       JOIN pg_temp.mej_01d1b_details incoming ON incoming.company_id = old_detail.company_id AND incoming.bsale_id = old_detail.bsale_id
       WHERE old_detail.company_id = p_company_id
         AND old_detail.bsale_document_id IS DISTINCT FROM v_document_id
     ) THEN
    RAISE EXCEPTION 'BSALE_DETAILS_IDENTITY_INVALID' USING ERRCODE = '23514';
  END IF;

  INSERT INTO integraciones.bsale_documents(
    company_id, bsale_id, number, emission_date, generation_date,
    total_amount, net_amount, tax_amount, exempt_amount, document_type_id,
    client_id, office_id, state, tracking_number, url_pdf, raw_json,
    bsale_sync_run_id, synced_at, updated_at
  ) VALUES (
    p_company_id, v_document_id, NULLIF(p_document->>'number', '')::integer,
    NULLIF(p_document->>'emission_date', '')::date,
    NULLIF(p_document->>'generation_date', '')::timestamptz,
    NULLIF(p_document->>'total_amount', '')::numeric,
    NULLIF(p_document->>'net_amount', '')::numeric,
    NULLIF(p_document->>'tax_amount', '')::numeric,
    NULLIF(p_document->>'exempt_amount', '')::numeric,
    (p_document->>'document_type_id')::integer,
    NULLIF(p_document->>'client_id', '')::integer,
    NULLIF(p_document->>'office_id', '')::integer,
    NULLIF(p_document->>'state', '')::integer,
    p_document->>'tracking_number', p_document->>'url_pdf', p_document->'raw_json',
    p_run_id, COALESCE(NULLIF(p_document->>'synced_at', '')::timestamptz, now()), now()
  )
  ON CONFLICT (company_id, bsale_id) DO UPDATE SET
    number = EXCLUDED.number, emission_date = EXCLUDED.emission_date,
    generation_date = EXCLUDED.generation_date, total_amount = EXCLUDED.total_amount,
    net_amount = EXCLUDED.net_amount, tax_amount = EXCLUDED.tax_amount,
    exempt_amount = EXCLUDED.exempt_amount, document_type_id = EXCLUDED.document_type_id,
    client_id = EXCLUDED.client_id, office_id = EXCLUDED.office_id, state = EXCLUDED.state,
    tracking_number = EXCLUDED.tracking_number, url_pdf = EXCLUDED.url_pdf,
    raw_json = EXCLUDED.raw_json, bsale_sync_run_id = EXCLUDED.bsale_sync_run_id,
    synced_at = EXCLUDED.synced_at, updated_at = now();

  INSERT INTO integraciones.bsale_document_details(
    company_id, bsale_id, bsale_document_id, related_detail_bsale_id, line_number,
    quantity, net_unit_value, total_unit_value, net_amount, tax_amount, total_amount,
    net_discount, variant_id, variant_code, variant_description, raw_json,
    bsale_sync_run_id, synced_at, updated_at
  )
  SELECT company_id, bsale_id, bsale_document_id, related_detail_bsale_id, line_number,
    quantity, net_unit_value, total_unit_value, net_amount, tax_amount, total_amount,
    net_discount, variant_id, variant_code, variant_description, raw_json,
    bsale_sync_run_id, COALESCE(synced_at, now()), now()
  FROM pg_temp.mej_01d1b_details
  ON CONFLICT (company_id, bsale_id) DO UPDATE SET
    bsale_document_id = EXCLUDED.bsale_document_id, related_detail_bsale_id = EXCLUDED.related_detail_bsale_id,
    line_number = EXCLUDED.line_number, quantity = EXCLUDED.quantity,
    net_unit_value = EXCLUDED.net_unit_value, total_unit_value = EXCLUDED.total_unit_value,
    net_amount = EXCLUDED.net_amount, tax_amount = EXCLUDED.tax_amount,
    total_amount = EXCLUDED.total_amount, net_discount = EXCLUDED.net_discount,
    variant_id = EXCLUDED.variant_id, variant_code = EXCLUDED.variant_code,
    variant_description = EXCLUDED.variant_description, raw_json = EXCLUDED.raw_json,
    bsale_sync_run_id = EXCLUDED.bsale_sync_run_id, synced_at = EXCLUDED.synced_at, updated_at = now();

  DELETE FROM integraciones.bsale_document_details old_detail
  WHERE old_detail.company_id = p_company_id
    AND old_detail.bsale_document_id = v_document_id
    AND NOT EXISTS (SELECT 1 FROM pg_temp.mej_01d1b_details incoming WHERE incoming.company_id = old_detail.company_id AND incoming.bsale_id = old_detail.bsale_id);

  UPDATE integraciones.bsale_sync_runs
  SET status = 'COMPLETED', completed_at = now(), documents_count = 1, document_details_count = v_detail_count, error_message = NULL
  WHERE id = p_run_id AND company_id = p_company_id AND status = 'STARTED';
  IF NOT FOUND THEN RAISE EXCEPTION 'BSALE_SYNC_RUN_COMPLETION_FAILED' USING ERRCODE = '23514'; END IF;

  RETURN jsonb_build_object('document_id', v_document_id, 'detail_count', v_detail_count, 'sync_run_id', p_run_id, 'status', 'COMPLETED');
END;
$function$;

REVOKE ALL ON FUNCTION integraciones.replace_bsale_document_snapshot_v1(uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.replace_bsale_document_snapshot_v1(uuid, uuid, jsonb, jsonb) TO service_role;

COMMENT ON FUNCTION integraciones.replace_bsale_document_snapshot_v1(uuid, uuid, jsonb, jsonb) IS
  'MEJ-01D1B: atomically replaces one company-scoped Bsale document projection and completes its sync run only after header/detail replacement succeeds.';

COMMIT;
