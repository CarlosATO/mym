-- Worker account: generic, immutable charge ledger.

CREATE TABLE rrhh.worker_account_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES rrhh.employees(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN ('MERMA', 'BSALE_BOLETA', 'BSALE_NOTA_CREDITO')),
  source_id text NOT NULL,
  document_type text,
  document_number text,
  document_date timestamptz,
  amount numeric(14,0) NOT NULL CHECK (amount <> 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVERSED')),
  reversal_of_charge_id uuid REFERENCES rrhh.worker_account_charges(id) ON DELETE RESTRICT,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
  UNIQUE (company_id, source_type, source_id)
);

CREATE INDEX worker_account_charges_employee_idx
  ON rrhh.worker_account_charges(company_id, employee_id);
CREATE INDEX worker_account_charges_document_date_idx
  ON rrhh.worker_account_charges(document_date);
CREATE INDEX worker_account_charges_status_idx
  ON rrhh.worker_account_charges(status);

ALTER TABLE rrhh.worker_account_charges ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker_account_charges_select ON rrhh.worker_account_charges
  FOR SELECT TO authenticated
  USING (
    core.has_company_access(auth.uid(), company_id)
    AND core.has_permission_for_company(
      auth.uid(),
      company_id,
      'logistica.mermas.account.view'
    )
  );

GRANT USAGE ON SCHEMA rrhh TO authenticated;
GRANT SELECT ON rrhh.worker_account_charges TO authenticated;
GRANT SELECT, INSERT, UPDATE ON rrhh.worker_account_charges TO service_role;
REVOKE DELETE ON rrhh.worker_account_charges FROM PUBLIC, anon, authenticated, service_role;

-- Existing allocations remain readable through internal_sale_id, while new and
-- future allocations target the generic charge directly.
ALTER TABLE mermas.worker_payment_allocations
  ALTER COLUMN internal_sale_id DROP NOT NULL;

ALTER TABLE mermas.worker_payment_allocations
  ADD COLUMN charge_id uuid REFERENCES rrhh.worker_account_charges(id) ON DELETE RESTRICT;

INSERT INTO rrhh.worker_account_charges (
  company_id, employee_id, source_type, source_id, document_type,
  document_number, document_date, amount, status, metadata, created_at
)
SELECT s.company_id, s.employee_id, 'MERMA', s.id::text, 'VIT', s.sale_number,
  s.created_at, s.total_amount,
  CASE WHEN s.status = 'REVERSED' THEN 'REVERSED' ELSE 'ACTIVE' END,
  jsonb_build_object(
    'internal_sale_id', s.id,
    'sale_number', s.sale_number,
    'total', s.total_amount,
    'origin', 'MERMA'
  ), s.created_at
FROM mermas.internal_sales s
ON CONFLICT (company_id, source_type, source_id) DO NOTHING;

UPDATE mermas.worker_payment_allocations a
SET charge_id = c.id
FROM rrhh.worker_account_charges c
WHERE a.charge_id IS NULL
  AND a.internal_sale_id IS NOT NULL
  AND c.company_id = a.company_id
  AND c.source_type = 'MERMA'
  AND c.source_id = a.internal_sale_id::text;

UPDATE mermas.worker_payment_allocations
SET internal_sale_id = NULL
WHERE charge_id IS NOT NULL;

ALTER TABLE mermas.worker_payment_allocations
  ADD CONSTRAINT worker_payment_allocations_one_target_check
  CHECK ((CASE WHEN charge_id IS NOT NULL THEN 1 ELSE 0 END)
       + (CASE WHEN internal_sale_id IS NOT NULL THEN 1 ELSE 0 END) = 1);

CREATE INDEX worker_payment_allocations_charge_idx
  ON mermas.worker_payment_allocations(company_id, charge_id);
CREATE UNIQUE INDEX mermas_worker_payment_allocations_payment_charge_uidx
  ON mermas.worker_payment_allocations(payment_id, charge_id)
  WHERE charge_id IS NOT NULL;

DO $$
DECLARE
  v_definition text;
  v_marker constant text := E'  ) RETURNING id INTO v_sale_id;';
  v_insert constant text := E'  ) RETURNING id INTO v_sale_id;\n\n  INSERT INTO rrhh.worker_account_charges (\n    company_id, employee_id, source_type, source_id, document_type,\n    document_number, document_date, amount, status, metadata, created_by\n  ) VALUES (\n    p_company_id, p_employee_id, ''MERMA'', v_sale_id::text, ''VIT'',\n    v_sale_number, v_now, v_total, ''ACTIVE'',\n    jsonb_build_object(''internal_sale_id'', v_sale_id, ''sale_number'', v_sale_number, ''total'', v_total, ''origin'', ''MERMA''),\n    p_user_id\n  );';
