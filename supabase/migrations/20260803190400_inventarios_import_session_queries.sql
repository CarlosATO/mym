-- Migration: 20260803190400_inventarios_import_session_queries.sql
-- Description: Fase 4I.3B. Consultas de sesion/snapshot para el flujo
--              EXCEL_IMPORT.
--              1) get_inventory_session_setup: expone inventory_site_id,
--                 campaign_id, stock_source, stock_import_id y la unidad
--                 inventariable heredada (aditivo, sin romper contratos).
--              2) get_inventory_session_snapshot: contenido congelado
--                 (productos, ubicaciones, teorico, costos) para UI.
--              3) get_inventory_session_import: importacion asociada a la
--                 sesion (archivo, modalidad, corte, estado, consumos).
-- Author: Assistant

-- ============================================================
-- 1. GET INVENTORY SESSION SETUP (aditivo)
--    Se agregan al objeto session: inventory_site_id, campaign_id,
--    stock_source, stock_import_id y la unidad inventariable.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_setup(
    p_company_id uuid,
    p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_session jsonb;
    v_snapshot jsonb;
    v_participants jsonb;
    v_zones jsonb;
    v_tasks jsonb;
    v_product_scope jsonb;
    v_indicators jsonb;
    v_zone_count bigint;
    v_location_count bigint;
    v_task_count bigint;
    v_snapshot_status text;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT pg_catalog.jsonb_build_object(
        'id', s.id,
        'company_id', s.company_id,
        'session_number', s.session_number,
        'name', s.name,
        'inventory_type', s.inventory_type,
        'status', s.status,
        'warehouse_id', s.warehouse_id,
        'bsale_office_id', s.bsale_office_id,
        'scope_mode', s.scope_mode,
        'responsible_user_id', s.responsible_user_id,
        'notes', s.notes,
        'prepared_at', s.prepared_at,
        'started_at', s.started_at,
        'created_at', s.created_at,
        'created_by', s.created_by,
        'updated_at', s.updated_at,
        'updated_by', s.updated_by,
        'inventory_site_id', s.inventory_site_id,
        'campaign_id', s.campaign_id,
        'stock_source', s.stock_source,
        'stock_import_id', s.stock_import_id,
        'site_name', is2.name,
        'site_code', is2.code,
        'site_type', is2.site_type,
        'campaign_name', ic.name,
        'campaign_product_scope', ic.product_scope
    )
    INTO v_session
    FROM inventarios.sessions s
    LEFT JOIN inventarios.inventory_sites is2 ON is2.company_id = s.company_id AND is2.id = s.inventory_site_id
    LEFT JOIN inventarios.inventory_campaigns ic ON ic.company_id = s.company_id AND ic.id = s.campaign_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id;

    IF v_session IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.jsonb_build_object(
        'id', os.id,
        'session_id', os.session_id,
        'snapshot_version', os.snapshot_version,
        'completion_status', os.completion_status,
        'bsale_sync_run_id', os.bsale_sync_run_id,
        'captured_at', os.captured_at,
        'captured_by', os.captured_by,
        'content_hash', os.content_hash,
        'created_at', os.created_at,
        'created_by', os.created_by
    )
    INTO v_snapshot
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', sp.id,
            'user_id', sp.user_id,
            'functional_role', sp.functional_role,
            'active_from', sp.active_from,
            'created_at', sp.created_at,
            'created_by', sp.created_by
        )
        ORDER BY sp.functional_role, sp.user_id
    )
    INTO v_participants
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id
      AND sp.session_id = p_session_id
      AND sp.revoked_at IS NULL;

    SELECT pg_catalog.count(*)
    INTO v_zone_count
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id;

    SELECT pg_catalog.count(*)
    INTO v_location_count
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id AND szl.session_id = p_session_id;

    SELECT pg_catalog.count(*)
    INTO v_task_count
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', sz.id,
            'zone_code', sz.zone_code,
            'scan_code', sz.scan_code,
            'display_name', sz.display_name,
            'priority', sz.priority,
            'is_enabled', sz.is_enabled,
            'created_at', sz.created_at,
            'created_by', sz.created_by,
            'locations', (
                SELECT CASE
                    WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                    ELSE pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                            'location_id', szl.location_id,
                            'snapshot_location_id', szl.snapshot_location_id,
                            'code', sll.code,
                            'name', sll.name,
                            'aisle', sll.aisle,
                            'rack', sll.rack,
                            'level', sll.level,
                            'position', sll.position,
                            'is_active', sll.is_active
                        )
                        ORDER BY sll.code
                    )
                END
                FROM inventarios.session_zone_locations szl
                JOIN inventarios.snapshot_locations sll
                  ON sll.company_id = szl.company_id
                 AND sll.snapshot_id = szl.snapshot_id
                 AND sll.location_id = szl.location_id
                WHERE szl.company_id = sz.company_id
                  AND szl.session_id = sz.session_id
                  AND szl.session_zone_id = sz.id
            )
        )
        ORDER BY sz.priority, sz.zone_code
    )
    INTO v_zones
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', t.id,
            'session_zone_id', t.session_zone_id,
            'task_kind', t.task_kind,
            'status', t.status,
            'version', t.version,
            'validation_cycle', t.validation_cycle,
            'current_assignment_id', t.current_assignment_id,
            'created_at', t.created_at,
            'created_by', t.created_by,
            'assignment', CASE
                WHEN ta.id IS NULL THEN NULL
                ELSE pg_catalog.jsonb_build_object(
                    'assignment_id', ta.id,
                    'user_id', ta.user_id,
                    'session_participant_id', ta.session_participant_id,
                    'functional_role', sp.functional_role,
                    'assigned_at', ta.assigned_at,
                    'assigned_by', ta.assigned_by
                )
            END
        )
        ORDER BY t.created_at
    )
    INTO v_tasks
    FROM inventarios.tasks t
    LEFT JOIN inventarios.task_assignments ta
      ON ta.company_id = t.company_id AND ta.task_id = t.id AND ta.released_at IS NULL
    LEFT JOIN inventarios.session_participants sp
      ON sp.company_id = ta.company_id
     AND sp.session_id = ta.session_id
     AND sp.id = ta.session_participant_id
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'bsale_variant_id', sps.bsale_variant_id,
            'product_id', sps.product_id,
            'sku', coalesce(p.sku::text, bv.code::text),
            'barcode', coalesce(p.barcode::text, bv.bar_code::text),
            'name', coalesce(pg_catalog.btrim(p.description)::text, pg_catalog.btrim(bv.description)::text, p.sku::text, bv.code::text)
        )
        ORDER BY coalesce(p.sku::text, bv.code::text)
    )
    INTO v_product_scope
    FROM inventarios.session_product_scopes sps
    LEFT JOIN adquisiciones.products p ON p.id = sps.product_id
    LEFT JOIN integraciones.bsale_variants bv
      ON bv.company_id = sps.company_id AND bv.bsale_id = sps.bsale_variant_id
    WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id
      AND sps.inclusion_type = 'INCLUDED';

    v_snapshot_status := v_snapshot ->> 'completion_status';

    v_indicators := pg_catalog.jsonb_build_object(
        'snapshot_pending', coalesce(v_snapshot_status, 'PENDING') = 'PENDING',
        'has_responsible', (v_session ->> 'responsible_user_id') IS NOT NULL,
        'active_participant_count', pg_catalog.jsonb_array_length(CASE WHEN v_participants IS NULL THEN '[]'::jsonb ELSE v_participants END),
        'zone_count', v_zone_count,
        'location_count', v_location_count,
        'task_count', v_task_count,
        'product_scope_count', pg_catalog.jsonb_array_length(CASE WHEN v_product_scope IS NULL THEN '[]'::jsonb ELSE v_product_scope END),
        'zones_without_locations', (
            SELECT pg_catalog.count(*) FROM inventarios.session_zones sz
            WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
              AND NOT EXISTS (
                  SELECT 1 FROM inventarios.session_zone_locations szl
                  WHERE szl.company_id = sz.company_id
                    AND szl.session_id = sz.session_id
                    AND szl.session_zone_id = sz.id
              )
        ),
        'zones_without_tasks', (
            SELECT pg_catalog.count(*) FROM inventarios.session_zones sz
            WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id
              AND NOT EXISTS (
                  SELECT 1 FROM inventarios.tasks t
                  WHERE t.company_id = sz.company_id
                    AND t.session_id = sz.session_id
                    AND t.session_zone_id = sz.id
                    AND t.cancelled_at IS NULL
                    AND t.superseded_at IS NULL
              )
        ),
        'ready_to_prepare', (
            v_zone_count > 0
            AND v_location_count > 0
            AND v_task_count > 0
            AND v_zone_count = v_location_count
        )
    );

    RETURN pg_catalog.jsonb_build_object(
        'session', v_session,
        'snapshot', v_snapshot,
        'participants', CASE WHEN v_participants IS NULL THEN '[]'::jsonb ELSE v_participants END,
        'zones', CASE WHEN v_zones IS NULL THEN '[]'::jsonb ELSE v_zones END,
        'tasks', CASE WHEN v_tasks IS NULL THEN '[]'::jsonb ELSE v_tasks END,
        'product_scope', CASE WHEN v_product_scope IS NULL THEN '[]'::jsonb ELSE v_product_scope END,
        'indicators', v_indicators
    );
