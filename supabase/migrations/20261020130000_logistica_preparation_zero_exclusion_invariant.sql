-- Invariante operacional de Preparacion:
-- prepared_quantity = 0 SIEMPRE representa una linea excluida del despacho.
--
-- Aunque un caller invoque directamente el RPC con p_excluded = false, la base
-- normaliza el resultado a:
--   prepared_quantity = 0
--   line_status = INCIDENT
--   excluded_from_dispatch = true
--   incident_type = LINE_EXCLUDED
--   required_bsale_action = REMOVE_LINE
--   expected_bsale_quantity = 0
--
-- No cambia nombre, firma, retorno, permisos ni el comportamiento para > 0.

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

COMMENT ON FUNCTION logistica.confirm_sales_order_preparation_line(uuid, uuid, numeric, text, text, boolean) IS
    'Confirma una linea de preparacion. Invariante: prepared_quantity = 0 siempre se persiste como LINE_EXCLUDED / REMOVE_LINE con excluded_from_dispatch = true, incluso si p_excluded = false.';
