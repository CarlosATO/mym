-- Migration: 20260803190000_inventarios_import_session_schema.sql
-- Description: Fase 4I.3B. Adaptacion de esquema para asociar importaciones
--              EXCEL_IMPORT validadas con sesiones de inventario y congelar
--              el snapshot operacional.
--              1) session_location_scopes pasa a usar inventory_site_locations
--                 como fuente canonica (inventory_site_location_id), manteniendo
--                 location_id de Logistica como opcional (sitios internos).
--              2) snapshot_locations congelan inventory_site_location_id;
--                 location_id/warehouse_id pasan a ser opcionales (sitios
--                 externos no tienen Logistica).
--              3) session_zone_locations.location_id pasa a ser opcional para
--                 permitir zonas sobre ubicaciones inventariables externas.
--              4) snapshot_products gana UNIQUE por product_id (canonico).
--              5) operational_snapshots gana metadatos de la importacion.
-- Author: Assistant

-- ============================================================
-- 1. SESSION LOCATION SCOPES -> inventory_site_locations canonico
-- ============================================================
ALTER TABLE inventarios.session_location_scopes
    ADD COLUMN IF NOT EXISTS inventory_site_location_id uuid;

ALTER TABLE inventarios.session_location_scopes
    ADD CONSTRAINT fk_inventarios_location_scopes_site_location
    FOREIGN KEY (company_id, inventory_site_location_id)
    REFERENCES inventarios.inventory_site_locations(company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE inventarios.session_location_scopes
    ALTER COLUMN location_id DROP NOT NULL;

-- No duplicados por ubicacion inventariable
CREATE UNIQUE INDEX uq_inventarios_location_scopes_site_location
    ON inventarios.session_location_scopes (company_id, session_id, inventory_site_location_id)
    WHERE inventory_site_location_id IS NOT NULL;

-- ============================================================
-- 2. SNAPSHOT LOCATIONS -> inventory_site_location_id congelado
--    Para sitios internos se conserva la trazabilidad a Logistica
--    (location_id). Para sitios externos location_id/warehouse_id
--    son opcionales.
-- ============================================================
ALTER TABLE inventarios.snapshot_locations
    ADD COLUMN IF NOT EXISTS inventory_site_location_id uuid;

ALTER TABLE inventarios.snapshot_locations
    ADD COLUMN IF NOT EXISTS source_logistics_location_id uuid;

ALTER TABLE inventarios.snapshot_locations
    ALTER COLUMN location_id DROP NOT NULL;

ALTER TABLE inventarios.snapshot_locations
    ALTER COLUMN warehouse_id DROP NOT NULL;

ALTER TABLE inventarios.snapshot_locations
    ADD CONSTRAINT fk_inventarios_snapshot_locations_site_location
    FOREIGN KEY (company_id, inventory_site_location_id)
    REFERENCES inventarios.inventory_site_locations(company_id, id)
    ON DELETE RESTRICT;

-- La ubicacion congelada es unica por snapshot
DROP INDEX IF EXISTS uq_inventarios_snapshot_locations_location;
CREATE UNIQUE INDEX uq_inventarios_snapshot_locations_site_location
    ON inventarios.snapshot_locations (company_id, snapshot_id, inventory_site_location_id)
    WHERE inventory_site_location_id IS NOT NULL;

-- ============================================================
-- 3. SESSION ZONE LOCATIONS -> location_id opcional
--    Una zona puede referenciar una ubicacion inventariable externa
--    (snapshot_location_id) sin necesidad de logistica.locations.
-- ============================================================
ALTER TABLE inventarios.session_zone_locations
    ALTER COLUMN location_id DROP NOT NULL;

-- ============================================================
-- 4. SNAPSHOT PRODUCTS -> UNIQUE por product_id canonico
--    Para EXCEL_IMPORT el product_id es obligatorio y unico por snapshot.
-- ============================================================
CREATE UNIQUE INDEX uq_inventarios_snapshot_products_snapshot_product
    ON inventarios.snapshot_products (company_id, snapshot_id, product_id)
    WHERE product_id IS NOT NULL;

-- ============================================================
-- 5. OPERATIONAL SNAPSHOTS -> metadatos de la importacion
-- ============================================================
ALTER TABLE inventarios.operational_snapshots
    ADD COLUMN IF NOT EXISTS stock_source text;

ALTER TABLE inventarios.operational_snapshots
    ADD COLUMN IF NOT EXISTS stock_import_id uuid;

ALTER TABLE inventarios.operational_snapshots
    ADD COLUMN IF NOT EXISTS inventory_site_id uuid;

ALTER TABLE inventarios.operational_snapshots
    ADD COLUMN IF NOT EXISTS warehouse_id uuid;

ALTER TABLE inventarios.operational_snapshots
    ADD COLUMN IF NOT EXISTS cutoff_at timestamptz;

ALTER TABLE inventarios.operational_snapshots
    ADD COLUMN IF NOT EXISTS modality text;

ALTER TABLE inventarios.operational_snapshots
    ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CLP';

ALTER TABLE inventarios.operational_snapshots
    ADD COLUMN IF NOT EXISTS file_sha256 char(64);

ALTER TABLE inventarios.operational_snapshots
    ADD COLUMN IF NOT EXISTS template_version text;

ALTER TABLE inventarios.operational_snapshots
    ADD CONSTRAINT fk_inventarios_snapshots_stock_import
    FOREIGN KEY (company_id, stock_import_id)
    REFERENCES inventarios.stock_imports(company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE inventarios.operational_snapshots
    ADD CONSTRAINT fk_inventarios_snapshots_inventory_site
    FOREIGN KEY (company_id, inventory_site_id)
    REFERENCES inventarios.inventory_sites(company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE inventarios.operational_snapshots
    DROP CONSTRAINT IF EXISTS chk_inventarios_snapshots_source;

ALTER TABLE inventarios.operational_snapshots
    ADD CONSTRAINT chk_inventarios_snapshots_source
    CHECK (stock_source IS NULL OR stock_source IN ('EXCEL_IMPORT', 'BSALE_SYNC'));

ALTER TABLE inventarios.operational_snapshots
    DROP CONSTRAINT IF EXISTS chk_inventarios_snapshots_modality;

ALTER TABLE inventarios.operational_snapshots
    ADD CONSTRAINT chk_inventarios_snapshots_modality
    CHECK (modality IS NULL OR modality IN ('GENERAL', 'POR_UBICACION'));

ALTER TABLE inventarios.operational_snapshots
    DROP CONSTRAINT IF EXISTS chk_inventarios_snapshots_currency;

ALTER TABLE inventarios.operational_snapshots
    ADD CONSTRAINT chk_inventarios_snapshots_currency
    CHECK (currency = 'CLP');
