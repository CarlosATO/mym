-- Migration: 20260803160100_inventarios_permission_fail_closed.sql
-- Description: Fase 4I.2H.1. has_permission_for_company y get_company_permissions
--              fail-closed: derivan exclusivamente del rol de empresa mapeado.
--              Se elimina el fallback permisivo a portal.users.role_id.
-- Author: Assistant

-- ============================================================
-- 1. HAS PERMISSION FOR COMPANY (fail-closed)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.has_permission_for_company(
    p_user_id uuid,
    p_company_id uuid,
    p_permission_code text
)
RETURNS boolean LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_company_role_id uuid;
    v_denied boolean;
BEGIN
    IF p_user_id IS NULL OR p_company_id IS NULL OR p_permission_code IS NULL THEN
        RETURN false;
    END IF;

    -- Denegacion explicita (granted=false) siempre gana
    SELECT EXISTS (
        SELECT 1 FROM portal.user_permissions up
        JOIN portal.permissions p ON p.id = up.permission_id
        WHERE up.user_id = p_user_id AND p.code = p_permission_code AND up.granted = false
    ) INTO v_denied;
    IF v_denied THEN
        RETURN false;
    END IF;

    -- Permiso otorgado explicitamente (granted=true) gana
    IF EXISTS (
        SELECT 1 FROM portal.user_permissions up
        JOIN portal.permissions p ON p.id = up.permission_id
        WHERE up.user_id = p_user_id AND p.code = p_permission_code AND up.granted = true
    ) THEN
        RETURN true;
    END IF;

    -- Rol por empresa: fail-closed (puede lanzar INV_COMPANY_ROLE_UNMAPPED)
    v_company_role_id := inventarios.resolve_company_role_id(p_user_id, p_company_id);

    IF v_company_role_id IS NULL THEN
        RETURN false;
    END IF;

    IF p_permission_code <> 'system.admin' AND EXISTS (
        SELECT 1 FROM portal.role_permissions rp
        JOIN portal.permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = v_company_role_id AND p.code = 'system.admin'
    ) THEN
        RETURN true;
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM portal.role_permissions rp
        JOIN portal.permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = v_company_role_id AND p.code = p_permission_code
    );
END;
$$;

-- ============================================================
-- 2. GET COMPANY PERMISSIONS (fail-closed)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_company_permissions(
    p_user_id uuid,
    p_company_id uuid
)
RETURNS TABLE (permission_code text)
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_company_role_id uuid;
BEGIN
    IF p_user_id IS NULL OR p_company_id IS NULL THEN
        RETURN;
    END IF;

    -- Fail-closed: puede lanzar INV_COMPANY_ROLE_UNMAPPED
    v_company_role_id := inventarios.resolve_company_role_id(p_user_id, p_company_id);

    IF v_company_role_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT DISTINCT p.code::text
    FROM portal.role_permissions rp
    JOIN portal.permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = v_company_role_id AND p.is_active = true;
END;
$$;

-- ============================================================
-- 3. GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.has_permission_for_company(uuid, uuid, text) OWNER TO postgres;
ALTER FUNCTION inventarios.get_company_permissions(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.has_permission_for_company(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_company_permissions(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.has_permission_for_company(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_company_permissions(uuid, uuid) TO authenticated;
