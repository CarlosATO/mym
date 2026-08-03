-- Migration: 20260803140000_inventarios_remove_include_general.sql
-- Description: Fase 4I.2G. Elimina include_in_general: todas las bodegas internas
--              activas y habilitadas participan en futuras campanas GENERAL.
--              Se retiran la columna, sus constraints y su uso en RPCs.
--              Las campanas existentes conservan su alcance congelado.
-- Author: Assistant

-- ============================================================
-- 1. RETIRAR CONSTRAINTS RELACIONADAS
-- ============================================================
ALTER TABLE inventarios.inventory_sites
    DROP CONSTRAINT IF EXISTS chk_inventarios_sites_include_general;

ALTER TABLE inventarios.inventory_sites
    DROP CONSTRAINT IF EXISTS chk_inventarios_sites_enabled_include_general;

-- ============================================================
-- 2. ELIMINAR LA COLUMNA
-- ============================================================
ALTER TABLE inventarios.inventory_sites
    DROP COLUMN IF EXISTS include_in_general;
