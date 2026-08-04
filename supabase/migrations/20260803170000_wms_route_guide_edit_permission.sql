-- Migration: 20260803170000_wms_route_guide_edit_permission.sql
-- Description: Fase WMS-RG.1. Permiso route_guides.edit_unsettled (solo
--              SUPER_USUARIO) y helpers transversales de autorizacion por
--              empresa en schema core, reutilizando company_role_mappings.
--              Los helpers de inventarios pasan a ser wrappers de los de core.
-- Author: Assistant

-- ============================================================
-- 1. PERMISO edit_unsettled (SOLO SUPER_USUARIO)
-- ============================================================
INSERT INTO portal.permissions (code, name, module_id)
SELECT 'logistica.route_guides.edit_unsettled', 'Editar Guías de Ruta no rendidas', module.id
FROM portal.modules module
WHERE module.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name, module_id = EXCLUDED.module_id;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r
JOIN portal.permissions p ON p.code = 'logistica.route_guides.edit_unsettled' AND p.is_active = true
WHERE r.name = 'SUPER_USUARIO' AND r.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Limpieza defensiva: ningun otro rol recibe el permiso
DELETE FROM portal.role_permissions rp
USING portal.roles r, portal.permissions p
WHERE rp.role_id = r.id AND rp.permission_id = p.id
  AND p.code = 'logistica.route_guides.edit_unsettled'
  AND r.name <> 'SUPER_USUARIO';

-- ============================================================
-- 2. HELPERS TRANSVERSALES EN CORE (fail-closed por empresa)
-- ============================================================
CREATE OR REPLACE FUNCTION core.resolve_company_role_id(
    p_user_id uuid,
    p_company_id uuid
)
RETURNS uuid LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_company_role text;
    v_mapped_role_id uuid;
    v_implicit_role_id uuid;
BEGIN
    IF p_user_id IS NULL OR p_company_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT uca.role INTO v_company_role
    FROM core.user_company_access uca
    WHERE uca.user_id = p_user_id AND uca.company_id = p_company_id
      AND uca.is_active = true
    ORDER BY uca.created_at
    LIMIT 1;

    IF v_company_role IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT crm.portal_role_id INTO v_mapped_role_id
    FROM core.company_role_mappings crm
    WHERE crm.company_role = v_company_role AND crm.company_id = p_company_id
      AND crm.is_active = true;

    IF v_mapped_role_id IS NULL THEN
        SELECT crm.portal_role_id INTO v_mapped_role_id
        FROM core.company_role_mappings crm
        WHERE crm.company_role = v_company_role AND crm.company_id IS NULL
          AND crm.is_active = true;
    END IF;

    IF v_mapped_role_id IS NULL THEN
        SELECT r.id INTO v_implicit_role_id
        FROM portal.roles r
        WHERE r.name = v_company_role AND r.is_active = true;
    END IF;

    IF v_mapped_role_id IS NOT NULL THEN
        RETURN v_mapped_role_id;
    END IF;
    IF v_implicit_role_id IS NOT NULL THEN
        RETURN v_implicit_role_id;
    END IF;

    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COMPANY_ROLE_UNMAPPED',
        DETAIL=pg_catalog.jsonb_build_object(
            'message','El rol de empresa no tiene un mapeo autorizado.',
            'company_role', v_company_role, 'retryable', false)::text;
END;
$$;

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
        SELECT 1 FROM portal.user_permissions up
        JOIN portal.permissions p ON p.id = up.permission_id
        WHERE up.user_id = p_user_id AND p.code = p_permission_code AND up.granted = false
    ) INTO v_denied;
    IF v_denied THEN
        RETURN false;
    END IF;

    IF EXISTS (
        SELECT 1 FROM portal.user_permissions up
        JOIN portal.permissions p ON p.id = up.permission_id
        WHERE up.user_id = p_user_id AND p.code = p_permission_code AND up.granted = true
    ) THEN
        RETURN true;
    END IF;

    v_company_role_id := core.resolve_company_role_id(p_user_id, p_company_id);

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
-- 3. REDEFINIR HELPERS DE INVENTARIOS COMO WRAPPERS DE CORE
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.resolve_company_role_id(
    p_user_id uuid,
    p_company_id uuid
)
RETURNS uuid LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    RETURN core.resolve_company_role_id(p_user_id, p_company_id);
END;
$$;

CREATE OR REPLACE FUNCTION inventarios.has_permission_for_company(
    p_user_id uuid,
    p_company_id uuid,
    p_permission_code text
)
RETURNS boolean LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    RETURN core.has_permission_for_company(p_user_id, p_company_id, p_permission_code);
END;
$$;

-- ============================================================
-- 4. GRANTS / OWNER
-- ============================================================
ALTER FUNCTION core.resolve_company_role_id(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION core.has_permission_for_company(uuid, uuid, text) OWNER TO postgres;
ALTER FUNCTION inventarios.resolve_company_role_id(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.has_permission_for_company(uuid, uuid, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION core.resolve_company_role_id(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION core.has_permission_for_company(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.resolve_company_role_id(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.has_permission_for_company(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION core.resolve_company_role_id(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION core.has_permission_for_company(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.resolve_company_role_id(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.has_permission_for_company(uuid, uuid, text) TO authenticated;
