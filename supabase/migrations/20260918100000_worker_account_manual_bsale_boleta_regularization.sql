-- Manual regularization for Bsale Boletas emitted without a client.

CREATE OR REPLACE FUNCTION mermas.regularize_worker_bsale_boleta(
  p_company_id uuid,
  p_user_id uuid,
  p_document_number integer,
  p_employee_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, rrhh, integraciones, mermas
AS $$
DECLARE
  v_document integraciones.bsale_documents%ROWTYPE;
  v_employee rrhh.employees%ROWTYPE;
  v_charge_id uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT portal.is_super_usuario(p_user_id) THEN
    RAISE EXCEPTION 'No autorizado para regularizar Boletas Bsale';
  END IF;
  IF p_document_number IS NULL OR p_document_number <= 0 THEN
    RAISE EXCEPTION 'El folio de la Boleta es inválido';
  END IF;
  IF p_employee_id IS NULL THEN
    RAISE EXCEPTION 'Debes seleccionar un trabajador';
  END IF;
  IF v_reason = '' THEN
    RAISE EXCEPTION 'El motivo es obligatorio';
  END IF;

  SELECT d.* INTO v_document
  FROM integraciones.bsale_documents d
  WHERE d.company_id = p_company_id
    AND d.number = p_document_number
    AND d.document_type_id = 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Boleta Bsale no encontrada';
  END IF;
  IF v_document.client_id IS NOT NULL THEN
    RAISE EXCEPTION 'La Boleta Bsale ya tiene cliente identificado';
  END IF;
  IF v_document.total_amount IS NULL OR v_document.total_amount <= 0 THEN
    RAISE EXCEPTION 'La Boleta Bsale no tiene un monto válido';
  END IF;
  IF EXISTS (
    SELECT 1 FROM rrhh.worker_account_charges c
    WHERE c.company_id = p_company_id
      AND c.source_type = 'BSALE_BOLETA'
      AND c.source_id = v_document.bsale_id::text
  ) THEN
    RAISE EXCEPTION 'La Boleta Bsale ya tiene un cargo de cuenta corriente';
  END IF;

  SELECT e.* INTO v_employee
  FROM rrhh.employees e
  WHERE e.id = p_employee_id AND e.estado = 'ACTIVO';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El trabajador seleccionado no está ACTIVO';
  END IF;

  INSERT INTO rrhh.worker_account_charges (
    company_id, employee_id, source_type, source_id, document_type,
    document_number, document_date, amount, status, metadata, created_by
  ) VALUES (
    p_company_id, p_employee_id, 'BSALE_BOLETA', v_document.bsale_id::text,
    'BOLETA', v_document.number::text,
    v_document.emission_date::timestamp AT TIME ZONE 'America/Santiago',
    v_document.total_amount, 'ACTIVE',
    jsonb_build_object(
      'manual_assignment', true,
      'assigned_employee_id', p_employee_id,
      'assigned_by', p_user_id,
      'reason', v_reason,
      'original_client_id', v_document.client_id,
      'document_number', v_document.number,
      'bsale_document_id', v_document.bsale_id,
      'origin', 'BSALE_MANUAL_REGULARIZATION'
    ),
    p_user_id
  )
  RETURNING id INTO v_charge_id;

  INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
  VALUES (
    'rrhh.worker_account_charges', v_charge_id, 'BSALE_MANUAL_REG',
    jsonb_build_object(
      'company_id', p_company_id,
      'charge_id', v_charge_id,
      'bsale_id', v_document.bsale_id,
      'document_number', v_document.number,
      'employee_id', p_employee_id,
      'amount', v_document.total_amount,
      'reason', v_reason,
      'origin', 'BSALE_MANUAL_REGULARIZATION'
    ),
    p_user_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'charge_id', v_charge_id,
    'bsale_id', v_document.bsale_id,
    'document_number', v_document.number,
    'employee_id', p_employee_id,
    'amount', v_document.total_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.regularize_worker_bsale_boleta(uuid, uuid, integer, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.regularize_worker_bsale_boleta(uuid, uuid, integer, uuid, text)
  TO service_role;
