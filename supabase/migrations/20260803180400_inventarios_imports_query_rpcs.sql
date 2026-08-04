-- Migration: 20260803180400_inventarios_imports_query_rpcs.sql
-- Description: Fase 4I.3A. RPCs de consulta de importaciones de stock/costo:
--              list_stock_imports, get_stock_import, get_stock_import_rows,
--              get_stock_import_issues y list_inventory_site_locations.
-- Author: Assistant

-- ============================================================
-- 1. LIST STOCK IMPORTS
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_stock_imports(
    p_company_id uuid,
    p_status text DEFAULT NULL,
    p_limit int DEFAULT 50,
    p_offset int DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_status text;
    v_limit int;
    v_offset int;
    v_total bigint;
    v_rows jsonb;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.read');
    v_status := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_status, '')));
    IF v_status = '' THEN v_status := NULL; END IF;
    v_limit := CASE WHEN COALESCE(p_limit, 50) < 1 THEN 1
                    WHEN COALESCE(p_limit, 50) > 200 THEN 200
                    ELSE COALESCE(p_limit, 50) END;
    v_offset := CASE WHEN COALESCE(p_offset, 0) < 0 THEN 0 ELSE COALESCE(p_offset, 0) END;

    SELECT count(*) INTO v_total
    FROM inventarios.stock_imports si
    WHERE si.company_id = p_company_id
      AND (v_status IS NULL OR si.status = v_status);

    SELECT pg_catalog.jsonb_agg(jb ORDER BY (jb->>'created_at') DESC)
    INTO v_rows
    FROM (
        SELECT pg_catalog.jsonb_build_object(
            'id', si.id,
            'company_id', si.company_id,
            'inventory_site_id', si.inventory_site_id,
            'site_name', s.name,
            'site_code', s.code,
            'site_type', s.site_type,
            'modality', si.modality,
            'cutoff_at', si.cutoff_at,
            'original_filename', si.original_filename,
            'status', si.status,
            'row_count', si.row_count,
            'error_count', si.error_count,
            'warning_count', si.warning_count,
            'created_at', si.created_at,
            'created_by_name', inventarios.user_display_name(si.created_by),
            'validated_at', si.validated_at,
            'file_sha256', si.file_sha256
        ) AS jb
        FROM inventarios.stock_imports si
        JOIN inventarios.inventory_sites s ON s.company_id = si.company_id AND s.id = si.inventory_site_id
        WHERE si.company_id = p_company_id
          AND (v_status IS NULL OR si.status = v_status)
        ORDER BY si.created_at DESC
        LIMIT v_limit OFFSET v_offset
    ) x;

    RETURN pg_catalog.jsonb_build_object(
        'imports', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END,
        'total', v_total
    );
END;
$$;

