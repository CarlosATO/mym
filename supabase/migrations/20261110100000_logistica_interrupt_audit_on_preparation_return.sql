-- Auditoria: invalidar el ciclo operativo al volver a Preparacion.
--
-- El ciclo interrumpido permanece consultable como CLOSED. Sus incidencias no
-- siguen activas porque pertenecen a un snapshot que ya no representa la
-- preparacion vigente; el audit_id conserva la trazabilidad historica.

BEGIN;
-- CLOSED es el estado historico de una sesion interrumpida. COMPLETED mantiene
-- la semantica de una auditoria finalizada por finalize_sales_order_audit.
ALTER TABLE logistica.sales_order_audits
  DROP CONSTRAINT IF EXISTS sales_order_audits_status_check;
ALTER TABLE logistica.sales_order_audits
  DROP CONSTRAINT IF EXISTS sales_order_audits_completed_consistency;
ALTER TABLE logistica.sales_order_audits
  ADD CONSTRAINT sales_order_audits_status_check
    CHECK (status IN ('OPEN', 'CLOSED', 'COMPLETED')),
  ADD CONSTRAINT sales_order_audits_completed_consistency CHECK (
    (status = 'OPEN' AND completed_at IS NULL)
    OR (status IN ('CLOSED', 'COMPLETED') AND completed_at IS NOT NULL)
  );
