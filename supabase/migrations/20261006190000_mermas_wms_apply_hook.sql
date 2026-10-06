-- Apply the WMS OUT in the same transaction that marks a confirmed outbound locally.

CREATE OR REPLACE FUNCTION mermas.apply_wms_after_outbound_local()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, mermas
AS $$
BEGIN
  IF NEW.local_applied_at IS NOT NULL AND OLD.local_applied_at IS NULL THEN
    PERFORM mermas.apply_wms_allocations(NEW.request_id, NEW.company_id, NEW.created_by);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mermas_apply_wms_after_local ON mermas.bsale_outbound_operations;
CREATE TRIGGER mermas_apply_wms_after_local
AFTER UPDATE OF local_applied_at ON mermas.bsale_outbound_operations
FOR EACH ROW EXECUTE FUNCTION mermas.apply_wms_after_outbound_local();

REVOKE ALL ON FUNCTION mermas.apply_wms_after_outbound_local() FROM PUBLIC, anon, authenticated;

-- Controlled repair entry point for a confirmed outbound created before WMS allocation existed.
CREATE OR REPLACE FUNCTION mermas.repair_wms_allocation(
  p_request_id uuid,
  p_company_id uuid,
  p_user_id uuid,
  p_source_receipt_item_id uuid,
  p_quantity numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, adquisiciones, logistica, mermas
AS $$
DECLARE
  v_line record;
  v_source record;
  v_existing numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM portal.users
    WHERE id = p_user_id AND is_active AND deleted_at IS NULL
  ) OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.request.create') THEN
    RAISE EXCEPTION 'No autorizado para reparar asignación WMS';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Cantidad de reparación inválida'; END IF;

  SELECT rl.*, p.id AS product_id
  INTO v_line
  FROM mermas.request_lines rl
  JOIN mermas.requests r ON r.id = rl.request_id AND r.company_id = p_company_id
  JOIN adquisiciones.products p
    ON p.company_id = p_company_id AND p.bsale_variant_id = rl.bsale_variant_id
  WHERE rl.request_id = p_request_id AND rl.company_id = p_company_id
  ORDER BY rl.created_at, rl.id
  LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Línea de Merma no encontrada'; END IF;
  IF p_quantity <> v_line.quantity THEN
    RAISE EXCEPTION 'La reparación debe cubrir exactamente la cantidad de la línea';
  END IF;

  SELECT km.source_id AS source_receipt_id, km.source_line_id AS source_receipt_item_id,
    km.product_id, km.warehouse_id, km.location_id, km.lot_number, km.expiration_date,
    max(km.unit_cost) AS unit_cost
  INTO v_source
  FROM logistica.kardex_movements km
  WHERE km.company_id = p_company_id
    AND km.source_type = 'PURCHASE_RECEIPT'
    AND km.movement_type = 'IN'
    AND km.source_line_id = p_source_receipt_item_id
    AND km.product_id = v_line.product_id
  GROUP BY km.source_id, km.source_line_id, km.product_id, km.warehouse_id,
    km.location_id, km.lot_number, km.expiration_date
  ORDER BY km.location_id
  LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fuente de recepción WMS no encontrada'; END IF;

  SELECT coalesce(sum(a.quantity), 0) INTO v_existing
  FROM mermas.wms_allocations a
  WHERE a.company_id = p_company_id AND a.request_id = p_request_id
    AND a.status IN ('RESERVED', 'APPLIED');
  IF v_existing > 0 THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'request_id', p_request_id);
  END IF;

  INSERT INTO mermas.wms_allocations(
    company_id, request_id, request_line_id, product_id, warehouse_id, location_id,
    source_receipt_id, source_receipt_item_id, quantity, unit_cost, lot_number,
    expiration_date, created_by
  ) VALUES (
    p_company_id, p_request_id, v_line.id, v_source.product_id, v_source.warehouse_id,
    v_source.location_id, v_source.source_receipt_id, v_source.source_receipt_item_id,
    p_quantity, v_source.unit_cost, v_source.lot_number, v_source.expiration_date, p_user_id
  );
  IF EXISTS (
    SELECT 1 FROM mermas.bsale_outbound_operations
    WHERE company_id = p_company_id AND request_id = p_request_id
      AND local_applied_at IS NOT NULL
  ) THEN
    PERFORM mermas.apply_wms_allocations(p_request_id, p_company_id, p_user_id);
  END IF;
  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'quantity', p_quantity);
END;
$$;

REVOKE ALL ON FUNCTION mermas.repair_wms_allocation(uuid, uuid, uuid, uuid, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.repair_wms_allocation(uuid, uuid, uuid, uuid, numeric)
  TO service_role;
