-- MERMAS: manual worker-account credit notes with dedicated PDF evidence.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'mermas-worker-credit-notes', 'mermas-worker-credit-notes', false,
  10485760, ARRAY['application/pdf']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = false, file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE mermas.worker_credit_note_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  charge_id uuid NOT NULL REFERENCES rrhh.worker_account_charges(id) ON DELETE RESTRICT,
  storage_path text NOT NULL,
  original_filename text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type = 'application/pdf'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  uploaded_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, charge_id),
  UNIQUE (company_id, storage_path)
);

CREATE INDEX mermas_worker_credit_note_evidence_charge_idx
  ON mermas.worker_credit_note_evidence(company_id, charge_id);

ALTER TABLE mermas.worker_credit_note_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY mermas_worker_credit_note_evidence_select
  ON mermas.worker_credit_note_evidence FOR SELECT TO authenticated
  USING (
    core.has_company_access(auth.uid(), company_id)
    AND core.has_permission_for_company(auth.uid(), company_id, 'logistica.mermas.account.view')
  );
GRANT SELECT ON mermas.worker_credit_note_evidence TO authenticated;
GRANT SELECT, INSERT ON mermas.worker_credit_note_evidence TO service_role;
REVOKE DELETE ON mermas.worker_credit_note_evidence FROM PUBLIC, anon, authenticated, service_role;

CREATE UNIQUE INDEX mermas_manual_credit_note_folio_uidx
  ON rrhh.worker_account_charges(company_id, (metadata->>'credit_note_number'))
  WHERE source_type = 'BSALE_NOTA_CREDITO' AND metadata->>'origin' = 'MANUAL';

CREATE POLICY mermas_worker_credit_note_evidence_storage_select
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'mermas-worker-credit-notes'
    AND core.has_company_access(auth.uid(), split_part(name, '/', 1)::uuid)
    AND core.has_permission_for_company(auth.uid(), split_part(name, '/', 1)::uuid, 'logistica.mermas.account.view')
    AND EXISTS (
      SELECT 1 FROM mermas.worker_credit_note_evidence evidence
      WHERE evidence.company_id = split_part(name, '/', 1)::uuid
        AND evidence.storage_path = name
    )
  );

