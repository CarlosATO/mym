-- Migration: 20260803130100_inventarios_site_config_rpcs.sql
-- Description: Fase 4I.2F. Actualiza sync_internal_inventory_sites para no
--              sobrescribir configuracion, agrega set_inventory_site_inventory_config,
--              y actualiza reglas GENERAL/SELECTIVE/EXTERNAL en campanas.
-- Author: Assistant

-- ============================================================
-- 1. SYNC: conservar config, forzar include_in_general=false si inactiva
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
            -- Nueva bodega: habilitada, pero NO incluida en GENERAL por defecto
            INSERT INTO inventarios.inventory_sites (
                company_id, name, code, site_type, warehouse_id, is_active,
                inventory_enabled, include_in_general, created_at, created_by,
                updated_at, updated_by
            ) VALUES (
                p_company_id, v_site_row.name, v_site_row.code, 'INTERNAL_WAREHOUSE',
                v_site_row.warehouse_id, coalesce(v_site_row.is_active, true),
                coalesce(v_site_row.is_active, true), false,
                pg_catalog.now(), v_actor_id, pg_catalog.now(), v_actor_id
            )
            RETURNING id INTO v_site_id;
            v_sites_created := v_sites_created + 1;
        ELSE
            -- Conservar inventory_enabled e include_in_general (decisiones del usuario).
            -- Solo sincronizar nombre/codigo/estado de la bodega.
            UPDATE inventarios.inventory_sites
            SET name = v_site_row.name,
                code = v_site_row.code,
                is_active = coalesce(v_site_row.is_active, true),
                updated_at = pg_catalog.now(),
                updated_by = v_actor_id
            WHERE id = v_site_id;
            v_sites_updated := v_sites_updated + 1;

            -- Si la bodega quedo inactiva, impedir su inclusion en campanas nuevas.
            IF NOT coalesce(v_site_row.is_active, true) THEN
                UPDATE inventarios.inventory_sites
                SET include_in_general = false,
                    inventory_enabled = false,
                    updated_at = pg_catalog.now(),
                    updated_by = v_actor_id
                WHERE id = v_site_id AND (include_in_general = true OR inventory_enabled = true);
            END IF;
        END IF;

        -- Sincronizar ubicaciones de la bodega interna
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
-- 1.5 UPDATE INVENTORY SITE: no toca warehouse_id ni site_type;
--     al deshabilitar inventario limpia include_in_general.
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
        include_in_general = CASE
            WHEN coalesce(p_inventory_enabled, inventory_enabled) = false THEN false
            ELSE include_in_general
        END,
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
-- 2. SET INVENTORY SITE INVENTORY CONFIG
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.set_inventory_site_inventory_config(
    p_company_id uuid,
    p_site_id uuid,
    p_inventory_enabled boolean,
    p_include_in_general boolean
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_site_type text;
    v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_site_id IS NULL OR p_inventory_enabled IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sites.manage');
    v_occurred_at := pg_catalog.now();

    SELECT site_type INTO v_site_type
    FROM inventarios.inventory_sites
    WHERE company_id = p_company_id AND id = p_site_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad inventariable no existe.','retryable',false)::text;
    END IF;

    -- include_in_general solo para INTERNAL_WAREHOUSE
    IF coalesce(p_include_in_general, false) = true AND v_site_type <> 'INTERNAL_WAREHOUSE' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo las bodegas internas pueden incluirse en el inventario general.','retryable',false)::text;
    END IF;

    UPDATE inventarios.inventory_sites
    SET inventory_enabled = p_inventory_enabled,
        include_in_general = CASE
            WHEN p_inventory_enabled = false THEN false
            ELSE coalesce(p_include_in_general, false)
        END,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_site_id;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_site_id, 'state', 'UPDATED', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('site_id', p_site_id)
    );
    RETURN v_response;
END;
$$;

