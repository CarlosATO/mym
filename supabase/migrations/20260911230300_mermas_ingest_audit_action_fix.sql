-- MERMAS: keep the ingest audit action within portal.audit_logs.action limits.

CREATE OR REPLACE FUNCTION mermas.process_bsale_consumption(
  p_company_id uuid, p_user_id uuid, p_header jsonb, p_details jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
  v_consumption_id bigint := NULLIF(p_header->>'id', '')::bigint;
  v_type integer := NULLIF(p_header->>'consumptionTypeId', '')::integer;
  v_consumption mermas.bsale_consumptions%ROWTYPE;
  v_detail jsonb;
  v_detail_id bigint;
  v_variant_id integer;
  v_quantity numeric;
  v_new_details integer := 0;
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.sync') THEN
    RAISE EXCEPTION 'No autorizado para sincronizar Mermas';
  END IF;
  IF v_consumption_id IS NULL OR v_type IS DISTINCT FROM 2 THEN
    RETURN jsonb_build_object('accepted', false, 'new_details', 0, 'new_movements', 0, 'request_id', NULL, 'request_status', NULL);
  END IF;
  INSERT INTO mermas.bsale_consumptions (
    company_id, consumption_id, consumption_date, note, consumption_type_id,
    office_id, user_id, raw_json, processed_at
  ) VALUES (
    p_company_id, v_consumption_id,
    CASE
      WHEN NULLIF(p_header->>'consumptionDate', '') IS NULL THEN NULL
      WHEN p_header->>'consumptionDate' ~ '^[-]?[0-9]+(\.[0-9]+)?$' THEN to_timestamp((p_header->>'consumptionDate')::numeric)
      ELSE (p_header->>'consumptionDate')::timestamptz
    END,
    p_header->>'note', v_type,
    NULLIF(p_header->'office'->>'id', '')::integer,
    NULLIF(p_header->'user'->>'id', '')::integer,
    p_header, now()
  ) ON CONFLICT (company_id, consumption_id) DO UPDATE SET
    consumption_date = EXCLUDED.consumption_date, note = EXCLUDED.note,
    consumption_type_id = EXCLUDED.consumption_type_id, office_id = EXCLUDED.office_id,
    user_id = EXCLUDED.user_id, raw_json = EXCLUDED.raw_json, processed_at = now()
  RETURNING * INTO v_consumption;
  FOR v_detail IN SELECT value FROM jsonb_array_elements(COALESCE(p_details, '[]'::jsonb)) LOOP
    v_detail_id := NULLIF(v_detail->>'id', '')::bigint;
    v_variant_id := COALESCE(NULLIF(v_detail->'variant'->>'id', '')::integer, NULLIF(v_detail->>'variant_id', '')::integer);
    v_quantity := NULLIF(v_detail->>'quantity', '')::numeric;
    IF v_detail_id IS NULL OR v_variant_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN CONTINUE; END IF;
    INSERT INTO mermas.bsale_consumption_details (
      company_id, consumption_id, detail_id, variant_id, quantity, cost, variant_stock, raw_json
    ) VALUES (
      p_company_id, v_consumption_id, v_detail_id, v_variant_id, v_quantity,
      NULLIF(v_detail->>'cost', '')::numeric,
      NULLIF(v_detail->>'variantStock', '')::numeric, v_detail
    ) ON CONFLICT (company_id, consumption_id, detail_id) DO NOTHING;
    IF FOUND THEN v_new_details := v_new_details + 1; END IF;
  END LOOP;
  IF v_new_details > 0 THEN
    INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
    VALUES ('mermas.bsale_consumptions', v_consumption.id, 'MERMAS_INGEST',
      jsonb_build_object('consumption_id', v_consumption_id, 'type_id', v_type, 'new_details', v_new_details), p_user_id);
  END IF;
  RETURN jsonb_build_object('accepted', true, 'new_details', v_new_details, 'new_movements', 0,
    'request_id', v_consumption.request_id, 'request_status', NULL);
END;
$$;

REVOKE ALL ON FUNCTION mermas.process_bsale_consumption(uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.process_bsale_consumption(uuid, uuid, jsonb, jsonb) TO service_role;
