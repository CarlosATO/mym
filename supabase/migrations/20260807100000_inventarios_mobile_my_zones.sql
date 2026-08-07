-- Migration: 20260807100000_inventarios_mobile_my_zones.sql
-- Description: M1.1A - Backend RPC for the Android app to list user's assigned counting zones.
-- Author: Assistant

SET search_path = pg_catalog, public, inventarios;

CREATE OR REPLACE FUNCTION inventarios.list_my_active_counting_zones()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, inventarios
AS $$
DECLARE
    v_actor_id uuid;
    v_actor_display_name text;
    v_result jsonb;
    v_zones_array jsonb;
    v_zone_count int;
BEGIN
    -- 1. Resolver identidad
    v_actor_id := inventarios.require_actor();

    SELECT btrim(u.nombre || ' ' || u.apellido) INTO v_actor_display_name
    FROM portal.users u
    WHERE u.id = v_actor_id;

    -- 2. Consultar zonas
    WITH counted_locations AS (
        SELECT session_zone_id, count(*) as location_count
        FROM inventarios.session_zone_locations
        GROUP BY session_zone_id
    ),
    my_zones AS (
        SELECT
            s.id AS session_id,
            s.name AS session_label,
            c.id AS inventory_id,
            c.name AS inventory_name,
            st.id AS site_id,
            st.name AS site_name,
            z.id AS zone_id,
            z.zone_code,
            z.display_name AS zone_name,
            t.id AS task_id,
            t.status AS task_status,
            COALESCE(loc.location_count, 0) AS location_count,
            z.priority
        FROM inventarios.task_assignments a
        JOIN inventarios.tasks t ON t.id = a.task_id
        JOIN inventarios.session_zones z ON z.id = t.session_zone_id
        JOIN inventarios.sessions s ON s.id = z.session_id
        JOIN inventarios.inventory_campaigns c ON c.id = s.campaign_id
        JOIN inventarios.inventory_sites st ON st.id = s.inventory_site_id
        JOIN inventarios.session_participants p ON p.id = a.session_participant_id
        LEFT JOIN counted_locations loc ON loc.session_zone_id = z.id
        WHERE
            a.user_id = v_actor_id
            AND a.released_at IS NULL
            AND p.user_id = v_actor_id
            AND p.revoked_at IS NULL
            AND s.status = 'COUNTING'
            AND z.is_enabled = true
            AND t.cancelled_at IS NULL
            AND t.superseded_at IS NULL
            AND t.invalidated_at IS NULL
            AND t.status IN ('ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED')
        ORDER BY
            s.created_at ASC,
            z.priority ASC,
            z.zone_code ASC
    )
    SELECT
        COALESCE(jsonb_agg(
            jsonb_build_object(
                'session_id', session_id,
                'session_label', session_label,
                'inventory_id', inventory_id,
                'inventory_name', inventory_name,
                'site_id', site_id,
                'site_name', site_name,
                'zone_id', zone_id,
                'zone_code', zone_code,
                'zone_name', zone_name,
                'task_id', task_id,
                'task_status', task_status,
                'location_count', location_count
            )
        ), '[]'::jsonb),
        COUNT(*)
    INTO v_zones_array, v_zone_count
    FROM my_zones;

    -- 3. Ensamblar respuesta
    v_result := jsonb_build_object(
        'actor', jsonb_build_object(
            'id', v_actor_id,
            'display_name', v_actor_display_name
        ),
        'zone_count', v_zone_count,
        'zones', v_zones_array
    );

    RETURN v_result;
END;
$$;

ALTER FUNCTION inventarios.list_my_active_counting_zones() OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.list_my_active_counting_zones() FROM PUBLIC;
REVOKE ALL ON FUNCTION inventarios.list_my_active_counting_zones() FROM anon;
GRANT EXECUTE ON FUNCTION inventarios.list_my_active_counting_zones() TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.list_my_active_counting_zones() TO service_role;