CREATE OR REPLACE FUNCTION logistica.move_sales_order_preparation_card(
  p_company_id uuid, p_card_id uuid, p_to_status text, p_observation text,
  p_user_id uuid, p_user_name text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = logistica, public AS $$
DECLARE
  v_card logistica.sales_order_preparation_cards%ROWTYPE;
  v_from_status text;
  v_pending integer;
  v_assigned_user_name text;
  v_locked_by_user_name text;
  v_interrupted_audit_id uuid;
  v_interrupted_at timestamptz := now();
BEGIN
  SELECT * INTO v_card
  FROM logistica.sales_order_preparation_cards
  WHERE id = p_card_id
  FOR UPDATE;
  IF NOT FOUND OR v_card.company_id <> p_company_id THEN
    RAISE EXCEPTION 'Tarjeta no encontrada o empresa invalida.';
  END IF;
  v_from_status := v_card.status;

  IF p_to_status = 'AUDITED' THEN
    RAISE EXCEPTION 'El estado Auditada sólo se obtiene finalizando la Auditoría.';
  END IF;
  IF v_from_status = 'AUDITED' THEN
    RAISE EXCEPTION 'Una Nota de Venta Auditada es terminal y no puede moverse manualmente.';
  END IF;
  IF v_from_status = 'IN_PREPARATION' AND p_to_status = 'IN_PREPARATION' THEN
    RAISE EXCEPTION 'Esta Nota de Venta ya fue tomada por otro preparador.';
  END IF;

  IF v_from_status = 'PENDING_ROUTE_PREP' AND p_to_status <> 'IN_PREPARATION' THEN
    RAISE EXCEPTION 'Desde Pendiente solo se puede pasar a En Preparacion.';
  END IF;
  IF v_from_status = 'IN_PREPARATION' AND p_to_status NOT IN ('IN_AUDIT', 'PENDING_ROUTE_PREP') THEN
    RAISE EXCEPTION 'Transicion invalida desde En Preparacion.';
  END IF;
  IF v_from_status = 'IN_AUDIT' AND p_to_status NOT IN ('IN_PREPARATION', 'PENDING_ROUTE_PREP') THEN
    RAISE EXCEPTION 'Transicion invalida desde Auditoria.';
  END IF;
  IF p_to_status = v_from_status THEN
    RAISE EXCEPTION 'La tarjeta ya se encuentra en el estado indicado.';
  END IF;

  IF v_from_status = 'IN_PREPARATION' THEN
    IF v_card.locked_by_user_id IS NULL THEN
      RAISE EXCEPTION 'Esta preparación aún no tiene responsable. Tómala antes de moverla.';
    END IF;
    IF v_card.locked_by_user_id <> p_user_id THEN
      RAISE EXCEPTION 'Esta preparación está asignada a otro usuario.';
    END IF;
  END IF;

  IF (p_to_status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION') AND v_from_status = 'IN_AUDIT')
     OR p_to_status = 'PENDING_ROUTE_PREP' THEN
    IF p_observation IS NULL OR btrim(p_observation) = '' THEN
      RAISE EXCEPTION 'Se requiere observacion para retroceder.';
    END IF;
  END IF;

  -- El snapshot OPEN deja de ser operativo antes de que la tarjeta vuelva a
  -- Preparacion. La siguiente toma calculara max(cycle_no) + 1.
  IF v_from_status = 'IN_AUDIT' AND p_to_status IN ('IN_PREPARATION', 'PENDING_ROUTE_PREP') THEN
    SELECT id INTO v_interrupted_audit_id
    FROM logistica.sales_order_audits
    WHERE company_id = p_company_id
      AND card_id = p_card_id
      AND status = 'OPEN'
    ORDER BY cycle_no DESC
    LIMIT 1
    FOR UPDATE;

    IF v_interrupted_audit_id IS NOT NULL THEN
      UPDATE logistica.sales_order_audits
         SET status = 'CLOSED',
             completed_at = v_interrupted_at,
             locked_by_user_id = NULL,
             locked_at = NULL,
             updated_at = v_interrupted_at
       WHERE id = v_interrupted_audit_id;

      UPDATE logistica.sales_order_audit_incidents
         SET status = 'SUPERSEDED',
             metadata = metadata || jsonb_build_object(
               'superseded_reason', 'AUDIT_INTERRUPTED_RETURN_TO_PREPARATION',
               'superseded_at', v_interrupted_at,
               'superseded_by', p_user_id
             ),
             updated_at = v_interrupted_at
       WHERE company_id = p_company_id
         AND audit_id = v_interrupted_audit_id
         AND status = 'OPEN';
    END IF;
  END IF;

  IF p_to_status = 'IN_PREPARATION' THEN
    PERFORM logistica.materialize_sales_order_preparation_snapshot(p_company_id, p_card_id);
  ELSIF p_to_status = 'IN_AUDIT' THEN
    PERFORM logistica.materialize_sales_order_preparation_snapshot(p_company_id, p_card_id);
    SELECT count(*) INTO v_pending
    FROM logistica.sales_order_preparation_lines
    WHERE company_id = p_company_id AND card_id = p_card_id
      AND (line_status = 'PENDING' OR prepared_quantity IS NULL);
    IF v_pending > 0 THEN
      RAISE EXCEPTION 'Faltan % productos por confirmar.', v_pending;
    END IF;
  END IF;

  INSERT INTO logistica.sales_order_preparation_movements (
    company_id, card_id, from_status, to_status, moved_by, movement_source,
    observation, metadata
  ) VALUES (
    p_company_id, p_card_id, v_from_status, p_to_status, p_user_id, 'USER',
    p_observation,
    jsonb_build_object(
      'moved_by_name', p_user_name,
      'lock_acquired', p_to_status = 'IN_PREPARATION',
      'lock_released', v_from_status = 'IN_PREPARATION'
        AND p_to_status IN ('IN_AUDIT', 'PENDING_ROUTE_PREP'),
      'interrupted_audit_id', v_interrupted_audit_id
    )
  );

  UPDATE logistica.sales_order_preparation_cards
     SET status = p_to_status,
         assigned_user_id = CASE
           WHEN p_to_status IN ('IN_PREPARATION', 'IN_AUDIT') THEN p_user_id
           ELSE assigned_user_id
         END,
         locked_by_user_id = CASE WHEN p_to_status = 'IN_PREPARATION' THEN p_user_id ELSE NULL END,
         locked_at = CASE WHEN p_to_status = 'IN_PREPARATION' THEN now() ELSE NULL END,
         last_moved_by = p_user_id,
         last_moved_at = now(),
         updated_at = now()
   WHERE id = p_card_id
   RETURNING * INTO v_card;

  SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
    INTO v_assigned_user_name FROM portal.users u WHERE u.id = v_card.assigned_user_id;
  SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
    INTO v_locked_by_user_name FROM portal.users u WHERE u.id = v_card.locked_by_user_id;

  RETURN jsonb_build_object(
    'card_id', p_card_id,
    'from_status', v_from_status,
    'to_status', p_to_status,
    'assigned_user_id', v_card.assigned_user_id,
    'assigned_user_name', v_assigned_user_name,
    'locked_by_user_id', v_card.locked_by_user_id,
    'locked_by_user_name', v_locked_by_user_name,
    'locked_at', v_card.locked_at,
    'interrupted_audit_id', v_interrupted_audit_id
  );
END;
$$;
REVOKE ALL ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text)
  TO service_role;
COMMIT;