-- ============================================================================
-- Migración: Movimientos de Tarjetas (Kanban)
-- Fecha: 2026-07-17
-- ============================================================================

CREATE OR REPLACE FUNCTION logistica.move_sales_order_preparation_card(
  p_company_id uuid,
  p_card_id uuid,
  p_to_status text,
  p_observation text,
  p_user_id uuid,
  p_user_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_card record;
  v_from_status text;
  v_is_backward boolean := false;
  v_result jsonb;
BEGIN
  -- Validaciones básicas
  IF p_company_id IS NULL OR p_card_id IS NULL OR p_user_id IS NULL OR p_to_status IS NULL THEN
    RAISE EXCEPTION 'Parámetros obligatorios faltantes.';
  END IF;

  -- Bloqueo transaccional
  SELECT *
  INTO v_card
  FROM logistica.sales_order_preparation_cards
  WHERE id = p_card_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tarjeta no encontrada.';
  END IF;

  IF v_card.company_id <> p_company_id THEN
    RAISE EXCEPTION 'La tarjeta no pertenece a la compañía.';
  END IF;

  v_from_status := v_card.status;

  -- Reglas de estado de origen a destino permitidos
  IF v_from_status = 'INVOICED_READY_FOR_ROUTE' THEN
    RAISE EXCEPTION 'No se permiten movimientos manuales desde Facturada / Lista.';
  END IF;

  IF v_from_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'No se permiten movimientos manuales desde Canceladas.';
  END IF;

  IF p_to_status = 'INVOICED_READY_FOR_ROUTE' THEN
    RAISE EXCEPTION 'No se permite mover manualmente a Facturada / Lista.';
  END IF;

  IF p_to_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'No se permite mover manualmente a Canceladas por ahora.';
  END IF;

  -- Validar Transición
  IF v_from_status = 'PENDING_ROUTE_PREP' AND p_to_status <> 'IN_PREPARATION' THEN
    RAISE EXCEPTION 'Desde Pendiente solo se puede pasar a En Preparación.';
  END IF;

  IF v_from_status = 'IN_PREPARATION' AND p_to_status NOT IN ('IN_AUDIT', 'PENDING_ROUTE_PREP') THEN
    RAISE EXCEPTION 'Desde En Preparación solo se puede pasar a En Auditoría o volver a Pendiente.';
  END IF;

  IF v_from_status = 'IN_AUDIT' AND p_to_status NOT IN ('IN_PREPARATION', 'PENDING_ROUTE_PREP') THEN
    RAISE EXCEPTION 'Desde En Auditoría solo se puede devolver a En Preparación o volver a Pendiente.';
  END IF;

  -- Si son el mismo estado, no hacer nada
  IF v_from_status = p_to_status THEN
    RAISE EXCEPTION 'La tarjeta ya se encuentra en el estado %', p_to_status;
  END IF;

  -- Validar retrocesos
  IF p_to_status = 'PENDING_ROUTE_PREP' OR (v_from_status = 'IN_AUDIT' AND p_to_status = 'IN_PREPARATION') THEN
    v_is_backward := true;
  END IF;

  IF v_is_backward = true AND (p_observation IS NULL OR trim(p_observation) = '') THEN
    RAISE EXCEPTION 'Se requiere una observación obligatoria para retroceder el estado.';
  END IF;

  -- 1. Insertar Movimiento
  INSERT INTO logistica.sales_order_preparation_movements (
    id,
    company_id,
    card_id,
    from_status,
    to_status,
    moved_by,
    movement_source,
    pin_validated,
    observation,
    metadata
  ) VALUES (
    gen_random_uuid(),
    p_company_id,
    p_card_id,
    v_from_status,
    p_to_status,
    p_user_id,
    'UI_KANBAN',
    false,
    p_observation,
    jsonb_build_object('moved_by_name', p_user_name)
  );

  -- 2. Actualizar Tarjeta
  UPDATE logistica.sales_order_preparation_cards
  SET 
    status = p_to_status,
    last_moved_by = p_user_id,
    last_moved_at = now(),
    updated_at = now()
  WHERE id = p_card_id;

  -- Preparar retorno
  v_result := jsonb_build_object(
    'card_id', p_card_id,
    'from_status', v_from_status,
    'to_status', p_to_status,
    'moved_at', now(),
    'moved_by', p_user_id,
    'observation', p_observation
  );

  RETURN v_result;
END;
$$;

-- Permisos
GRANT EXECUTE ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) TO authenticated, service_role;
