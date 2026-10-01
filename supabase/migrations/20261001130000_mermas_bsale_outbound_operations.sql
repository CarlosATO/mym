-- MERMAS: durable state for a future Petgroup -> Bsale consumption write.
-- This migration intentionally does not call Bsale or alter the current ingest flow.

CREATE TABLE mermas.bsale_outbound_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES mermas.requests(id) ON DELETE RESTRICT,
  operation_type text NOT NULL DEFAULT 'MERMAS_CONSUMPTION'
    CHECK (operation_type = 'MERMAS_CONSUMPTION'),
  correlation_key text NOT NULL DEFAULT gen_random_uuid()::text,
  status text NOT NULL DEFAULT 'PREPARED'
    CHECK (status IN ('PREPARED', 'SENDING', 'CONFIRMED', 'RECONCILIATION_REQUIRED', 'FAILED')),
  bsale_consumption_id bigint,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  created_by uuid NOT NULL REFERENCES portal.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sending_at timestamptz,
  confirmed_at timestamptz,
  reconciliation_required_at timestamptz,
  CONSTRAINT bsale_outbound_operations_correlation_key_uq UNIQUE (correlation_key),
  CONSTRAINT bsale_outbound_operations_request_type_uq
    UNIQUE (company_id, request_id, operation_type),
  CONSTRAINT bsale_outbound_operations_consumption_uq
    UNIQUE (company_id, bsale_consumption_id),
  CONSTRAINT bsale_outbound_operations_consumption_fk
    FOREIGN KEY (company_id, bsale_consumption_id)
    REFERENCES mermas.bsale_consumptions(company_id, consumption_id),
  CONSTRAINT bsale_outbound_operations_confirmed_guard CHECK (
    status <> 'CONFIRMED'
    OR (bsale_consumption_id IS NOT NULL AND confirmed_at IS NOT NULL)
  ),
  CONSTRAINT bsale_outbound_operations_sending_guard CHECK (
    status <> 'SENDING' OR sending_at IS NOT NULL
  ),
  CONSTRAINT bsale_outbound_operations_reconciliation_guard CHECK (
    status <> 'RECONCILIATION_REQUIRED' OR reconciliation_required_at IS NOT NULL
  ),
  CONSTRAINT bsale_outbound_operations_failed_guard CHECK (
    status <> 'FAILED' OR length(btrim(COALESCE(last_error, ''))) > 0
  )
);

CREATE INDEX mermas_bsale_outbound_operations_company_status_idx
  ON mermas.bsale_outbound_operations(company_id, status, updated_at DESC);

ALTER TABLE mermas.bsale_outbound_operations ENABLE ROW LEVEL SECURITY;

-- Technical outbound state is not directly readable or writable by clients.
REVOKE ALL ON mermas.bsale_outbound_operations FROM PUBLIC, anon, authenticated;
GRANT ALL ON mermas.bsale_outbound_operations TO service_role;

