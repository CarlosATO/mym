-- The commercial price is an exact amount per captured purchase presentation.
-- Existing orders remain unknown; no historical values are inferred.
ALTER TABLE adquisiciones.purchase_order_items
  ADD COLUMN commercial_unit_price_snapshot numeric(18,4),
  ADD CONSTRAINT poi_commercial_price_snapshot_check CHECK (
    commercial_unit_price_snapshot IS NULL OR (
      item_type = 'PRODUCT' AND purchase_unit_factor_snapshot IS NOT NULL
      AND commercial_unit_price_snapshot >= 0
    )
  );

COMMENT ON COLUMN adquisiciones.purchase_order_items.commercial_unit_price_snapshot IS
  'Precio exacto por presentación capturada; NULL para líneas históricas, servicios o anteriores a la captura de precio.';

-- A commercial order must stay in draft until downstream economic integration is complete.
CREATE FUNCTION adquisiciones.guard_commercial_po_status()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, adquisiciones AS $$
BEGIN
  IF NEW.status NOT IN ('BORRADOR', 'CANCELADA') AND EXISTS (
    SELECT 1 FROM adquisiciones.purchase_order_items i
    WHERE i.po_id = NEW.id AND i.company_id = NEW.company_id
      AND (i.purchase_unit_factor_snapshot IS NOT NULL OR i.commercial_unit_price_snapshot IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'La emisión de órdenes con configuración comercial está deshabilitada'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_commercial_po_status
  BEFORE UPDATE OF status ON adquisiciones.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_commercial_po_status();

CREATE FUNCTION adquisiciones.guard_commercial_po_item()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, adquisiciones AS $$
DECLARE v_status text;
BEGIN
  IF NEW.purchase_unit_factor_snapshot IS NOT NULL OR NEW.commercial_unit_price_snapshot IS NOT NULL THEN
    SELECT status INTO v_status FROM adquisiciones.purchase_orders
    WHERE id = NEW.po_id AND company_id = NEW.company_id FOR UPDATE;
    IF v_status IS DISTINCT FROM 'BORRADOR' THEN
      RAISE EXCEPTION 'La configuración comercial solo puede guardarse en órdenes borrador'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_commercial_po_item
  BEFORE INSERT OR UPDATE OF purchase_unit_factor_snapshot, commercial_unit_price_snapshot, po_id, company_id
  ON adquisiciones.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_commercial_po_item();
