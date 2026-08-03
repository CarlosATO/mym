-- Migration: 20260803105010_inventarios_catalogs_offices_fix.sql
-- Description: Corrige get_inventory_session_catalogs: bsale_offices no tiene is_active ni code.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_catalogs(
    p_company_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_warehouses jsonb;
    v_offices jsonb;
    v_locations jsonb;
    v_users jsonb;
    v_roles jsonb;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', w.id, 'code', w.code, 'name', w.name,
                'warehouse_type', w.warehouse_type, 'is_default', w.is_default
            )
            ORDER BY w.code
        )
    END
    INTO v_warehouses
    FROM adquisiciones.warehouses w
    WHERE w.company_id = p_company_id AND w.is_active = true AND w.status = 'ACTIVE';

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'bsale_id', bo.bsale_id, 'name', bo.name, 'code', bo.bsale_id::text
            )
            ORDER BY bo.name
        )
    END
    INTO v_offices
    FROM integraciones.bsale_offices bo
    WHERE bo.company_id = p_company_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', l.id, 'warehouse_id', l.warehouse_id, 'code', l.code,
                'name', l.name, 'aisle', l.aisle, 'rack', l.rack,
                'level', l.level, 'position', l.position
            )
            ORDER BY l.code
        )
    END
    INTO v_locations
    FROM logistica.locations l
    WHERE l.company_id = p_company_id AND l.is_active = true;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', u.id, 'email', u.email, 'nombre', u.nombre, 'apellido', u.apellido
            )
            ORDER BY u.nombre, u.apellido
        )
    END
    INTO v_users
    FROM portal.users u
    JOIN core.user_company_access uca
      ON uca.user_id = u.id AND uca.company_id = p_company_id AND uca.is_active = true
    WHERE u.is_active = true AND u.deleted_at IS NULL;

    v_roles := '["COUNTER","SUPERVISOR","ADMINISTRATOR","MANAGER"]'::jsonb;

    RETURN pg_catalog.jsonb_build_object(
        'warehouses', v_warehouses,
        'offices', v_offices,
        'locations', v_locations,
        'users', v_users,
        'functional_roles', v_roles
    );
END;
$$;

ALTER FUNCTION inventarios.get_inventory_session_catalogs(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_session_catalogs(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_catalogs(uuid) TO authenticated;
