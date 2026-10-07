-- WMS tracing is best-effort. Bsale remains the source of truth for Merma creation.
-- A line is allocated only when its complete quantity can be traced.

CREATE OR REPLACE FUNCTION mermas.reserve_wms_allocations(
  p_request_id uuid,
  p_company_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, adquisiciones, logistica, mermas
AS $$
DECLARE
  v_request mermas.requests%ROWTYPE;
  v_line record;
  v_source record;
  v_remaining numeric;
  v_piece numeric;
  v_reserved numeric;
  v_source_available numeric;
  v_allocated numeric;
  v_available_total numeric;
BEGIN
  SELECT * INTO v_request
  FROM mermas.requests
  WHERE id = p_request_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud de Merma no encontrada'; END IF;
  IF v_request.status = 'CANCELADA' THEN RAISE EXCEPTION 'No se puede asignar stock a una solicitud cancelada'; END IF;

  -- Serialize reservations for this company and product without imposing FEFO.
  FOR v_line IN
    SELECT rl.*, p.id AS product_id
    FROM mermas.request_lines rl
    JOIN adquisiciones.products p
      ON p.company_id = p_company_id AND p.bsale_variant_id = rl.bsale_variant_id
    WHERE rl.request_id = p_request_id AND rl.company_id = p_company_id
    ORDER BY rl.created_at, rl.id
    FOR UPDATE OF rl
  LOOP
    SELECT coalesce(sum(a.quantity), 0) INTO v_allocated
    FROM mermas.wms_allocations a
    WHERE a.company_id = p_company_id AND a.request_line_id = v_line.id
      AND a.status IN ('RESERVED', 'APPLIED');
    v_remaining := v_line.quantity - v_allocated;
    IF v_remaining <= 0 THEN CONTINUE; END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_company_id::text || ':' || v_line.product_id::text, 0)
    );

    -- Preflight the complete line before inserting anything. This makes the
    -- allocation all-or-nothing per line and prevents misleading partial trace.
    SELECT coalesce(sum(source.available_quantity), 0)
    INTO v_available_total
    FROM (
      SELECT
        km.source_line_id,
        km.product_id,
        km.warehouse_id,
        km.location_id,
        km.lot_number,
        km.expiration_date,
        sum(km.quantity) FILTER (WHERE km.movement_type = 'IN')
          - coalesce((
            SELECT sum(out_km.quantity)
            FROM logistica.kardex_movements out_km
            WHERE out_km.company_id = p_company_id
              AND out_km.movement_type = 'OUT'
              AND out_km.source_type = 'MERMA'
              AND out_km.source_line_id = km.source_line_id
              AND out_km.product_id = km.product_id
              AND out_km.warehouse_id = km.warehouse_id
              AND out_km.location_id = km.location_id
              AND out_km.lot_number IS NOT DISTINCT FROM km.lot_number
              AND out_km.expiration_date IS NOT DISTINCT FROM km.expiration_date
          ), 0)
          - coalesce((
            SELECT sum(a.quantity)
            FROM mermas.wms_allocations a
            WHERE a.company_id = p_company_id
              AND a.status = 'RESERVED'
              AND a.source_receipt_item_id = km.source_line_id
              AND a.product_id = km.product_id
              AND a.warehouse_id = km.warehouse_id
              AND a.location_id = km.location_id
              AND a.lot_number IS NOT DISTINCT FROM km.lot_number
              AND a.expiration_date IS NOT DISTINCT FROM km.expiration_date
          ), 0) AS available_quantity
      FROM logistica.kardex_movements km
      WHERE km.company_id = p_company_id
        AND km.product_id = v_line.product_id
        AND km.movement_type = 'IN'
        AND km.source_type = 'PURCHASE_RECEIPT'
        AND km.source_id IS NOT NULL
        AND km.source_line_id IS NOT NULL
      GROUP BY km.source_id, km.source_line_id, km.product_id, km.warehouse_id,
        km.location_id, km.lot_number, km.expiration_date
      HAVING sum(km.quantity) > 0
        AND sum(km.quantity) - coalesce((
          SELECT sum(out_km.quantity)
          FROM logistica.kardex_movements out_km
          WHERE out_km.company_id = p_company_id
            AND out_km.movement_type = 'OUT'
            AND out_km.source_type = 'MERMA'
            AND out_km.source_line_id = km.source_line_id
            AND out_km.product_id = km.product_id
            AND out_km.warehouse_id = km.warehouse_id
            AND out_km.location_id = km.location_id
            AND out_km.lot_number IS NOT DISTINCT FROM km.lot_number
            AND out_km.expiration_date IS NOT DISTINCT FROM km.expiration_date
        ), 0) - coalesce((
          SELECT sum(a.quantity)
          FROM mermas.wms_allocations a
          WHERE a.company_id = p_company_id AND a.status = 'RESERVED'
            AND a.source_receipt_item_id = km.source_line_id
            AND a.product_id = km.product_id AND a.warehouse_id = km.warehouse_id
            AND a.location_id = km.location_id
            AND a.lot_number IS NOT DISTINCT FROM km.lot_number
            AND a.expiration_date IS NOT DISTINCT FROM km.expiration_date
        ), 0) > 0
    ) source;

    -- No exception: Bsale creation continues without WMS tracing.
    IF v_available_total < v_remaining THEN CONTINUE; END IF;

    FOR v_source IN
      SELECT
        km.source_id AS source_receipt_id,
        km.source_line_id AS source_receipt_item_id,
        km.product_id,
        km.warehouse_id,
        km.location_id,
        km.lot_number,
        km.expiration_date,
        max(km.unit_cost) AS unit_cost,
        sum(km.quantity) FILTER (WHERE km.movement_type = 'IN')
          - coalesce((
            SELECT sum(out_km.quantity)
            FROM logistica.kardex_movements out_km
            WHERE out_km.company_id = p_company_id AND out_km.movement_type = 'OUT'
              AND out_km.source_type = 'MERMA' AND out_km.source_line_id = km.source_line_id
              AND out_km.product_id = km.product_id AND out_km.warehouse_id = km.warehouse_id
              AND out_km.location_id = km.location_id
              AND out_km.lot_number IS NOT DISTINCT FROM km.lot_number
              AND out_km.expiration_date IS NOT DISTINCT FROM km.expiration_date
          ), 0)
          - coalesce((
            SELECT sum(a.quantity)
            FROM mermas.wms_allocations a
            WHERE a.company_id = p_company_id AND a.status = 'RESERVED'
              AND a.source_receipt_item_id = km.source_line_id AND a.product_id = km.product_id
              AND a.warehouse_id = km.warehouse_id AND a.location_id = km.location_id
              AND a.lot_number IS NOT DISTINCT FROM km.lot_number
              AND a.expiration_date IS NOT DISTINCT FROM km.expiration_date
          ), 0) AS available_quantity
      FROM logistica.kardex_movements km
      WHERE km.company_id = p_company_id AND km.product_id = v_line.product_id
        AND km.movement_type = 'IN' AND km.source_type = 'PURCHASE_RECEIPT'
        AND km.source_id IS NOT NULL AND km.source_line_id IS NOT NULL
      GROUP BY km.source_id, km.source_line_id, km.product_id, km.warehouse_id,
        km.location_id, km.lot_number, km.expiration_date
      HAVING sum(km.quantity) > 0
      ORDER BY km.source_line_id, km.location_id
    LOOP
      v_source_available := v_source.available_quantity;
      v_piece := least(v_remaining, v_source_available);
      IF v_piece <= 0 THEN CONTINUE; END IF;

      INSERT INTO mermas.wms_allocations(
        company_id, request_id, request_line_id, product_id, warehouse_id, location_id,
        source_receipt_id, source_receipt_item_id, quantity, unit_cost,
        lot_number, expiration_date, created_by
      ) VALUES (
        p_company_id, p_request_id, v_line.id, v_line.product_id, v_source.warehouse_id,
        v_source.location_id, v_source.source_receipt_id, v_source.source_receipt_item_id,
        v_piece, v_source.unit_cost, v_source.lot_number, v_source.expiration_date, p_user_id
      ) ON CONFLICT (company_id, request_line_id, source_receipt_item_id, location_id, lot_number, expiration_date)
      DO UPDATE SET quantity = mermas.wms_allocations.quantity + EXCLUDED.quantity;
      v_remaining := v_remaining - v_piece;
      EXIT WHEN v_remaining <= 0;
    END LOOP;
  END LOOP;

  SELECT coalesce(sum(a.quantity), 0) INTO v_reserved
  FROM mermas.wms_allocations a
  WHERE a.company_id = p_company_id AND a.request_id = p_request_id
    AND a.status = 'RESERVED';
  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'reserved_quantity', v_reserved);
END;
$$;

REVOKE ALL ON FUNCTION mermas.reserve_wms_allocations(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.reserve_wms_allocations(uuid, uuid, uuid) TO service_role;