CREATE OR REPLACE FUNCTION mermas.prepare_merma_bsale_outbound_operation(
  p_request_id uuid,
  p_company_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
  v_request mermas.requests%ROWTYPE;
  v_operation mermas.bsale_outbound_operations%ROWTYPE;
  v_created boolean := false;
  v_line_count integer;
BEGIN
  IF p_request_id IS NULL OR p_company_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Solicitud outbound inválida';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Usuario inválido';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM portal.users u
    WHERE u.id = p_user_id
      AND u.is_active
      AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Usuario inválido o inactivo';
  END IF;
  IF NOT core.has_company_access(p_user_id, p_company_id) THEN
    RAISE EXCEPTION 'El usuario no tiene acceso a la empresa activa';
  END IF;
  IF NOT core.has_permission_for_company(
    p_user_id, p_company_id, 'logistica.mermas.request.create'
  ) THEN
    RAISE EXCEPTION 'No autorizado para preparar el consumo Bsale de Mermas';
  END IF;

  SELECT * INTO v_request
  FROM mermas.requests
  WHERE id = p_request_id
    AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solicitud de Merma no encontrada';
  END IF;
  IF v_request.status IN ('CUMPLIDA', 'FINALIZADA', 'CANCELADA') THEN
    RAISE EXCEPTION 'La solicitud de Merma ya no está disponible para outbound';
  END IF;

  SELECT count(*)::integer INTO v_line_count
  FROM mermas.request_lines
  WHERE request_id = p_request_id
    AND company_id = p_company_id;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'La solicitud de Merma no contiene líneas';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mermas.request_lines
    WHERE request_id = p_request_id
      AND company_id = p_company_id
      AND (quantity <= 0 OR bsale_variant_id IS NULL OR bsale_variant_id <= 0)
  ) THEN
    RAISE EXCEPTION 'La solicitud contiene una línea inválida';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mermas.request_lines
    WHERE request_id = p_request_id
      AND company_id = p_company_id
      AND expiration_date IS NULL
  ) THEN
    RAISE EXCEPTION 'Todas las líneas requieren vencimiento';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mermas.request_lines rl
    WHERE rl.request_id = p_request_id
      AND rl.company_id = p_company_id
      AND NOT EXISTS (
        SELECT 1
        FROM mermas.evidence e
        WHERE e.company_id = p_company_id
          AND e.request_id = p_request_id
          AND e.request_line_id = rl.id
      )
  ) THEN
    RAISE EXCEPTION 'Todas las líneas requieren al menos una fotografía';
  END IF;

  -- The request row lock serializes callers; the unique constraint remains the
  -- database-level protection if another code path inserts this entity.
  SELECT * INTO v_operation
  FROM mermas.bsale_outbound_operations
  WHERE company_id = p_company_id
    AND request_id = p_request_id
    AND operation_type = 'MERMAS_CONSUMPTION';

  IF NOT FOUND THEN
    INSERT INTO mermas.bsale_outbound_operations (
      company_id, request_id, operation_type, status, created_by
    ) VALUES (
      p_company_id, p_request_id, 'MERMAS_CONSUMPTION', 'PREPARED', p_user_id
    )
    ON CONFLICT (company_id, request_id, operation_type) DO NOTHING
    RETURNING * INTO v_operation;
    v_created := FOUND;
  END IF;

  IF NOT FOUND AND NOT v_created THEN
    SELECT * INTO v_operation
    FROM mermas.bsale_outbound_operations
    WHERE company_id = p_company_id
      AND request_id = p_request_id
      AND operation_type = 'MERMAS_CONSUMPTION';
  END IF;

  IF v_created THEN
    INSERT INTO portal.audit_logs (
      table_name, record_id, action, new_data, performed_by
    ) VALUES (
      'mermas.bsale_outbound_operations',
      v_operation.id,
      'OUTBOUND_PREPARED',
      jsonb_build_object(
        'operation_id', v_operation.id,
        'request_id', p_request_id,
        'company_id', p_company_id,
        'operation_type', v_operation.operation_type,
        'correlation_key', v_operation.correlation_key,
        'status', v_operation.status,
        'performed_by', p_user_id
      ),
      p_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'created', v_created,
    'operation_id', v_operation.id,
    'company_id', v_operation.company_id,
    'request_id', v_operation.request_id,
    'operation_type', v_operation.operation_type,
    'correlation_key', v_operation.correlation_key,
    'status', v_operation.status,
    'bsale_consumption_id', v_operation.bsale_consumption_id,
    'attempt_count', v_operation.attempt_count,
    'last_error', v_operation.last_error,
    'created_by', v_operation.created_by,
    'created_at', v_operation.created_at,
    'updated_at', v_operation.updated_at,
    'sending_at', v_operation.sending_at,
    'confirmed_at', v_operation.confirmed_at,
    'reconciliation_required_at', v_operation.reconciliation_required_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION mermas.get_merma_bsale_outbound_operation(
  p_request_id uuid,
  p_company_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
  v_operation mermas.bsale_outbound_operations%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_company_id IS NULL OR p_user_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM portal.users u
       WHERE u.id = p_user_id AND u.is_active AND u.deleted_at IS NULL
     )
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.view') THEN
    RAISE EXCEPTION 'No autorizado para consultar outbound de Mermas';
  END IF;

  SELECT * INTO v_operation
  FROM mermas.bsale_outbound_operations
  WHERE request_id = p_request_id
    AND company_id = p_company_id
    AND operation_type = 'MERMAS_CONSUMPTION';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false, 'request_id', p_request_id);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'operation_id', v_operation.id,
    'company_id', v_operation.company_id,
    'request_id', v_operation.request_id,
    'operation_type', v_operation.operation_type,
    'correlation_key', v_operation.correlation_key,
    'status', v_operation.status,
    'bsale_consumption_id', v_operation.bsale_consumption_id,
    'attempt_count', v_operation.attempt_count,
    'last_error', v_operation.last_error,
    'created_by', v_operation.created_by,
    'created_at', v_operation.created_at,
    'updated_at', v_operation.updated_at,
    'sending_at', v_operation.sending_at,
    'confirmed_at', v_operation.confirmed_at,
    'reconciliation_required_at', v_operation.reconciliation_required_at
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.prepare_merma_bsale_outbound_operation(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.prepare_merma_bsale_outbound_operation(uuid, uuid, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION mermas.get_merma_bsale_outbound_operation(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.get_merma_bsale_outbound_operation(uuid, uuid, uuid)
  TO service_role;
