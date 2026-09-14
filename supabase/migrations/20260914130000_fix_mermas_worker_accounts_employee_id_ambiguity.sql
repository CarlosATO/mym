-- MERMAS: qualify worker account employee references to avoid PL/pgSQL output-column ambiguity.

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
    SELECT c.employee_id
    FROM charges c
    UNION
    SELECT p.employee_id
    FROM payments p
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
  LEFT JOIN charges c ON c.employee_id = a.employee_id
  LEFT JOIN payments p ON p.employee_id = a.employee_id
  WHERE v_search = ''
    OR pg_catalog.translate(pg_catalog.lower(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)), 'áéíóúüñ', 'aeiouun') LIKE '%' || v_search_names || '%'
    OR pg_catalog.translate(pg_catalog.lower(coalesce(e.rut, '')), '.- ', '') LIKE '%' || v_search_rut || '%'
  ORDER BY greatest(coalesce(c.total_charges, 0) - coalesce(p.approved_payments, 0), 0) DESC,
    pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno);
END;
$$;

REVOKE ALL ON FUNCTION mermas.get_worker_accounts(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.get_worker_accounts(uuid, uuid, text)
  TO service_role;
