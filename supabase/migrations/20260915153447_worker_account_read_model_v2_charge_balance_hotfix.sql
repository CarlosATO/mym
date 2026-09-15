CREATE OR REPLACE FUNCTION mermas.get_worker_account_detail_v2(
  p_company_id uuid,
  p_user_id uuid,
  p_employee_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, rrhh, integraciones, mermas
AS $$
DECLARE
  v_employee rrhh.employees%ROWTYPE;
  v_summary jsonb;
  v_charges jsonb;
  v_payments jsonb;
  v_movements jsonb;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_employee_id IS NULL
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.account.view') THEN
    RAISE EXCEPTION 'No autorizado para consultar cuenta corriente';
  END IF;

  SELECT e.* INTO v_employee
  FROM rrhh.employees e
  WHERE e.id = p_employee_id
    AND (EXISTS (SELECT 1 FROM rrhh.worker_account_charges c WHERE c.company_id = p_company_id AND c.employee_id = e.id)
      OR EXISTS (SELECT 1 FROM mermas.worker_payments p WHERE p.company_id = p_company_id AND p.employee_id = e.id));
  IF NOT FOUND THEN RAISE EXCEPTION 'Trabajador no encontrado'; END IF;

  WITH charge_balances AS (
    SELECT c.id, c.source_type, c.source_id, c.document_type, c.document_number,
      c.document_date, c.created_at, c.amount AS original_amount, c.status,
      coalesce(sum(a.amount) FILTER (WHERE p.status = 'APPROVED'), 0)::numeric AS approved_paid_amount
    FROM rrhh.worker_account_charges c
    LEFT JOIN mermas.worker_payment_allocations a ON a.company_id = c.company_id AND a.charge_id = c.id
    LEFT JOIN mermas.worker_payments p ON p.id = a.payment_id
    WHERE c.company_id = p_company_id AND c.employee_id = p_employee_id
    GROUP BY c.id, c.source_type, c.source_id, c.document_type, c.document_number, c.document_date, c.created_at, c.amount, c.status
  )
  SELECT jsonb_build_object(
    'total_original_charges', coalesce(sum(original_amount) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type IN ('MERMA', 'BSALE_BOLETA')), 0),
    'approved_payments', (SELECT coalesce(sum(amount), 0) FROM mermas.worker_payments WHERE company_id = p_company_id AND employee_id = p_employee_id AND status = 'APPROVED'),
    'pending_review_payments', (SELECT coalesce(sum(amount), 0) FROM mermas.worker_payments WHERE company_id = p_company_id AND employee_id = p_employee_id AND status = 'PENDING_REVIEW'),
    'official_balance', coalesce(sum(greatest(original_amount - approved_paid_amount, 0)) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type IN ('MERMA', 'BSALE_BOLETA')), 0),
    'projected_balance', greatest(coalesce(sum(greatest(original_amount - approved_paid_amount, 0)) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type IN ('MERMA', 'BSALE_BOLETA')), 0) - (SELECT coalesce(sum(amount), 0) FROM mermas.worker_payments WHERE company_id = p_company_id AND employee_id = p_employee_id AND status = 'PENDING_REVIEW'), 0),
    'merma_original', coalesce(sum(original_amount) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type = 'MERMA'), 0),
    'merma_balance', coalesce(sum(greatest(original_amount - approved_paid_amount, 0)) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type = 'MERMA'), 0),
    'bsale_boleta_original', coalesce(sum(original_amount) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type = 'BSALE_BOLETA'), 0),
    'bsale_boleta_balance', coalesce(sum(greatest(original_amount - approved_paid_amount, 0)) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type = 'BSALE_BOLETA'), 0),
    'charge_count', count(*) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type IN ('MERMA', 'BSALE_BOLETA')),
    'open_charge_count', count(*) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type IN ('MERMA', 'BSALE_BOLETA') AND greatest(original_amount - approved_paid_amount, 0) > 0),
    'paid_charge_count', count(*) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type IN ('MERMA', 'BSALE_BOLETA') AND greatest(original_amount - approved_paid_amount, 0) = 0)
  ) INTO v_summary
  FROM charge_balances;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'charge_id', c.id, 'source_type', c.source_type,
    'source_label', CASE c.source_type WHEN 'MERMA' THEN 'Venta Mermas' WHEN 'BSALE_BOLETA' THEN 'Boleta Bsale' ELSE c.source_type END,
    'source_id', c.source_id, 'document_type', c.document_type, 'document_number', c.document_number,
    'document_date', c.document_date, 'original_amount', c.original_amount,
    'approved_paid_amount', c.approved_paid_amount,
    'outstanding_amount', CASE WHEN c.status = 'ACTIVE' AND c.original_amount > 0 THEN greatest(c.original_amount - c.approved_paid_amount, 0) ELSE 0 END, 'status', c.status,
    'items', CASE WHEN c.source_type = 'MERMA' THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object('bsale_variant_id', l.bsale_variant_id, 'sku', l.sku_snapshot, 'product_name', l.product_name_snapshot, 'quantity', l.quantity, 'unit_price', l.worker_unit_price_snapshot, 'line_total', l.line_total) ORDER BY l.created_at, l.id)
      FROM mermas.internal_sale_lines l WHERE l.company_id = p_company_id AND l.sale_id::text = c.source_id
    ), '[]'::jsonb) WHEN c.source_type = 'BSALE_BOLETA' THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object('bsale_variant_id', d.variant_id, 'variant_id', d.variant_id, 'sku', coalesce(v.code, d.variant_code), 'variant_code', coalesce(v.code, d.variant_code), 'product_name', coalesce(bp.name, d.variant_description, v.description, 'Producto Bsale'), 'variant_description', d.variant_description, 'quantity', d.quantity, 'unit_price', d.total_unit_value, 'line_total', d.total_amount) ORDER BY d.line_number, d.id)
      FROM integraciones.bsale_document_details d
      LEFT JOIN integraciones.bsale_variants v ON v.company_id = d.company_id AND v.bsale_id = d.variant_id
      LEFT JOIN integraciones.bsale_products bp ON bp.company_id = d.company_id AND bp.bsale_id = v.bsale_product_id
      WHERE d.company_id = p_company_id AND d.bsale_document_id::text = c.source_id
    ), '[]'::jsonb) ELSE '[]'::jsonb END,
    'allocations', coalesce((SELECT jsonb_agg(jsonb_build_object('payment_id', p.id, 'payment_number', p.payment_number, 'payment_date', p.submitted_at, 'amount', a.amount) ORDER BY p.submitted_at, p.id)
      FROM mermas.worker_payment_allocations a JOIN mermas.worker_payments p ON p.id = a.payment_id
      WHERE a.company_id = p_company_id AND p.company_id = p_company_id AND a.charge_id = c.id AND p.status = 'APPROVED'), '[]'::jsonb)
  ) ORDER BY coalesce(c.document_date, c.created_at), c.id), '[]'::jsonb) INTO v_charges
  FROM (
    SELECT wc.*,
      wc.amount AS original_amount,
      coalesce((
        SELECT sum(a.amount)
        FROM mermas.worker_payment_allocations a
        JOIN mermas.worker_payments p ON p.id = a.payment_id
        WHERE a.company_id = wc.company_id
          AND a.charge_id = wc.id
          AND p.company_id = wc.company_id
          AND p.status = 'APPROVED'
      ), 0)::numeric AS approved_paid_amount
    FROM rrhh.worker_account_charges wc
    WHERE wc.company_id = p_company_id
      AND wc.employee_id = p_employee_id
  ) c;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'payment_id', p.id, 'payment_number', p.payment_number, 'amount', p.amount, 'status', p.status,
    'submitted_at', p.submitted_at, 'reviewed_at', p.reviewed_at,
    'allocations', CASE WHEN p.status = 'APPROVED' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('charge_id', c.id, 'source_type', c.source_type, 'document_number', c.document_number, 'amount', a.amount) ORDER BY c.document_date, c.id)
      FROM mermas.worker_payment_allocations a JOIN rrhh.worker_account_charges c ON c.id = a.charge_id
      WHERE a.company_id = p_company_id AND c.company_id = p_company_id AND a.payment_id = p.id), '[]'::jsonb) ELSE '[]'::jsonb END
  ) ORDER BY p.submitted_at, p.id), '[]'::jsonb) INTO v_payments
  FROM mermas.worker_payments p
  WHERE p.company_id = p_company_id AND p.employee_id = p_employee_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'movement_type', movement_type, 'charge_id', charge_id, 'payment_id', payment_id,
    'source_type', source_type, 'reference_number', reference_number, 'amount', amount,
    'status', status, 'occurred_at', occurred_at
  ) ORDER BY occurred_at, reference_number, coalesce(charge_id, payment_id)), '[]'::jsonb) INTO v_movements
  FROM (
    SELECT 'CHARGE'::text AS movement_type, c.id AS charge_id, NULL::uuid AS payment_id,
      c.source_type, coalesce(c.document_number, c.source_id) AS reference_number,
      c.amount, c.status, coalesce(c.document_date, c.created_at) AS occurred_at
    FROM rrhh.worker_account_charges c WHERE c.company_id = p_company_id AND c.employee_id = p_employee_id
    UNION ALL
    SELECT 'PAYMENT', NULL, p.id, NULL, coalesce(p.payment_number, 'Pago sin correlativo'),
      p.amount, p.status, p.submitted_at
    FROM mermas.worker_payments p WHERE p.company_id = p_company_id AND p.employee_id = p_employee_id
  ) movements;

  RETURN jsonb_build_object(
    'employee', jsonb_build_object('id', v_employee.id, 'name', pg_catalog.btrim(pg_catalog.concat_ws(' ', v_employee.nombres, v_employee.apellido_paterno, v_employee.apellido_materno)), 'rut', v_employee.rut, 'status', v_employee.estado),
    'summary', v_summary, 'charges', v_charges, 'payments', v_payments, 'movements', v_movements
  );
END;
$$;
