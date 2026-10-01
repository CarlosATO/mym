-- Atomic claim and terminal transitions for the PetGroup -> Bsale outbound worker.

-- Confirmation stores the remote ID only. The ingestion tables are populated by
-- Bloque 3, so this technical state cannot require their row yet.
ALTER TABLE mermas.bsale_outbound_operations
  DROP CONSTRAINT IF EXISTS bsale_outbound_operations_consumption_fk;

CREATE OR REPLACE FUNCTION mermas.claim_merma_bsale_outbound_operation(
  p_operation_id uuid,
  p_company_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
  v_operation mermas.bsale_outbound_operations%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_company_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Operación outbound inválida';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM portal.users
    WHERE id = p_user_id AND is_active AND deleted_at IS NULL
  ) OR NOT core.has_company_access(p_user_id, p_company_id) THEN
    RAISE EXCEPTION 'Usuario no autorizado para reclamar outbound de Mermas';
  END IF;
  UPDATE mermas.bsale_outbound_operations
  SET status = 'SENDING', attempt_count = attempt_count + 1,
      sending_at = now(), last_error = NULL, updated_at = now()
  WHERE id = p_operation_id AND company_id = p_company_id AND status = 'PREPARED'
  RETURNING * INTO v_operation;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'operation_id', p_operation_id);
  END IF;
  RETURN jsonb_build_object('claimed', true, 'operation_id', v_operation.id,
    'company_id', v_operation.company_id, 'request_id', v_operation.request_id,
    'correlation_key', v_operation.correlation_key, 'status', v_operation.status,
    'attempt_count', v_operation.attempt_count);
END;
$$;

CREATE OR REPLACE FUNCTION mermas.finish_merma_bsale_outbound_operation(
  p_operation_id uuid,
  p_company_id uuid,
  p_status text,
  p_consumption_id bigint DEFAULT NULL,
  p_error text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
  v_operation mermas.bsale_outbound_operations%ROWTYPE;
BEGIN
  IF p_status NOT IN ('CONFIRMED', 'RECONCILIATION_REQUIRED', 'FAILED') THEN
    RAISE EXCEPTION 'Estado outbound inválido';
  END IF;
  IF p_status = 'CONFIRMED' AND p_consumption_id IS NULL THEN
    RAISE EXCEPTION 'CONFIRMED requiere consumption_id';
  END IF;
  IF p_status IN ('FAILED', 'RECONCILIATION_REQUIRED') AND NULLIF(btrim(p_error), '') IS NULL THEN
    RAISE EXCEPTION 'El estado terminal requiere un error';
  END IF;
  UPDATE mermas.bsale_outbound_operations
  SET status = p_status,
      bsale_consumption_id = CASE WHEN p_status = 'CONFIRMED' THEN p_consumption_id ELSE bsale_consumption_id END,
      last_error = CASE WHEN p_status = 'CONFIRMED' THEN NULL ELSE NULLIF(btrim(p_error), '') END,
      confirmed_at = CASE WHEN p_status = 'CONFIRMED' THEN now() ELSE confirmed_at END,
      reconciliation_required_at = CASE WHEN p_status = 'RECONCILIATION_REQUIRED' THEN now() ELSE reconciliation_required_at END,
      updated_at = now()
  WHERE id = p_operation_id AND company_id = p_company_id AND status = 'SENDING'
  RETURNING * INTO v_operation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La operación no está en estado SENDING o no existe';
  END IF;
  RETURN jsonb_build_object('operation_id', v_operation.id, 'status', v_operation.status,
    'bsale_consumption_id', v_operation.bsale_consumption_id, 'last_error', v_operation.last_error);
END;
$$;

REVOKE ALL ON FUNCTION mermas.claim_merma_bsale_outbound_operation(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.claim_merma_bsale_outbound_operation(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION mermas.finish_merma_bsale_outbound_operation(uuid, uuid, text, bigint, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.finish_merma_bsale_outbound_operation(uuid, uuid, text, bigint, text) TO service_role;
