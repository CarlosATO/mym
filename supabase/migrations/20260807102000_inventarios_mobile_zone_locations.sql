-- Migration: 20260807102000_inventarios_mobile_zone_locations.sql
-- Description: M1.2A - Get zone locations for mobile app
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.get_my_counting_zone_locations(p_zone_id pg_catalog.uuid)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id pg_catalog.uuid;
    v_zone_data pg_catalog.jsonb;
    v_locations_array pg_catalog.jsonb;
    v_location_count pg_catalog.int4;
    v_is_authorized pg_catalog.bool;
BEGIN
    -- 1. Resolver actor
    v_actor_id := inventarios.require_actor();

    -- 2. Autorizacion estricta
    SELECT true INTO v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION
            USING ERRCODE = 'P0001',
                  MESSAGE = 'INV_ACCESS_DENIED',
                  DETAIL = pg_catalog.jsonb_build_object(
                      'message', 'No tienes acceso a esta zona de conteo.',
                      'retryable', false
                  )::pg_catalog.text;
    END IF;

    -- 3. Obtener zona info
    SELECT pg_catalog.jsonb_build_object(
        'zone_id', z.id,
        'zone_name', z.display_name,
        'zone_code', z.zone_code,
        'task_id', t.id,
        'task_status', t.status,
        'inventory_name', c.name,
        'site_name', st.name
    ) INTO v_zone_data
    FROM inventarios.session_zones z
    JOIN inventarios.tasks t ON t.session_zone_id = z.id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.inventory_campaigns c ON c.id = s.campaign_id
    JOIN inventarios.inventory_sites st ON st.id = s.inventory_site_id
    JOIN inventarios.task_assignments a ON a.task_id = t.id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL
    LIMIT 1;

    -- 4. Obtener ubicaciones
    WITH locs AS (
        SELECT 
            sl.location_id,
            sl.code AS location_code,
            sl.name AS location_name,
            pg_catalog.row_number() over (order by sl.code asc, sl.name asc) AS sort_order
        FROM inventarios.session_zone_locations szl
        JOIN inventarios.snapshot_locations sl ON sl.id = szl.snapshot_location_id
        WHERE szl.session_zone_id = p_zone_id
        ORDER BY sl.code ASC, sl.name ASC
    )
    SELECT 
        COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'location_id', location_id,
                'location_code', location_code,
                'location_name', location_name,
                'sort_order', sort_order
            )
        ), '[]'::pg_catalog.jsonb),
        COUNT(*)
    INTO v_locations_array, v_location_count
    FROM locs;

    -- 5. Ensamblar payload
    RETURN pg_catalog.jsonb_build_object(
        'zone', v_zone_data,
        'location_count', v_location_count,
        'locations', v_locations_array
    );
END;
$$;

ALTER FUNCTION inventarios.get_my_counting_zone_locations(pg_catalog.uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_my_counting_zone_locations(pg_catalog.uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventarios.get_my_counting_zone_locations(pg_catalog.uuid) FROM anon;
GRANT EXECUTE ON FUNCTION inventarios.get_my_counting_zone_locations(pg_catalog.uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_my_counting_zone_locations(pg_catalog.uuid) TO service_role;
