-- Funciones transaccionales para borradores de liquidación de comisiones.
-- Sigue el patrón SECURITY DEFINER usado en create_purchase_order, create_stock_adjustment, etc.

-- 1. Crear borrador: inserta settlement DRAFT + líneas con eligibility_locked_at = now()

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

-- 2. Cancelar borrador: cambia a CANCELLED y libera líneas

CREATE OR REPLACE FUNCTION comercial.cancel_commission_settlement_draft(
  p_company_id uuid,
  p_user_id uuid,
  p_settlement_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_settlement comercial.commission_settlements;
  v_has_access boolean;
BEGIN
  SELECT core.has_company_access(p_user_id, p_company_id) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a la empresa');
  END IF;

  SELECT * INTO v_settlement
  FROM comercial.commission_settlements
  WHERE id = p_settlement_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Liquidación no encontrada');
  END IF;

  IF v_settlement.status != 'DRAFT' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo se puede cancelar un borrador en estado DRAFT');
  END IF;

  IF v_settlement.source = 'HISTORICAL' THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se puede cancelar la liquidación histórica');
  END IF;

  UPDATE comercial.commission_settlements
  SET status = 'CANCELLED',
      cancelled_at = now(),
      cancelled_by = p_user_id,
      cancellation_reason = p_reason,
      updated_at = now(),
      updated_by = p_user_id
  WHERE id = p_settlement_id;

  UPDATE comercial.commission_settlement_lines
  SET eligibility_locked_at = NULL,
      updated_at = now(),
      updated_by = p_user_id
  WHERE settlement_id = p_settlement_id;

  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- 3. Emitir borrador: asigna correlativo y cambia a ISSUED

CREATE OR REPLACE FUNCTION comercial.issue_commission_settlement(
  p_company_id uuid,
  p_user_id uuid,
  p_settlement_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_settlement comercial.commission_settlements;
  v_has_access boolean;
  v_next_number bigint;
  v_settlement_code text;
BEGIN
  SELECT core.has_company_access(p_user_id, p_company_id) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a la empresa');
  END IF;

  SELECT * INTO v_settlement
  FROM comercial.commission_settlements
  WHERE id = p_settlement_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Liquidación no encontrada');
  END IF;

  IF v_settlement.status != 'DRAFT' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo se puede emitir un borrador en estado DRAFT');
  END IF;

  INSERT INTO comercial.commission_settlement_sequences (company_id, last_settlement_number)
  VALUES (p_company_id, 1)
  ON CONFLICT (company_id) DO UPDATE
  SET last_settlement_number = comercial.commission_settlement_sequences.last_settlement_number + 1
  RETURNING last_settlement_number INTO v_next_number;

  v_settlement_code := 'LIQ-' || to_char(now(), 'YYYY') || '-' || LPAD(v_next_number::text, 6, '0');

  UPDATE comercial.commission_settlements
  SET status = 'ISSUED',
      settlement_number = v_next_number,
      settlement_code = v_settlement_code,
      issued_at = now(),
      issued_by = p_user_id,
      updated_at = now(),
      updated_by = p_user_id
  WHERE id = p_settlement_id;

  RETURN jsonb_build_object(
    'success', true,
    'settlement_number', v_next_number,
    'settlement_code', v_settlement_code
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION comercial.create_commission_settlement_draft(uuid, uuid, bigint, uuid, text, date, date, text, jsonb, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION comercial.cancel_commission_settlement_draft(uuid, uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION comercial.issue_commission_settlement(uuid, uuid, uuid) TO authenticated, service_role;
