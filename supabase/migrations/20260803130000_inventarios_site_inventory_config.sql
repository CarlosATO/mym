-- Migration: 20260803130000_inventarios_site_inventory_config.sql
-- Description: Fase 4I.2F. Configuracion dinamica de unidades inventariables:
--              include_in_general para campanas GENERAL. No modifica campanas
--              ya creadas (el alcance queda congelado en campaign_sites).
-- Author: Assistant

-- ============================================================
-- 1. COLUMNA include_in_general
-- ============================================================
ALTER TABLE inventarios.inventory_sites
    ADD COLUMN include_in_general boolean NOT NULL DEFAULT false;

-- ============================================================
-- 2. CONSTRAINT: include_in_general exige INTERNAL_WAREHOUSE activo y habilitado
-- ============================================================
ALTER TABLE inventarios.inventory_sites
    ADD CONSTRAINT chk_inventarios_sites_include_general
    CHECK (
        include_in_general = false
        OR (
            include_in_general = true
            AND site_type = 'INTERNAL_WAREHOUSE'
            AND is_active = true
            AND inventory_enabled = true
        )
    );

-- ============================================================
-- 3. CONSTRAINT: inventory_enabled=false implica include_in_general=false
-- ============================================================
ALTER TABLE inventarios.inventory_sites
    ADD CONSTRAINT chk_inventarios_sites_enabled_include_general
    CHECK (
        inventory_enabled = true
        OR include_in_general = false
    );
