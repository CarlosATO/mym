-- Allow incomplete draft lines, but reject non-positive prices whenever an OC is emitted.

CREATE OR REPLACE FUNCTION adquisiciones.validate_purchase_order_item_price_on_issue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_status text;
BEGIN
    SELECT status INTO v_status
    FROM adquisiciones.purchase_orders
    WHERE id = COALESCE(NEW.po_id, OLD.po_id);

    IF v_status = 'EMITIDA'
       AND COALESCE(NEW.quantity, 0) > 0
       AND (NEW.unit_price IS NULL OR NEW.unit_price <= 0) THEN
        RAISE EXCEPTION 'Hay productos sin precio unitario. Complete el precio antes de emitir la orden.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_purchase_order_item_price_on_issue
  ON adquisiciones.purchase_order_items;
CREATE TRIGGER trg_validate_purchase_order_item_price_on_issue
  BEFORE INSERT OR UPDATE OF quantity, unit_price
  ON adquisiciones.purchase_order_items
  FOR EACH ROW
  EXECUTE FUNCTION adquisiciones.validate_purchase_order_item_price_on_issue();

CREATE OR REPLACE FUNCTION adquisiciones.validate_purchase_order_prices_on_issue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = 'EMITIDA' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
        IF EXISTS (
            SELECT 1
            FROM adquisiciones.purchase_order_items item
            WHERE item.po_id = NEW.id
              AND COALESCE(item.quantity, 0) > 0
              AND (item.unit_price IS NULL OR item.unit_price <= 0)
        ) THEN
            RAISE EXCEPTION 'Hay productos sin precio unitario. Complete el precio antes de emitir la orden.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_purchase_order_prices_on_issue
  ON adquisiciones.purchase_orders;
CREATE TRIGGER trg_validate_purchase_order_prices_on_issue
  BEFORE INSERT OR UPDATE OF status
  ON adquisiciones.purchase_orders
  FOR EACH ROW
  EXECUTE FUNCTION adquisiciones.validate_purchase_order_prices_on_issue();
