-- Preparacion: control exclusivo de escritura por preparador.
--
-- Semantica:
--   assigned_user_id  = ultimo preparador responsable.
--   locked_by_user_id = preparador con control exclusivo mientras IN_PREPARATION.
--   locked_at         = momento de adquisicion del control.
--
-- El lock no expira por tiempo. Se libera solo con una transicion explicita.
-- La lectura del board permanece disponible para todos los usuarios autorizados.

-- ============================================================================
-- 1. Board: exponer el lock sin nombres (los nombres se resuelven en batch)
-- ============================================================================
CREATE OR REPLACE VIEW logistica.vw_sales_order_preparation_board AS
SELECT
    c.id AS card_id, c.company_id, c.status, c.priority, c.assigned_user_id,
    c.route_date, c.normalized_city, nv.nv_bsale_id, nv.nv_folio,
    nv.nv_emission_date, nv.nv_generation_date, nv.client_name, nv.city_raw,
    nv.municipality_raw, nv.address_raw, nv.seller_bsale_id, nv.seller_name,
    nv.total_quantity, nv.total_amount, nv.invoice_folio, nv.is_invoiced,
    c.created_at, c.updated_at, nv.net_amount, nv.tax_amount, nv.gross_amount,
    c.locked_by_user_id, c.locked_at
FROM logistica.sales_order_preparation_cards c
JOIN integraciones.vw_bsale_sales_orders_for_preparation nv
  ON c.company_id = nv.company_id AND c.bsale_nv_id = nv.nv_bsale_id
WHERE c.closed_at IS NULL
  AND c.status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT')
  AND nv.is_invoiced = false
  AND NOT EXISTS (
    SELECT 1
    FROM logistica.sales_order_preparation_exclusions e
    WHERE e.company_id = c.company_id
      AND e.bsale_nv_id = c.bsale_nv_id
      AND e.active = true
  );

ALTER VIEW logistica.vw_sales_order_preparation_board SET (security_invoker = true);

