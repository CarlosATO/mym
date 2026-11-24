ALTER TABLE adquisiciones.product_supplier_mappings
  ADD COLUMN IF NOT EXISTS purchase_unit varchar(30),
  ADD COLUMN IF NOT EXISTS purchase_unit_factor integer NOT NULL DEFAULT 1;

UPDATE adquisiciones.product_supplier_mappings
SET purchase_unit_factor = 1
WHERE purchase_unit_factor IS NULL OR purchase_unit_factor < 1;

UPDATE adquisiciones.product_supplier_mappings
SET purchase_unit = NULLIF(btrim(purchase_unit), '');

ALTER TABLE adquisiciones.product_supplier_mappings
  ALTER COLUMN purchase_unit_factor SET DEFAULT 1,
  ALTER COLUMN purchase_unit_factor SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_supplier_mappings_purchase_unit_factor_check'
      AND conrelid = 'adquisiciones.product_supplier_mappings'::regclass
  ) THEN
    ALTER TABLE adquisiciones.product_supplier_mappings
      ADD CONSTRAINT product_supplier_mappings_purchase_unit_factor_check
      CHECK (purchase_unit_factor >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_supplier_mappings_purchase_unit_required_for_factor_check'
      AND conrelid = 'adquisiciones.product_supplier_mappings'::regclass
  ) THEN
    ALTER TABLE adquisiciones.product_supplier_mappings
      ADD CONSTRAINT product_supplier_mappings_purchase_unit_required_for_factor_check
      CHECK (purchase_unit_factor = 1 OR NULLIF(btrim(purchase_unit), '') IS NOT NULL);
  END IF;
END $$;

COMMENT ON COLUMN adquisiciones.product_supplier_mappings.purchase_unit IS
  'Presentación comercial utilizada para comprar este producto a este proveedor.';
COMMENT ON COLUMN adquisiciones.product_supplier_mappings.purchase_unit_factor IS
  'Cantidad de unidades internas contenidas en una unidad comercial de compra.';
