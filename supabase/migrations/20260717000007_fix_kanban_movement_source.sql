-- ============================================================================
-- Migración: Fix Kanban Movement Source
-- Fecha: 2026-07-17
-- Objetivo:
--   1. Cambiar movement_source a 'USER' para cumplir con la constraint
--      sales_order_preparation_movements_movement_source_check.
--   2. Mantener toda la seguridad y hardening de 000006.
-- ============================================================================

CREATE OR REPLACE FUNCTION logistica.move_sales_order_preparation_card(
  p_company_id    uuid,
  p_card_id       uuid,
  p_to_status     text,
  p_observation   text,
  p_user_id       uuid,
  p_user_name     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
  v_card        record;
  v_from_status text;
  v_is_backward boolean := false;
BEGIN
  IF p_company_id IS NULL OR p_card_id IS NULL OR p_user_id IS NULL OR p_to_status IS NULL THEN
    RAISE EXCEPTION 'Parámetros obligatorios faltantes.';
  END IF;

  SELECT *
  INTO v_card
  FROM logistica.sales_order_preparation_cards
  WHERE id = p_card_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tarjeta no encontrada: %', p_card_id;
  END IF;

  IF v_card.company_id <> p_company_id THEN
    RAISE EXCEPTION 'La tarjeta % no pertenece a la compañía %.', p_card_id, p_company_id;
  END IF;

  v_from_status := v_card.status;

  IF v_from_status = 'INVOICED_READY_FOR_ROUTE' THEN
    RAISE EXCEPTION 'No se permiten movimientos manuales desde el estado INVOICED_READY_FOR_ROUTE.';
  END IF;

  IF v_from_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'No se permiten movimientos manuales desde el estado CANCELLED.';
  END IF;

  IF p_to_status = 'INVOICED_READY_FOR_ROUTE' THEN
    RAISE EXCEPTION 'No se puede mover manualmente a INVOICED_READY_FOR_ROUTE. Es un estado automático.';
  END IF;

  IF p_to_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'No se puede mover manualmente a CANCELLED por ahora.';
  END IF;

  IF v_from_status = p_to_status THEN
    RAISE EXCEPTION 'La tarjeta ya se encuentra en el estado %.', p_to_status;
  END IF;

  IF v_from_status = 'PENDING_ROUTE_PREP' AND p_to_status <> 'IN_PREPARATION' THEN
    RAISE EXCEPTION 'Desde PENDING_ROUTE_PREP solo se puede pasar a IN_PREPARATION. Destino inválido: %.', p_to_status;
  END IF;

  IF v_from_status = 'IN_PREPARATION' AND p_to_status NOT IN ('IN_AUDIT', 'PENDING_ROUTE_PREP') THEN
    RAISE EXCEPTION 'Desde IN_PREPARATION solo se puede pasar a IN_AUDIT o PENDING_ROUTE_PREP. Destino inválido: %.', p_to_status;
  END IF;

  IF v_from_status = 'IN_AUDIT' AND p_to_status NOT IN ('IN_PREPARATION', 'PENDING_ROUTE_PREP') THEN
    RAISE EXCEPTION 'Desde IN_AUDIT solo se puede devolver a IN_PREPARATION o PENDING_ROUTE_PREP. Destino inválido: %.', p_to_status;
  END IF;

  IF p_to_status = 'PENDING_ROUTE_PREP'
     OR (v_from_status = 'IN_AUDIT' AND p_to_status = 'IN_PREPARATION')
  THEN
    v_is_backward := true;
  END IF;

  IF v_is_backward = true AND (p_observation IS NULL OR trim(p_observation) = '') THEN
    RAISE EXCEPTION 'Se requiere una observación para retroceder el estado de % a %.', v_from_status, p_to_status;
  END IF;

  INSERT INTO logistica.sales_order_preparation_movements (
    id, company_id, card_id, from_status, to_status,
    moved_by, movement_source, pin_validated, observation, metadata
  ) VALUES (
    gen_random_uuid(), p_company_id, p_card_id, v_from_status, p_to_status,
    p_user_id, 'USER', false, p_observation,
    jsonb_build_object('moved_by_name', p_user_name)
  );

  UPDATE logistica.sales_order_preparation_cards
  SET
    status        = p_to_status,
    last_moved_by = p_user_id,
    last_moved_at = now(),
    updated_at    = now()
  WHERE id = p_card_id;

  RETURN jsonb_build_object(
    'card_id',     p_card_id,
    'from_status', v_from_status,
    'to_status',   p_to_status,
    'moved_at',    now(),
    'moved_by',    p_user_id,
    'observation', p_observation
  );
END;
$$;

REVOKE ALL     ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) FROM authenticated;

GRANT EXECUTE ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) TO service_role;
