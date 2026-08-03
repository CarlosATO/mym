-- Migration: 20260803120150_inventarios_site_locations_unique_fix.sql
-- Description: Fase 4I.2E. Agrega UNIQUE(company_id, inventory_site_id, id) a
--              inventory_site_locations para respaldar la FK compuesta de
--              stock_import_rows.inventory_site_location_id.
-- Author: Assistant

ALTER TABLE inventarios.inventory_site_locations
    ADD CONSTRAINT uq_inventarios_site_locations_site_id UNIQUE (company_id, inventory_site_id, id);