END;
$$;

-- ============================================================
-- 2. GET INVENTORY SESSION SNAPSHOT (contenido congelado)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_snapshot(
    p_company_id uuid,
    p_session_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_snapshot_id uuid;
    v_products jsonb;
    v_locations jsonb;
    v_theoretical jsonb;
    v_costs jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT os.id INTO v_snapshot_id
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id;
    IF v_snapshot_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('products','[]'::jsonb,'locations','[]'::jsonb,'theoretical','[]'::jsonb,'costs','[]'::jsonb);
    END IF;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'product_id', sp.product_id,
                'sku', sp.sku,
                'barcode', sp.barcode,
                'name', sp.name
            ) ORDER BY sp.sku
        )
    END
    INTO v_products
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'snapshot_location_id', sl.id,
                'inventory_site_location_id', sl.inventory_site_location_id,
                'code', sl.code,
                'name', sl.name,
                'aisle', sl.aisle,
                'rack', sl.rack,
                'level', sl.level,
                'position', sl.position,
                'is_active', sl.is_active
            ) ORDER BY sl.code
        )
    END
    INTO v_locations
    FROM inventarios.snapshot_locations sl
    WHERE sl.company_id = p_company_id AND sl.snapshot_id = v_snapshot_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'product_id', sp.product_id,
                'sku', sp.sku,
                'scope_level', st.scope_level,
                'location_code', sl.code,
                'theoretical_quantity', st.theoretical_quantity
            ) ORDER BY sp.sku, sl.code
        )
    END
    INTO v_theoretical
    FROM inventarios.snapshot_theoretical_stocks st
    JOIN inventarios.snapshot_products sp ON sp.company_id = st.company_id AND sp.snapshot_id = st.snapshot_id AND sp.id = st.snapshot_product_id
    LEFT JOIN inventarios.snapshot_locations sl ON sl.company_id = st.company_id AND sl.snapshot_id = st.snapshot_id AND sl.id = st.snapshot_location_id
    WHERE st.company_id = p_company_id AND st.snapshot_id = v_snapshot_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'product_id', sp.product_id,
                'sku', sp.sku,
                'unit_cost', uc.unit_cost,
                'currency', uc.currency,
                'source', uc.source,
                'has_cost', uc.has_cost,
                'valuation_status', uc.valuation_status
            ) ORDER BY sp.sku
        )
    END
    INTO v_costs
    FROM inventarios.snapshot_unit_costs uc
    JOIN inventarios.snapshot_products sp ON sp.company_id = uc.company_id AND sp.snapshot_id = uc.snapshot_id AND sp.id = uc.snapshot_product_id
    WHERE uc.company_id = p_company_id AND uc.snapshot_id = v_snapshot_id;

    RETURN pg_catalog.jsonb_build_object(
        'products', CASE WHEN v_products IS NULL THEN '[]'::jsonb ELSE v_products END,
        'locations', CASE WHEN v_locations IS NULL THEN '[]'::jsonb ELSE v_locations END,
        'theoretical', CASE WHEN v_theoretical IS NULL THEN '[]'::jsonb ELSE v_theoretical END,
        'costs', CASE WHEN v_costs IS NULL THEN '[]'::jsonb ELSE v_costs END
    );
