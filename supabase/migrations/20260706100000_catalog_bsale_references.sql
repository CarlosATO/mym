-- ============================================================================
-- Migration: 20260706100000_catalog_bsale_references.sql
-- Schema: adquisiciones
-- Descripción: Agrega referencias de trazabilidad Bsale a products
-- ============================================================================

ALTER TABLE adquisiciones.products
ADD COLUMN IF NOT EXISTS bsale_product_id integer,
ADD COLUMN IF NOT EXISTS bsale_variant_id integer,
ADD COLUMN IF NOT EXISTS bsale_product_type_id integer,
ADD COLUMN IF NOT EXISTS bsale_product_type_name text,
ADD COLUMN IF NOT EXISTS source text DEFAULT 'PETGRUP',
ADD COLUMN IF NOT EXISTS last_bsale_sync_at timestamptz,
ADD COLUMN IF NOT EXISTS bsale_product_state integer,
ADD COLUMN IF NOT EXISTS bsale_variant_state integer,
ADD COLUMN IF NOT EXISTS bsale_sync_hash text,
ADD COLUMN IF NOT EXISTS bsale_status_conflict boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS bsale_status_conflict_reason text,
ADD COLUMN IF NOT EXISTS bsale_status_conflict_detected_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_products_company_bsale_prod ON adquisiciones.products(company_id, bsale_product_id);
CREATE INDEX IF NOT EXISTS idx_products_company_bsale_type ON adquisiciones.products(company_id, bsale_product_type_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_company_bsale_variant ON adquisiciones.products(company_id, bsale_variant_id) WHERE bsale_variant_id IS NOT NULL;
