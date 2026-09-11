-- MERMAS: terminal rejection for Bsale entries and operational archive.
ALTER TABLE mermas.movements
  DROP CONSTRAINT IF EXISTS movements_authorization_status_check;

ALTER TABLE mermas.movements
  ADD CONSTRAINT movements_authorization_status_check
  CHECK (authorization_status IN ('PENDIENTE_AUTORIZACION', 'AUTORIZADA', 'RECHAZADA'));

ALTER TABLE mermas.movements
  ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES portal.users(id),
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

CREATE INDEX IF NOT EXISTS mermas_movements_rejected_idx
  ON mermas.movements(company_id, authorization_status, rejected_at DESC);

CREATE OR REPLACE FUNCTION mermas.authorize_movement(
  p_movement_id uuid, p_company_id uuid, p_user_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, mermas
AS $$
DECLARE
  v_movement mermas.movements%ROWTYPE;
  v_evidence_count integer;
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.authorize') THEN
    RAISE EXCEPTION 'No autorizado para autorizar entradas de Mermas';
  END IF;
  SELECT * INTO v_movement
  FROM mermas.movements
  WHERE id = p_movement_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entrada no encontrada'; END IF;
  IF v_movement.authorization_status = 'AUTORIZADA' THEN
    RETURN jsonb_build_object('success', false, 'already_authorized', true);
  END IF;
  IF v_movement.authorization_status <> 'PENDIENTE_AUTORIZACION' THEN
    RAISE EXCEPTION 'La entrada está en estado terminal y no puede autorizarse';
  END IF;
  SELECT count(*)::integer INTO v_evidence_count
  FROM mermas.evidence e
  JOIN mermas.request_lines rl ON rl.id = e.request_line_id
  WHERE e.company_id = p_company_id
    AND (rl.id = v_movement.request_line_id
      OR (v_movement.request_line_id IS NULL AND e.request_id = v_movement.request_id));
  IF v_evidence_count < 1 THEN
    RAISE EXCEPTION 'La entrada no puede autorizarse sin evidencia fotográfica';
  END IF;
  UPDATE mermas.movements
  SET authorization_status = 'AUTORIZADA', authorized_by = p_user_id, authorized_at = now()
  WHERE id = p_movement_id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  VALUES ('mermas.movements', p_movement_id, 'AUTHORIZE',
    jsonb_build_object('authorization_status', 'PENDIENTE_AUTORIZACION'),
    jsonb_build_object('authorization_status', 'AUTORIZADA'), p_user_id);
  RETURN jsonb_build_object('success', true, 'status', 'AUTORIZADA');
END;
$$;

CREATE OR REPLACE FUNCTION mermas.reject_movement(
  p_movement_id uuid, p_company_id uuid, p_user_id uuid, p_reason text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, mermas
AS $$
DECLARE
  v_movement mermas.movements%ROWTYPE;
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.authorize') THEN
    RAISE EXCEPTION 'No autorizado para rechazar entradas de Mermas';
  END IF;
  IF v_reason = '' THEN RAISE EXCEPTION 'El motivo del rechazo es obligatorio'; END IF;
  SELECT * INTO v_movement
  FROM mermas.movements
  WHERE id = p_movement_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entrada no encontrada'; END IF;
  IF v_movement.authorization_status <> 'PENDIENTE_AUTORIZACION' THEN
    RAISE EXCEPTION 'La entrada está en estado terminal y no puede rechazarse nuevamente';
  END IF;
  UPDATE mermas.movements
  SET authorization_status = 'RECHAZADA', rejected_by = p_user_id,
      rejected_at = now(), rejection_reason = v_reason
  WHERE id = p_movement_id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  VALUES ('mermas.movements', p_movement_id, 'MERMA_REJECTED',
    jsonb_build_object('authorization_status', 'PENDIENTE_AUTORIZACION'),
    jsonb_build_object('authorization_status', 'RECHAZADA', 'rejection_reason', v_reason), p_user_id);
  RETURN jsonb_build_object('success', true, 'status', 'RECHAZADA');
END;
$$;

REVOKE ALL ON FUNCTION mermas.reject_movement(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.reject_movement(uuid, uuid, uuid, text) TO service_role;
