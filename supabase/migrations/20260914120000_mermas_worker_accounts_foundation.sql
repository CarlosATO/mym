-- MERMAS: foundation for worker current accounts and future payments.

CREATE TABLE mermas.worker_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES rrhh.employees(id) ON DELETE RESTRICT,
  payment_number text,
  amount numeric(14,0) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'PENDING_REVIEW'
    CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'REVERSED')),
  submitted_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, payment_number)
);

CREATE TABLE mermas.worker_payment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL REFERENCES mermas.worker_payments(id) ON DELETE RESTRICT,
  storage_path text NOT NULL,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  uploaded_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mermas.worker_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL REFERENCES mermas.worker_payments(id) ON DELETE RESTRICT,
  internal_sale_id uuid NOT NULL REFERENCES mermas.internal_sales(id) ON DELETE RESTRICT,
  amount numeric(14,0) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mermas_worker_payments_account_idx
  ON mermas.worker_payments(company_id, employee_id, submitted_at DESC);
CREATE INDEX mermas_worker_payment_evidence_payment_idx
  ON mermas.worker_payment_evidence(company_id, payment_id);
CREATE INDEX mermas_worker_payment_allocations_payment_idx
  ON mermas.worker_payment_allocations(company_id, payment_id);
CREATE INDEX mermas_worker_payment_allocations_sale_idx
  ON mermas.worker_payment_allocations(company_id, internal_sale_id);

CREATE TRIGGER trg_mermas_worker_payments_set_updated_at
  BEFORE UPDATE ON mermas.worker_payments
  FOR EACH ROW EXECUTE FUNCTION portal.set_updated_at();

ALTER TABLE mermas.worker_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mermas.worker_payment_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE mermas.worker_payment_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY mermas_worker_payments_select ON mermas.worker_payments FOR SELECT TO authenticated
  USING (core.has_company_access(auth.uid(), company_id) AND portal.has_permission('logistica.mermas.view'));
CREATE POLICY mermas_worker_payment_evidence_select ON mermas.worker_payment_evidence FOR SELECT TO authenticated
  USING (core.has_company_access(auth.uid(), company_id) AND portal.has_permission('logistica.mermas.view'));
CREATE POLICY mermas_worker_payment_allocations_select ON mermas.worker_payment_allocations FOR SELECT TO authenticated
  USING (core.has_company_access(auth.uid(), company_id) AND portal.has_permission('logistica.mermas.view'));

GRANT SELECT ON mermas.worker_payments, mermas.worker_payment_evidence,
  mermas.worker_payment_allocations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON mermas.worker_payments,
  mermas.worker_payment_evidence, mermas.worker_payment_allocations TO service_role;
REVOKE DELETE ON mermas.worker_payments, mermas.worker_payment_evidence,
  mermas.worker_payment_allocations FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION mermas.get_worker_accounts(
  p_company_id uuid,
  p_user_id uuid,
  p_search text DEFAULT NULL
) RETURNS TABLE (
  employee_id uuid,
  employee_name text,
  rut text,
  employee_status text,
  total_charges numeric,
  approved_payments numeric,
  pending_review_payments numeric,
  official_balance numeric,
  projected_balance numeric,
  last_sale_at timestamptz,
  last_payment_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, rrhh, mermas
AS $$
DECLARE
  v_search text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, '')));
  v_search_names text;
  v_search_rut text;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.view') THEN
    RAISE EXCEPTION 'No autorizado para consultar cuentas corrientes de trabajadores';
  END IF;

  v_search_names := pg_catalog.translate(v_search, 'áéíóúüñ', 'aeiouun');
  v_search_rut := pg_catalog.translate(v_search, '.- ', '');

  RETURN QUERY
  WITH charges AS (
    SELECT s.company_id, s.employee_id,
      sum(s.total_amount)::numeric AS total_charges,
      max(s.created_at) AS last_sale_at
    FROM mermas.internal_sales s
    WHERE s.company_id = p_company_id AND s.status <> 'REVERSED'
    GROUP BY s.company_id, s.employee_id
  ), payments AS (
    SELECT p.company_id, p.employee_id,
      coalesce(sum(p.amount) FILTER (WHERE p.status = 'APPROVED'), 0)::numeric AS approved_payments,
      coalesce(sum(p.amount) FILTER (WHERE p.status = 'PENDING_REVIEW'), 0)::numeric AS pending_review_payments,
      max(p.submitted_at) AS last_payment_at
    FROM mermas.worker_payments p
    WHERE p.company_id = p_company_id
    GROUP BY p.company_id, p.employee_id
  ), account_employees AS (
    SELECT employee_id FROM charges
    UNION
    SELECT employee_id FROM payments
  )
  SELECT e.id,
    pg_catalog.btrim(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)),
    e.rut,
    e.estado,
    coalesce(c.total_charges, 0)::numeric,
    coalesce(p.approved_payments, 0)::numeric,
    coalesce(p.pending_review_payments, 0)::numeric,
    greatest(coalesce(c.total_charges, 0) - coalesce(p.approved_payments, 0), 0)::numeric,
    greatest(coalesce(c.total_charges, 0) - coalesce(p.approved_payments, 0) - coalesce(p.pending_review_payments, 0), 0)::numeric,
    c.last_sale_at,
    p.last_payment_at
  FROM account_employees a
  JOIN rrhh.employees e ON e.id = a.employee_id
  LEFT JOIN charges c ON c.employee_id = e.id
  LEFT JOIN payments p ON p.employee_id = e.id
  WHERE v_search = ''
    OR pg_catalog.translate(pg_catalog.lower(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)), 'áéíóúüñ', 'aeiouun') LIKE '%' || v_search_names || '%'
    OR pg_catalog.translate(pg_catalog.lower(coalesce(e.rut, '')), '.- ', '') LIKE '%' || v_search_rut || '%'
  ORDER BY greatest(coalesce(c.total_charges, 0) - coalesce(p.approved_payments, 0), 0) DESC,
    pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno);
