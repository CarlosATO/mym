-- Worker account: reconcile Bsale credit notes against worker Boleta charges.

CREATE OR REPLACE FUNCTION mermas.reconcile_worker_bsale_credit_notes(
  p_company_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, rrhh, integraciones, mermas
AS $$
DECLARE
  v_activation_date constant date := DATE '2026-09-01';
  v_document record;
  v_reference record;
  v_boleta record;
  v_charge record;
  v_source_id text;
  v_folio numeric;
  v_current_nc_total numeric;
  v_approved_paid numeric;
  v_metadata jsonb;
  v_scanned integer := 0;
  v_created integer := 0;
  v_already_exists integer := 0;
  v_unmatched_reference integer := 0;
  v_unmatched_charge integer := 0;
  v_ambiguous integer := 0;
  v_invalid integer := 0;
  v_exceeds_original integer := 0;
  v_overapplied integer := 0;
BEGIN
  IF p_company_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM core.companies c WHERE c.id = p_company_id AND c.is_active
  ) THEN
    RAISE EXCEPTION 'Empresa inválida para reconciliar NC Bsale';
  END IF;

  -- Scan every NC first. A missing reference must be classified, not filtered out.
  FOR v_document IN
    SELECT d.company_id, d.bsale_id, d.number, d.emission_date, d.total_amount,
      d.document_type_id, d.state,
      d.raw_json->>'cancellationDate' AS cancellation_date,
      d.raw_json->>'cancellationStatus' AS cancellation_status
    FROM integraciones.bsale_documents d
    WHERE d.company_id = p_company_id
      AND d.document_type_id = 2
      AND d.emission_date >= v_activation_date
    ORDER BY d.emission_date, d.number, d.bsale_id
  LOOP
    v_scanned := v_scanned + 1;
    v_source_id := v_document.bsale_id::text;

    IF v_document.state IS DISTINCT FROM 0
       OR nullif(btrim(coalesce(v_document.cancellation_date, '')), '') IS NOT NULL
       OR coalesce(nullif(btrim(v_document.cancellation_status), ''), '0') <> '0'
       OR v_document.number IS NULL
       OR v_document.emission_date IS NULL
       OR v_document.total_amount IS NULL
       OR v_document.total_amount <= 0
       OR v_document.total_amount <> trunc(v_document.total_amount) THEN
      v_invalid := v_invalid + 1;
      CONTINUE;
    END IF;

    SELECT count(*)::integer AS eligible_count,
      min(ref.referenced_document_number) AS referenced_document_number,
      min(ref.reference_code) AS reference_code,
      min(ref.reference_reason) AS reference_reason
    INTO v_reference
    FROM integraciones.bsale_document_references ref
    WHERE ref.company_id = p_company_id
      AND ref.bsale_document_id = v_document.bsale_id
      AND coalesce(ref.referenced_document_type_id::text, ref.raw_json->>'TpoDocRef') = '39';

    IF v_reference.eligible_count = 0 THEN
      v_unmatched_reference := v_unmatched_reference + 1;
      CONTINUE;
    END IF;
    IF v_reference.eligible_count > 1 THEN
      v_ambiguous := v_ambiguous + 1;
      CONTINUE;
    END IF;

    IF v_reference.referenced_document_number IS NULL
       OR btrim(v_reference.referenced_document_number) !~ '^[0-9]+$' THEN
      v_invalid := v_invalid + 1;
      CONTINUE;
    END IF;

    v_folio := v_reference.referenced_document_number::numeric;
    IF v_folio <= 0 OR v_folio > 2147483647 OR v_folio <> trunc(v_folio) THEN
      v_invalid := v_invalid + 1;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM rrhh.worker_account_charges charge
      WHERE charge.company_id = p_company_id
        AND charge.source_type = 'BSALE_NOTA_CREDITO'
        AND charge.source_id = v_source_id
    ) THEN
      v_already_exists := v_already_exists + 1;
      CONTINUE;
    END IF;

    SELECT d.bsale_id, d.number
    INTO v_boleta
    FROM integraciones.bsale_documents d
    WHERE d.company_id = p_company_id
      AND d.document_type_id = 1
      AND d.number = v_folio::integer
    LIMIT 2;

    IF NOT FOUND THEN
      v_unmatched_reference := v_unmatched_reference + 1;
      CONTINUE;
    END IF;
    IF (SELECT count(*) FROM integraciones.bsale_documents d
        WHERE d.company_id = p_company_id AND d.document_type_id = 1 AND d.number = v_folio::integer) > 1 THEN
      v_ambiguous := v_ambiguous + 1;
      CONTINUE;
    END IF;

    SELECT c.id, c.employee_id, c.amount
    INTO v_charge
    FROM rrhh.worker_account_charges c
    WHERE c.company_id = p_company_id
      AND c.source_type = 'BSALE_BOLETA'
      AND c.source_id = v_boleta.bsale_id::text
    LIMIT 2;

    IF NOT FOUND THEN
      v_unmatched_charge := v_unmatched_charge + 1;
      CONTINUE;
    END IF;
    IF (SELECT count(*) FROM rrhh.worker_account_charges c
        WHERE c.company_id = p_company_id AND c.source_type = 'BSALE_BOLETA'
          AND c.source_id = v_boleta.bsale_id::text) > 1 THEN
      v_ambiguous := v_ambiguous + 1;
      CONTINUE;
    END IF;

    -- Use the same employee lock as payment approval, then lock the original.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'mermas-worker-payment:' || p_company_id::text || ':' || v_charge.employee_id::text, 0));
    SELECT c.id, c.employee_id, c.amount
    INTO v_charge
    FROM rrhh.worker_account_charges c
    WHERE c.id = v_charge.id AND c.company_id = p_company_id
    FOR UPDATE;
    IF NOT FOUND THEN
      v_unmatched_charge := v_unmatched_charge + 1;
      CONTINUE;
    END IF;

    SELECT coalesce(sum(abs(nc.amount)), 0)::numeric
    INTO v_current_nc_total
    FROM rrhh.worker_account_charges nc
    WHERE nc.company_id = p_company_id
      AND nc.source_type = 'BSALE_NOTA_CREDITO'
      AND nc.reversal_of_charge_id = v_charge.id
      AND nc.status = 'ACTIVE';

    IF v_current_nc_total + v_document.total_amount > v_charge.amount THEN
      v_exceeds_original := v_exceeds_original + 1;
      CONTINUE;
    END IF;

    SELECT coalesce(sum(a.amount) FILTER (WHERE p.status = 'APPROVED'), 0)::numeric
    INTO v_approved_paid
    FROM mermas.worker_payment_allocations a
    JOIN mermas.worker_payments p ON p.id = a.payment_id
    WHERE a.company_id = p_company_id
      AND p.company_id = p_company_id
      AND a.charge_id = v_charge.id;

    v_metadata := jsonb_build_object(
      'origin', 'BSALE',
      'bsale_credit_note_id', v_document.bsale_id,
      'credit_note_number', v_document.number,
      'referenced_bsale_document_id', v_boleta.bsale_id,
      'referenced_document_number', v_reference.referenced_document_number,
      'reference_code', v_reference.reference_code,
      'reference_reason', v_reference.reference_reason,
      'original_charge_id', v_charge.id
    );
    IF v_approved_paid + v_current_nc_total + v_document.total_amount > v_charge.amount THEN
      v_overapplied := v_overapplied + 1;
      v_metadata := v_metadata || jsonb_build_object(
        'overapplied_after_credit_note', true,
        'approved_paid_amount', v_approved_paid,
        'credit_note_total_after', v_current_nc_total + v_document.total_amount,
        'original_amount', v_charge.amount
      );
    END IF;

    INSERT INTO rrhh.worker_account_charges (
      company_id, employee_id, source_type, source_id, document_type,
      document_number, document_date, amount, status, metadata,
      reversal_of_charge_id
    ) VALUES (
      p_company_id, v_charge.employee_id, 'BSALE_NOTA_CREDITO', v_source_id,
      'NOTA_CREDITO', v_document.number::text,
      v_document.emission_date::timestamp AT TIME ZONE 'America/Santiago',
      -v_document.total_amount, 'ACTIVE', v_metadata, v_charge.id
    ) ON CONFLICT (company_id, source_type, source_id) DO NOTHING;

    IF FOUND THEN
      v_created := v_created + 1;
    ELSE
      v_already_exists := v_already_exists + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'scanned', v_scanned, 'created', v_created, 'already_exists', v_already_exists,
    'unmatched_reference', v_unmatched_reference, 'unmatched_charge', v_unmatched_charge,
    'ambiguous', v_ambiguous, 'invalid', v_invalid,
    'exceeds_original', v_exceeds_original, 'overapplied', v_overapplied
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.reconcile_worker_bsale_credit_notes(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.reconcile_worker_bsale_credit_notes(uuid) TO service_role;

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
  -- NC reconciliation uses the same lock, so FIFO and NC cannot read a moving balance.
  PERFORM 1 FROM rrhh.worker_account_charges c
  WHERE c.company_id = p_company_id AND c.employee_id = v_payment.employee_id
    AND c.status = 'ACTIVE' AND c.source_type IN ('MERMA', 'BSALE_BOLETA')
  FOR UPDATE;
  v_remaining := v_payment.amount;
  FOR v_charge IN
    SELECT c.id, c.source_type, c.source_id, c.document_number, c.amount,
      c.document_date, c.created_at,
      greatest(
        c.amount - CASE WHEN c.source_type = 'BSALE_BOLETA' THEN coalesce((
          SELECT sum(abs(nc.amount)) FROM rrhh.worker_account_charges nc
          WHERE nc.company_id = p_company_id AND nc.source_type = 'BSALE_NOTA_CREDITO'
            AND nc.reversal_of_charge_id = c.id AND nc.status = 'ACTIVE'
        ), 0) ELSE 0 END
        - coalesce(sum(a.amount) FILTER (WHERE approved.status = 'APPROVED'), 0)::numeric, 0
      ) AS remaining
    FROM rrhh.worker_account_charges c
    LEFT JOIN mermas.worker_payment_allocations a ON a.company_id = p_company_id AND a.charge_id = c.id
    LEFT JOIN mermas.worker_payments approved ON approved.id = a.payment_id AND approved.company_id = p_company_id
    WHERE c.company_id = p_company_id AND c.employee_id = v_payment.employee_id
      AND c.status = 'ACTIVE' AND c.source_type IN ('MERMA', 'BSALE_BOLETA')
    GROUP BY c.id, c.source_type, c.source_id, c.document_number, c.amount, c.document_date, c.created_at
    HAVING greatest(
      c.amount - CASE WHEN c.source_type = 'BSALE_BOLETA' THEN coalesce((
        SELECT sum(abs(nc.amount)) FROM rrhh.worker_account_charges nc
        WHERE nc.company_id = p_company_id AND nc.source_type = 'BSALE_NOTA_CREDITO'
          AND nc.reversal_of_charge_id = c.id AND nc.status = 'ACTIVE'
      ), 0) ELSE 0 END
      - coalesce(sum(a.amount) FILTER (WHERE approved.status = 'APPROVED'), 0)::numeric, 0
    ) > 0
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

CREATE OR REPLACE FUNCTION mermas.get_worker_accounts_v2(
  p_company_id uuid, p_user_id uuid, p_search text DEFAULT NULL
) RETURNS TABLE (
  employee_id uuid, employee_name text, rut text, employee_status text,
  approved_payments numeric, official_balance numeric, projected_balance numeric,
  pending_review_payments numeric, merma_balance numeric, bsale_boleta_balance numeric,
  active_charge_count bigint, open_charge_count bigint,
  last_charge_at timestamptz, last_payment_at timestamptz
) LANGUAGE plpgsql STABLE SECURITY DEFINER
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
    SELECT c.id, c.company_id, c.employee_id, c.source_type, c.amount AS original_amount,
      CASE WHEN c.source_type = 'BSALE_BOLETA' THEN coalesce((SELECT sum(abs(nc.amount)) FROM rrhh.worker_account_charges nc
        WHERE nc.company_id = p_company_id AND nc.source_type = 'BSALE_NOTA_CREDITO'
          AND nc.reversal_of_charge_id = c.id AND nc.status = 'ACTIVE'), 0) ELSE 0 END::numeric AS credit_note_amount,
      coalesce(sum(a.amount) FILTER (WHERE p.status = 'APPROVED'), 0)::numeric AS approved_paid_amount,
      coalesce(c.document_date, c.created_at) AS charge_at
    FROM rrhh.worker_account_charges c
    LEFT JOIN mermas.worker_payment_allocations a ON a.company_id = p_company_id AND a.charge_id = c.id
    LEFT JOIN mermas.worker_payments p ON p.id = a.payment_id AND p.company_id = p_company_id
    WHERE c.company_id = p_company_id AND c.status = 'ACTIVE'
      AND c.amount > 0 AND c.source_type IN ('MERMA', 'BSALE_BOLETA')
    GROUP BY c.id, c.company_id, c.employee_id, c.source_type, c.amount, c.document_date, c.created_at
  ), account_charges AS (
    SELECT employee_id,
      coalesce(sum(greatest(original_amount - credit_note_amount - approved_paid_amount, 0)), 0)::numeric AS official_balance,
      coalesce(sum(greatest(original_amount - approved_paid_amount, 0)) FILTER (WHERE source_type = 'MERMA'), 0)::numeric AS merma_balance,
      coalesce(sum(greatest(original_amount - credit_note_amount - approved_paid_amount, 0)) FILTER (WHERE source_type = 'BSALE_BOLETA'), 0)::numeric AS bsale_boleta_balance,
      count(*) AS active_charge_count,
      count(*) FILTER (WHERE greatest(original_amount - credit_note_amount - approved_paid_amount, 0) > 0) AS open_charge_count,
      max(charge_at) AS last_charge_at
    FROM charge_balances GROUP BY employee_id
  ), account_payments AS (
    SELECT employee_id, coalesce(sum(amount) FILTER (WHERE status = 'APPROVED'), 0)::numeric AS approved_payments,
      coalesce(sum(amount) FILTER (WHERE status = 'PENDING_REVIEW'), 0)::numeric AS pending_review_payments,
      max(submitted_at) AS last_payment_at
    FROM mermas.worker_payments WHERE company_id = p_company_id GROUP BY employee_id
  ), account_employees AS (
    SELECT employee_id FROM account_charges UNION SELECT employee_id FROM account_payments
  )
  SELECT e.id, pg_catalog.btrim(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)),
    e.rut, e.estado, coalesce(p.approved_payments, 0)::numeric,
    greatest(coalesce(c.official_balance, 0), 0)::numeric,
    greatest(coalesce(c.official_balance, 0) - coalesce(p.pending_review_payments, 0), 0)::numeric,
    coalesce(p.pending_review_payments, 0)::numeric, coalesce(c.merma_balance, 0)::numeric,
    coalesce(c.bsale_boleta_balance, 0)::numeric, coalesce(c.active_charge_count, 0),
    coalesce(c.open_charge_count, 0), c.last_charge_at, p.last_payment_at
  FROM account_employees a JOIN rrhh.employees e ON e.id = a.employee_id
  LEFT JOIN account_charges c ON c.employee_id = e.id LEFT JOIN account_payments p ON p.employee_id = e.id
  WHERE v_search = '' OR pg_catalog.translate(pg_catalog.lower(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)), 'áéíóúüñ', 'aeiouun') LIKE '%' || v_search_names || '%'
    OR pg_catalog.translate(pg_catalog.lower(coalesce(e.rut, '')), '.- ', '') LIKE '%' || v_search_rut || '%'
  ORDER BY greatest(coalesce(c.official_balance, 0), 0) DESC, pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno);
