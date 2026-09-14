-- MERMAS: worker payment submission with mandatory private evidence.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'mermas-worker-payments',
  'mermas-worker-payments',
  false,
  10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE mermas.worker_payment_correlatives (
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  payment_year integer NOT NULL,
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (company_id, payment_year)
);

CREATE UNIQUE INDEX mermas_worker_payment_evidence_payment_uidx
  ON mermas.worker_payment_evidence(payment_id);

CREATE POLICY mermas_worker_payment_evidence_storage_select ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'mermas-worker-payments'
    AND core.has_company_access(auth.uid(), split_part(name, '/', 1)::uuid)
    AND portal.has_permission('logistica.mermas.view')
    AND EXISTS (
      SELECT 1
      FROM mermas.worker_payment_evidence evidence
      WHERE evidence.company_id = split_part(name, '/', 1)::uuid
        AND evidence.storage_path = name
    )
  );

GRANT ALL ON mermas.worker_payment_correlatives TO service_role;

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
  v_total_charges numeric := 0;
  v_approved_payments numeric := 0;
  v_pending_review_payments numeric := 0;
  v_available numeric := 0;
  v_object storage.objects%ROWTYPE;
  v_metadata_size bigint;
  v_metadata_mime text;
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
  IF p_original_filename IS NULL OR p_original_filename <> split_part(p_storage_path, '/', 5)
     OR p_original_filename !~ '^[A-Za-z0-9._-]+$' THEN
    RAISE EXCEPTION 'El nombre del comprobante no es válido';
  END IF;

  -- Serializa envíos del mismo trabajador para que el saldo proyectado sea consistente.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'mermas-worker-payment:' || p_company_id::text || ':' || p_employee_id::text, 0));

  SELECT * INTO v_object
  FROM storage.objects o
  WHERE o.bucket_id = 'mermas-worker-payments' AND o.name = p_storage_path
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El comprobante subido no existe'; END IF;
  v_metadata_size := CASE
    WHEN v_object.metadata->>'size' ~ '^[0-9]+$' THEN (v_object.metadata->>'size')::bigint
    ELSE NULL
  END;
  v_metadata_mime := coalesce(v_object.metadata->>'mimetype', v_object.metadata->>'contentType');
  IF v_metadata_size IS DISTINCT FROM p_size_bytes OR v_metadata_mime IS DISTINCT FROM p_mime_type THEN
    RAISE EXCEPTION 'Los datos del comprobante no coinciden';
  END IF;

  SELECT coalesce(sum(s.total_amount), 0) INTO v_total_charges
  FROM mermas.internal_sales s
  WHERE s.company_id = p_company_id AND s.employee_id = p_employee_id AND s.status <> 'REVERSED';
  SELECT coalesce(sum(p.amount) FILTER (WHERE p.status = 'APPROVED'), 0),
    coalesce(sum(p.amount) FILTER (WHERE p.status = 'PENDING_REVIEW'), 0)
  INTO v_approved_payments, v_pending_review_payments
  FROM mermas.worker_payments p
  WHERE p.company_id = p_company_id AND p.employee_id = p_employee_id;
  v_available := greatest(v_total_charges - v_approved_payments - v_pending_review_payments, 0);
  IF v_total_charges <= 0 THEN RAISE EXCEPTION 'El trabajador no tiene deuda pendiente'; END IF;
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
    p_company_id, p_employee_id, v_payment_number, p_amount, 'PENDING_REVIEW', p_user_id, v_now
  ) RETURNING id INTO v_payment_id;
  INSERT INTO mermas.worker_payment_evidence(
    company_id, payment_id, storage_path, original_filename, mime_type, size_bytes, uploaded_by
  ) VALUES (
    p_company_id, v_payment_id, p_storage_path, p_original_filename, p_mime_type, p_size_bytes, p_user_id
  );
  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES (
    'mermas.worker_payments', v_payment_id, 'MERMA_PAY_SUBMIT',
    jsonb_build_object(
      'payment_id', v_payment_id,
      'payment_number', v_payment_number,
      'employee_id', p_employee_id,
      'amount', p_amount,
      'company_id', p_company_id
    ), p_user_id
  );

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'payment_number', v_payment_number,
    'amount', p_amount,
    'status', 'PENDING_REVIEW'
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.submit_worker_payment(uuid, uuid, uuid, numeric, uuid, text, text, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.submit_worker_payment(uuid, uuid, uuid, numeric, uuid, text, text, text, bigint)
  TO service_role;
