-- Migration: 20260803140100_inventarios_campaign_scopes.sql
-- Description: Fase 4I.2G. Dimensiones de alcance de campanas: site_scope,
--              product_scope y location_scope, con tablas de productos y
--              ubicaciones seleccionadas. Backfill de campanas existentes.
-- Author: Assistant

-- ============================================================
-- 1. COLUMNAS DE ALCANCE EN inventory_campaigns
-- ============================================================
ALTER TABLE inventarios.inventory_campaigns
    ADD COLUMN site_scope text;

ALTER TABLE inventarios.inventory_campaigns
    ADD COLUMN product_scope text;

ALTER TABLE inventarios.inventory_campaigns
    ADD CONSTRAINT chk_inventarios_campaigns_site_scope
    CHECK (site_scope IN ('ALL_INTERNAL', 'SELECTED'));

ALTER TABLE inventarios.inventory_campaigns
    ADD CONSTRAINT chk_inventarios_campaigns_product_scope
    CHECK (product_scope IN ('ALL', 'SELECTED'));

-- ============================================================
-- 2. LOCATION SCOPE EN inventory_campaign_sites
-- ============================================================
ALTER TABLE inventarios.inventory_campaign_sites
    ADD COLUMN location_scope text;

ALTER TABLE inventarios.inventory_campaign_sites
    ADD CONSTRAINT chk_inventarios_campaign_sites_location_scope
    CHECK (location_scope IN ('ALL', 'SELECTED'));

-- ============================================================
-- 3. PRODUCTOS SELECCIONADOS DE LA CAMPANA
-- ============================================================
CREATE TABLE inventarios.inventory_campaign_products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    product_id uuid NOT NULL REFERENCES adquisiciones.products(id) ON DELETE RESTRICT,
    sku text NOT NULL,
    display_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_campaign_products_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_campaign_products_campaign_product UNIQUE (company_id, campaign_id, product_id),
    CONSTRAINT fk_inventarios_campaign_products_campaign
        FOREIGN KEY (company_id, campaign_id)
        REFERENCES inventarios.inventory_campaigns(company_id, id)
        ON DELETE CASCADE
);

CREATE INDEX idx_inventarios_campaign_products_campaign
    ON inventarios.inventory_campaign_products (company_id, campaign_id, display_order);

-- ============================================================
-- 4. UBICACIONES SELECCIONADAS POR UNIDAD DE LA CAMPANA
-- ============================================================
CREATE TABLE inventarios.inventory_campaign_site_locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_site_id uuid NOT NULL,
    inventory_site_location_id uuid NOT NULL,
    display_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_campaign_site_locations_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_campaign_site_locations_campaign_site UNIQUE (company_id, campaign_site_id, inventory_site_location_id),
    CONSTRAINT fk_inventarios_campaign_site_locations_campaign_site
        FOREIGN KEY (company_id, campaign_site_id)
        REFERENCES inventarios.inventory_campaign_sites(company_id, id)
        ON DELETE CASCADE
);

CREATE INDEX idx_inventarios_campaign_site_locations_campaign_site
    ON inventarios.inventory_campaign_site_locations (company_id, campaign_site_id, display_order);

-- ============================================================
-- 5. BACKFILL DE CAMPANAS EXISTENTES
-- ============================================================
UPDATE inventarios.inventory_campaigns
SET site_scope = CASE
        WHEN campaign_type = 'GENERAL' THEN 'ALL_INTERNAL'
        ELSE 'SELECTED'
    END,
    product_scope = 'ALL',
    updated_at = pg_catalog.now()
WHERE site_scope IS NULL;

UPDATE inventarios.inventory_campaign_sites
SET location_scope = 'ALL'
WHERE location_scope IS NULL;

-- ============================================================
-- 6. NOT NULL DESPUES DEL BACKFILL
-- ============================================================
ALTER TABLE inventarios.inventory_campaigns
    ALTER COLUMN site_scope SET NOT NULL;

ALTER TABLE inventarios.inventory_campaigns
    ALTER COLUMN product_scope SET NOT NULL;

ALTER TABLE inventarios.inventory_campaign_sites
    ALTER COLUMN location_scope SET NOT NULL;
