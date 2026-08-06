-- 4I.3C.7C.3E.6B.1: RPC de catalogo autorizado de usuarios de campana.
-- Devuelve exclusivamente usuarios activos con acceso activo a la empresa:
--   portal.users con is_active = true y deleted_at IS NULL, y core.user_company_access
--   activa para p_company_id. Lectura autorizada con inventarios.campaigns.read.
-- No crea tablas, datos, policies ni triggers.

CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaign_user_catalog(
    p_company_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_users jsonb;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    PERFORM inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'user_id', u.id,
                'nombre', u.nombre,
                'apellido', u.apellido,
                'email', u.email
            )
            ORDER BY u.nombre, u.apellido, u.email
        )
    END
    INTO v_users
    FROM portal.users u
    JOIN core.user_company_access uca
      ON uca.user_id = u.id AND uca.company_id = p_company_id AND uca.is_active = true
    WHERE u.is_active = true AND u.deleted_at IS NULL;

    RETURN pg_catalog.jsonb_build_object('users', v_users);
END;
$$;

ALTER FUNCTION inventarios.list_inventory_campaign_user_catalog(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.list_inventory_campaign_user_catalog(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_user_catalog(uuid) TO authenticated;
