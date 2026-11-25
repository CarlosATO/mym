-- No defaults or backfill: existing and legacy-written lines remain historical/unknown.
ALTER TABLE adquisiciones.purchase_order_items
  ADD COLUMN purchase_unit_snapshot varchar(30),
  ADD COLUMN purchase_unit_factor_snapshot integer,
  ADD COLUMN product_supplier_mapping_id uuid;

ALTER TABLE adquisiciones.purchase_order_items
  ADD CONSTRAINT poi_commercial_snapshot_shape_check CHECK ((
    (item_type = 'SERVICE' AND purchase_unit_snapshot IS NULL
      AND purchase_unit_factor_snapshot IS NULL AND product_supplier_mapping_id IS NULL)
    OR
    (item_type = 'PRODUCT' AND (
      (purchase_unit_snapshot IS NULL AND purchase_unit_factor_snapshot IS NULL
        AND product_supplier_mapping_id IS NULL)
      OR (purchase_unit_snapshot IS NULL AND purchase_unit_factor_snapshot = 1)
      OR (purchase_unit_snapshot IS NOT NULL AND btrim(purchase_unit_snapshot) <> ''
        AND purchase_unit_factor_snapshot IS NOT NULL AND purchase_unit_factor_snapshot >= 1)
    ))
  ) IS TRUE),
  ADD CONSTRAINT poi_commercial_mapping_fkey
    FOREIGN KEY (product_supplier_mapping_id)
    REFERENCES adquisiciones.product_supplier_mappings(id) ON DELETE SET NULL;

-- Check the association when captured, without re-reading mutable catalog values.
CREATE FUNCTION adquisiciones.validate_po_commercial_mapping()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, adquisiciones AS $$
BEGIN
  IF NEW.product_supplier_mapping_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM adquisiciones.product_supplier_mappings m
    WHERE m.id = NEW.product_supplier_mapping_id
      AND m.company_id = NEW.company_id AND m.product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'El mapeo comercial no corresponde a la empresa y producto de la línea'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_po_commercial_mapping
  BEFORE INSERT OR UPDATE OF product_supplier_mapping_id, company_id, product_id
  ON adquisiciones.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION adquisiciones.validate_po_commercial_mapping();

COMMENT ON COLUMN adquisiciones.purchase_order_items.purchase_unit_snapshot IS
  'Presentación comercial capturada; NULL con factor NULL indica historial desconocido, con factor 1 indica configuración pendiente.';
COMMENT ON COLUMN adquisiciones.purchase_order_items.purchase_unit_factor_snapshot IS
  'Unidades internas por compra capturadas; cantidad comercial = quantity / factor. NULL indica historial desconocido o servicio.';
COMMENT ON COLUMN adquisiciones.purchase_order_items.product_supplier_mapping_id IS
  'Trazabilidad al mapeo al capturar la línea; se desvincula si el mapeo se elimina, sin alterar los valores capturados.';
