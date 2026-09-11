-- MERMAS: avoid duplicate direct entries when a Bsale detail was already allocated.

CREATE OR REPLACE FUNCTION mermas.prevent_duplicate_bsale_movement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, mermas
AS $$
DECLARE
  v_detail_quantity numeric;
  v_allocated_quantity numeric;
BEGIN
  IF NEW.movement_type = 'ENTRADA_BSALE'
     AND NEW.detail_id IS NOT NULL
     AND NEW.allocation_id IS NULL THEN
    SELECT quantity INTO v_detail_quantity
    FROM mermas.bsale_consumption_details
    WHERE company_id = NEW.company_id
      AND consumption_id = NEW.consumption_id
      AND detail_id = NEW.detail_id;

    SELECT COALESCE(sum(quantity), 0) INTO v_allocated_quantity
    FROM mermas.movements
    WHERE company_id = NEW.company_id
      AND detail_id = NEW.detail_id
      AND allocation_id IS NOT NULL;

    IF v_detail_quantity IS NOT NULL THEN
      IF v_allocated_quantity >= v_detail_quantity THEN
        RETURN NULL;
      END IF;
      NEW.quantity := LEAST(NEW.quantity, v_detail_quantity - v_allocated_quantity);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mermas_prevent_duplicate_bsale_movement ON mermas.movements;
CREATE TRIGGER mermas_prevent_duplicate_bsale_movement
BEFORE INSERT ON mermas.movements
FOR EACH ROW EXECUTE FUNCTION mermas.prevent_duplicate_bsale_movement();

-- Remove only direct rows fully covered by an existing request allocation.
-- The audit entry makes this historical correction explicit and repeatable.
WITH doomed AS (
  SELECT m.id
  FROM mermas.movements m
  JOIN mermas.bsale_consumption_details d
    ON d.company_id = m.company_id
   AND d.consumption_id = m.consumption_id
   AND d.detail_id = m.detail_id
  WHERE m.movement_type = 'ENTRADA_BSALE'
    AND m.allocation_id IS NULL
    AND COALESCE((
      SELECT sum(a.quantity)
      FROM mermas.bsale_detail_allocations a
      WHERE a.company_id = m.company_id
        AND a.consumption_detail_id = d.id
    ), 0) >= d.quantity
), deleted AS (
  DELETE FROM mermas.movements m
  USING doomed
  WHERE m.id = doomed.id
  RETURNING m.*
)
INSERT INTO portal.audit_logs(
  table_name, record_id, action, old_data, new_data, performed_at
)
SELECT
  'mermas.movements', id, 'MERMA_DATA_REPAIR', to_jsonb(deleted),
  jsonb_build_object('reason', 'direct movement duplicated an allocated Bsale detail'),
  now()
FROM deleted;