-- ============================================================================
-- 2. Confirmacion de linea: solo el owner del lock puede mutar.
--    Mantiene todas las reglas de cantidades/incidencias vigentes.
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.confirm_sales_order_preparation_line(
    p_company_id uuid,
    p_line_id uuid,
    p_prepared_quantity numeric,
    p_reason_code text DEFAULT NULL,
    p_observation text DEFAULT NULL,
    p_excluded boolean DEFAULT false
)
RETURNS logistica.sales_order_preparation_lines
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_line logistica.sales_order_preparation_lines%ROWTYPE;
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_incident_type text;
    v_is_excluded boolean;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    SELECT l.* INTO v_line FROM logistica.sales_order_preparation_lines l
      WHERE l.id = p_line_id AND l.company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Linea de preparacion no encontrada.'; END IF;
    SELECT c.* INTO v_card FROM logistica.sales_order_preparation_cards c
      WHERE c.id = v_line.card_id AND c.company_id = p_company_id FOR UPDATE;
    IF NOT FOUND OR v_card.status <> 'IN_PREPARATION' THEN
        RAISE EXCEPTION 'La tarjeta debe estar En preparacion.';
    END IF;
    IF v_card.locked_by_user_id IS NULL THEN
        RAISE EXCEPTION 'Esta preparación aún no tiene responsable. Tómala antes de continuar.';
    END IF;
    IF v_card.locked_by_user_id <> v_actor THEN
        RAISE EXCEPTION 'Esta preparación está asignada a otro usuario.';
    END IF;
    IF p_prepared_quantity IS NULL OR p_prepared_quantity < 0 OR p_prepared_quantity > v_line.requested_quantity THEN
        RAISE EXCEPTION 'La cantidad a despachar debe estar entre 0 y la cantidad solicitada.';
    END IF;
    IF p_excluded AND p_prepared_quantity <> 0 THEN
        RAISE EXCEPTION 'Una linea excluida debe quedar con cantidad 0.';
    END IF;

    -- Invariante: cantidad 0 es exclusion operacional aunque el caller no lo declare.
    v_is_excluded := COALESCE(p_excluded, false) OR p_prepared_quantity = 0;

    IF (p_prepared_quantity < v_line.requested_quantity OR v_is_excluded)
       AND (p_reason_code IS NULL OR btrim(p_reason_code) = '') THEN
        RAISE EXCEPTION 'El motivo es obligatorio para una diferencia o exclusion.';
    END IF;
    IF p_reason_code = 'OTRO' AND (p_observation IS NULL OR btrim(p_observation) = '') THEN
        RAISE EXCEPTION 'La observacion es obligatoria para el motivo OTRO.';
    END IF;
    IF p_reason_code IS NOT NULL AND p_reason_code NOT IN ('SIN_STOCK', 'STOCK_INSUFICIENTE', 'PRODUCTO_DANADO', 'PRODUCTO_VENCIDO_NO_APTO', 'ERROR_PEDIDO', 'SOLICITUD_CLIENTE', 'OTRO') THEN
        RAISE EXCEPTION 'Motivo de incidencia invalido.';
    END IF;

    UPDATE logistica.sales_order_preparation_incidents
       SET status = 'SUPERSEDED', updated_at = now()
     WHERE company_id = p_company_id AND preparation_line_id = v_line.id AND status = 'OPEN';

    IF v_is_excluded OR p_prepared_quantity < v_line.requested_quantity THEN
        v_incident_type := CASE WHEN v_is_excluded THEN 'LINE_EXCLUDED' ELSE 'QUANTITY_REDUCTION' END;
        INSERT INTO logistica.sales_order_preparation_incidents (
            company_id, card_id, preparation_line_id, bsale_nv_id, nv_folio,
            bsale_detail_id, bsale_variant_id, sku, product_name, incident_type,
            reason_code, observation, requested_quantity, prepared_quantity,
            difference_quantity, required_bsale_action, expected_bsale_quantity,
            created_by
        ) VALUES (
            p_company_id, v_line.card_id, v_line.id, v_line.bsale_nv_id, v_card.bsale_nv_folio,
            v_line.bsale_detail_id, v_line.bsale_variant_id, v_line.sku, v_line.product_name,
            v_incident_type, p_reason_code, NULLIF(btrim(p_observation), ''),
            v_line.requested_quantity, p_prepared_quantity, p_prepared_quantity - v_line.requested_quantity,
            CASE WHEN v_is_excluded THEN 'REMOVE_LINE' ELSE 'SET_QUANTITY' END,
            p_prepared_quantity, v_actor
        );
    END IF;

    UPDATE logistica.sales_order_preparation_lines
       SET prepared_quantity = p_prepared_quantity,
           line_status = CASE WHEN v_is_excluded OR p_prepared_quantity < requested_quantity THEN 'INCIDENT' ELSE 'CONFIRMED' END,
           excluded_from_dispatch = v_is_excluded,
           confirmed_by = v_actor, confirmed_at = now(), updated_at = now()
     WHERE id = v_line.id
     RETURNING * INTO v_line;
    RETURN v_line;
END;
$$;

