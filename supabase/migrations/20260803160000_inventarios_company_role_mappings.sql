-- Migration: 20260803160000_inventarios_company_role_mappings.sql
-- Description: Fase 4I.2H.1. Autorizacion fail-closed por rol de empresa.
--              Mapeo declarativo y auditable de user_company_access.role a
--              portal.roles, con error seguro para roles no mapeados.
--              Elimina el fallback permisivo a portal.users.role_id.
-- Author: Assistant

-- ============================================================
-- 1. TABLA DE MAPEO DECLARATIVO
--    company_role: valor de core.user_company_access.role
--    portal_role_id: rol de portal.roles que otorga permisos
--    company_id: opcional; NULL = mapeo global por empresa
-- ============================================================
CREATE TABLE core.company_role_mappings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_role text NOT NULL,
    company_id uuid REFERENCES core.companies(id) ON DELETE CASCADE,
    portal_role_id uuid NOT NULL REFERENCES portal.roles(id) ON DELETE RESTRICT,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
    CONSTRAINT uq_company_role_mappings_role UNIQUE (company_role, company_id)
);

-- ============================================================
-- 2. MAPEO EXPLICITO DE LOS ROLES REALES
--    ADMIN -> SUPER_USUARIO (rol administrativo de la empresa)
--    FINANZAS -> FINANZAS
--    SUPER_USUARIO -> SUPER_USUARIO
-- ============================================================
INSERT INTO core.company_role_mappings (company_role, company_id, portal_role_id, is_active, created_at)
SELECT m.company_role, NULL, r.id, true, pg_catalog.now()
FROM (VALUES
    ('ADMIN', 'SUPER_USUARIO'),
    ('FINANZAS', 'FINANZAS'),
    ('SUPER_USUARIO', 'SUPER_USUARIO')
) AS m(company_role, role_name)
JOIN portal.roles r ON r.name = m.role_name AND r.is_active = true;

-- ============================================================
-- 3. RESOLUCION FAIL-CLOSED
--    Devuelve el rol de portal aplicable o lanza INV_COMPANY_ROLE_UNMAPPED.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.resolve_company_role_id(
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

    -- Rol por empresa (fuente canónica). Debe existir acceso activo.
    SELECT uca.role INTO v_company_role
    FROM core.user_company_access uca
    WHERE uca.user_id = p_user_id AND uca.company_id = p_company_id
      AND uca.is_active = true
    ORDER BY uca.created_at
    LIMIT 1;

    IF v_company_role IS NULL THEN
        RETURN NULL;
    END IF;

    -- 1) Mapeo declarativo especifico de la empresa
    SELECT crm.portal_role_id INTO v_mapped_role_id
    FROM core.company_role_mappings crm
    WHERE crm.company_role = v_company_role AND crm.company_id = p_company_id
      AND crm.is_active = true;

    -- 2) Mapeo declarativo global
    IF v_mapped_role_id IS NULL THEN
        SELECT crm.portal_role_id INTO v_mapped_role_id
        FROM core.company_role_mappings crm
        WHERE crm.company_role = v_company_role AND crm.company_id IS NULL
          AND crm.is_active = true;
    END IF;

    -- 3) Coincidencia implicita de nombre (rol empresarial = rol de portal)
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

    -- Fail-closed: rol empresarial desconocido se deniega
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COMPANY_ROLE_UNMAPPED',
        DETAIL=pg_catalog.jsonb_build_object(
            'message','El rol de empresa no tiene un mapeo autorizado.',
            'company_role', v_company_role, 'retryable', false)::text;
END;
$$;

-- ============================================================
-- 4. GRANTS / OWNER
-- ============================================================
GRANT SELECT ON TABLE core.company_role_mappings TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE core.company_role_mappings TO service_role;

ALTER FUNCTION inventarios.resolve_company_role_id(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.resolve_company_role_id(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.resolve_company_role_id(uuid, uuid) TO authenticated;
