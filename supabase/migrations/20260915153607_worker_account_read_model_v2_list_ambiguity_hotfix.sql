CREATE OR REPLACE FUNCTION mermas.get_worker_accounts_v2(
  p_company_id uuid,
  p_user_id uuid,
  p_search text DEFAULT NULL
) RETURNS TABLE (
  employee_id uuid,
  employee_name text,
  rut text,
  employee_status text,
  approved_payments numeric,
  official_balance numeric,
  projected_balance numeric,
  pending_review_payments numeric,
  merma_balance numeric,
  bsale_boleta_balance numeric,
  active_charge_count bigint,
  open_charge_count bigint,
  last_charge_at timestamptz,
  last_payment_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, rrhh, integraciones, mermas
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
  WITH charge_balances AS (
    SELECT c.id, c.company_id, c.employee_id, c.source_type,
      c.amount AS original_amount,
      coalesce(sum(a.amount) FILTER (WHERE p.status = 'APPROVED'), 0)::numeric AS approved_paid_amount,
      coalesce(c.document_date, c.created_at) AS charge_at
    FROM rrhh.worker_account_charges c
    LEFT JOIN mermas.worker_payment_allocations a
      ON a.company_id = c.company_id AND a.charge_id = c.id
    LEFT JOIN mermas.worker_payments p ON p.id = a.payment_id
    WHERE c.company_id = p_company_id AND c.status = 'ACTIVE' AND c.amount > 0
    GROUP BY c.id, c.company_id, c.employee_id, c.source_type, c.amount, c.document_date, c.created_at
  ), account_charges AS (
    SELECT cb.employee_id,
      coalesce(sum(greatest(cb.original_amount - cb.approved_paid_amount, 0)), 0)::numeric AS official_balance,
      coalesce(sum(greatest(cb.original_amount - cb.approved_paid_amount, 0)) FILTER (WHERE cb.source_type = 'MERMA'), 0)::numeric AS merma_balance,
      coalesce(sum(greatest(cb.original_amount - cb.approved_paid_amount, 0)) FILTER (WHERE cb.source_type = 'BSALE_BOLETA'), 0)::numeric AS bsale_boleta_balance,
      count(*) AS active_charge_count,
      count(*) FILTER (WHERE greatest(cb.original_amount - cb.approved_paid_amount, 0) > 0) AS open_charge_count,
      max(cb.charge_at) AS last_charge_at
    FROM charge_balances cb
    GROUP BY cb.employee_id
  ), account_payments AS (
    SELECT wp.employee_id,
      coalesce(sum(wp.amount) FILTER (WHERE wp.status = 'APPROVED'), 0)::numeric AS approved_payments,
      coalesce(sum(wp.amount) FILTER (WHERE wp.status = 'PENDING_REVIEW'), 0)::numeric AS pending_review_payments,
      max(wp.submitted_at) AS last_payment_at
    FROM mermas.worker_payments wp
    WHERE wp.company_id = p_company_id
    GROUP BY wp.employee_id
  ), account_employees AS (
    SELECT ac.employee_id FROM account_charges ac
    UNION
    SELECT ap.employee_id FROM account_payments ap
  )
  SELECT ae.employee_id,
    pg_catalog.btrim(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)),
    e.rut, e.estado, coalesce(ap.approved_payments, 0)::numeric,
    greatest(coalesce(ac.official_balance, 0), 0)::numeric,
    greatest(coalesce(ac.official_balance, 0) - coalesce(ap.pending_review_payments, 0), 0)::numeric,
    coalesce(ap.pending_review_payments, 0)::numeric,
    coalesce(ac.merma_balance, 0)::numeric,
    coalesce(ac.bsale_boleta_balance, 0)::numeric,
    coalesce(ac.active_charge_count, 0), coalesce(ac.open_charge_count, 0),
    ac.last_charge_at, ap.last_payment_at
  FROM account_employees ae
  JOIN rrhh.employees e ON e.id = ae.employee_id
  LEFT JOIN account_charges ac ON ac.employee_id = ae.employee_id
  LEFT JOIN account_payments ap ON ap.employee_id = ae.employee_id
  WHERE v_search = ''
    OR pg_catalog.translate(pg_catalog.lower(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)), 'áéíóúüñ', 'aeiouun') LIKE '%' || v_search_names || '%'
    OR pg_catalog.translate(pg_catalog.lower(coalesce(e.rut, '')), '.- ', '') LIKE '%' || v_search_rut || '%'
  ORDER BY greatest(coalesce(ac.official_balance, 0), 0) DESC,
    pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno);
END;
$$;