REVOKE ALL ON FUNCTION logistica.confirm_sales_order_preparation_line(uuid, uuid, numeric, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.confirm_sales_order_preparation_line(uuid, uuid, numeric, text, text, boolean) TO authenticated, service_role;

-- ============================================================================
-- 3. Movimiento de tarjeta: adquiere/valida/libera lock atomicamente.
-- ============================================================================
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
BEGIN
  SELECT * INTO v_card FROM logistica.sales_order_preparation_cards WHERE id = p_card_id FOR UPDATE;
  IF NOT FOUND OR v_card.company_id <> p_company_id THEN RAISE EXCEPTION 'Tarjeta no encontrada o empresa invalida.'; END IF;
  v_from_status := v_card.status;

  -- Carrera Pending -> Preparacion: el segundo usuario encuentra la tarjeta ya
  -- en IN_PREPARATION y recibe un error operacional claro.
  IF v_from_status = 'IN_PREPARATION' AND p_to_status = 'IN_PREPARATION' THEN
    RAISE EXCEPTION 'Esta Nota de Venta ya fue tomada por otro preparador.';
  END IF;

  IF v_from_status = 'PENDING_ROUTE_PREP' AND p_to_status <> 'IN_PREPARATION' THEN RAISE EXCEPTION 'Desde Pendiente solo se puede pasar a En Preparacion.'; END IF;
  IF v_from_status = 'IN_PREPARATION' AND p_to_status NOT IN ('IN_AUDIT', 'PENDING_ROUTE_PREP') THEN RAISE EXCEPTION 'Transicion invalida desde En Preparacion.'; END IF;
  IF v_from_status = 'IN_AUDIT' AND p_to_status NOT IN ('IN_PREPARATION', 'PENDING_ROUTE_PREP') THEN RAISE EXCEPTION 'Transicion invalida desde Auditoria.'; END IF;

  IF p_to_status = v_from_status THEN RAISE EXCEPTION 'La tarjeta ya se encuentra en el estado indicado.'; END IF;

  -- Mientras esta En preparacion, solo el owner del lock puede moverla.
  IF v_from_status = 'IN_PREPARATION' THEN
    IF v_card.locked_by_user_id IS NULL THEN
      RAISE EXCEPTION 'Esta preparación aún no tiene responsable. Tómala antes de moverla.';
    END IF;
    IF v_card.locked_by_user_id <> p_user_id THEN
      RAISE EXCEPTION 'Esta preparación está asignada a otro usuario.';
    END IF;
  END IF;

  IF p_to_status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION') AND v_from_status = 'IN_AUDIT' OR p_to_status = 'PENDING_ROUTE_PREP' THEN
    IF p_observation IS NULL OR btrim(p_observation) = '' THEN RAISE EXCEPTION 'Se requiere observacion para retroceder.'; END IF;
  END IF;

  IF p_to_status = 'IN_PREPARATION' THEN
    PERFORM logistica.materialize_sales_order_preparation_snapshot(p_company_id, p_card_id);
  ELSIF p_to_status = 'IN_AUDIT' THEN
    PERFORM logistica.materialize_sales_order_preparation_snapshot(p_company_id, p_card_id);
    SELECT count(*) INTO v_pending FROM logistica.sales_order_preparation_lines
      WHERE company_id = p_company_id AND card_id = p_card_id
        AND (line_status = 'PENDING' OR prepared_quantity IS NULL);
    IF v_pending > 0 THEN RAISE EXCEPTION 'Faltan % productos por confirmar.', v_pending; END IF;
  END IF;

  INSERT INTO logistica.sales_order_preparation_movements (
    company_id, card_id, from_status, to_status, moved_by, movement_source, observation, metadata
  ) VALUES (p_company_id, p_card_id, v_from_status, p_to_status, p_user_id, 'USER', p_observation,
    jsonb_build_object(
      'moved_by_name', p_user_name,
      'lock_acquired', p_to_status = 'IN_PREPARATION',
      'lock_released', v_from_status = 'IN_PREPARATION' AND p_to_status IN ('IN_AUDIT', 'PENDING_ROUTE_PREP')
    ));

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

  SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '') INTO v_assigned_user_name
    FROM portal.users u WHERE u.id = v_card.assigned_user_id;
  SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '') INTO v_locked_by_user_name
    FROM portal.users u WHERE u.id = v_card.locked_by_user_id;

  RETURN jsonb_build_object(
    'card_id', p_card_id,
    'from_status', v_from_status,
    'to_status', p_to_status,
    'assigned_user_id', v_card.assigned_user_id,
    'assigned_user_name', v_assigned_user_name,
    'locked_by_user_id', v_card.locked_by_user_id,
    'locked_by_user_name', v_locked_by_user_name,
    'locked_at', v_card.locked_at
  );
END;
$$;

REVOKE ALL ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) TO service_role;