-- ============================================================
-- 3. LIST: exponer include_in_general
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
            'include_in_general', is2.include_in_general,
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
-- 4. SET CAMPAIGN SITES: GENERAL solo con include_in_general
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.set_inventory_campaign_sites(
    p_company_id uuid,
    p_campaign_id uuid,
    p_site_ids uuid[]
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_campaign_type text;
    v_campaign_status text;
    v_site_id uuid;
    v_order integer := 1;
    v_occurred_at timestamptz;
    v_response jsonb;
    v_general_count bigint;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');
    v_occurred_at := pg_catalog.now();

    SELECT campaign_type, status INTO v_campaign_type, v_campaign_status
    FROM inventarios.inventory_campaigns
    WHERE company_id = p_company_id AND id = p_campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo se puede configurar el alcance en DRAFT.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    IF v_campaign_type = 'GENERAL' THEN
        SELECT pg_catalog.count(*) INTO v_general_count
        FROM inventarios.inventory_sites is2
        WHERE is2.company_id = p_company_id
          AND is2.site_type = 'INTERNAL_WAREHOUSE'
          AND is2.is_active = true AND is2.inventory_enabled = true
          AND is2.include_in_general = true;

        IF v_general_count < 1 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NO_GENERAL_SITES_CONFIGURED',
                DETAIL=pg_catalog.jsonb_build_object('message','No hay unidades configuradas para el inventario general.','retryable',false)::text;
        END IF;

        INSERT INTO inventarios.inventory_campaign_sites (
            company_id, campaign_id, inventory_site_id, is_required, display_order,
            created_at, created_by
        )
        SELECT p_company_id, p_campaign_id, is2.id, true,
               pg_catalog.row_number() OVER (ORDER BY is2.code),
               v_occurred_at, v_actor_id
        FROM inventarios.inventory_sites is2
        WHERE is2.company_id = p_company_id
          AND is2.site_type = 'INTERNAL_WAREHOUSE'
          AND is2.is_active = true AND is2.inventory_enabled = true
          AND is2.include_in_general = true
        ON CONFLICT (company_id, campaign_id, inventory_site_id) DO NOTHING;
    ELSE
        IF p_site_ids IS NULL OR pg_catalog.array_length(p_site_ids, 1) IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                DETAIL=pg_catalog.jsonb_build_object('message','Selecciona al menos una unidad.','retryable',false)::text;
        END IF;

        FOR v_site_id IN
            SELECT unnest(p_site_ids)
        LOOP
            -- SELECTIVE: cualquier sitio activo con inventory_enabled
            -- EXTERNAL: solo OWN_STORE/EXTERNAL_SITE
            IF v_campaign_type = 'EXTERNAL' THEN
                PERFORM 1 FROM inventarios.inventory_sites is2
                WHERE is2.company_id = p_company_id AND is2.id = v_site_id
                  AND is2.inventory_enabled = true AND is2.is_active = true
                  AND is2.site_type IN ('OWN_STORE','EXTERNAL_SITE');
            ELSE
                PERFORM 1 FROM inventarios.inventory_sites is2
                WHERE is2.company_id = p_company_id AND is2.id = v_site_id
                  AND is2.inventory_enabled = true AND is2.is_active = true;
            END IF;
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                    DETAIL=pg_catalog.jsonb_build_object('message','La unidad no existe o no esta habilitada.','retryable',false,'site_id',v_site_id)::text;
            END IF;

            INSERT INTO inventarios.inventory_campaign_sites (
                company_id, campaign_id, inventory_site_id, is_required, display_order,
                created_at, created_by
            ) VALUES (
                p_company_id, p_campaign_id, v_site_id, true, v_order,
                v_occurred_at, v_actor_id
            )
            ON CONFLICT (company_id, campaign_id, inventory_site_id) DO NOTHING;
            v_order := v_order + 1;
        END LOOP;
    END IF;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_campaign_id, 'state', 'DRAFT', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('campaign_id', p_campaign_id)
    );
    RETURN v_response;
END;
$$;

-- ============================================================
-- 5. GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.sync_internal_inventory_sites(uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.update_inventory_site(uuid, uuid, text, boolean, boolean) OWNER TO postgres;
ALTER FUNCTION inventarios.set_inventory_site_inventory_config(uuid, uuid, boolean, boolean) OWNER TO postgres;
ALTER FUNCTION inventarios.list_inventory_sites(uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.sync_internal_inventory_sites(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.update_inventory_site(uuid, uuid, text, boolean, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.set_inventory_site_inventory_config(uuid, uuid, boolean, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.list_inventory_sites(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.sync_internal_inventory_sites(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.update_inventory_site(uuid, uuid, text, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.set_inventory_site_inventory_config(uuid, uuid, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_sites(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.set_inventory_campaign_sites(uuid, uuid, uuid[]) TO authenticated;
