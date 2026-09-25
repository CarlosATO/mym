-- MERMAS: historical monthly worker account statement.

CREATE OR REPLACE FUNCTION mermas.get_worker_monthly_account_report(
  p_company_id uuid,
  p_user_id uuid,
  p_year integer,
  p_month integer
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, rrhh, mermas
AS $$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL
     OR p_year IS NULL OR p_month IS NULL
     OR p_month < 1 OR p_month > 12
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.account.view') THEN
    RAISE EXCEPTION 'No autorizado para consultar el estado de cuenta mensual';
  END IF;

  v_start := pg_catalog.make_timestamptz(p_year, p_month, 1, 0, 0, 0, 'America/Santiago');
  v_end := pg_catalog.make_timestamptz(
    CASE WHEN p_month = 12 THEN p_year + 1 ELSE p_year END,
    CASE WHEN p_month = 12 THEN 1 ELSE p_month + 1 END,
    1, 0, 0, 0, 'America/Santiago'
  );

  WITH charge_events AS (
    SELECT c.id AS charge_id, c.employee_id, c.source_type,
      coalesce(c.document_number, c.source_id) AS reference_number,
      coalesce(c.document_date, c.created_at) AS occurred_at,
      c.amount::numeric AS amount
    FROM rrhh.worker_account_charges c
    WHERE c.company_id = p_company_id
      AND c.status = 'ACTIVE'
      AND c.source_type IN ('MERMA', 'BSALE_BOLETA', 'BSALE_NOTA_CREDITO')
  ), payment_events AS (
    SELECT p.id AS payment_id, p.employee_id, p.payment_number AS reference_number,
      'PAYMENT'::text AS movement_type, p.submitted_at AS occurred_at,
      p.amount::numeric AS amount, (-p.amount)::numeric AS balance_effect
    FROM mermas.worker_payments p
    WHERE p.company_id = p_company_id
      AND p.status IN ('ACTIVE', 'APPROVED', 'VOIDED')
    UNION ALL
    SELECT p.id, p.employee_id, p.payment_number,
      'PAYMENT_VOID'::text, p.voided_at, p.amount::numeric, p.amount::numeric
    FROM mermas.worker_payments p
    WHERE p.company_id = p_company_id
      AND p.status = 'VOIDED'
      AND p.voided_at IS NOT NULL
  ), ledger AS (
    SELECT ce.employee_id, ce.occurred_at,
      CASE WHEN ce.source_type = 'BSALE_NOTA_CREDITO' THEN 'ADJUSTMENT' ELSE 'CHARGE' END::text AS movement_type,
      ce.source_type, ce.reference_number, ce.charge_id, NULL::uuid AS payment_id,
      ce.amount, ce.amount AS balance_effect
    FROM charge_events ce
    UNION ALL
    SELECT pe.employee_id, pe.occurred_at, pe.movement_type, 'WORKER_PAYMENT'::text,
      pe.reference_number, NULL::uuid, pe.payment_id, pe.amount, pe.balance_effect
    FROM payment_events pe
  ), worker_values AS (
    SELECT e.id AS employee_id,
      pg_catalog.btrim(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)) AS employee_name,
      e.rut,
      coalesce(sum(l.balance_effect) FILTER (WHERE l.occurred_at < v_start), 0)::numeric AS opening_balance,
      coalesce(sum(l.amount) FILTER (WHERE l.movement_type = 'CHARGE' AND l.source_type = 'MERMA'
        AND l.occurred_at >= v_start AND l.occurred_at < v_end), 0)::numeric AS merma_charges,
      coalesce(sum(l.amount) FILTER (WHERE l.movement_type = 'CHARGE' AND l.source_type = 'BSALE_BOLETA'
        AND l.occurred_at >= v_start AND l.occurred_at < v_end), 0)::numeric AS bsale_charges,
      coalesce(sum(l.amount) FILTER (WHERE l.movement_type = 'ADJUSTMENT'
        AND l.occurred_at >= v_start AND l.occurred_at < v_end), 0)::numeric AS adjustments,
      coalesce(sum(l.amount) FILTER (WHERE l.movement_type = 'PAYMENT'
        AND l.occurred_at >= v_start AND l.occurred_at < v_end), 0)::numeric AS payments,
      coalesce(sum(l.amount) FILTER (WHERE l.movement_type = 'PAYMENT_VOID'
        AND l.occurred_at >= v_start AND l.occurred_at < v_end), 0)::numeric AS voided_payments,
      count(l.*) FILTER (WHERE l.occurred_at >= v_start AND l.occurred_at < v_end)::integer AS movement_count
    FROM rrhh.employees e
    LEFT JOIN ledger l ON l.employee_id = e.id
    GROUP BY e.id, e.nombres, e.apellido_paterno, e.apellido_materno, e.rut
  ), workers AS (
    SELECT w.*,
      (w.opening_balance + w.merma_charges + w.bsale_charges + w.adjustments
        - w.payments + w.voided_payments)::numeric AS closing_balance
    FROM worker_values w
  ), included_workers AS (
    SELECT w.*
    FROM workers w
    WHERE w.opening_balance <> 0
       OR w.movement_count > 0
       OR w.closing_balance <> 0
  ), summary AS (
    SELECT coalesce(sum(opening_balance), 0)::numeric AS opening_balance,
      coalesce(sum(merma_charges), 0)::numeric AS merma_charges,
      coalesce(sum(bsale_charges), 0)::numeric AS bsale_charges,
      coalesce(sum(adjustments), 0)::numeric AS adjustments,
      coalesce(sum(payments), 0)::numeric AS payments,
      coalesce(sum(voided_payments), 0)::numeric AS voided_payments,
      coalesce(sum(closing_balance), 0)::numeric AS closing_balance,
      count(*)::integer AS worker_count,
      count(*) FILTER (WHERE closing_balance <> 0)::integer AS workers_with_closing_debt
    FROM included_workers
  )
  SELECT jsonb_build_object(
    'period', jsonb_build_object(
      'year', p_year, 'month', p_month,
      'timezone', 'America/Santiago', 'start', v_start, 'end', v_end
    ),
    'summary', (SELECT to_jsonb(s) FROM summary s),
    'workers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'employee_id', w.employee_id,
        'name', w.employee_name,
        'rut', w.rut,
        'opening_balance', w.opening_balance,
        'merma_charges', w.merma_charges,
        'bsale_charges', w.bsale_charges,
        'adjustments', w.adjustments,
        'payments', w.payments,
        'voided_payments', w.voided_payments,
        'closing_balance', w.closing_balance,
        'movement_count', w.movement_count,
        'has_activity', (w.movement_count > 0),
        'movements', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'type', l.movement_type,
            'source_type', l.source_type,
            'reference_number', l.reference_number,
            'date', l.occurred_at,
            'amount', l.amount,
            'balance_effect', l.balance_effect,
            'charge_id', l.charge_id,
            'payment_id', l.payment_id
          ) ORDER BY l.occurred_at, l.reference_number, coalesce(l.charge_id, l.payment_id))
          FROM ledger l
          WHERE l.employee_id = w.employee_id
            AND l.occurred_at >= v_start AND l.occurred_at < v_end
        ), '[]'::jsonb)
      ) ORDER BY w.employee_name, w.employee_id)
      FROM included_workers w
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION mermas.get_worker_monthly_account_report(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.get_worker_monthly_account_report(uuid, uuid, integer, integer)
  TO service_role;