END;
$$;

CREATE OR REPLACE FUNCTION mermas.get_worker_account_detail(
  p_company_id uuid,
  p_user_id uuid,
  p_employee_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, rrhh, mermas
AS $$
DECLARE
  v_employee rrhh.employees%ROWTYPE;
  v_summary jsonb;
  v_movements jsonb;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_employee_id IS NULL
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.view') THEN
    RAISE EXCEPTION 'No autorizado para consultar cuenta corriente';
  END IF;

  SELECT * INTO v_employee FROM rrhh.employees WHERE id = p_employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trabajador no encontrado'; END IF;

  WITH charges AS (
    SELECT coalesce(sum(s.total_amount), 0)::numeric AS total_charges
    FROM mermas.internal_sales s
    WHERE s.company_id = p_company_id AND s.employee_id = p_employee_id AND s.status <> 'REVERSED'
  ), payments AS (
    SELECT
      coalesce(sum(p.amount) FILTER (WHERE p.status = 'APPROVED'), 0)::numeric AS approved_payments,
      coalesce(sum(p.amount) FILTER (WHERE p.status = 'PENDING_REVIEW'), 0)::numeric AS pending_review_payments
    FROM mermas.worker_payments p
    WHERE p.company_id = p_company_id AND p.employee_id = p_employee_id
  )
  SELECT jsonb_build_object(
    'total_charges', c.total_charges,
    'approved_payments', p.approved_payments,
    'pending_review_payments', p.pending_review_payments,
    'official_balance', greatest(c.total_charges - p.approved_payments, 0),
    'projected_balance', greatest(c.total_charges - p.approved_payments - p.pending_review_payments, 0)
  ) INTO v_summary
  FROM charges c CROSS JOIN payments p;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'movement_type', movement_type,
    'label', label,
    'reference_number', reference_number,
    'amount', amount,
    'status', status,
    'occurred_at', occurred_at
  ) ORDER BY occurred_at, reference_number), '[]'::jsonb)
  INTO v_movements
  FROM (
    SELECT 'SALE'::text AS movement_type, 'VENTA / CARGO'::text AS label,
      s.sale_number AS reference_number, s.total_amount AS amount,
      s.status, s.created_at AS occurred_at
    FROM mermas.internal_sales s
    WHERE s.company_id = p_company_id AND s.employee_id = p_employee_id
    UNION ALL
    SELECT 'PAYMENT'::text, CASE p.status
      WHEN 'PENDING_REVIEW' THEN 'PAGO PENDIENTE'
      WHEN 'APPROVED' THEN 'PAGO APROBADO'
      WHEN 'REJECTED' THEN 'PAGO RECHAZADO'
      WHEN 'REVERSED' THEN 'PAGO REVERSADO'
      ELSE 'PAGO'
    END, coalesce(p.payment_number, 'Pago sin correlativo'), p.amount,
      p.status, p.submitted_at
    FROM mermas.worker_payments p
    WHERE p.company_id = p_company_id AND p.employee_id = p_employee_id
  ) movements;

  RETURN jsonb_build_object(
    'employee', jsonb_build_object(
      'id', v_employee.id,
      'name', pg_catalog.btrim(pg_catalog.concat_ws(' ', v_employee.nombres, v_employee.apellido_paterno, v_employee.apellido_materno)),
      'rut', v_employee.rut,
      'status', v_employee.estado
    ),
    'summary', v_summary,
    'movements', v_movements
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.get_worker_accounts(uuid, uuid, text),
  mermas.get_worker_account_detail(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.get_worker_accounts(uuid, uuid, text),
  mermas.get_worker_account_detail(uuid, uuid, uuid) TO service_role;
