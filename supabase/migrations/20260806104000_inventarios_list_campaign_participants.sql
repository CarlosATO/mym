-- 4I.3C.7C.3E.2A: RPC de listado del equipo global de campana.
-- Devuelve roles activos y revocados (historial preservado), con conteos
-- de roles activos. Lectura autorizada con inventarios.campaigns.read.

CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaign_participants(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_participants jsonb;
    v_counters bigint; v_supervisors bigint; v_admins bigint; v_managers bigint;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    PERFORM inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    IF NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_campaigns c
        WHERE c.company_id = p_company_id AND c.id = p_campaign_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    -- LEFT JOIN preserva filas historicas aunque el usuario este inactivo,
    -- eliminado logicamente o sin acceso actual a la empresa.
    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'participant_id', p.id,
            'user_id', p.user_id,
            'user_name', u.nombre,
            'email', u.email,
            'user_is_active', CASE WHEN u.is_active IS NULL THEN false ELSE u.is_active END,
            'participant_role', p.participant_role,
            'state', CASE WHEN p.revoked_at IS NULL THEN 'ACTIVE' ELSE 'REVOKED' END,
            'active_from', p.active_from,
            'revoked_at', p.revoked_at,
            'revocation_reason', p.revocation_reason,
            'created_by', p.created_by
        )
        ORDER BY u.nombre, p.user_id, p.participant_role, p.active_from
    )
    INTO v_participants
    FROM inventarios.inventory_campaign_participants p
    LEFT JOIN portal.users u ON u.id = p.user_id
    WHERE p.company_id = p_company_id AND p.campaign_id = p_campaign_id;

    -- Conteos: unicamente roles activos.
    SELECT pg_catalog.count(*) FILTER (WHERE participant_role = 'COUNTER'),
           pg_catalog.count(*) FILTER (WHERE participant_role = 'SUPERVISOR'),
           pg_catalog.count(*) FILTER (WHERE participant_role = 'ADMINISTRATOR'),
           pg_catalog.count(*) FILTER (WHERE participant_role = 'MANAGER')
    INTO v_counters, v_supervisors, v_admins, v_managers
    FROM inventarios.inventory_campaign_participants
    WHERE company_id = p_company_id AND campaign_id = p_campaign_id
      AND revoked_at IS NULL;

    RETURN pg_catalog.jsonb_build_object(
        'participants', coalesce(v_participants, '[]'::jsonb),
        'counts', pg_catalog.jsonb_build_object(
            'COUNTER', v_counters,
            'SUPERVISOR', v_supervisors,
            'ADMINISTRATOR', v_admins,
            'MANAGER', v_managers
        )
    );
END;
$$;

ALTER FUNCTION inventarios.list_inventory_campaign_participants(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.list_inventory_campaign_participants(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_participants(uuid, uuid) TO authenticated;