-- ============================================================
-- 2. GET STOCK IMPORT
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_stock_import(
    p_company_id uuid,
    p_import_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_import jsonb;
BEGIN
    IF p_company_id IS NULL OR p_import_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.read');

    SELECT pg_catalog.jsonb_build_object(
        'id', si.id,
        'company_id', si.company_id,
        'inventory_site_id', si.inventory_site_id,
        'site_name', s.name,
        'site_code', s.code,
        'site_type', s.site_type,
        'warehouse_id', si.warehouse_id,
        'modality', si.modality,
        'cutoff_at', si.cutoff_at,
        'original_filename', si.original_filename,
        'mime_type', si.mime_type,
        'file_size', si.file_size,
        'file_sha256', si.file_sha256,
        'storage_path', si.storage_path,
        'previous_storage_path', si.previous_storage_path,
        'previous_file_sha256', si.previous_file_sha256,
        'status', si.status,
        'row_count', si.row_count,
        'error_count', si.error_count,
        'warning_count', si.warning_count,
        'file_issues', si.file_issues,
        'validated_at', si.validated_at,
        'validated_by_name', inventarios.user_display_name(si.validated_by),
        'created_at', si.created_at,
        'created_by_name', inventarios.user_display_name(si.created_by)
    ) INTO v_import
    FROM inventarios.stock_imports si
    JOIN inventarios.inventory_sites s ON s.company_id = si.company_id AND s.id = si.inventory_site_id
    WHERE si.company_id = p_company_id AND si.id = p_import_id;

    IF v_import IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no existe.','retryable',false)::text;
    END IF;

    RETURN pg_catalog.jsonb_build_object('import', v_import);
END;
$$;

-- ============================================================
-- 3. GET STOCK IMPORT ROWS (paginado + filtro)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_stock_import_rows(
    p_company_id uuid,
    p_import_id uuid,
    p_filter text DEFAULT 'ALL',
    p_limit int DEFAULT 50,
    p_offset int DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_filter text;
    v_limit int;
    v_offset int;
    v_total bigint;
    v_rows jsonb;
BEGIN
    IF p_company_id IS NULL OR p_import_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.read');
    v_filter := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_filter, 'ALL')));
    IF v_filter NOT IN ('ALL', 'VALID', 'WARNING', 'ERROR') THEN v_filter := 'ALL'; END IF;
    v_limit := CASE WHEN COALESCE(p_limit, 50) < 1 THEN 1
                    WHEN COALESCE(p_limit, 50) > 500 THEN 500
                    ELSE COALESCE(p_limit, 50) END;
    v_offset := CASE WHEN COALESCE(p_offset, 0) < 0 THEN 0 ELSE COALESCE(p_offset, 0) END;

    SELECT count(*) INTO v_total
    FROM inventarios.stock_import_rows r
    WHERE r.company_id = p_company_id AND r.import_id = p_import_id
      AND (v_filter = 'ALL' OR r.row_status = v_filter);

    SELECT pg_catalog.jsonb_agg(jb ORDER BY (jb->>'row_index')::int)
    INTO v_rows
    FROM (
        SELECT pg_catalog.jsonb_build_object(
            'row_index', r.row_index,
            'sku', r.sku,
            'barcode', r.barcode,
            'entered_name', r.entered_name,
            'product_id', r.product_id,
            'product_sku', p.sku,
            'product_name', p.description,
            'location_code', l.code,
            'location_name', l.name,
            'quantity', r.theoretical_quantity,
            'cost', r.unit_cost,
            'row_status', r.row_status,
            'issues', (
                SELECT CASE
                    WHEN count(*) = 0 THEN '[]'::jsonb
                    ELSE pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object('level', i.issue_level, 'code', i.issue_code, 'message', i.safe_message)
                        ORDER BY i.created_at
                    )
                END
                FROM inventarios.stock_import_row_issues i
                WHERE i.company_id = r.company_id AND i.import_id = r.import_id AND i.row_id = r.id
            )
        ) AS jb
        FROM inventarios.stock_import_rows r
        LEFT JOIN adquisiciones.products p ON p.id = r.product_id
        LEFT JOIN inventarios.inventory_site_locations l
          ON l.company_id = r.company_id AND l.inventory_site_id = r.inventory_site_id AND l.id = r.inventory_site_location_id
        WHERE r.company_id = p_company_id AND r.import_id = p_import_id
          AND (v_filter = 'ALL' OR r.row_status = v_filter)
        ORDER BY r.row_index
        LIMIT v_limit OFFSET v_offset
    ) x;

    RETURN pg_catalog.jsonb_build_object(
        'rows', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END,
        'total', v_total
    );
END;
$$;

-- ============================================================
-- 4. GET STOCK IMPORT ISSUES (para exportar CSV de errores)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_stock_import_issues(
    p_company_id uuid,
    p_import_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_rows jsonb;
BEGIN
    IF p_company_id IS NULL OR p_import_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.read');

    SELECT pg_catalog.jsonb_agg(jb ORDER BY (jb->>'row_index')::int)
    INTO v_rows
    FROM (
        SELECT pg_catalog.jsonb_build_object(
            'row_index', i.row_index,
            'sku', r.sku,
            'location_code', l.code,
            'level', i.issue_level,
            'code', i.issue_code,
            'message', i.safe_message
        ) AS jb
        FROM inventarios.stock_import_row_issues i
        JOIN inventarios.stock_import_rows r
          ON r.company_id = i.company_id AND r.import_id = i.import_id AND r.id = i.row_id
        LEFT JOIN inventarios.inventory_site_locations l
          ON l.company_id = r.company_id AND l.inventory_site_id = r.inventory_site_id AND l.id = r.inventory_site_location_id
        WHERE i.company_id = p_company_id AND i.import_id = p_import_id
    ) x;

    RETURN pg_catalog.jsonb_build_object(
        'issues', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END
    );
END;
$$;

-- ============================================================
-- 5. LIST INVENTORY SITE LOCATIONS (para plantillas/formularios)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_inventory_site_locations(
    p_company_id uuid,
    p_inventory_site_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_rows jsonb;
BEGIN
    IF p_company_id IS NULL OR p_inventory_site_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.read');

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', l.id,
            'code', l.code,
            'name', l.name,
            'is_active', l.is_active
        ) ORDER BY l.code
    )
    INTO v_rows
    FROM inventarios.inventory_site_locations l
    WHERE l.company_id = p_company_id AND l.inventory_site_id = p_inventory_site_id;

    RETURN pg_catalog.jsonb_build_object(
        'locations', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END
    );
END;
$$;

-- ============================================================
-- GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.list_stock_imports(uuid, text, int, int) OWNER TO postgres;
ALTER FUNCTION inventarios.get_stock_import(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.get_stock_import_rows(uuid, uuid, text, int, int) OWNER TO postgres;
ALTER FUNCTION inventarios.get_stock_import_issues(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.list_inventory_site_locations(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.list_stock_imports(uuid, text, int, int) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_stock_import(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_stock_import_rows(uuid, uuid, text, int, int) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_stock_import_issues(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.list_inventory_site_locations(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.list_stock_imports(uuid, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_stock_import(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_stock_import_rows(uuid, uuid, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_stock_import_issues(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_site_locations(uuid, uuid) TO authenticated;
