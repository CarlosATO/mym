-- Migration: 20260803150000_inventarios_authorization_by_company.sql
-- Description: Fase 4I.2H. Resuelve permisos de Inventarios por rol de empresa
--              (core.user_company_access.role) con mapeo a portal.roles, y
--              fallback al rol global del portal cuando no hay mapeo o no hay
--              asignacion por empresa. Evita que un usuario con
--              user_company_access.role=FINANZAS herede permisos de un
--              portal.users.role_id=SUPER_USUARIO.
-- Author: Assistant

-- ============================================================
-- 1. RESOLUCION DE ROL POR EMPRESA
--    Devuelve el id de portal.roles aplicable al usuario para la empresa,
--    o NULL si no hay mapeo (entonces se usa el rol global).
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.resolve_company_role_id(
    p_user_id uuid,
    p_company_id uuid
)
RETURNS uuid LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_role_name text;
    v_role_id uuid;
BEGIN
    IF p_user_id IS NULL OR p_company_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT uca.role INTO v_role_name
    FROM core.user_company_access uca
    WHERE uca.user_id = p_user_id AND uca.company_id = p_company_id
      AND uca.is_active = true
    ORDER BY uca.created_at
    LIMIT 1;

    IF v_role_name IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT r.id INTO v_role_id
    FROM portal.roles r
    WHERE r.name = v_role_name AND r.is_active = true;

    RETURN v_role_id;
END;
$$;

-- ============================================================
-- 2. HAS PERMISSION POR EMPRESA
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.has_permission_for_company(
    p_user_id uuid,
    p_company_id uuid,
    p_permission_code text
)
RETURNS boolean LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_company_role_id uuid;
    v_global_role_id uuid;
    v_denied boolean;
BEGIN
    IF p_user_id IS NULL OR p_company_id IS NULL OR p_permission_code IS NULL THEN
        RETURN false;
    END IF;

    -- Denegacion explicita (user_permissions granted=false) siempre gana
    SELECT EXISTS (
        SELECT 1 FROM portal.user_permissions up
        JOIN portal.permissions p ON p.id = up.permission_id
        WHERE up.user_id = p_user_id AND p.code = p_permission_code AND up.granted = false
    ) INTO v_denied;
    IF v_denied THEN
        RETURN false;
    END IF;

    -- Permiso otorgado explícitamente (granted=true) siempre gana
    IF EXISTS (
        SELECT 1 FROM portal.user_permissions up
        JOIN portal.permissions p ON p.id = up.permission_id
        WHERE up.user_id = p_user_id AND p.code = p_permission_code AND up.granted = true
    ) THEN
        RETURN true;
    END IF;

    -- Rol por empresa como fuente canónica
    v_company_role_id := inventarios.resolve_company_role_id(p_user_id, p_company_id);

    -- system.admin por rol por empresa
    IF v_company_role_id IS NOT NULL AND p_permission_code <> 'system.admin' THEN
        IF EXISTS (
            SELECT 1 FROM portal.role_permissions rp
            JOIN portal.permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = v_company_role_id AND p.code = 'system.admin'
        ) THEN
            RETURN true;
        END IF;
        IF EXISTS (
            SELECT 1 FROM portal.role_permissions rp
            JOIN portal.permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = v_company_role_id AND p.code = p_permission_code
        ) THEN
            RETURN true;
        END IF;
        RETURN false;
    END IF;

    -- Fallback al rol global del portal (sin rol por empresa mapeable)
    SELECT role_id INTO v_global_role_id
    FROM portal.users
    WHERE id = p_user_id AND is_active = true AND deleted_at IS NULL;

    IF v_global_role_id IS NULL THEN
        RETURN false;
    END IF;

    IF p_permission_code <> 'system.admin' AND EXISTS (
        SELECT 1 FROM portal.role_permissions rp
        JOIN portal.permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = v_global_role_id AND p.code = 'system.admin'
    ) THEN
        RETURN true;
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM portal.role_permissions rp
        JOIN portal.permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = v_global_role_id AND p.code = p_permission_code
    );
END;
$$;

-- ============================================================
-- 3. REDEFINIR require_permission DE INVENTARIOS
--    Usa la resolucion por empresa y conserva require_company_access.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.require_permission(
    p_company_id uuid,
    p_permission_code text
)
RETURNS uuid LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_actor_uid uuid;
    v_permission_code text;
BEGIN
    IF p_permission_code IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El permiso solicitado no es valido para esta operacion.','retryable',false)::text;
    END IF;

    v_permission_code := pg_catalog.btrim(p_permission_code);

    IF v_permission_code = '' OR v_permission_code NOT LIKE 'inventarios.%' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El permiso solicitado no es valido para esta operacion.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_company_access(p_company_id);
    v_actor_uid := auth.uid();

    IF NOT inventarios.has_permission_for_company(v_actor_uid, p_company_id, v_permission_code) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes el permiso requerido para esta operacion.','retryable',false)::text;
    END IF;

    RETURN v_actor_id;
END;
$$;

-- ============================================================
-- 4. GET COMPANY PERMISSIONS (para guards del layout)
--    Devuelve los permisos del usuario para una empresa concreta.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_company_permissions(
    p_user_id uuid,
    p_company_id uuid
)
RETURNS TABLE (permission_code text)
LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_company_role_id uuid;
    v_global_role_id uuid;
BEGIN
    IF p_user_id IS NULL OR p_company_id IS NULL THEN
        RETURN;
    END IF;

    v_company_role_id := inventarios.resolve_company_role_id(p_user_id, p_company_id);

    IF v_company_role_id IS NOT NULL THEN
        RETURN QUERY
        SELECT DISTINCT p.code::text
        FROM portal.role_permissions rp
        JOIN portal.permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = v_company_role_id AND p.is_active = true;
    ELSE
        SELECT role_id INTO v_global_role_id
        FROM portal.users
        WHERE id = p_user_id AND is_active = true AND deleted_at IS NULL;
        IF v_global_role_id IS NOT NULL THEN
            RETURN QUERY
            SELECT DISTINCT p.code::text
            FROM portal.role_permissions rp
            JOIN portal.permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = v_global_role_id AND p.is_active = true;
        END IF;
    END IF;
END;
$$;

-- ============================================================
-- 5. GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.resolve_company_role_id(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.has_permission_for_company(uuid, uuid, text) OWNER TO postgres;
ALTER FUNCTION inventarios.require_permission(uuid, text) OWNER TO postgres;
ALTER FUNCTION inventarios.get_company_permissions(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.resolve_company_role_id(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.has_permission_for_company(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.require_permission(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_company_permissions(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.resolve_company_role_id(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.has_permission_for_company(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.require_permission(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_company_permissions(uuid, uuid) TO authenticated;
