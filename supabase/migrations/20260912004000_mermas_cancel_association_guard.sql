-- MERMAS: an associated Bsale consumption cannot be cancelled.

CREATE OR REPLACE FUNCTION mermas.cancel_request(
  p_request_id uuid,
  p_company_id uuid,
  p_user_id uuid,
  p_reason text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, mermas
AS $$
DECLARE
  v_request mermas.requests%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Usuario inválido';
  END IF;
  IF NOT core.has_company_access(p_user_id, p_company_id) THEN
    RAISE EXCEPTION 'El usuario no tiene acceso a la empresa activa';
  END IF;
  IF NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.cancel') THEN
    RAISE EXCEPTION 'No autorizado para cancelar solicitudes de Merma';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'El motivo de cancelación es obligatorio';
  END IF;

  SELECT * INTO v_request
  FROM mermas.requests
  WHERE id = p_request_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud no encontrada'; END IF;
  IF v_request.status <> 'PENDIENTE' THEN
    RAISE EXCEPTION 'Solo se pueden cancelar solicitudes PENDIENTE';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mermas.bsale_consumptions
    WHERE company_id = p_company_id AND request_id = p_request_id
  ) OR EXISTS (
    SELECT 1
    FROM mermas.bsale_detail_allocations
    WHERE company_id = p_company_id AND request_id = p_request_id
  ) THEN
    RAISE EXCEPTION 'La solicitud no puede cancelarse porque ya existe un consumo Bsale asociado.';
  END IF;

  UPDATE mermas.requests
  SET status = 'CANCELADA',
      cancellation_reason = btrim(p_reason),
      cancelled_by = p_user_id,
      cancelled_at = now(),
      updated_at = now()
  WHERE id = p_request_id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  VALUES (
    'mermas.requests',
    p_request_id,
    'CANCEL',
    jsonb_build_object('status', 'PENDIENTE'),
    jsonb_build_object('status', 'CANCELADA', 'reason', btrim(p_reason)),
    p_user_id
  );
  RETURN jsonb_build_object('success', true, 'status', 'CANCELADA');
END;
$$;

REVOKE ALL ON FUNCTION mermas.cancel_request(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.cancel_request(uuid, uuid, uuid, text) TO service_role;