CREATE OR REPLACE FUNCTION mermas.register_manual_worker_credit_note(
  p_company_id uuid, p_user_id uuid, p_original_charge_id uuid,
  p_credit_note_number text, p_credit_note_date date, p_amount numeric,
  p_upload_id uuid, p_storage_path text, p_original_filename text,
  p_mime_type text, p_size_bytes bigint, p_observation text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, rrhh, mermas, storage
AS $$
DECLARE
  v_charge rrhh.worker_account_charges%ROWTYPE;
  v_paid numeric := 0;
  v_previous_nc numeric := 0;
  v_available numeric := 0;
  v_new_balance numeric := 0;
  v_note_id uuid;
  v_now timestamptz := now();
  v_object storage.objects%ROWTYPE;
  v_metadata_size bigint;
  v_metadata_mime text;
  v_employee_id uuid;
  v_number text := btrim(coalesce(p_credit_note_number, ''));
  v_observation text := nullif(btrim(coalesce(p_observation, '')), '');
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM portal.users u WHERE u.id = p_user_id AND u.is_active AND u.deleted_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM core.companies c WHERE c.id = p_company_id AND c.is_active)
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT (core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.authorize') OR portal.is_super_usuario(p_user_id)) THEN
    RAISE EXCEPTION 'No autorizado para registrar notas de crédito de trabajadores';
  END IF;
  IF p_original_charge_id IS NULL OR v_number = '' OR v_number !~ '^[0-9]+$' THEN RAISE EXCEPTION 'El folio de la NC es inválido'; END IF;
  IF p_credit_note_date IS NULL THEN RAISE EXCEPTION 'La fecha de la NC es obligatoria'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> trunc(p_amount) THEN RAISE EXCEPTION 'El monto de la NC debe ser un entero mayor que cero'; END IF;
  IF p_mime_type <> 'application/pdf' OR p_size_bytes IS NULL OR p_size_bytes <= 0 OR p_size_bytes > 10485760 THEN RAISE EXCEPTION 'La evidencia debe ser un PDF de hasta 10 MB'; END IF;
  IF p_upload_id IS NULL OR p_storage_path IS NULL OR p_original_filename IS NULL
     OR p_storage_path !~ ('^' || p_company_id::text || '/[0-9a-f-]{36}/credit-note/' || p_upload_id::text || '/[A-Za-z0-9._-]+$')
     OR p_original_filename <> split_part(p_storage_path, '/', 5)
     OR p_original_filename !~ '^[A-Za-z0-9._-]+\.pdf$' THEN
    RAISE EXCEPTION 'La ruta de evidencia no es válida';
  END IF;

  SELECT employee_id INTO v_employee_id FROM rrhh.worker_account_charges c
  WHERE c.id = p_original_charge_id AND c.company_id = p_company_id;
  -- This is the same account lock acquired by payment submission/approval.
  PERFORM pg_advisory_xact_lock(hashtextextended('mermas-worker-payment:' || p_company_id::text || ':' || v_employee_id::text, 0));
  SELECT * INTO v_charge FROM rrhh.worker_account_charges c
  WHERE c.id = p_original_charge_id AND c.company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_charge.source_type <> 'BSALE_BOLETA' OR v_charge.status <> 'ACTIVE' OR v_charge.amount <= 0 THEN
    RAISE EXCEPTION 'El cargo seleccionado no es una Boleta Bsale activa';
  END IF;
  IF split_part(p_storage_path, '/', 2) <> v_charge.employee_id::text THEN RAISE EXCEPTION 'La evidencia no corresponde al trabajador'; END IF;
  IF EXISTS (SELECT 1 FROM rrhh.worker_account_charges c WHERE c.company_id = p_company_id AND c.source_type = 'BSALE_NOTA_CREDITO' AND c.metadata->>'origin' = 'MANUAL' AND c.metadata->>'credit_note_number' = v_number) THEN
    RAISE EXCEPTION 'El folio de Nota de Crédito ya está registrado en la empresa';
  END IF;
  SELECT coalesce(sum(abs(nc.amount)), 0) INTO v_previous_nc FROM rrhh.worker_account_charges nc
  WHERE nc.company_id = p_company_id AND nc.reversal_of_charge_id = v_charge.id AND nc.source_type = 'BSALE_NOTA_CREDITO' AND nc.status = 'ACTIVE';
  SELECT coalesce(sum(a.amount) FILTER (WHERE p.status IN ('ACTIVE', 'APPROVED')), 0) INTO v_paid
  FROM mermas.worker_payment_allocations a JOIN mermas.worker_payments p ON p.id = a.payment_id
  WHERE a.company_id = p_company_id AND a.charge_id = v_charge.id AND p.company_id = p_company_id;
  v_available := greatest(v_charge.amount - v_previous_nc - v_paid, 0);
  IF p_amount > v_available THEN RAISE EXCEPTION 'El monto excede el saldo disponible de la Boleta'; END IF;

  SELECT * INTO v_object FROM storage.objects o WHERE o.bucket_id = 'mermas-worker-credit-notes' AND o.name = p_storage_path FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El PDF de la Nota de Crédito no existe'; END IF;
  v_metadata_size := CASE WHEN v_object.metadata->>'size' ~ '^[0-9]+$' THEN (v_object.metadata->>'size')::bigint ELSE NULL END;
  v_metadata_mime := coalesce(v_object.metadata->>'mimetype', v_object.metadata->>'contentType');
  IF v_metadata_size IS DISTINCT FROM p_size_bytes OR v_metadata_mime IS DISTINCT FROM 'application/pdf' THEN RAISE EXCEPTION 'Los datos del PDF no coinciden'; END IF;

  INSERT INTO rrhh.worker_account_charges(
    company_id, employee_id, source_type, source_id, document_type, document_number,
    document_date, amount, status, reversal_of_charge_id, metadata, created_by
  ) VALUES (
    p_company_id, v_charge.employee_id, 'BSALE_NOTA_CREDITO', 'MANUAL:' || v_number || ':' || p_upload_id::text,
    'NOTA_CREDITO', v_number, p_credit_note_date::timestamp AT TIME ZONE 'America/Santiago', -p_amount, 'ACTIVE', v_charge.id,
    jsonb_build_object('origin', 'MANUAL', 'credit_note_number', v_number, 'credit_note_date', p_credit_note_date,
      'original_charge_id', v_charge.id, 'original_document_number', v_charge.document_number,
      'employee_id', v_charge.employee_id, 'registered_by', p_user_id) || CASE WHEN v_observation IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('observation', v_observation) END,
    p_user_id
  ) RETURNING id INTO v_note_id;
  INSERT INTO mermas.worker_credit_note_evidence(company_id, charge_id, storage_path, original_filename, mime_type, size_bytes, uploaded_by)
  VALUES (p_company_id, v_note_id, p_storage_path, p_original_filename, p_mime_type, p_size_bytes, p_user_id);
  v_new_balance := v_available - p_amount;
  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES ('rrhh.worker_account_charges', v_note_id, 'MERMA_NC_MANUAL', jsonb_build_object(
    'company_id', p_company_id, 'user_id', p_user_id, 'employee_id', v_charge.employee_id,
    'original_charge_id', v_charge.id, 'original_document_number', v_charge.document_number,
    'credit_note_number', v_number, 'credit_note_date', p_credit_note_date, 'amount', p_amount,
    'evidence', p_storage_path, 'observation', v_observation, 'balance_before', v_available, 'balance_after', v_new_balance
  ), p_user_id);
  RETURN jsonb_build_object('charge_id', v_note_id, 'balance_before', v_available, 'balance_after', v_new_balance);
END;
$$;

REVOKE ALL ON FUNCTION mermas.register_manual_worker_credit_note(uuid, uuid, uuid, text, date, numeric, uuid, text, text, text, bigint, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.register_manual_worker_credit_note(uuid, uuid, uuid, text, date, numeric, uuid, text, text, text, bigint, text) TO service_role;

CREATE OR REPLACE FUNCTION mermas.get_worker_credit_note_context(p_company_id uuid, p_user_id uuid, p_charge_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, rrhh, mermas
AS $$
DECLARE v_charge record; v_notes jsonb;
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id) OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.account.view') THEN RAISE EXCEPTION 'No autorizado'; END IF;
  SELECT c.id, c.employee_id, c.document_number, c.amount INTO v_charge FROM rrhh.worker_account_charges c WHERE c.id = p_charge_id AND c.company_id = p_company_id AND c.source_type = 'BSALE_BOLETA';
  IF NOT FOUND THEN RAISE EXCEPTION 'Boleta no encontrada'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('charge_id', nc.id, 'number', nc.document_number, 'date', nc.document_date, 'amount', abs(nc.amount), 'observation', nc.metadata->>'observation', 'has_evidence', EXISTS (SELECT 1 FROM mermas.worker_credit_note_evidence e WHERE e.charge_id = nc.id)) ORDER BY nc.document_date, nc.id), '[]'::jsonb) INTO v_notes FROM rrhh.worker_account_charges nc WHERE nc.company_id = p_company_id AND nc.reversal_of_charge_id = v_charge.id AND nc.source_type = 'BSALE_NOTA_CREDITO' AND nc.status = 'ACTIVE';
  RETURN jsonb_build_object('original_amount', v_charge.amount, 'document_number', v_charge.document_number, 'credit_notes', v_notes);
END; $$;
REVOKE ALL ON FUNCTION mermas.get_worker_credit_note_context(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.get_worker_credit_note_context(uuid, uuid, uuid) TO service_role;
