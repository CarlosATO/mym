-- Migration: 20260803097000_inventarios_harden_display_name.sql
-- Description: Fase 4H.2F1 (control de seguridad). Re-afirma que el helper
--              inventarios.user_display_name no exponga EXECUTE a ningun rol.
--              No cambia la logica del helper.
-- Author: Assistant

REVOKE ALL ON FUNCTION inventarios.user_display_name(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios
    REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios
    REVOKE EXECUTE ON FUNCTIONS FROM authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios
    REVOKE EXECUTE ON FUNCTIONS FROM service_role;