BEGIN
  SELECT pg_get_functiondef('mermas.create_internal_sale(uuid, uuid, uuid, jsonb)'::regprocedure)
    INTO v_definition;
  IF v_definition IS NULL OR position(v_marker IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected create_internal_sale state while adding worker ledger charge';
  END IF;
  v_definition := replace(v_definition, v_marker, v_insert);
  EXECUTE v_definition;
END;
$$;

CREATE OR REPLACE FUNCTION mermas.get_worker_accounts(
  p_company_id uuid, p_user_id uuid, p_search text DEFAULT NULL
) RETURNS TABLE (
  employee_id uuid, employee_name text, rut text, employee_status text,
  total_charges numeric, approved_payments numeric, pending_review_payments numeric,
  official_balance numeric, projected_balance numeric,
  last_sale_at timestamptz, last_payment_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, rrhh, mermas
AS $$
DECLARE
  v_search text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, '')));
  v_search_names text;
  v_search_rut text;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.account.view') THEN
    RAISE EXCEPTION 'No autorizado para consultar cuentas corrientes de trabajadores';
  END IF;
  v_search_names := pg_catalog.translate(v_search, 'áéíóúüñ', 'aeiouun');
  v_search_rut := pg_catalog.translate(v_search, '.- ', '');
  RETURN QUERY
  WITH charges AS (
    SELECT c.company_id, c.employee_id, sum(c.amount)::numeric AS total_charges,
      max(coalesce(c.document_date, c.created_at)) AS last_sale_at
    FROM rrhh.worker_account_charges c
    WHERE c.company_id = p_company_id AND c.status = 'ACTIVE'
    GROUP BY c.company_id, c.employee_id
  ), payments AS (
    SELECT p.company_id, p.employee_id,
      coalesce(sum(p.amount) FILTER (WHERE p.status = 'APPROVED'), 0)::numeric AS approved_payments,
      coalesce(sum(p.amount) FILTER (WHERE p.status = 'PENDING_REVIEW'), 0)::numeric AS pending_review_payments,
      max(p.submitted_at) AS last_payment_at
    FROM mermas.worker_payments p
    WHERE p.company_id = p_company_id
    GROUP BY p.company_id, p.employee_id
  ), account_employees AS (
    SELECT c.employee_id FROM charges c UNION SELECT p.employee_id FROM payments p
  )
  SELECT e.id,
    pg_catalog.btrim(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)),
    e.rut, e.estado, coalesce(c.total_charges, 0)::numeric,
    coalesce(p.approved_payments, 0)::numeric, coalesce(p.pending_review_payments, 0)::numeric,
    greatest(coalesce(c.total_charges, 0) - coalesce(p.approved_payments, 0), 0)::numeric,
    greatest(coalesce(c.total_charges, 0) - coalesce(p.approved_payments, 0) - coalesce(p.pending_review_payments, 0), 0)::numeric,
    c.last_sale_at, p.last_payment_at
  FROM account_employees a
  JOIN rrhh.employees e ON e.id = a.employee_id
  LEFT JOIN charges c ON c.employee_id = a.employee_id
  LEFT JOIN payments p ON p.employee_id = a.employee_id
  WHERE v_search = ''
    OR pg_catalog.translate(pg_catalog.lower(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)), 'áéíóúüñ', 'aeiouun') LIKE '%' || v_search_names || '%'
    OR pg_catalog.translate(pg_catalog.lower(coalesce(e.rut, '')), '.- ', '') LIKE '%' || v_search_rut || '%'
  ORDER BY greatest(coalesce(c.total_charges, 0) - coalesce(p.approved_payments, 0), 0) DESC,
    pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno);
END;
$$;

