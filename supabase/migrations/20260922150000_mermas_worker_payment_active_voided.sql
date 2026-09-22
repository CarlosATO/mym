-- MERMAS: immediate worker payments with traceable voiding.

ALTER TABLE mermas.worker_payments
  ADD COLUMN IF NOT EXISTS voided_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE mermas.worker_payments
  DROP CONSTRAINT IF EXISTS worker_payments_status_check;
ALTER TABLE mermas.worker_payments
  ADD CONSTRAINT worker_payments_status_check
  CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'REVERSED', 'ACTIVE', 'VOIDED'));

CREATE OR REPLACE FUNCTION mermas.recompute_internal_sale_payment_status(
  p_company_id uuid,
  p_sale_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, rrhh, mermas
AS $$
DECLARE
  v_charge_id uuid;
  v_charge_amount numeric;
  v_allocated numeric;
BEGIN
  SELECT c.id, c.amount
  INTO v_charge_id, v_charge_amount
  FROM rrhh.worker_account_charges c
  WHERE c.company_id = p_company_id
    AND c.source_type = 'MERMA'
    AND c.source_id = p_sale_id::text;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT coalesce(sum(a.amount) FILTER (WHERE p.status = 'ACTIVE'), 0)
  INTO v_allocated
  FROM mermas.worker_payment_allocations a
  JOIN mermas.worker_payments p
    ON p.id = a.payment_id
   AND p.company_id = p_company_id
  WHERE a.company_id = p_company_id
    AND a.charge_id = v_charge_id;

  UPDATE mermas.internal_sales
  SET status = CASE
    WHEN status = 'REVERSED' THEN status
    WHEN v_allocated >= v_charge_amount THEN 'RENDERED'
    ELSE 'PENDING_RENDITION'
  END,
  updated_at = now()
  WHERE company_id = p_company_id
    AND id = p_sale_id
    AND status <> 'REVERSED';
END;
$$;

REVOKE ALL ON FUNCTION mermas.recompute_internal_sale_payment_status(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION mermas.submit_worker_payment(
  p_company_id uuid,
  p_user_id uuid,
  p_employee_id uuid,
  p_amount numeric,
  p_upload_id uuid,
  p_storage_path text,
  p_original_filename text,
  p_mime_type text,
  p_size_bytes bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, rrhh, mermas, storage
AS $$
DECLARE
  v_now timestamptz := now();
  v_today date := timezone('America/Santiago', v_now)::date;
  v_year integer := extract(year FROM v_today)::integer;
  v_sequence bigint;
  v_payment_id uuid;
  v_payment_number text;
  v_available numeric := 0;
  v_remaining numeric;
  v_allocated numeric := 0;
  v_charge record;
  v_to_apply numeric;
  v_object storage.objects%ROWTYPE;
  v_metadata_size bigint;
  v_metadata_mime text;
  v_allocations jsonb := '[]'::jsonb;
  v_sale_id uuid;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_employee_id IS NULL OR p_upload_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM portal.users u
       WHERE u.id = p_user_id AND u.is_active AND u.deleted_at IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM core.companies c
       WHERE c.id = p_company_id AND c.is_active
     )
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.create') THEN
    RAISE EXCEPTION 'No autorizado para registrar pagos de trabajadores';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM rrhh.employees e WHERE e.id = p_employee_id) THEN
    RAISE EXCEPTION 'Trabajador no encontrado';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'El monto debe ser mayor que cero';
  END IF;
  IF p_mime_type NOT IN ('application/pdf', 'image/jpeg', 'image/png')
     OR p_size_bytes IS NULL OR p_size_bytes <= 0 OR p_size_bytes > 10485760 THEN
    RAISE EXCEPTION 'El comprobante no cumple los requisitos';
  END IF;
  IF p_storage_path IS NULL
     OR p_storage_path <> pg_catalog.btrim(p_storage_path)
     OR p_storage_path !~ ('^' || p_company_id::text || '/' || p_employee_id::text || '/pending/' || p_upload_id::text || '/[A-Za-z0-9._-]+$') THEN
    RAISE EXCEPTION 'La ruta del comprobante no es válida';
  END IF;
  IF p_original_filename IS NULL
     OR p_original_filename <> split_part(p_storage_path, '/', 5)
     OR p_original_filename !~ '^[A-Za-z0-9._-]+$' THEN
    RAISE EXCEPTION 'El nombre del comprobante no es válido';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'mermas-worker-payment:' || p_company_id::text || ':' || p_employee_id::text, 0));

  SELECT * INTO v_object
  FROM storage.objects o
  WHERE o.bucket_id = 'mermas-worker-payments'
    AND o.name = p_storage_path
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El comprobante subido no existe';
  END IF;
  v_metadata_size := CASE
    WHEN v_object.metadata->>'size' ~ '^[0-9]+$' THEN (v_object.metadata->>'size')::bigint
    ELSE NULL
  END;
  v_metadata_mime := coalesce(v_object.metadata->>'mimetype', v_object.metadata->>'contentType');
  IF v_metadata_size IS DISTINCT FROM p_size_bytes
     OR v_metadata_mime IS DISTINCT FROM p_mime_type THEN
    RAISE EXCEPTION 'Los datos del comprobante no coinciden';
  END IF;

  -- Lock the account's active debt before calculating FIFO availability.
  PERFORM 1
  FROM rrhh.worker_account_charges c
  WHERE c.company_id = p_company_id
    AND c.employee_id = p_employee_id
    AND c.status = 'ACTIVE'
    AND c.amount > 0
    AND c.source_type IN ('MERMA', 'BSALE_BOLETA')
  FOR UPDATE;

  SELECT coalesce(sum(greatest(
    c.amount
    - CASE WHEN c.source_type = 'BSALE_BOLETA' THEN coalesce((
        SELECT sum(abs(nc.amount))
        FROM rrhh.worker_account_charges nc
        WHERE nc.company_id = p_company_id
          AND nc.source_type = 'BSALE_NOTA_CREDITO'
          AND nc.reversal_of_charge_id = c.id
          AND nc.status = 'ACTIVE'
      ), 0) ELSE 0 END
    - coalesce((
        SELECT sum(a.amount)
        FROM mermas.worker_payment_allocations a
        JOIN mermas.worker_payments p ON p.id = a.payment_id
        WHERE a.company_id = p_company_id
          AND a.charge_id = c.id
          AND p.company_id = p_company_id
          AND p.status = 'ACTIVE'
      ), 0),
    0
  )), 0)
  INTO v_available
  FROM rrhh.worker_account_charges c
  WHERE c.company_id = p_company_id
    AND c.employee_id = p_employee_id
    AND c.status = 'ACTIVE'
    AND c.amount > 0
    AND c.source_type IN ('MERMA', 'BSALE_BOLETA');

  IF v_available <= 0 THEN
    RAISE EXCEPTION 'El trabajador no tiene deuda pendiente';
  END IF;
  IF p_amount > v_available THEN
    RAISE EXCEPTION 'El monto excede el saldo disponible';
  END IF;

  INSERT INTO mermas.worker_payment_correlatives(company_id, payment_year, next_value)
  VALUES (p_company_id, v_year, 2)
  ON CONFLICT (company_id, payment_year)
  DO UPDATE SET next_value = mermas.worker_payment_correlatives.next_value + 1
  RETURNING next_value - 1 INTO v_sequence;
  v_payment_number := 'PIT-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0');

  INSERT INTO mermas.worker_payments(
    company_id, employee_id, payment_number, amount, status, submitted_by, submitted_at
  ) VALUES (
    p_company_id, p_employee_id, v_payment_number, p_amount, 'ACTIVE', p_user_id, v_now
  ) RETURNING id INTO v_payment_id;

  INSERT INTO mermas.worker_payment_evidence(
    company_id, payment_id, storage_path, original_filename, mime_type, size_bytes, uploaded_by
  ) VALUES (
    p_company_id, v_payment_id, p_storage_path, p_original_filename, p_mime_type, p_size_bytes, p_user_id
  );

  v_remaining := p_amount;
  FOR v_charge IN
    SELECT c.id, c.source_type, c.source_id, c.document_number, c.amount,
      greatest(
        c.amount
        - CASE WHEN c.source_type = 'BSALE_BOLETA' THEN coalesce((
            SELECT sum(abs(nc.amount))
            FROM rrhh.worker_account_charges nc
            WHERE nc.company_id = p_company_id
              AND nc.source_type = 'BSALE_NOTA_CREDITO'
              AND nc.reversal_of_charge_id = c.id
              AND nc.status = 'ACTIVE'
          ), 0) ELSE 0 END
        - coalesce((
            SELECT sum(a.amount)
            FROM mermas.worker_payment_allocations a
            JOIN mermas.worker_payments p ON p.id = a.payment_id
            WHERE a.company_id = p_company_id
              AND a.charge_id = c.id
              AND p.company_id = p_company_id
              AND p.status = 'ACTIVE'
          ), 0),
        0
      ) AS remaining
    FROM rrhh.worker_account_charges c
    WHERE c.company_id = p_company_id
      AND c.employee_id = p_employee_id
      AND c.status = 'ACTIVE'
      AND c.amount > 0
      AND c.source_type IN ('MERMA', 'BSALE_BOLETA')
    ORDER BY coalesce(c.document_date, c.created_at), c.id
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_to_apply := least(v_remaining, v_charge.remaining);
    IF v_to_apply <= 0 THEN
      CONTINUE;
    END IF;
    INSERT INTO mermas.worker_payment_allocations(company_id, payment_id, charge_id, amount)
    VALUES (p_company_id, v_payment_id, v_charge.id, v_to_apply);
    v_allocated := v_allocated + v_to_apply;
    v_remaining := v_remaining - v_to_apply;
    v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
      'charge_id', v_charge.id,
      'source_type', v_charge.source_type,
      'source_id', v_charge.source_id,
      'document_number', v_charge.document_number,
      'amount', v_to_apply
    ));
  END LOOP;

  IF v_remaining > 0 OR v_allocated <> p_amount THEN
    RAISE EXCEPTION 'La deuda pendiente no alcanza para asignar completamente el pago';
  END IF;

  FOR v_sale_id IN
    SELECT DISTINCT c.source_id::uuid
    FROM mermas.worker_payment_allocations a
    JOIN rrhh.worker_account_charges c ON c.id = a.charge_id
    WHERE a.company_id = p_company_id
      AND a.payment_id = v_payment_id
      AND c.company_id = p_company_id
      AND c.source_type = 'MERMA'
  LOOP
    PERFORM mermas.recompute_internal_sale_payment_status(p_company_id, v_sale_id);
  END LOOP;

  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES (
    'mermas.worker_payments', v_payment_id, 'MERMA_PAY_SUBMIT',
    jsonb_build_object(
      'payment_id', v_payment_id,
      'payment_number', v_payment_number,
      'employee_id', p_employee_id,
      'amount', p_amount,
      'company_id', p_company_id,
      'status', 'ACTIVE',
      'allocations', v_allocations
    ), p_user_id
  );

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'payment_number', v_payment_number,
    'amount', p_amount,
    'status', 'ACTIVE',
    'balance_before', v_available,
    'balance_after', v_available - p_amount,
    'allocations', v_allocations
  );
