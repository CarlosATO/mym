-- Reserve WMS stock for Merma requests and consume it only after Bsale CONFIRMED.

ALTER TABLE logistica.kardex_movements
  DROP CONSTRAINT IF EXISTS kardex_movements_source_type_check;

ALTER TABLE logistica.kardex_movements
  ADD CONSTRAINT kardex_movements_source_type_check
  CHECK (source_type IN ('PURCHASE_RECEIPT', 'ADJUSTMENT', 'TRANSFER', 'MERMA'));

CREATE TABLE IF NOT EXISTS mermas.wms_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES mermas.requests(id) ON DELETE CASCADE,
  request_line_id uuid NOT NULL REFERENCES mermas.request_lines(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES adquisiciones.products(id),
  warehouse_id uuid NOT NULL REFERENCES adquisiciones.warehouses(id),
  location_id uuid NOT NULL REFERENCES logistica.locations(id),
  source_receipt_id uuid NOT NULL REFERENCES logistica.purchase_receipts(id),
  source_receipt_item_id uuid NOT NULL REFERENCES logistica.purchase_receipt_items(id),
  quantity numeric(14,4) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(14,4),
  lot_number varchar(100),
  expiration_date date,
  status text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'APPLIED', 'RELEASED')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  created_by uuid REFERENCES portal.users(id),
  UNIQUE (company_id, request_line_id, source_receipt_item_id, location_id, lot_number, expiration_date)
);

CREATE INDEX IF NOT EXISTS mermas_wms_allocations_request_idx
  ON mermas.wms_allocations(company_id, request_id, status);
CREATE INDEX IF NOT EXISTS mermas_wms_allocations_source_idx
  ON mermas.wms_allocations(company_id, source_receipt_item_id, status);

ALTER TABLE mermas.wms_allocations ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON mermas.wms_allocations TO authenticated;
GRANT ALL ON mermas.wms_allocations TO service_role;

CREATE POLICY mermas_wms_allocations_select ON mermas.wms_allocations
  FOR SELECT TO authenticated
  USING (core.has_company_access(auth.uid(), company_id)
    AND portal.has_permission('logistica.mermas.view'));

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
    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'Stock WMS insuficiente para la línea %', v_line.id;
    END IF;
  END LOOP;

  SELECT coalesce(sum(a.quantity), 0) INTO v_reserved
  FROM mermas.wms_allocations a
  WHERE a.company_id = p_company_id AND a.request_id = p_request_id
    AND a.status = 'RESERVED';
  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'reserved_quantity', v_reserved);
END;
$$;

CREATE OR REPLACE FUNCTION mermas.apply_wms_allocations(
  p_request_id uuid,
  p_company_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, adquisiciones, logistica, mermas
AS $$
DECLARE
  v_allocation record;
  v_stock numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM portal.users
    WHERE id = p_user_id AND is_active AND deleted_at IS NULL
  ) OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.request.create') THEN
    RAISE EXCEPTION 'No autorizado para aplicar stock WMS de Mermas';
  END IF;

  FOR v_allocation IN
    SELECT * FROM mermas.wms_allocations
    WHERE company_id = p_company_id AND request_id = p_request_id
    ORDER BY id
    FOR UPDATE
  LOOP
    IF v_allocation.status = 'APPLIED' THEN CONTINUE; END IF;
    IF v_allocation.status <> 'RESERVED' THEN
      RAISE EXCEPTION 'La asignación WMS % no está reservada', v_allocation.id;
    END IF;

    SELECT coalesce(sum(
      CASE WHEN movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT') THEN quantity
           WHEN movement_type IN ('OUT', 'TRANSFER_OUT') THEN -quantity ELSE 0 END
    ), 0) INTO v_stock
    FROM logistica.kardex_movements
    WHERE company_id = p_company_id
      AND product_id = v_allocation.product_id
      AND warehouse_id = v_allocation.warehouse_id
      AND location_id = v_allocation.location_id
      AND lot_number IS NOT DISTINCT FROM v_allocation.lot_number
      AND expiration_date IS NOT DISTINCT FROM v_allocation.expiration_date;
    IF v_stock < v_allocation.quantity THEN
      RAISE EXCEPTION 'Stock WMS insuficiente en la ubicación de la asignación %', v_allocation.id;
    END IF;

    INSERT INTO logistica.kardex_movements(
      company_id, product_id, warehouse_id, location_id, movement_type, source_type,
      source_id, source_line_id, quantity, unit_cost, total_cost, lot_number,
      expiration_date, notes, created_by
    ) VALUES (
      p_company_id, v_allocation.product_id, v_allocation.warehouse_id, v_allocation.location_id,
      'OUT', 'MERMA', p_request_id, v_allocation.source_receipt_item_id,
      v_allocation.quantity, v_allocation.unit_cost,
      v_allocation.quantity * coalesce(v_allocation.unit_cost, 0), v_allocation.lot_number,
      v_allocation.expiration_date, 'Salida WMS por Merma', p_user_id
    );
    UPDATE mermas.wms_allocations
    SET status = 'APPLIED', applied_at = now()
    WHERE id = v_allocation.id AND company_id = p_company_id;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'APPLIED');
END;
$$;

CREATE OR REPLACE FUNCTION mermas.reserve_request_wms_after_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, adquisiciones, logistica, mermas
AS $$
BEGIN
  PERFORM mermas.reserve_wms_allocations(NEW.request_id, NEW.company_id, (SELECT created_by FROM mermas.requests WHERE id = NEW.request_id));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mermas_request_lines_wms_allocation ON mermas.request_lines;
CREATE CONSTRAINT TRIGGER mermas_request_lines_wms_allocation
AFTER INSERT ON mermas.request_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION mermas.reserve_request_wms_after_lines();

REVOKE ALL ON FUNCTION mermas.reserve_wms_allocations(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mermas.apply_wms_allocations(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.reserve_wms_allocations(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION mermas.apply_wms_allocations(uuid, uuid, uuid) TO service_role;
