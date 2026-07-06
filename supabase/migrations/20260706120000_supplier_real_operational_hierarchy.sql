-- Migration: supplier_real_operational_hierarchy
-- Objective: Add columns to support REAL vs BSALE_OPERATIVE suppliers hierarchy.

-- 1. Add supplier_kind
ALTER TABLE adquisiciones.suppliers ADD COLUMN IF NOT EXISTS supplier_kind varchar(30) DEFAULT 'REAL';

-- Add check constraint for supplier_kind
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_suppliers_supplier_kind'
    ) THEN
        ALTER TABLE adquisiciones.suppliers 
        ADD CONSTRAINT chk_suppliers_supplier_kind CHECK (supplier_kind IN ('REAL', 'BSALE_OPERATIVE'));
    END IF;
END $$;

-- 2. Add parent_supplier_id for pseudo-suppliers
ALTER TABLE adquisiciones.suppliers ADD COLUMN IF NOT EXISTS parent_supplier_id uuid NULL REFERENCES adquisiciones.suppliers(id) ON DELETE SET NULL;

-- 3. Add Bsale technical columns to suppliers
ALTER TABLE adquisiciones.suppliers ADD COLUMN IF NOT EXISTS bsale_product_type_id integer NULL;
ALTER TABLE adquisiciones.suppliers ADD COLUMN IF NOT EXISTS bsale_product_type_name text NULL;
ALTER TABLE adquisiciones.suppliers ADD COLUMN IF NOT EXISTS source text NULL;
ALTER TABLE adquisiciones.suppliers ADD COLUMN IF NOT EXISTS last_bsale_sync_at timestamptz NULL;

-- 4. Create Indexes
CREATE INDEX IF NOT EXISTS idx_suppliers_kind_company ON adquisiciones.suppliers (company_id, supplier_kind);
CREATE INDEX IF NOT EXISTS idx_suppliers_parent_company ON adquisiciones.suppliers (company_id, parent_supplier_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_bsale_type_company ON adquisiciones.suppliers (company_id, bsale_product_type_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_bsale_type_unique ON adquisiciones.suppliers (company_id, bsale_product_type_id) WHERE bsale_product_type_id IS NOT NULL;
