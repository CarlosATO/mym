-- Migration: Fix bsale_product_type_id type
-- The integraciones.bsale_product_types.id is actually a UUID, not an integer.
ALTER TABLE adquisiciones.suppliers 
  DROP COLUMN IF EXISTS bsale_product_type_id CASCADE;

ALTER TABLE adquisiciones.suppliers 
  ADD COLUMN bsale_product_type_id uuid NULL REFERENCES integraciones.bsale_product_types(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_suppliers_bsale_type_company ON adquisiciones.suppliers (company_id, bsale_product_type_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_bsale_type_unique ON adquisiciones.suppliers (company_id, bsale_product_type_id) WHERE bsale_product_type_id IS NOT NULL;