END;
$$;

-- ============================================================
-- 3. GET INVENTORY SESSION IMPORT (importacion asociada)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_import(
    p_company_id uuid,
    p_session_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_import jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT pg_catalog.jsonb_build_object(
        'id', si.id,
        'original_filename', si.original_filename,
        'modality', si.modality,
        'cutoff_at', si.cutoff_at,
        'status', si.status,
        'row_count', si.row_count,
        'error_count', si.error_count,
        'warning_count', si.warning_count,
        'validated_at', si.validated_at,
        'file_sha256', si.file_sha256,
        'consumed_session_id', si.consumed_session_id,
        'created_by_name', inventarios.user_display_name(si.created_by)
    ) INTO v_import
    FROM inventarios.stock_imports si
    JOIN inventarios.sessions s ON s.company_id = si.company_id AND s.id = p_session_id
    WHERE si.company_id = p_company_id AND si.id = s.stock_import_id;

    RETURN pg_catalog.jsonb_build_object(
        'import', v_import
    );
END;
$$;

-- ============================================================
-- GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.get_inventory_session_setup(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.get_inventory_session_snapshot(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.get_inventory_session_import(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_session_setup(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_inventory_session_snapshot(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_inventory_session_import(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_setup(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_snapshot(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_import(uuid, uuid) TO authenticated;