END;
$$;

CREATE OR REPLACE FUNCTION mermas.get_worker_account_detail_v2(
  p_company_id uuid, p_user_id uuid, p_employee_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
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
  SELECT e.* INTO v_employee FROM rrhh.employees e
  WHERE e.id = p_employee_id AND (EXISTS (SELECT 1 FROM rrhh.worker_account_charges c WHERE c.company_id = p_company_id AND c.employee_id = e.id)
    OR EXISTS (SELECT 1 FROM mermas.worker_payments p WHERE p.company_id = p_company_id AND p.employee_id = e.id));
  IF NOT FOUND THEN RAISE EXCEPTION 'Trabajador no encontrado'; END IF;

  WITH charge_balances AS (
    SELECT c.id, c.source_type, c.source_id, c.document_type, c.document_number, c.document_date,
      c.created_at, c.amount AS original_amount, c.status,
      CASE WHEN c.source_type = 'BSALE_BOLETA' THEN coalesce((SELECT sum(abs(nc.amount)) FROM rrhh.worker_account_charges nc
        WHERE nc.company_id = p_company_id AND nc.source_type = 'BSALE_NOTA_CREDITO'
          AND nc.reversal_of_charge_id = c.id AND nc.status = 'ACTIVE'), 0) ELSE 0 END::numeric AS credit_note_amount,
      coalesce(sum(a.amount) FILTER (WHERE p.status = 'APPROVED'), 0)::numeric AS approved_paid_amount
    FROM rrhh.worker_account_charges c
    LEFT JOIN mermas.worker_payment_allocations a ON a.company_id = p_company_id AND a.charge_id = c.id
    LEFT JOIN mermas.worker_payments p ON p.id = a.payment_id AND p.company_id = p_company_id
    WHERE c.company_id = p_company_id AND c.employee_id = p_employee_id
      AND c.source_type IN ('MERMA', 'BSALE_BOLETA')
    GROUP BY c.id, c.source_type, c.source_id, c.document_type, c.document_number, c.document_date, c.created_at, c.amount, c.status
  )
  SELECT jsonb_build_object(
    'total_original_charges', coalesce(sum(original_amount) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0), 0),
    'approved_payments', (SELECT coalesce(sum(amount), 0) FROM mermas.worker_payments WHERE company_id = p_company_id AND employee_id = p_employee_id AND status = 'APPROVED'),
    'pending_review_payments', (SELECT coalesce(sum(amount), 0) FROM mermas.worker_payments WHERE company_id = p_company_id AND employee_id = p_employee_id AND status = 'PENDING_REVIEW'),
    'official_balance', coalesce(sum(greatest(original_amount - credit_note_amount - approved_paid_amount, 0)) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0), 0),
    'projected_balance', greatest(coalesce(sum(greatest(original_amount - credit_note_amount - approved_paid_amount, 0)) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0), 0) - (SELECT coalesce(sum(amount), 0) FROM mermas.worker_payments WHERE company_id = p_company_id AND employee_id = p_employee_id AND status = 'PENDING_REVIEW'), 0),
    'merma_original', coalesce(sum(original_amount) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type = 'MERMA'), 0),
    'merma_balance', coalesce(sum(greatest(original_amount - approved_paid_amount, 0)) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type = 'MERMA'), 0),
    'bsale_boleta_original', coalesce(sum(original_amount) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type = 'BSALE_BOLETA'), 0),
    'bsale_boleta_balance', coalesce(sum(greatest(original_amount - credit_note_amount - approved_paid_amount, 0)) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type = 'BSALE_BOLETA'), 0),
    'charge_count', count(*) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0),
    'open_charge_count', count(*) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND greatest(original_amount - credit_note_amount - approved_paid_amount, 0) > 0),
    'paid_charge_count', count(*) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND greatest(original_amount - credit_note_amount - approved_paid_amount, 0) = 0)
  ) INTO v_summary FROM charge_balances;

  WITH charge_balances AS (
    SELECT c.id, c.source_type, c.source_id, c.document_type, c.document_number, c.document_date,
      c.created_at, c.amount AS original_amount, c.status,
      CASE WHEN c.source_type = 'BSALE_BOLETA' THEN coalesce((SELECT sum(abs(nc.amount)) FROM rrhh.worker_account_charges nc
        WHERE nc.company_id = p_company_id AND nc.source_type = 'BSALE_NOTA_CREDITO'
          AND nc.reversal_of_charge_id = c.id AND nc.status = 'ACTIVE'), 0) ELSE 0 END::numeric AS credit_note_amount,
      coalesce(sum(a.amount) FILTER (WHERE p.status = 'APPROVED'), 0)::numeric AS approved_paid_amount
    FROM rrhh.worker_account_charges c
    LEFT JOIN mermas.worker_payment_allocations a ON a.company_id = p_company_id AND a.charge_id = c.id
    LEFT JOIN mermas.worker_payments p ON p.id = a.payment_id AND p.company_id = p_company_id
    WHERE c.company_id = p_company_id AND c.employee_id = p_employee_id
      AND c.source_type IN ('MERMA', 'BSALE_BOLETA')
    GROUP BY c.id, c.source_type, c.source_id, c.document_type, c.document_number, c.document_date, c.created_at, c.amount, c.status
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'charge_id', c.id, 'source_type', c.source_type,
    'source_label', CASE c.source_type WHEN 'MERMA' THEN 'Venta Mermas' WHEN 'BSALE_BOLETA' THEN 'Boleta Bsale' ELSE c.source_type END,
    'source_id', c.source_id, 'document_type', c.document_type, 'document_number', c.document_number,
    'document_date', c.document_date, 'original_amount', c.original_amount,
    'credit_note_amount', c.credit_note_amount, 'approved_paid_amount', c.approved_paid_amount,
    'outstanding_amount', CASE WHEN c.status = 'ACTIVE' AND c.original_amount > 0 THEN greatest(c.original_amount - c.credit_note_amount - c.approved_paid_amount, 0) ELSE 0 END,
    'status', c.status,
    'items', CASE WHEN c.source_type = 'MERMA' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('bsale_variant_id', l.bsale_variant_id, 'sku', l.sku_snapshot, 'product_name', l.product_name_snapshot, 'quantity', l.quantity, 'unit_price', l.worker_unit_price_snapshot, 'line_total', l.line_total) ORDER BY l.created_at, l.id) FROM mermas.internal_sale_lines l WHERE l.company_id = p_company_id AND l.sale_id::text = c.source_id), '[]'::jsonb)
      WHEN c.source_type = 'BSALE_BOLETA' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('bsale_variant_id', d.variant_id, 'variant_id', d.variant_id, 'sku', coalesce(v.code, d.variant_code), 'variant_code', coalesce(v.code, d.variant_code), 'product_name', coalesce(bp.name, d.variant_description, v.description, 'Producto Bsale'), 'variant_description', d.variant_description, 'quantity', d.quantity, 'unit_price', d.total_unit_value, 'line_total', d.total_amount) ORDER BY d.line_number, d.id) FROM integraciones.bsale_document_details d LEFT JOIN integraciones.bsale_variants v ON v.company_id = d.company_id AND v.bsale_id = d.variant_id LEFT JOIN integraciones.bsale_products bp ON bp.company_id = d.company_id AND bp.bsale_id = v.bsale_product_id WHERE d.company_id = p_company_id AND d.bsale_document_id::text = c.source_id), '[]'::jsonb)
      ELSE '[]'::jsonb END,
    'allocations', coalesce((SELECT jsonb_agg(jsonb_build_object('payment_id', p.id, 'payment_number', p.payment_number, 'payment_date', p.submitted_at, 'amount', a.amount) ORDER BY p.submitted_at, p.id) FROM mermas.worker_payment_allocations a JOIN mermas.worker_payments p ON p.id = a.payment_id WHERE a.company_id = p_company_id AND p.company_id = p_company_id AND a.charge_id = c.id AND p.status = 'APPROVED'), '[]'::jsonb)
  ) ORDER BY coalesce(c.document_date, c.created_at), c.id), '[]'::jsonb) INTO v_charges
  FROM charge_balances c;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'payment_id', p.id, 'payment_number', p.payment_number, 'amount', p.amount, 'status', p.status,
    'submitted_at', p.submitted_at, 'reviewed_at', p.reviewed_at,
    'allocations', CASE WHEN p.status = 'APPROVED' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('charge_id', c.id, 'source_type', c.source_type, 'document_number', c.document_number, 'amount', a.amount) ORDER BY c.document_date, c.id) FROM mermas.worker_payment_allocations a JOIN rrhh.worker_account_charges c ON c.id = a.charge_id WHERE a.company_id = p_company_id AND c.company_id = p_company_id AND a.payment_id = p.id), '[]'::jsonb) ELSE '[]'::jsonb END
  ) ORDER BY p.submitted_at, p.id), '[]'::jsonb) INTO v_payments
  FROM mermas.worker_payments p WHERE p.company_id = p_company_id AND p.employee_id = p_employee_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'movement_type', movement_type, 'charge_id', charge_id, 'reversal_of_charge_id', reversal_of_charge_id, 'payment_id', payment_id,
    'source_type', source_type, 'reference_number', reference_number, 'amount', amount,
    'status', status, 'occurred_at', occurred_at
  ) ORDER BY occurred_at,
    CASE movement_type WHEN 'CHARGE' THEN 0 WHEN 'ADJUSTMENT' THEN 1 WHEN 'PAYMENT' THEN 2 ELSE 9 END,
    reference_number, coalesce(charge_id, payment_id)), '[]'::jsonb) INTO v_movements
  FROM (
    SELECT CASE WHEN c.source_type = 'BSALE_NOTA_CREDITO' THEN 'ADJUSTMENT' ELSE 'CHARGE' END::text AS movement_type,
      c.id AS charge_id, c.reversal_of_charge_id, NULL::uuid AS payment_id, c.source_type,
      coalesce(c.document_number, c.source_id) AS reference_number, c.amount, c.status,
      coalesce(c.document_date, c.created_at) AS occurred_at
    FROM rrhh.worker_account_charges c
    WHERE c.company_id = p_company_id AND c.employee_id = p_employee_id
      AND (c.source_type IN ('MERMA', 'BSALE_BOLETA') OR c.source_type = 'BSALE_NOTA_CREDITO')
    UNION ALL
    SELECT 'PAYMENT', NULL, NULL, p.id, NULL, coalesce(p.payment_number, 'Pago sin correlativo'), p.amount, p.status, p.submitted_at
    FROM mermas.worker_payments p WHERE p.company_id = p_company_id AND p.employee_id = p_employee_id
  ) movements;

  RETURN jsonb_build_object(
    'employee', jsonb_build_object('id', v_employee.id, 'name', pg_catalog.btrim(pg_catalog.concat_ws(' ', v_employee.nombres, v_employee.apellido_paterno, v_employee.apellido_materno)), 'rut', v_employee.rut, 'status', v_employee.estado),
    'summary', v_summary, 'charges', v_charges, 'payments', v_payments, 'movements', v_movements
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.get_worker_accounts_v2(uuid, uuid, text),
  mermas.get_worker_account_detail_v2(uuid, uuid, uuid),
  mermas.approve_worker_payment(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.get_worker_accounts_v2(uuid, uuid, text),
  mermas.get_worker_account_detail_v2(uuid, uuid, uuid),
  mermas.approve_worker_payment(uuid, uuid, uuid) TO service_role;
