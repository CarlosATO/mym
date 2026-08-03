-- Migration: 20260803140200_inventarios_sites_scope_rpcs.sql
-- Description: Fase 4I.2G. Redefine RPCs de sitios y sync sin include_in_general.
--              sync_internal_inventory_sites ya no toca configuracion de inclusion;
--              una bodega interna activa y habilitada participa en GENERAL.
-- Author: Assistant

-- ============================================================
-- 1. SYNC: nueva bodega activa -> inventory_enabled=true (participa en GENERAL)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.sync_internal_inventory_sites(
    p_company_id uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_site_row record;
    v_location record;
    v_site_id uuid;
    v_sites_created integer := 0;
    v_sites_updated integer := 0;
    v_locations_created integer := 0;
    v_locations_updated integer := 0;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sites.manage');

    FOR v_site_row IN
        SELECT w.id AS warehouse_id, w.code, w.name, w.is_active, w.status
        FROM adquisiciones.warehouses w
        WHERE w.company_id = p_company_id
        ORDER BY w.code
    LOOP
        SELECT id INTO v_site_id
        FROM inventarios.inventory_sites
        WHERE company_id = p_company_id AND warehouse_id = v_site_row.warehouse_id
          AND site_type = 'INTERNAL_WAREHOUSE';

        IF v_site_id IS NULL THEN
            INSERT INTO inventarios.inventory_sites (
                company_id, name, code, site_type, warehouse_id, is_active,
                inventory_enabled, created_at, created_by, updated_at, updated_by
            ) VALUES (
                p_company_id, v_site_row.name, v_site_row.code, 'INTERNAL_WAREHOUSE',
                v_site_row.warehouse_id, coalesce(v_site_row.is_active, true),
                coalesce(v_site_row.is_active, true),
                pg_catalog.now(), v_actor_id, pg_catalog.now(), v_actor_id
            )
            RETURNING id INTO v_site_id;
            v_sites_created := v_sites_created + 1;
        ELSE
            UPDATE inventarios.inventory_sites
            SET name = v_site_row.name,
                code = v_site_row.code,
                is_active = coalesce(v_site_row.is_active, true),
                updated_at = pg_catalog.now(),
                updated_by = v_actor_id
            WHERE id = v_site_id;
            v_sites_updated := v_sites_updated + 1;

            -- Si la bodega quedo inactiva, impedir su participacion en nuevas campanas.
            IF NOT coalesce(v_site_row.is_active, true) THEN
                UPDATE inventarios.inventory_sites
                SET inventory_enabled = false,
                    updated_at = pg_catalog.now(),
                    updated_by = v_actor_id
                WHERE id = v_site_id AND inventory_enabled = true;
            END IF;
        END IF;

        FOR v_location IN
            SELECT l.id AS location_id, l.code, l.name, l.aisle, l.rack, l.level,
                   l.position, l.is_active
            FROM logistica.locations l
            WHERE l.company_id = p_company_id AND l.warehouse_id = v_site_row.warehouse_id
            ORDER BY l.code
        LOOP
            IF EXISTS (
                SELECT 1 FROM inventarios.inventory_site_locations isl
                WHERE isl.company_id = p_company_id
                  AND isl.inventory_site_id = v_site_id
                  AND isl.source_logistics_location_id = v_location.location_id
            ) THEN
                UPDATE inventarios.inventory_site_locations
                SET code = v_location.code,
                    name = v_location.name,
                    aisle = v_location.aisle,
                    rack = v_location.rack,
                    level = v_location.level,
                    position = v_location.position,
                    is_active = v_location.is_active,
                    updated_at = pg_catalog.now(),
                    updated_by = v_actor_id
                WHERE company_id = p_company_id
                  AND inventory_site_id = v_site_id
                  AND source_logistics_location_id = v_location.location_id;
                v_locations_updated := v_locations_updated + 1;
            ELSE
                INSERT INTO inventarios.inventory_site_locations (
                    company_id, inventory_site_id, source_logistics_location_id,
                    code, name, aisle, rack, level, position, is_active,
                    created_at, created_by, updated_at, updated_by
                ) VALUES (
                    p_company_id, v_site_id, v_location.location_id,
                    v_location.code, v_location.name, v_location.aisle, v_location.rack,
                    v_location.level, v_location.position, v_location.is_active,
                    pg_catalog.now(), v_actor_id, pg_catalog.now(), v_actor_id
                );
                v_locations_created := v_locations_created + 1;
            END IF;
        END LOOP;
    END LOOP;

    RETURN pg_catalog.jsonb_build_object(
        'sites_created', v_sites_created,
        'sites_updated', v_sites_updated,
        'locations_created', v_locations_created,
        'locations_updated', v_locations_updated
    );
END;
$$;

-- ============================================================
-- 2. UPDATE INVENTORY SITE (sin include_in_general)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.update_inventory_site(
    p_company_id uuid,
    p_site_id uuid,
    p_name text,
    p_is_active boolean,
    p_inventory_enabled boolean
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_name text;
    v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    v_name := pg_catalog.btrim(coalesce(p_name, ''));
    IF p_company_id IS NULL OR p_site_id IS NULL OR v_name = '' OR pg_catalog.char_length(v_name) > 200 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sites.manage');
    v_occurred_at := pg_catalog.now();

    UPDATE inventarios.inventory_sites
    SET name = v_name,
        is_active = coalesce(p_is_active, is_active),
        inventory_enabled = coalesce(p_inventory_enabled, inventory_enabled),
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_site_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad inventariable no existe.','retryable',false)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_site_id, 'state', 'UPDATED', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('site_id', p_site_id)
    );
    RETURN v_response;
END;
$$;

-- ============================================================
-- 3. SET INVENTORY SITE INVENTORY CONFIG (solo inventory_enabled)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.set_inventory_site_inventory_config(
    p_company_id uuid,
    p_site_id uuid,
    p_inventory_enabled boolean
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_site_id IS NULL OR p_inventory_enabled IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sites.manage');
    v_occurred_at := pg_catalog.now();

    UPDATE inventarios.inventory_sites
    SET inventory_enabled = p_inventory_enabled,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_site_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad inventariable no existe.','retryable',false)::text;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_site_id, 'state', 'UPDATED', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('site_id', p_site_id)
    );
    RETURN v_response;
END;
$$;

-- ============================================================
-- 4. LIST (sin include_in_general)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_inventory_sites(
    p_company_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_rows jsonb;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sites.read');

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', is2.id,
            'company_id', is2.company_id,
            'name', is2.name,
            'code', is2.code,
            'site_type', is2.site_type,
            'warehouse_id', is2.warehouse_id,
            'warehouse_name', w.name,
            'is_active', is2.is_active,
            'inventory_enabled', is2.inventory_enabled,
            'location_count', (
                SELECT pg_catalog.count(*) FROM inventarios.inventory_site_locations isl
                WHERE isl.company_id = is2.company_id AND isl.inventory_site_id = is2.id
                  AND isl.is_active = true
            ),
            'created_at', is2.created_at,
            'updated_at', is2.updated_at
        ) ORDER BY is2.code
    )
    INTO v_rows
    FROM inventarios.inventory_sites is2
    LEFT JOIN adquisiciones.warehouses w ON w.id = is2.warehouse_id
    WHERE is2.company_id = p_company_id;

    RETURN pg_catalog.jsonb_build_object(
        'sites', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END
    );
END;
$$;

-- ============================================================
-- 5. GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.sync_internal_inventory_sites(uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.update_inventory_site(uuid, uuid, text, boolean, boolean) OWNER TO postgres;
ALTER FUNCTION inventarios.set_inventory_site_inventory_config(uuid, uuid, boolean) OWNER TO postgres;
ALTER FUNCTION inventarios.list_inventory_sites(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.sync_internal_inventory_sites(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.update_inventory_site(uuid, uuid, text, boolean, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.set_inventory_site_inventory_config(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.list_inventory_sites(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.sync_internal_inventory_sites(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.update_inventory_site(uuid, uuid, text, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.set_inventory_site_inventory_config(uuid, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_sites(uuid) TO authenticated;
