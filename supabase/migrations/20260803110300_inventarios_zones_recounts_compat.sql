-- Migration: 20260803110300_inventarios_zones_recounts_compat.sql
-- Description: Fase 4I.2C. Permite multiples ubicaciones por zona (1:N),
--              agrega snapshot_location_id a recount_requests, y agrega columnas
--              compatibles a sessions y snapshot_products sin romper RPCs.
-- Author: Assistant

-- ============================================================
-- 1. ZONAS: permitir multiples ubicaciones por zona
--    Se elimina UNIQUE(company_id, session_zone_id) y se agrega una unique
--    compuesta que respalde la FK de count_entries manteniendo integridad.
-- ============================================================
ALTER TABLE inventarios.session_zone_locations
    DROP CONSTRAINT uq_inventarios_zone_locations_company_zone;

ALTER TABLE inventarios.session_zone_locations
    ADD CONSTRAINT uq_inventarios_zone_locations_company_zone_location
    UNIQUE (company_id, session_id, snapshot_id, session_zone_id, snapshot_location_id);

-- Una ubicacion sigue perteneciendo a una sola zona dentro de la jornada.
-- uq_inventarios_zone_locations_session_location ya lo garantiza.

-- ============================================================
-- 2. RECUENTOS: ubicacion explicita
-- ============================================================
ALTER TABLE inventarios.recount_requests
    ADD COLUMN snapshot_location_id uuid;

ALTER TABLE inventarios.recount_requests
    ADD CONSTRAINT fk_inventarios_recounts_location
    FOREIGN KEY (company_id, snapshot_id, snapshot_location_id)
    REFERENCES inventarios.snapshot_locations(company_id, snapshot_id, id)
    ON DELETE RESTRICT;

CREATE INDEX idx_inventarios_recounts_location
    ON inventarios.recount_requests (company_id, snapshot_id, snapshot_location_id);

-- ============================================================
-- 3. SESSIONS: columnas compatibles para stock source
-- ============================================================
ALTER TABLE inventarios.sessions
    ADD COLUMN stock_source text;

ALTER TABLE inventarios.sessions
    ADD COLUMN stock_import_id uuid;

ALTER TABLE inventarios.sessions
    ADD COLUMN stock_sync_run_id uuid;

ALTER TABLE inventarios.sessions
    ALTER COLUMN bsale_office_id DROP NOT NULL;

ALTER TABLE inventarios.sessions
    ADD CONSTRAINT fk_inventarios_sessions_stock_import
    FOREIGN KEY (company_id, stock_import_id)
    REFERENCES inventarios.stock_imports(company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE inventarios.sessions
    ADD CONSTRAINT fk_inventarios_sessions_stock_sync_run
    FOREIGN KEY (stock_sync_run_id)
    REFERENCES integraciones.bsale_sync_runs(id)
    ON DELETE RESTRICT;

-- Una importacion no puede asociarse a mas de una sesion
CREATE UNIQUE INDEX uq_inventarios_sessions_stock_import
    ON inventarios.sessions (company_id, stock_import_id)
    WHERE stock_import_id IS NOT NULL;

-- ============================================================
-- 4. SNAPSHOT_PRODUCTS: bsale_variant_id opcional
-- ============================================================
ALTER TABLE inventarios.snapshot_products
    ALTER COLUMN bsale_variant_id DROP NOT NULL;

-- ============================================================
-- 5. BACKFILL: sesiones historicas con bsale_office_id -> BSALE_SYNC
-- ============================================================
UPDATE inventarios.sessions
SET stock_source = 'BSALE_SYNC'
WHERE stock_source IS NULL AND bsale_office_id IS NOT NULL;

-- ============================================================
-- 6. PERMISOS DE LECTURA PARA NUEVAS TABLAS
-- ============================================================
GRANT SELECT ON TABLE inventarios.snapshot_theoretical_stocks TO authenticated;
GRANT SELECT ON TABLE inventarios.snapshot_unit_costs TO authenticated;
GRANT SELECT ON TABLE inventarios.official_version_location_items TO authenticated;
GRANT SELECT ON TABLE inventarios.session_zone_locations TO authenticated;
GRANT SELECT ON TABLE inventarios.recount_requests TO authenticated;
