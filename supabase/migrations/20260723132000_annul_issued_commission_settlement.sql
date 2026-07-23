-- Anulación de liquidaciones emitidas: conserva correlativo, libera líneas.

CREATE OR REPLACE FUNCTION comercial.annul_commission_settlement(
  p_company_id uuid,
  p_settlement_id uuid,
  p_user_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_settlement comercial.commission_settlements;
  v_has_access boolean;
  v_released_lines int;
BEGIN
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El motivo de anulación es obligatorio');
  END IF;

  SELECT core.has_company_access(p_user_id, p_company_id) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a la empresa');
  END IF;

  SELECT * INTO v_settlement
  FROM comercial.commission_settlements
  WHERE id = p_settlement_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Liquidación no encontrada');
  END IF;

  IF v_settlement.status = 'DRAFT' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Para cancelar un borrador usa la opción Cancelar en la sección Borradores');
  END IF;

  IF v_settlement.status = 'CANCELLED' THEN
    RETURN jsonb_build_object('success', false, 'error', 'La liquidación ya está anulada');
  END IF;

  IF v_settlement.source = 'HISTORICAL' OR v_settlement.settlement_code = 'HISTORICO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se puede anular la liquidación histórica');
  END IF;

  UPDATE comercial.commission_settlements
  SET status = 'CANCELLED',
      cancelled_at = now(),
      cancelled_by = p_user_id,
      cancellation_reason = p_reason,
      updated_at = now(),
      updated_by = p_user_id
  WHERE id = p_settlement_id;

  WITH released AS (
    UPDATE comercial.commission_settlement_lines
    SET eligibility_locked_at = NULL,
        updated_at = now(),
        updated_by = p_user_id
    WHERE settlement_id = p_settlement_id
      AND company_id = p_company_id
      AND line_type IN ('INVOICE', 'CREDIT_NOTE')
    RETURNING id
  )
  SELECT COUNT(*) INTO v_released_lines FROM released;

  RETURN jsonb_build_object(
    'success', true,
    'settlement_id', v_settlement.id,
    'settlement_code', v_settlement.settlement_code,
    'released_lines', v_released_lines
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION comercial.annul_commission_settlement(uuid, uuid, uuid, text) TO authenticated, service_role;
