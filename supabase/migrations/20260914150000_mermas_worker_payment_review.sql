-- MERMAS: SUPER_USUARIO review and FIFO settlement of worker payments.

CREATE UNIQUE INDEX mermas_worker_payment_allocations_payment_sale_uidx
  ON mermas.worker_payment_allocations(payment_id, internal_sale_id);

CREATE OR REPLACE FUNCTION mermas.get_worker_payments_for_review(
  p_company_id uuid,
  p_user_id uuid,
  p_status text DEFAULT 'PENDING_REVIEW'
) RETURNS TABLE (
  payment_id uuid,
  payment_number text,
  employee_id uuid,
  employee_name text,
  rut text,
  amount numeric,
  submitted_at timestamptz,
  submitted_by text,
  status text,
  original_filename text,
  mime_type text,
  size_bytes bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, rrhh, mermas
AS $$
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM core.companies c WHERE c.id = p_company_id AND c.is_active)
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT portal.is_super_usuario(p_user_id) THEN
    RAISE EXCEPTION 'No autorizado para revisar pagos de trabajadores';
  END IF;
  RETURN QUERY
  SELECT p.id, p.payment_number, p.employee_id,
    pg_catalog.btrim(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)),
    e.rut, p.amount, p.submitted_at,
    coalesce(pg_catalog.btrim(pg_catalog.concat_ws(' ', u.nombre, u.apellido)), u.email, p.submitted_by::text),
    p.status, evidence.original_filename, evidence.mime_type, evidence.size_bytes
  FROM mermas.worker_payments p
  JOIN rrhh.employees e ON e.id = p.employee_id
  JOIN portal.users u ON u.id = p.submitted_by
  JOIN mermas.worker_payment_evidence evidence ON evidence.payment_id = p.id
  WHERE p.company_id = p_company_id
    AND (p_status IS NULL OR p.status = p_status)
  ORDER BY p.submitted_at ASC, p.payment_number ASC;
END;
$$;

