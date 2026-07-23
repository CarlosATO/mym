-- Agrega validación defensiva en create_commission_settlement_draft
-- para que jsonb_array_elements reciba siempre un array.

CREATE OR REPLACE FUNCTION comercial.create_commission_settlement_draft(
  p_company_id uuid,
  p_user_id uuid,
  p_seller_bsale_id bigint,
  p_seller_profile_id uuid,
  p_seller_name text,
  p_period_from date,
  p_period_to date,
  p_period_label text,
  p_lines jsonb,
  p_total_net_amount numeric,
  p_total_commission_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_settlement_id uuid;
  v_line jsonb;
  v_has_access boolean;
  v_line_type text;
  v_invoice_line_id uuid;
  v_source_document_line_id uuid;
BEGIN
  SELECT core.has_company_access(p_user_id, p_company_id) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a la empresa');
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_PAYLOAD: el parámetro líneas debe ser un arreglo JSON. Se recibió: ' || COALESCE(jsonb_typeof(p_lines)::text, 'NULL'));
  END IF;

  IF jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'EMPTY_PAYLOAD: no hay líneas para crear el borrador');
  END IF;

  INSERT INTO comercial.commission_settlements (
    company_id, settlement_code, seller_profile_id, seller_bsale_id, seller_name,
    period_from, period_to, period_label, status, source,
    total_net_amount, total_commission_amount, created_by, updated_by
  ) VALUES (
    p_company_id,
    'DRAFT-' || p_seller_bsale_id::text || '-' || to_char(now(), 'YYYYMMDDHH24MISS'),
    p_seller_profile_id, p_seller_bsale_id, p_seller_name,
    p_period_from, p_period_to, p_period_label, 'DRAFT', 'NORMAL',
    p_total_net_amount, p_total_commission_amount, p_user_id, p_user_id
  )
  RETURNING id INTO v_settlement_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_line_type := CASE WHEN (v_line->>'commission_line_type')::text = 'CREDIT_NOTE_LINE' THEN 'CREDIT_NOTE' ELSE 'INVOICE' END;

    IF v_line_type = 'CREDIT_NOTE' THEN
      v_invoice_line_id := NULL;
      v_source_document_line_id := (v_line->>'source_detail_id')::uuid;
    ELSE
      v_invoice_line_id := (v_line->>'invoice_line_id')::uuid;
      v_source_document_line_id := (v_line->>'source_detail_id')::uuid;
    END IF;

    INSERT INTO comercial.commission_settlement_lines (
      company_id, settlement_id, line_type,
      seller_profile_id, seller_bsale_id, seller_name,
      invoice_bsale_id, invoice_number, invoice_line_id,
      product_id, sku, product_name,
      supplier_id, commission_group_id, customer_name,
      quantity, net_amount, commission_base_amount, commission_percent, commission_amount,
      rule_id, payment_completed_at,
      source_document_bsale_id, source_document_number, source_document_type_id, source_document_line_id,
      original_invoice_bsale_id, original_invoice_number,
      eligibility_locked_at,
      created_by, updated_by,
      metadata
    ) VALUES (
      p_company_id, v_settlement_id, v_line_type,
      p_seller_profile_id, p_seller_bsale_id, p_seller_name,
      (v_line->>'invoice_bsale_id')::bigint, (v_line->>'invoice_number')::bigint, v_invoice_line_id,
      (v_line->>'product_id')::uuid, v_line->>'sku', v_line->>'product_name',
      (v_line->>'supplier_id')::uuid, (v_line->>'commission_group_id')::uuid, v_line->>'customer_name',
      (v_line->>'quantity')::numeric, (v_line->>'net_amount')::numeric, (v_line->>'net_amount')::numeric,
      (v_line->>'commission_percent')::numeric, (v_line->>'commission_amount')::numeric,
      (v_line->>'rule_id')::uuid, (v_line->>'payment_completed_at')::timestamptz,
      (v_line->>'source_document_id')::bigint, (v_line->>'source_document_number')::bigint,
      CASE WHEN (v_line->>'source_document_type')::text = 'CREDIT_NOTE' THEN 2 ELSE 5 END,
      v_source_document_line_id,
      (v_line->>'original_invoice_id')::bigint, (v_line->>'original_invoice_number')::bigint,
      now(),
      p_user_id, p_user_id,
      jsonb_build_object(
        'supplier_name', v_line->>'supplier_name',
        'commission_group_name', v_line->>'commission_group_name',
        'adjustment_reason', v_line->>'adjustment_reason',
        'source_document_type', v_line->>'source_document_type',
        'commission_line_type', v_line->>'commission_line_type',
        'warning_code', v_line->>'warning_code',
        'warning_message', v_line->>'warning_message'
      )
    );
  END LOOP;

  RETURN jsonb_build_object('success', true, 'settlement_id', v_settlement_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'error', 'Ya existe un borrador activo para este vendedor. Cancélalo antes de crear otro.');
WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION comercial.create_commission_settlement_draft(uuid, uuid, bigint, uuid, text, date, date, text, jsonb, numeric, numeric) TO authenticated, service_role;
