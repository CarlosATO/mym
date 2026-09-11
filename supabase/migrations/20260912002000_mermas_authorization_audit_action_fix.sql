-- MERMAS: keep authorization audit actions within portal.audit_logs.action limits.

CREATE OR REPLACE FUNCTION mermas.authorize_request_with_consumption(
  p_request_id uuid, p_consumption_id bigint, p_company_id uuid, p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
  v_request mermas.requests%ROWTYPE;
  v_consumption mermas.bsale_consumptions%ROWTYPE;
  v_detail record;
  v_line record;
  v_allocation_id uuid;
  v_has_evidence boolean;
  v_mismatch boolean;
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.authorize') THEN
    RAISE EXCEPTION 'No autorizado para autorizar ingresos de Mermas';
  END IF;
  SELECT * INTO v_request FROM mermas.requests
    WHERE id = p_request_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud no encontrada'; END IF;
  IF v_request.status <> 'PENDIENTE' THEN RAISE EXCEPTION 'La solicitud ya no está pendiente'; END IF;

  SELECT bool_and(EXISTS (
    SELECT 1 FROM mermas.evidence e WHERE e.company_id = p_company_id AND e.request_line_id = rl.id
  )) INTO v_has_evidence
  FROM mermas.request_lines rl WHERE rl.request_id = p_request_id;
  IF NOT COALESCE(v_has_evidence, false) THEN RAISE EXCEPTION 'Todas las líneas requieren evidencia fotográfica'; END IF;
  IF EXISTS (SELECT 1 FROM mermas.request_lines WHERE request_id = p_request_id AND expiration_date IS NULL) THEN
    RAISE EXCEPTION 'Todas las líneas requieren vencimiento';
  END IF;

  SELECT * INTO v_consumption FROM mermas.bsale_consumptions
    WHERE company_id = p_company_id AND consumption_id = p_consumption_id FOR UPDATE;
  IF NOT FOUND OR v_consumption.consumption_type_id <> 2 THEN
    RAISE EXCEPTION 'El consumo Bsale no es una Merma válida';
  END IF;
  IF v_consumption.request_id IS NOT NULL AND v_consumption.request_id <> p_request_id THEN
    RAISE EXCEPTION 'El consumo Bsale ya está asociado a otra solicitud';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mermas.bsale_detail_allocations a
    JOIN mermas.bsale_consumption_details d ON d.id = a.consumption_detail_id
    WHERE d.company_id = p_company_id AND d.consumption_id = p_consumption_id
      AND a.request_id IS DISTINCT FROM p_request_id
  ) THEN
    RAISE EXCEPTION 'Un detalle Bsale ya está asociado a otra solicitud';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT bsale_variant_id AS variant_id, sum(quantity) AS qty
      FROM mermas.request_lines WHERE request_id = p_request_id GROUP BY bsale_variant_id
    ) rq FULL JOIN (
      SELECT variant_id, sum(quantity) AS qty
      FROM mermas.bsale_consumption_details
      WHERE company_id = p_company_id AND consumption_id = p_consumption_id GROUP BY variant_id
    ) bs USING (variant_id)
    WHERE COALESCE(rq.qty, 0) <> COALESCE(bs.qty, 0)
  ) INTO v_mismatch;
  IF v_mismatch THEN RAISE EXCEPTION 'Los productos y cantidades no coinciden con el consumo Bsale'; END IF;

  FOR v_detail IN
    SELECT d.* FROM mermas.bsale_consumption_details d
    WHERE d.company_id = p_company_id AND d.consumption_id = p_consumption_id
    ORDER BY d.detail_id
  LOOP
    SELECT rl.* INTO v_line FROM mermas.request_lines rl
    WHERE rl.request_id = p_request_id AND rl.bsale_variant_id = v_detail.variant_id
      AND v_detail.quantity <= rl.quantity - COALESCE((
        SELECT sum(a.quantity) FROM mermas.bsale_detail_allocations a WHERE a.request_line_id = rl.id
      ), 0)
    ORDER BY rl.created_at, rl.id LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'No se pudo asignar el detalle Bsale % a una línea', v_detail.detail_id; END IF;

    INSERT INTO mermas.bsale_detail_allocations(
      company_id, consumption_detail_id, request_line_id, request_id,
      quantity, expiration_date, lot
    ) VALUES (
      p_company_id, v_detail.id, v_line.id, p_request_id,
      v_detail.quantity, v_line.expiration_date, v_line.lot
    ) RETURNING id INTO v_allocation_id;

    INSERT INTO mermas.movements(
      company_id, movement_type, variant_id, quantity, expiration_date, lot,
      consumption_id, detail_id, allocation_id, request_id, request_line_id,
      source, authorization_status, authorized_by, authorized_at
    ) VALUES (
      p_company_id, 'ENTRADA_BSALE', v_detail.variant_id, v_detail.quantity,
      v_line.expiration_date, v_line.lot, p_consumption_id, v_detail.detail_id,
      v_allocation_id, p_request_id, v_line.id, 'BSALE', 'AUTORIZADA', p_user_id, now()
    );
  END LOOP;

  UPDATE mermas.bsale_consumptions
  SET request_id = p_request_id, match_method = 'MANUAL_AUTHORIZATION', processed_at = now()
  WHERE company_id = p_company_id AND consumption_id = p_consumption_id;
  UPDATE mermas.requests SET status = 'FINALIZADA', updated_at = now()
  WHERE id = p_request_id;
  INSERT INTO portal.audit_logs(table_name, record_id, action, old_data, new_data, performed_by)
  VALUES ('mermas.requests', p_request_id, 'MERMAS_AUTH',
    jsonb_build_object('status', v_request.status),
    jsonb_build_object('status', 'FINALIZADA', 'consumption_id', p_consumption_id), p_user_id);
  RETURN jsonb_build_object('success', true, 'status', 'FINALIZADA', 'consumption_id', p_consumption_id);
END;
$$;

REVOKE ALL ON FUNCTION mermas.authorize_request_with_consumption(uuid, bigint, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.authorize_request_with_consumption(uuid, bigint, uuid, uuid) TO service_role;