CREATE OR REPLACE FUNCTION mermas.get_worker_payment_review_detail(
  p_company_id uuid,
  p_user_id uuid,
  p_payment_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, rrhh, mermas
AS $$
DECLARE
  v_payment mermas.worker_payments%ROWTYPE;
  v_employee rrhh.employees%ROWTYPE;
  v_evidence mermas.worker_payment_evidence%ROWTYPE;
  v_summary jsonb;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_payment_id IS NULL
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT portal.is_super_usuario(p_user_id) THEN
    RAISE EXCEPTION 'No autorizado para revisar pagos de trabajadores';
  END IF;
  SELECT * INTO v_payment FROM mermas.worker_payments p
    WHERE p.id = p_payment_id AND p.company_id = p_company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pago no encontrado'; END IF;
  SELECT * INTO v_employee FROM rrhh.employees e WHERE e.id = v_payment.employee_id;
  SELECT * INTO v_evidence FROM mermas.worker_payment_evidence evidence WHERE evidence.payment_id = v_payment.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'El pago no tiene comprobante'; END IF;

  WITH charges AS (
    SELECT coalesce(sum(s.total_amount), 0)::numeric AS total_charges
    FROM mermas.internal_sales s
    WHERE s.company_id = p_company_id AND s.employee_id = v_payment.employee_id AND s.status <> 'REVERSED'
  ), payments AS (
    SELECT coalesce(sum(p.amount) FILTER (WHERE p.status = 'APPROVED'), 0)::numeric AS approved_payments,
      coalesce(sum(p.amount) FILTER (WHERE p.status = 'PENDING_REVIEW'), 0)::numeric AS pending_review_payments
    FROM mermas.worker_payments p
    WHERE p.company_id = p_company_id AND p.employee_id = v_payment.employee_id
  )
  SELECT jsonb_build_object(
    'total_charges', c.total_charges,
    'approved_payments', p.approved_payments,
    'pending_review_payments', p.pending_review_payments,
    'official_balance', greatest(c.total_charges - p.approved_payments, 0),
    'projected_balance', greatest(c.total_charges - p.approved_payments - p.pending_review_payments, 0)
  ) INTO v_summary FROM charges c CROSS JOIN payments p;

  RETURN jsonb_build_object(
    'payment', jsonb_build_object(
      'id', v_payment.id, 'payment_number', v_payment.payment_number, 'amount', v_payment.amount,
      'status', v_payment.status, 'submitted_at', v_payment.submitted_at,
      'submitted_by', coalesce((SELECT pg_catalog.btrim(pg_catalog.concat_ws(' ', u.nombre, u.apellido)) FROM portal.users u WHERE u.id = v_payment.submitted_by), v_payment.submitted_by::text)
    ),
    'employee', jsonb_build_object(
      'id', v_employee.id,
      'name', pg_catalog.btrim(pg_catalog.concat_ws(' ', v_employee.nombres, v_employee.apellido_paterno, v_employee.apellido_materno)),
      'rut', v_employee.rut
    ),
    'summary', v_summary,
    'evidence', jsonb_build_object(
      'original_filename', v_evidence.original_filename, 'mime_type', v_evidence.mime_type,
      'size_bytes', v_evidence.size_bytes
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION mermas.approve_worker_payment(
  p_company_id uuid,
  p_user_id uuid,
  p_payment_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, rrhh, mermas
AS $$
DECLARE
  v_payment mermas.worker_payments%ROWTYPE;
  v_sale record;
  v_sale_remaining numeric;
  v_to_apply numeric;
  v_remaining numeric;
  v_allocations jsonb := '[]'::jsonb;
  v_allocated numeric := 0;
  v_sale_allocated numeric;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_payment_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM core.companies c WHERE c.id = p_company_id AND c.is_active)
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT portal.is_super_usuario(p_user_id) THEN
    RAISE EXCEPTION 'No autorizado para aprobar pagos de trabajadores';
  END IF;
  SELECT * INTO v_payment FROM mermas.worker_payments p
    WHERE p.id = p_payment_id AND p.company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pago no encontrado'; END IF;
  IF v_payment.status <> 'PENDING_REVIEW' THEN RAISE EXCEPTION 'El pago ya fue revisado'; END IF;
  IF NOT EXISTS (SELECT 1 FROM mermas.worker_payment_evidence evidence WHERE evidence.payment_id = v_payment.id) THEN
    RAISE EXCEPTION 'El pago no tiene comprobante';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'mermas-worker-payment:' || p_company_id::text || ':' || v_payment.employee_id::text, 0));
  v_remaining := v_payment.amount;

  FOR v_sale IN
    SELECT s.id, s.sale_number, s.total_amount,
      coalesce(sum(a.amount) FILTER (WHERE approved.status = 'APPROVED'), 0)::numeric AS approved_allocated
    FROM mermas.internal_sales s
    LEFT JOIN mermas.worker_payment_allocations a ON a.internal_sale_id = s.id AND a.company_id = p_company_id
    LEFT JOIN mermas.worker_payments approved ON approved.id = a.payment_id
    WHERE s.company_id = p_company_id AND s.employee_id = v_payment.employee_id AND s.status <> 'REVERSED'
    GROUP BY s.id, s.sale_number, s.total_amount, s.created_at
    HAVING s.total_amount - coalesce(sum(a.amount) FILTER (WHERE approved.status = 'APPROVED'), 0) > 0
    ORDER BY s.created_at ASC, s.sale_number ASC
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_sale_remaining := v_sale.total_amount - v_sale.approved_allocated;
    v_to_apply := least(v_remaining, v_sale_remaining);
    INSERT INTO mermas.worker_payment_allocations(company_id, payment_id, internal_sale_id, amount)
    VALUES (p_company_id, v_payment.id, v_sale.id, v_to_apply);
    v_allocated := v_allocated + v_to_apply;
    v_remaining := v_remaining - v_to_apply;
    v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
      'internal_sale_id', v_sale.id, 'sale_number', v_sale.sale_number, 'amount', v_to_apply));
    SELECT coalesce(sum(a.amount) FILTER (WHERE approved.status = 'APPROVED'), 0) + v_to_apply
      INTO v_sale_allocated
    FROM mermas.worker_payment_allocations a
    JOIN mermas.worker_payments approved ON approved.id = a.payment_id
    WHERE a.internal_sale_id = v_sale.id AND a.company_id = p_company_id;
    IF v_sale_allocated >= v_sale.total_amount THEN
      UPDATE mermas.internal_sales s SET status = 'RENDERED', updated_at = now()
      WHERE s.id = v_sale.id AND s.status <> 'REVERSED';
    END IF;
  END LOOP;
  IF v_remaining > 0 OR v_allocated <> v_payment.amount THEN
    RAISE EXCEPTION 'La deuda pendiente no alcanza para asignar completamente el pago';
  END IF;

  UPDATE mermas.worker_payments p SET status = 'APPROVED', reviewed_by = p_user_id,
    reviewed_at = now(), rejection_reason = NULL, updated_at = now()
  WHERE p.id = v_payment.id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES ('mermas.worker_payments', v_payment.id, 'MERMA_PAY_APPROVE', jsonb_build_object(
    'payment_id', v_payment.id, 'payment_number', v_payment.payment_number,
    'employee_id', v_payment.employee_id, 'amount', v_payment.amount,
    'company_id', p_company_id, 'allocations', v_allocations), p_user_id);
  RETURN jsonb_build_object('payment_id', v_payment.id, 'payment_number', v_payment.payment_number,
    'status', 'APPROVED', 'allocations', v_allocations);