END;
$$;

CREATE OR REPLACE FUNCTION mermas.void_worker_payment(
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
  v_sale_id uuid;
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL OR p_payment_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM portal.users u
       WHERE u.id = p_user_id AND u.is_active AND u.deleted_at IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM core.companies c
       WHERE c.id = p_company_id AND c.is_active
     )
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.authorize') THEN
    RAISE EXCEPTION 'No autorizado para anular pagos de trabajadores';
  END IF;
  IF v_reason = '' THEN
    RAISE EXCEPTION 'El motivo de anulación es obligatorio';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'mermas-worker-payment:' || p_company_id::text || ':' || p_payment_id::text, 0));

  SELECT * INTO v_payment
  FROM mermas.worker_payments p
  WHERE p.id = p_payment_id
    AND p.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pago no encontrado';
  END IF;
  IF v_payment.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Sólo se pueden anular pagos ACTIVE';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'mermas-worker-payment:' || p_company_id::text || ':' || v_payment.employee_id::text, 0));

  UPDATE mermas.worker_payments
  SET status = 'VOIDED', voided_by = p_user_id, voided_at = now(),
      void_reason = v_reason, updated_at = now()
  WHERE id = v_payment.id;

  FOR v_sale_id IN
    SELECT DISTINCT c.source_id::uuid
    FROM mermas.worker_payment_allocations a
    JOIN rrhh.worker_account_charges c ON c.id = a.charge_id
    WHERE a.company_id = p_company_id
      AND a.payment_id = v_payment.id
      AND c.company_id = p_company_id
      AND c.source_type = 'MERMA'
  LOOP
    PERFORM mermas.recompute_internal_sale_payment_status(p_company_id, v_sale_id);
  END LOOP;

  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES (
    'mermas.worker_payments', v_payment.id, 'MERMA_PAY_VOID',
    jsonb_build_object(
      'payment_id', v_payment.id,
      'payment_number', v_payment.payment_number,
      'employee_id', v_payment.employee_id,
      'amount', v_payment.amount,
      'company_id', p_company_id,
      'status', 'VOIDED',
      'voided_at', now(),
      'void_reason', v_reason
    ), p_user_id
  );

  RETURN jsonb_build_object(
    'payment_id', v_payment.id,
    'payment_number', v_payment.payment_number,
    'amount', v_payment.amount,
    'status', 'VOIDED',
    'voided_by', p_user_id,
    'void_reason', v_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.submit_worker_payment(uuid, uuid, uuid, numeric, uuid, text, text, text, bigint),
  mermas.void_worker_payment(uuid, uuid, uuid, text),
  mermas.recompute_internal_sale_payment_status(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.submit_worker_payment(uuid, uuid, uuid, numeric, uuid, text, text, text, bigint),
  mermas.void_worker_payment(uuid, uuid, uuid, text)
  TO service_role;

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
      coalesce(sum(a.amount) FILTER (WHERE p.status = 'ACTIVE'), 0)::numeric AS active_paid_amount,
      coalesce(c.document_date, c.created_at) AS charge_at
    FROM rrhh.worker_account_charges c
    LEFT JOIN mermas.worker_payment_allocations a ON a.company_id = p_company_id AND a.charge_id = c.id
    LEFT JOIN mermas.worker_payments p ON p.id = a.payment_id AND p.company_id = p_company_id
    WHERE c.company_id = p_company_id AND c.status = 'ACTIVE'
      AND c.amount > 0 AND c.source_type IN ('MERMA', 'BSALE_BOLETA')
    GROUP BY c.id, c.company_id, c.employee_id, c.source_type, c.amount, c.document_date, c.created_at
  ), account_charges AS (
    SELECT cb.employee_id,
      coalesce(sum(greatest(original_amount - credit_note_amount - active_paid_amount, 0)), 0)::numeric AS official_balance,
      coalesce(sum(greatest(original_amount - active_paid_amount, 0)) FILTER (WHERE source_type = 'MERMA'), 0)::numeric AS merma_balance,
      coalesce(sum(greatest(original_amount - credit_note_amount - active_paid_amount, 0)) FILTER (WHERE source_type = 'BSALE_BOLETA'), 0)::numeric AS bsale_boleta_balance,
      count(*) AS active_charge_count,
      count(*) FILTER (WHERE greatest(original_amount - credit_note_amount - active_paid_amount, 0) > 0) AS open_charge_count,
      max(charge_at) AS last_charge_at
    FROM charge_balances GROUP BY employee_id
  ), account_payments AS (
    SELECT wp.employee_id,
      coalesce(sum(amount) FILTER (WHERE status = 'ACTIVE'), 0)::numeric AS active_payments,
      max(submitted_at) FILTER (WHERE status = 'ACTIVE') AS last_payment_at
    FROM mermas.worker_payments wp
    WHERE company_id = p_company_id
    GROUP BY employee_id
  ), account_employees AS (
    SELECT employee_id FROM account_charges UNION SELECT employee_id FROM account_payments
  )
  SELECT e.id, pg_catalog.btrim(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)),
    e.rut, e.estado, coalesce(p.active_payments, 0)::numeric,
    greatest(coalesce(c.official_balance, 0), 0)::numeric,
    greatest(coalesce(c.official_balance, 0), 0)::numeric,
    0::numeric, coalesce(c.merma_balance, 0)::numeric,
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
      coalesce(sum(a.amount) FILTER (WHERE p.status = 'ACTIVE'), 0)::numeric AS active_paid_amount
    FROM rrhh.worker_account_charges c
    LEFT JOIN mermas.worker_payment_allocations a ON a.company_id = p_company_id AND a.charge_id = c.id
    LEFT JOIN mermas.worker_payments p ON p.id = a.payment_id AND p.company_id = p_company_id
    WHERE c.company_id = p_company_id AND c.employee_id = p_employee_id
      AND c.source_type IN ('MERMA', 'BSALE_BOLETA')
    GROUP BY c.id, c.source_type, c.source_id, c.document_type, c.document_number, c.document_date, c.created_at, c.amount, c.status
  )
  SELECT jsonb_build_object(
    'total_original_charges', coalesce(sum(original_amount) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0), 0),
    'approved_payments', (SELECT coalesce(sum(amount), 0) FROM mermas.worker_payments WHERE company_id = p_company_id AND employee_id = p_employee_id AND status = 'ACTIVE'),
    'pending_review_payments', 0,
    'official_balance', coalesce(sum(greatest(original_amount - credit_note_amount - active_paid_amount, 0)) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0), 0),
    'projected_balance', coalesce(sum(greatest(original_amount - credit_note_amount - active_paid_amount, 0)) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0), 0),
    'merma_original', coalesce(sum(original_amount) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type = 'MERMA'), 0),
    'merma_balance', coalesce(sum(greatest(original_amount - active_paid_amount, 0)) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type = 'MERMA'), 0),
    'bsale_boleta_original', coalesce(sum(original_amount) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type = 'BSALE_BOLETA'), 0),
    'bsale_boleta_balance', coalesce(sum(greatest(original_amount - credit_note_amount - active_paid_amount, 0)) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND source_type = 'BSALE_BOLETA'), 0),
    'charge_count', count(*) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0),
    'open_charge_count', count(*) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND greatest(original_amount - credit_note_amount - active_paid_amount, 0) > 0),
    'paid_charge_count', count(*) FILTER (WHERE status = 'ACTIVE' AND original_amount > 0 AND greatest(original_amount - credit_note_amount - active_paid_amount, 0) = 0)
  ) INTO v_summary FROM charge_balances;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'charge_id', c.id, 'source_type', c.source_type,
    'source_label', CASE c.source_type WHEN 'MERMA' THEN 'Venta Mermas' WHEN 'BSALE_BOLETA' THEN 'Boleta Bsale' ELSE c.source_type END,
    'source_id', c.source_id, 'document_type', c.document_type, 'document_number', c.document_number,
    'document_date', c.document_date, 'original_amount', c.original_amount,
    'credit_note_amount', c.credit_note_amount, 'approved_paid_amount', c.active_paid_amount,
    'outstanding_amount', CASE WHEN c.status = 'ACTIVE' AND c.original_amount > 0 THEN greatest(c.original_amount - c.credit_note_amount - c.active_paid_amount, 0) ELSE 0 END,
    'status', c.status,
    'items', CASE WHEN c.source_type = 'MERMA' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('bsale_variant_id', l.bsale_variant_id, 'sku', l.sku_snapshot, 'product_name', l.product_name_snapshot, 'quantity', l.quantity, 'unit_price', l.worker_unit_price_snapshot, 'line_total', l.line_total) ORDER BY l.created_at, l.id) FROM mermas.internal_sale_lines l WHERE l.company_id = p_company_id AND l.sale_id::text = c.source_id), '[]'::jsonb)
      WHEN c.source_type = 'BSALE_BOLETA' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('bsale_variant_id', d.variant_id, 'variant_id', d.variant_id, 'sku', coalesce(v.code, d.variant_code), 'variant_code', coalesce(v.code, d.variant_code), 'product_name', coalesce(bp.name, d.variant_description, v.description, 'Producto Bsale'), 'variant_description', d.variant_description, 'quantity', d.quantity, 'unit_price', d.total_unit_value, 'line_total', d.total_amount) ORDER BY d.line_number, d.id) FROM integraciones.bsale_document_details d LEFT JOIN integraciones.bsale_variants v ON v.company_id = d.company_id AND v.bsale_id = d.variant_id LEFT JOIN integraciones.bsale_products bp ON bp.company_id = d.company_id AND bp.bsale_id = v.bsale_product_id WHERE d.company_id = p_company_id AND d.bsale_document_id::text = c.source_id), '[]'::jsonb)
      ELSE '[]'::jsonb END,
    'allocations', coalesce((SELECT jsonb_agg(jsonb_build_object('payment_id', p.id, 'payment_number', p.payment_number, 'payment_date', p.submitted_at, 'amount', a.amount) ORDER BY p.submitted_at, p.id)
      FROM mermas.worker_payment_allocations a JOIN mermas.worker_payments p ON p.id = a.payment_id
      WHERE a.company_id = p_company_id AND p.company_id = p_company_id AND a.charge_id = c.id AND p.status = 'ACTIVE'), '[]'::jsonb)
  ) ORDER BY coalesce(c.document_date, c.created_at), c.id), '[]'::jsonb) INTO v_charges
  FROM (
    SELECT c.id, c.source_type, c.source_id, c.document_type, c.document_number, c.document_date,
      c.created_at, c.amount AS original_amount, c.status,
      CASE WHEN c.source_type = 'BSALE_BOLETA' THEN coalesce((SELECT sum(abs(nc.amount)) FROM rrhh.worker_account_charges nc
        WHERE nc.company_id = p_company_id AND nc.source_type = 'BSALE_NOTA_CREDITO'
          AND nc.reversal_of_charge_id = c.id AND nc.status = 'ACTIVE'), 0) ELSE 0 END::numeric AS credit_note_amount,
      coalesce(sum(a.amount) FILTER (WHERE p.status = 'ACTIVE'), 0)::numeric AS active_paid_amount
    FROM rrhh.worker_account_charges c
    LEFT JOIN mermas.worker_payment_allocations a ON a.company_id = p_company_id AND a.charge_id = c.id
    LEFT JOIN mermas.worker_payments p ON p.id = a.payment_id AND p.company_id = p_company_id
    WHERE c.company_id = p_company_id AND c.employee_id = p_employee_id
      AND c.source_type IN ('MERMA', 'BSALE_BOLETA')
    GROUP BY c.id, c.source_type, c.source_id, c.document_type, c.document_number, c.document_date, c.created_at, c.amount, c.status
  ) c;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'payment_id', p.id, 'payment_number', p.payment_number, 'amount', p.amount, 'status', p.status,
    'submitted_at', p.submitted_at, 'reviewed_at', p.reviewed_at,
    'voided_by', p.voided_by, 'voided_at', p.voided_at, 'void_reason', p.void_reason,
    'allocations', coalesce((SELECT jsonb_agg(jsonb_build_object('charge_id', c.id, 'source_type', c.source_type, 'document_number', c.document_number, 'amount', a.amount) ORDER BY c.document_date, c.id)
      FROM mermas.worker_payment_allocations a JOIN rrhh.worker_account_charges c ON c.id = a.charge_id
      WHERE a.company_id = p_company_id AND c.company_id = p_company_id AND a.payment_id = p.id AND p.status = 'ACTIVE'), '[]'::jsonb)
  ) ORDER BY p.submitted_at, p.id), '[]'::jsonb) INTO v_payments
  FROM mermas.worker_payments p WHERE p.company_id = p_company_id AND p.employee_id = p_employee_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'movement_type', movement_type, 'charge_id', charge_id, 'reversal_of_charge_id', reversal_of_charge_id, 'payment_id', payment_id,
    'source_type', source_type, 'reference_number', reference_number, 'amount', amount,
    'status', status, 'occurred_at', occurred_at, 'voided_at', voided_at, 'void_reason', void_reason
  ) ORDER BY occurred_at, reference_number, coalesce(charge_id, payment_id)), '[]'::jsonb) INTO v_movements
  FROM (
    SELECT CASE WHEN c.source_type = 'BSALE_NOTA_CREDITO' THEN 'ADJUSTMENT' ELSE 'CHARGE' END::text AS movement_type,
      c.id AS charge_id, c.reversal_of_charge_id, NULL::uuid AS payment_id, c.source_type,
      coalesce(c.document_number, c.source_id) AS reference_number, c.amount, c.status,
      coalesce(c.document_date, c.created_at) AS occurred_at, NULL::timestamptz AS voided_at, NULL::text AS void_reason
    FROM rrhh.worker_account_charges c
    WHERE c.company_id = p_company_id AND c.employee_id = p_employee_id
      AND (c.source_type IN ('MERMA', 'BSALE_BOLETA') OR c.source_type = 'BSALE_NOTA_CREDITO')
    UNION ALL
    SELECT 'PAYMENT', NULL, NULL, p.id, NULL, coalesce(p.payment_number, 'Pago sin correlativo'), p.amount,
      p.status, p.submitted_at, p.voided_at, p.void_reason
    FROM mermas.worker_payments p WHERE p.company_id = p_company_id AND p.employee_id = p_employee_id
  ) movements;

  RETURN jsonb_build_object(
    'employee', jsonb_build_object('id', v_employee.id, 'name', pg_catalog.btrim(pg_catalog.concat_ws(' ', v_employee.nombres, v_employee.apellido_paterno, v_employee.apellido_materno)), 'rut', v_employee.rut, 'status', v_employee.estado),
    'summary', v_summary, 'charges', v_charges, 'payments', v_payments, 'movements', v_movements
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.get_worker_accounts_v2(uuid, uuid, text),
  mermas.get_worker_account_detail_v2(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.get_worker_accounts_v2(uuid, uuid, text),
  mermas.get_worker_account_detail_v2(uuid, uuid, uuid)
  TO service_role;