-- ============================================================================
-- 4. Toma explicita: claim legacy sin responsable o takeover autorizado.
--    Usa auth.uid(); no acepta identidad ni permisos desde el cliente.
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.take_sales_order_preparation_card(
  p_company_id uuid,
  p_card_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = logistica, public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_card logistica.sales_order_preparation_cards%ROWTYPE;
  v_previous_user_id uuid;
  v_previous_user_name text;
  v_actor_name text;
  v_event text;
  v_source text;
BEGIN
  IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
    RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
  END IF;

  SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
   WHERE id = p_card_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tarjeta no encontrada.'; END IF;
  IF v_card.status <> 'IN_PREPARATION' THEN
    RAISE EXCEPTION 'Solo se puede tomar una tarjeta En preparación.';
  END IF;

  IF v_card.locked_by_user_id = v_actor THEN
    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '') INTO v_actor_name
      FROM portal.users u WHERE u.id = v_actor;
    RETURN jsonb_build_object(
      'card_id', p_card_id,
      'assigned_user_id', v_card.assigned_user_id,
      'assigned_user_name', v_actor_name,
      'locked_by_user_id', v_card.locked_by_user_id,
      'locked_by_user_name', v_actor_name,
      'locked_at', v_card.locked_at,
      'event', 'PREPARATION_LOCK_ALREADY_OWNED'
    );
  END IF;

  IF v_card.locked_by_user_id IS NULL THEN
    IF NOT portal.has_permission('logistica.preparation.manage') THEN
      RAISE EXCEPTION 'No tienes permiso para tomar esta preparación.';
    END IF;
    v_event := 'PREPARATION_LOCK_CLAIM';
    v_source := 'USER';
  ELSE
    IF NOT portal.has_permission('logistica.preparation.authorize_exception') THEN
      RAISE EXCEPTION 'No tienes permiso para tomar la preparación de otro usuario.';
    END IF;
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
      RAISE EXCEPTION 'El motivo es obligatorio para tomar la preparación de otro usuario.';
    END IF;
    v_previous_user_id := v_card.locked_by_user_id;
    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '') INTO v_previous_user_name
      FROM portal.users u WHERE u.id = v_previous_user_id;
    v_event := 'PREPARATION_LOCK_TAKEOVER';
    v_source := 'ADMIN';
  END IF;

  SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '') INTO v_actor_name
    FROM portal.users u WHERE u.id = v_actor;

  UPDATE logistica.sales_order_preparation_cards
     SET assigned_user_id = v_actor,
         locked_by_user_id = v_actor,
         locked_at = now(),
         last_moved_by = v_actor,
         last_moved_at = now(),
         updated_at = now()
   WHERE id = p_card_id
   RETURNING * INTO v_card;

  INSERT INTO logistica.sales_order_preparation_movements (
    company_id, card_id, from_status, to_status, moved_by, movement_source, observation, metadata
  ) VALUES (
    p_company_id, p_card_id, 'IN_PREPARATION', 'IN_PREPARATION', v_actor, v_source,
    NULLIF(btrim(p_reason), ''),
    jsonb_build_object(
      'event', v_event,
      'previous_user_id', v_previous_user_id,
      'new_user_id', v_actor,
      'previous_user_name', v_previous_user_name,
      'new_user_name', v_actor_name,
      'reason', NULLIF(btrim(p_reason), '')
    )
  );

  RETURN jsonb_build_object(
    'card_id', p_card_id,
    'assigned_user_id', v_card.assigned_user_id,
    'assigned_user_name', v_actor_name,
    'locked_by_user_id', v_card.locked_by_user_id,
    'locked_by_user_name', v_actor_name,
    'locked_at', v_card.locked_at,
    'event', v_event
  );
END;
$$;

REVOKE ALL ON FUNCTION logistica.take_sales_order_preparation_card(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.take_sales_order_preparation_card(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION logistica.take_sales_order_preparation_card(uuid, uuid, text) IS
  'Toma o retoma el control exclusivo de una tarjeta IN_PREPARATION. Claim legacy requiere manage; takeover de otro usuario requiere authorize_exception y motivo obligatorio. Registra movement PREPARATION_LOCK_CLAIM o PREPARATION_LOCK_TAKEOVER.';