CREATE OR REPLACE FUNCTION mermas.get_worker_account_detail(
  p_company_id uuid, p_user_id uuid, p_employee_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, rrhh, mermas
AS $$
DECLARE
  v_employee rrhh.employees%ROWTYPE;
  v_summary jsonb;
  v_movements jsonb;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_employee_id IS NULL
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.account.view') THEN
    RAISE EXCEPTION 'No autorizado para consultar cuenta corriente';
  END IF;
  SELECT * INTO v_employee FROM rrhh.employees WHERE id = p_employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trabajador no encontrado'; END IF;
  WITH charges AS (
    SELECT coalesce(sum(c.amount) FILTER (WHERE c.status = 'ACTIVE'), 0)::numeric AS total_charges
    FROM rrhh.worker_account_charges c
    WHERE c.company_id = p_company_id AND c.employee_id = p_employee_id
  ), payments AS (
    SELECT coalesce(sum(p.amount) FILTER (WHERE p.status = 'APPROVED'), 0)::numeric AS approved_payments,
      coalesce(sum(p.amount) FILTER (WHERE p.status = 'PENDING_REVIEW'), 0)::numeric AS pending_review_payments
    FROM mermas.worker_payments p WHERE p.company_id = p_company_id AND p.employee_id = p_employee_id
  )
  SELECT jsonb_build_object('total_charges', c.total_charges,
    'approved_payments', p.approved_payments, 'pending_review_payments', p.pending_review_payments,
    'official_balance', greatest(c.total_charges - p.approved_payments, 0),
    'projected_balance', greatest(c.total_charges - p.approved_payments - p.pending_review_payments, 0))
  INTO v_summary FROM charges c CROSS JOIN payments p;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'movement_type', movement_type, 'label', label, 'reference_number', reference_number,
    'amount', amount, 'status', status, 'occurred_at', occurred_at,
    'source_type', source_type, 'charge_id', charge_id
  ) ORDER BY occurred_at, reference_number), '[]'::jsonb)
  INTO v_movements
  FROM (
    SELECT 'CHARGE'::text AS movement_type,
      CASE c.source_type WHEN 'MERMA' THEN 'VENTA / CARGO' WHEN 'BSALE_BOLETA' THEN 'BOLETA BSALE'
        WHEN 'BSALE_NOTA_CREDITO' THEN 'NOTA DE CRÉDITO BSALE' ELSE 'CARGO' END AS label,
      coalesce(c.document_number, c.source_id) AS reference_number, c.amount,
      c.status, coalesce(c.document_date, c.created_at) AS occurred_at, c.source_type, c.id AS charge_id
    FROM rrhh.worker_account_charges c
    WHERE c.company_id = p_company_id AND c.employee_id = p_employee_id
    UNION ALL
    SELECT 'PAYMENT'::text, CASE p.status WHEN 'PENDING_REVIEW' THEN 'PAGO PENDIENTE'
      WHEN 'APPROVED' THEN 'PAGO APROBADO' WHEN 'REJECTED' THEN 'PAGO RECHAZADO'
      WHEN 'REVERSED' THEN 'PAGO REVERSADO' ELSE 'PAGO' END,
      coalesce(p.payment_number, 'Pago sin correlativo'), p.amount, p.status, p.submitted_at, NULL, NULL
    FROM mermas.worker_payments p
    WHERE p.company_id = p_company_id AND p.employee_id = p_employee_id
  ) movements;
  RETURN jsonb_build_object('employee', jsonb_build_object('id', v_employee.id,
    'name', pg_catalog.btrim(pg_catalog.concat_ws(' ', v_employee.nombres, v_employee.apellido_paterno, v_employee.apellido_materno)),
    'rut', v_employee.rut, 'status', v_employee.estado), 'summary', v_summary, 'movements', v_movements);
END;
$$;

