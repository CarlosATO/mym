-- Migration: 20260803120300_inventarios_backfill_and_sync.sql
-- Description: Fase 4I.2E. Backfill de inventory_sites desde bodegas, sync
--              idempotente de ubicaciones desde Logistica, y envoltorio LEGACY
--              para sesiones/importaciones historicas. No modifica snapshots,
--              conteos ni resultados.
-- Author: Assistant

-- ============================================================
-- 1. FUNCION DE SINCRONIZACION IDEMPOTENTE
--    adquisiciones.warehouses -> inventory_sites INTERNAL_WAREHOUSE
--    logistica.locations      -> inventory_site_locations
--    No elimina registros; conserva vinculo source_logistics_location_id;
--    no crea ubicaciones externas.
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
          AND w.is_active = true
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
                inventory_enabled = coalesce(v_site_row.is_active, true),
                updated_at = pg_catalog.now(),
                updated_by = v_actor_id
            WHERE id = v_site_id;
            v_sites_updated := v_sites_updated + 1;
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

ALTER FUNCTION inventarios.sync_internal_inventory_sites(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.sync_internal_inventory_sites(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.sync_internal_inventory_sites(uuid) TO authenticated;

-- ============================================================
-- 2. BACKFILL: inventory_sites desde bodegas existentes
-- ============================================================
DO $$
DECLARE
    v_company_id uuid;
    v_site_id uuid;
    v_backfill_user uuid;
    v_row record;
BEGIN
    FOR v_company_id IN
        SELECT DISTINCT s.company_id FROM inventarios.sessions s
        WHERE s.warehouse_id IS NOT NULL
        UNION
        SELECT DISTINCT si.company_id FROM inventarios.stock_imports si
        WHERE si.warehouse_id IS NOT NULL
        UNION
        SELECT DISTINCT w.company_id FROM adquisiciones.warehouses w
        WHERE w.company_id IS NOT NULL
    LOOP
        SELECT COALESCE(
            (SELECT s.created_by FROM inventarios.sessions s
             WHERE s.company_id = v_company_id ORDER BY s.created_at LIMIT 1),
            (SELECT si.created_by FROM inventarios.stock_imports si
             WHERE si.company_id = v_company_id ORDER BY si.created_at LIMIT 1)
        ) INTO v_backfill_user;

        IF v_backfill_user IS NULL THEN
            SELECT u.id INTO v_backfill_user
            FROM portal.users u
            JOIN core.user_company_access uca ON uca.user_id = u.id AND uca.company_id = v_company_id
            WHERE u.is_active = true AND uca.is_active = true
            ORDER BY u.created_at
            LIMIT 1;
        END IF;

        FOR v_row IN
            SELECT w.id AS warehouse_id, w.code, w.name, w.is_active
            FROM adquisiciones.warehouses w
            WHERE w.id IN (
                SELECT s.warehouse_id FROM inventarios.sessions s
                WHERE s.company_id = v_company_id AND s.warehouse_id IS NOT NULL
                UNION
                SELECT si.warehouse_id FROM inventarios.stock_imports si
                WHERE si.company_id = v_company_id AND si.warehouse_id IS NOT NULL
            )
            ORDER BY w.code
        LOOP
            SELECT id INTO v_site_id
            FROM inventarios.inventory_sites
            WHERE company_id = v_company_id AND warehouse_id = v_row.warehouse_id
              AND site_type = 'INTERNAL_WAREHOUSE';

            IF v_site_id IS NULL THEN
                INSERT INTO inventarios.inventory_sites (
                    company_id, name, code, site_type, warehouse_id, is_active,
                    inventory_enabled, created_at, created_by, updated_at, updated_by
                ) VALUES (
                    v_company_id, v_row.name, v_row.code, 'INTERNAL_WAREHOUSE',
                    v_row.warehouse_id, coalesce(v_row.is_active, true),
                    coalesce(v_row.is_active, true),
                    pg_catalog.now(), v_backfill_user,
                    pg_catalog.now(), v_backfill_user
                )
                RETURNING id INTO v_site_id;
            END IF;

            -- Sincronizar ubicaciones de la bodega
            INSERT INTO inventarios.inventory_site_locations (
                company_id, inventory_site_id, source_logistics_location_id,
                code, name, aisle, rack, level, position, is_active,
                created_at, created_by, updated_at, updated_by
            )
            SELECT l.company_id, v_site_id, l.id, l.code, l.name, l.aisle, l.rack,
                   l.level, l.position, l.is_active,
                   pg_catalog.now(), v_backfill_user,
                   pg_catalog.now(), v_backfill_user
            FROM logistica.locations l
            WHERE l.company_id = v_company_id AND l.warehouse_id = v_row.warehouse_id
            ON CONFLICT (company_id, source_logistics_location_id)
            WHERE source_logistics_location_id IS NOT NULL
            DO NOTHING;
        END LOOP;
    END LOOP;
END;
$$;

-- ============================================================
-- 3. BACKFILL: campana envoltorio LEGACY por sesion historica
--    Solo para sesiones sin campaign_id. Una campana LEGACY por sesion.
-- ============================================================
DO $$
DECLARE
    v_session record;
    v_campaign_id uuid;
    v_site_id uuid;
BEGIN
    FOR v_session IN
        SELECT s.id, s.company_id, s.warehouse_id, s.name, s.created_at, s.created_by
        FROM inventarios.sessions s
        WHERE s.campaign_id IS NULL AND s.inventory_site_id IS NULL
        ORDER BY s.company_id, s.created_at
    LOOP
        -- Resolver sitio interno desde warehouse
        IF v_session.warehouse_id IS NOT NULL THEN
            SELECT id INTO v_site_id
            FROM inventarios.inventory_sites
            WHERE company_id = v_session.company_id
              AND warehouse_id = v_session.warehouse_id
              AND site_type = 'INTERNAL_WAREHOUSE';

            IF v_site_id IS NULL THEN
                RAISE EXCEPTION USING ERRCODE='P0001',
                    MESSAGE='INV_BACKFILL_INCOMPATIBLE',
                    DETAIL=pg_catalog.jsonb_build_object(
                        'message','No existe unidad inventariable para la bodega de la sesion.',
                        'session_id', v_session.id, 'retryable', false)::text;
            END IF;
        ELSE
            v_site_id := NULL;
        END IF;

        INSERT INTO inventarios.inventory_campaigns (
            company_id, name, campaign_type, status, planned_at, started_at,
            completed_at, approved_at, approved_by, cancelled_at, cancelled_by,
            cancellation_reason, created_at, created_by, updated_at, updated_by
        ) VALUES (
            v_session.company_id,
            'LEGACY ' || v_session.name,
            'GENERAL',
            CASE
                WHEN v_session.status = 'APPROVED' THEN 'APPROVED'
                WHEN v_session.status = 'CANCELLED' THEN 'CANCELLED'
                ELSE 'UNDER_REVIEW'
            END,
            v_session.created_at, v_session.created_at,
            v_session.reviewed_at, v_session.approved_at, v_session.approved_by,
            v_session.cancelled_at, v_session.cancelled_by, v_session.cancellation_reason,
            v_session.created_at, v_session.created_by, v_session.created_at, v_session.created_by
        )
        RETURNING id INTO v_campaign_id;

        IF v_site_id IS NOT NULL THEN
            INSERT INTO inventarios.inventory_campaign_sites (
                company_id, campaign_id, inventory_site_id, is_required, display_order,
                created_at, created_by
            ) VALUES (
                v_session.company_id, v_campaign_id, v_site_id, true, 1,
                v_session.created_at, v_session.created_by
            )
            ON CONFLICT (company_id, campaign_id, inventory_site_id) DO NOTHING;
        END IF;

        UPDATE inventarios.sessions
        SET campaign_id = v_campaign_id,
            inventory_site_id = v_site_id,
            updated_at = pg_catalog.now()
        WHERE id = v_session.id AND company_id = v_session.company_id;
    END LOOP;
END;
$$;

-- ============================================================
-- 4. BACKFILL: asociar stock_imports historicas a inventory_site
--    Solo cuando la correspondencia warehouse -> site es inequivoca.
-- ============================================================
UPDATE inventarios.stock_imports si
SET inventory_site_id = isites.id,
    updated_at = pg_catalog.now()
FROM (
    SELECT DISTINCT si2.id AS import_id, is2.id
    FROM inventarios.stock_imports si2
    JOIN inventarios.inventory_sites is2
      ON is2.company_id = si2.company_id
     AND is2.warehouse_id = si2.warehouse_id
     AND is2.site_type = 'INTERNAL_WAREHOUSE'
    WHERE si2.inventory_site_id IS NULL AND si2.warehouse_id IS NOT NULL
) isites
WHERE si.id = isites.import_id;

-- ============================================================
-- 5. LIMPIEZA DEFENSIVA: no inventar asociaciones
--    (los importes sin bodega/warehouse inequivoca quedan con site NULL)
-- ============================================================
