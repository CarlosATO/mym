-- Migration: 20260803190500_inventarios_prepare_import_grants.sql
-- Description: Fase 4I.3B. Grants y owner de prepare_inventory_session_from_import.
-- Author: Assistant

-- ============================================================
-- GRANTS / OWNER
-- ============================================================
-- ============================================================
-- GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.prepare_inventory_session_from_import(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.prepare_inventory_session_from_import(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.prepare_inventory_session_from_import(uuid, uuid, uuid) TO authenticated;
