-- Migration: 20260902120000_inventarios_system_admin_authorization.sql
-- Description: Treat the global system.admin permission as an ERP-wide
--              authorization bypass for company-scoped Inventarios permissions.

CREATE OR REPLACE FUNCTION core.has_permission_for_company(
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

    SELECT EXISTS (
        SELECT 1
        FROM portal.user_permissions up
        JOIN portal.permissions p ON p.id = up.permission_id
        WHERE up.user_id = p_user_id
          AND p.code = p_permission_code
          AND up.granted = false
    ) INTO v_denied;
    IF v_denied THEN
        RETURN false;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM portal.user_permissions up
        JOIN portal.permissions p ON p.id = up.permission_id
        WHERE up.user_id = p_user_id
          AND p.code = p_permission_code
          AND up.granted = true
    ) THEN
        RETURN true;
    END IF;

    -- system.admin is global and bypasses functional Inventarios permissions.
    IF p_permission_code <> 'system.admin'
       AND portal.user_has_permission(p_user_id, 'system.admin') THEN
        RETURN true;
    END IF;

    v_company_role_id := core.resolve_company_role_id(p_user_id, p_company_id);

    IF v_company_role_id IS NULL THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM portal.role_permissions rp
        JOIN portal.permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = v_company_role_id
          AND p.code = p_permission_code
    );
END;
$$;

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

    -- Keep the UI read model aligned with the server-side authorization.
    IF portal.user_has_permission(p_user_id, 'system.admin') THEN
        RETURN QUERY
        SELECT p.code::text
        FROM portal.permissions p
        WHERE p.is_active = true;
        RETURN;
    END IF;

    v_company_role_id := inventarios.resolve_company_role_id(p_user_id, p_company_id);

    IF v_company_role_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT DISTINCT p.code::text
    FROM portal.role_permissions rp
    JOIN portal.permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = v_company_role_id
      AND p.is_active = true;
END;
$$;

ALTER FUNCTION core.has_permission_for_company(uuid, uuid, text) OWNER TO postgres;
ALTER FUNCTION inventarios.get_company_permissions(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION core.has_permission_for_company(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_company_permissions(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION core.has_permission_for_company(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_company_permissions(uuid, uuid) TO authenticated;
