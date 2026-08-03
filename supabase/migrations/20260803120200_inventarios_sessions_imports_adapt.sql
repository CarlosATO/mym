-- Migration: 20260803120200_inventarios_sessions_imports_adapt.sql
-- Description: Fase 4I.2E. Adaptacion aditiva de sessions y stock_imports/rows
--              para campanas y unidades inventariables. No redefinir RPCs.
-- Author: Assistant

-- ============================================================
-- 1. SESSIONS: campana y unidad inventariable
-- ============================================================
ALTER TABLE inventarios.sessions
    ADD COLUMN campaign_id uuid;

ALTER TABLE inventarios.sessions
    ADD COLUMN inventory_site_id uuid;

ALTER TABLE inventarios.sessions
    ADD CONSTRAINT fk_inventarios_sessions_campaign
    FOREIGN KEY (company_id, campaign_id)
    REFERENCES inventarios.inventory_campaigns(company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE inventarios.sessions
    ADD CONSTRAINT fk_inventarios_sessions_inventory_site
    FOREIGN KEY (company_id, inventory_site_id)
    REFERENCES inventarios.inventory_sites(company_id, id)
    ON DELETE RESTRICT;

-- Una sesion de campana debe pertenecer a una unidad materializada en la campana
ALTER TABLE inventarios.sessions
    ADD CONSTRAINT fk_inventarios_sessions_campaign_site
    FOREIGN KEY (company_id, campaign_id, inventory_site_id)
    REFERENCES inventarios.inventory_campaign_sites(company_id, campaign_id, inventory_site_id)
    ON DELETE RESTRICT;

-- Una unidad no puede repetirse dentro de la misma campana
CREATE UNIQUE INDEX uq_inventarios_sessions_campaign_site
    ON inventarios.sessions (company_id, campaign_id, inventory_site_id)
    WHERE campaign_id IS NOT NULL AND inventory_site_id IS NOT NULL;

-- ============================================================
-- 2. STOCK IMPORTS: unidad inventariable
-- ============================================================
ALTER TABLE inventarios.stock_imports
    ADD COLUMN inventory_site_id uuid;

ALTER TABLE inventarios.stock_imports
    ALTER COLUMN warehouse_id DROP NOT NULL;

ALTER TABLE inventarios.stock_imports
    ADD CONSTRAINT fk_inventarios_stock_imports_inventory_site
    FOREIGN KEY (company_id, inventory_site_id)
    REFERENCES inventarios.inventory_sites(company_id, id)
    ON DELETE RESTRICT;

CREATE INDEX idx_inventarios_stock_imports_site
    ON inventarios.stock_imports (company_id, inventory_site_id);

-- ============================================================
-- 3. STOCK IMPORT ROWS: ubicacion de sitio
-- ============================================================
ALTER TABLE inventarios.stock_import_rows
    ADD COLUMN inventory_site_id uuid;

ALTER TABLE inventarios.stock_import_rows
    ADD COLUMN inventory_site_location_id uuid;

ALTER TABLE inventarios.stock_import_rows
    ADD CONSTRAINT fk_inventarios_stock_import_rows_site
    FOREIGN KEY (company_id, inventory_site_id)
    REFERENCES inventarios.inventory_sites(company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE inventarios.stock_import_rows
    ADD CONSTRAINT fk_inventarios_stock_import_rows_site_location
    FOREIGN KEY (company_id, inventory_site_id, inventory_site_location_id)
    REFERENCES inventarios.inventory_site_locations(company_id, inventory_site_id, id)
    ON DELETE RESTRICT;