CREATE OR REPLACE FUNCTION mermas.approve_worker_payment(
  p_company_id uuid, p_user_id uuid, p_payment_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, rrhh, mermas
AS $$
DECLARE
  v_payment mermas.worker_payments%ROWTYPE;
  v_charge record;
  v_charge_remaining numeric;
  v_to_apply numeric;
  v_remaining numeric;
  v_allocations jsonb := '[]'::jsonb;
  v_allocated numeric := 0;
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
  IF NOT EXISTS (SELECT 1 FROM mermas.worker_payment_evidence e WHERE e.payment_id = v_payment.id) THEN
    RAISE EXCEPTION 'El pago no tiene comprobante';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'mermas-worker-payment:' || p_company_id::text || ':' || v_payment.employee_id::text, 0));
  v_remaining := v_payment.amount;
  FOR v_charge IN
    SELECT c.id, c.source_type, c.source_id, c.document_number, c.amount,
      c.document_date, c.created_at,
      c.amount - coalesce(sum(a.amount) FILTER (WHERE approved.status = 'APPROVED'), 0)::numeric AS remaining
    FROM rrhh.worker_account_charges c
    LEFT JOIN mermas.worker_payment_allocations a ON a.charge_id = c.id AND a.company_id = p_company_id
    LEFT JOIN mermas.worker_payments approved ON approved.id = a.payment_id
    WHERE c.company_id = p_company_id AND c.employee_id = v_payment.employee_id AND c.status = 'ACTIVE' AND c.amount > 0
    GROUP BY c.id, c.source_type, c.source_id, c.document_number, c.amount, c.document_date, c.created_at
    HAVING c.amount - coalesce(sum(a.amount) FILTER (WHERE approved.status = 'APPROVED'), 0)::numeric > 0
    ORDER BY coalesce(c.document_date, c.created_at), c.document_number NULLS LAST, c.id
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_charge_remaining := v_charge.remaining;
    v_to_apply := least(v_remaining, v_charge_remaining);
    INSERT INTO mermas.worker_payment_allocations(company_id, payment_id, charge_id, amount)
    VALUES (p_company_id, v_payment.id, v_charge.id, v_to_apply);
    v_allocated := v_allocated + v_to_apply;
    v_remaining := v_remaining - v_to_apply;
    v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
      'charge_id', v_charge.id, 'source_type', v_charge.source_type,
      'source_id', v_charge.source_id, 'document_number', v_charge.document_number,
      'amount', v_to_apply));
    IF v_charge.source_type = 'MERMA' AND v_charge_remaining <= v_to_apply THEN
      UPDATE mermas.internal_sales SET status = 'RENDERED', updated_at = now()
      WHERE id = v_charge.source_id::uuid AND status <> 'REVERSED';
    END IF;
  END LOOP;
  IF v_remaining > 0 OR v_allocated <> v_payment.amount THEN
    RAISE EXCEPTION 'La deuda pendiente no alcanza para asignar completamente el pago';
  END IF;
  UPDATE mermas.worker_payments SET status = 'APPROVED', reviewed_by = p_user_id,
    reviewed_at = now(), rejection_reason = NULL, updated_at = now() WHERE id = v_payment.id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES ('mermas.worker_payments', v_payment.id, 'MERMA_PAY_APPROVE', jsonb_build_object(
    'payment_id', v_payment.id, 'payment_number', v_payment.payment_number,
    'employee_id', v_payment.employee_id, 'amount', v_payment.amount,
    'company_id', p_company_id, 'allocations', v_allocations), p_user_id);
  RETURN jsonb_build_object('payment_id', v_payment.id, 'payment_number', v_payment.payment_number,
    'status', 'APPROVED', 'allocations', v_allocations);
END;
$$;

-- Payment submission and review summaries use the same authoritative ledger.
DO $$
DECLARE
  v_definition text;
  v_old text := E'  SELECT coalesce(sum(s.total_amount), 0) INTO v_total_charges\n  FROM mermas.internal_sales s\n  WHERE s.company_id = p_company_id AND s.employee_id = p_employee_id AND s.status <> ''REVERSED'';';
  v_new text := E'  SELECT coalesce(sum(c.amount) FILTER (WHERE c.status = ''ACTIVE''), 0) INTO v_total_charges\n  FROM rrhh.worker_account_charges c\n  WHERE c.company_id = p_company_id AND c.employee_id = p_employee_id;';
BEGIN
  SELECT pg_get_functiondef('mermas.submit_worker_payment(uuid, uuid, uuid, numeric, uuid, text, text, text, bigint)'::regprocedure) INTO v_definition;
  IF position(v_old IN v_definition) = 0 THEN RAISE EXCEPTION 'Unexpected submit_worker_payment charge query'; END IF;
  EXECUTE replace(v_definition, v_old, v_new);

  SELECT pg_get_functiondef('mermas.get_worker_payment_review_detail(uuid, uuid, uuid)'::regprocedure) INTO v_definition;
  v_old := E'    SELECT coalesce(sum(s.total_amount), 0)::numeric AS total_charges\n    FROM mermas.internal_sales s\n    WHERE s.company_id = p_company_id AND s.employee_id = v_payment.employee_id AND s.status <> ''REVERSED''';
  v_new := E'    SELECT coalesce(sum(c.amount) FILTER (WHERE c.status = ''ACTIVE''), 0)::numeric AS total_charges\n     FROM rrhh.worker_account_charges c\n     WHERE c.company_id = p_company_id AND c.employee_id = v_payment.employee_id';
  IF position(v_old IN v_definition) = 0 THEN RAISE EXCEPTION 'Unexpected payment review charge query'; END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END;
$$;

REVOKE ALL ON FUNCTION mermas.get_worker_accounts(uuid, uuid, text),
  mermas.get_worker_account_detail(uuid, uuid, uuid),
  mermas.approve_worker_payment(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.get_worker_accounts(uuid, uuid, text),
  mermas.get_worker_account_detail(uuid, uuid, uuid),
  mermas.approve_worker_payment(uuid, uuid, uuid) TO service_role;