END;
$$;

CREATE OR REPLACE FUNCTION mermas.reject_worker_payment(
  p_company_id uuid,
  p_user_id uuid,
  p_payment_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, rrhh, mermas
AS $$
DECLARE
  v_payment mermas.worker_payments%ROWTYPE;
  v_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_payment_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM core.companies c WHERE c.id = p_company_id AND c.is_active)
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT portal.is_super_usuario(p_user_id) THEN
    RAISE EXCEPTION 'No autorizado para rechazar pagos de trabajadores';
  END IF;
  IF v_reason = '' THEN RAISE EXCEPTION 'El motivo del rechazo es obligatorio'; END IF;
  SELECT * INTO v_payment FROM mermas.worker_payments p
    WHERE p.id = p_payment_id AND p.company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pago no encontrado'; END IF;
  IF v_payment.status <> 'PENDING_REVIEW' THEN RAISE EXCEPTION 'El pago ya fue revisado'; END IF;
  UPDATE mermas.worker_payments p SET status = 'REJECTED', reviewed_by = p_user_id,
    reviewed_at = now(), rejection_reason = v_reason, updated_at = now()
  WHERE p.id = v_payment.id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES ('mermas.worker_payments', v_payment.id, 'MERMA_PAY_REJECT', jsonb_build_object(
    'payment_id', v_payment.id, 'payment_number', v_payment.payment_number,
    'employee_id', v_payment.employee_id, 'amount', v_payment.amount,
    'company_id', p_company_id, 'reason', v_reason), p_user_id);
  RETURN jsonb_build_object('payment_id', v_payment.id, 'payment_number', v_payment.payment_number,
    'status', 'REJECTED');
END;
$$;

REVOKE ALL ON FUNCTION mermas.get_worker_payments_for_review(uuid, uuid, text),
  mermas.get_worker_payment_review_detail(uuid, uuid, uuid),
  mermas.approve_worker_payment(uuid, uuid, uuid),
  mermas.reject_worker_payment(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.get_worker_payments_for_review(uuid, uuid, text),
  mermas.get_worker_payment_review_detail(uuid, uuid, uuid),
  mermas.approve_worker_payment(uuid, uuid, uuid),
  mermas.reject_worker_payment(uuid, uuid, uuid, text)
  TO service_role;
