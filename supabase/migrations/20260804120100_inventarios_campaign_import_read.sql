-- Migration: 20260804120100_inventarios_campaign_import_read.sql
-- Description: Fase 4I.3C.2B. Consulta de lectura especifica para importaciones
--              de campana con detalle de filas, incidencias y IDs resueltos.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.get_campaign_stock_import(
    p_company_id uuid,
    p_import_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_import jsonb;
    v_campaign jsonb;
    v_rows jsonb;
    v_issues jsonb;
    v_total_rows bigint;
    v_valid_rows bigint;
    v_warning_rows bigint;
    v_error_rows bigint;
    v_issue_warning_count bigint;
    v_issue_error_count bigint;
BEGIN
    IF p_company_id IS NULL OR p_import_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.read');

    SELECT pg_catalog.jsonb_build_object(
        'id', si.id,
        'company_id', si.company_id,
        'campaign_id', si.campaign_id,
        'theoretical_scope', si.theoretical_scope,
        'status', si.status,
        'row_count', si.row_count,
        'error_count', si.error_count,
        'warning_count', si.warning_count,
        'original_filename', si.original_filename,
        'file_issues', COALESCE(si.file_issues, '[]'::jsonb),
        'validated_at', si.validated_at,
        'created_at', si.created_at,
        'updated_at', si.updated_at
    )
    INTO v_import
    FROM inventarios.stock_imports si
    WHERE si.company_id = p_company_id
      AND si.id = p_import_id
      AND si.campaign_id IS NOT NULL
      AND si.theoretical_scope IS NOT NULL;

    IF v_import IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.jsonb_build_object(
        'id', ic.id,
        'name', ic.name,
        'product_scope', ic.product_scope,
        'status', ic.status
    )
    INTO v_campaign
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = (v_import ->> 'campaign_id')::uuid;

    SELECT count(*) INTO v_total_rows
    FROM inventarios.stock_import_rows r
    WHERE r.company_id = p_company_id AND r.import_id = p_import_id;

    SELECT count(*) INTO v_valid_rows
    FROM inventarios.stock_import_rows r
    WHERE r.company_id = p_company_id AND r.import_id = p_import_id AND r.row_status = 'VALID';

    SELECT count(*) INTO v_warning_rows
    FROM inventarios.stock_import_rows r
    WHERE r.company_id = p_company_id AND r.import_id = p_import_id AND r.row_status = 'WARNING';

    SELECT count(*) INTO v_error_rows
    FROM inventarios.stock_import_rows r
    WHERE r.company_id = p_company_id AND r.import_id = p_import_id AND r.row_status = 'ERROR';

    SELECT count(*) FILTER (WHERE i.issue_level = 'WARNING'),
           count(*) FILTER (WHERE i.issue_level = 'ERROR')
    INTO v_issue_warning_count, v_issue_error_count
    FROM inventarios.stock_import_row_issues i
    WHERE i.company_id = p_company_id AND i.import_id = p_import_id;

    SELECT CASE
        WHEN count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'row_index', r.row_index,
                'sku', r.sku,
                'barcode', r.barcode,
                'entered_name', r.entered_name,
                'product_id', r.product_id,
                'entered_site_code', r.entered_site_code,
                'resolved_inventory_site_id', r.resolved_inventory_site_id,
                'entered_location_code', r.entered_location_code,
                'inventory_site_location_id', r.inventory_site_location_id,
                'quantity', r.theoretical_quantity,
                'cost', r.unit_cost,
                'row_status', r.row_status,
                'issues', COALESCE((
                    SELECT pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                            'severity', i.issue_level,
                            'code', i.issue_code,
                            'field', i.field,
                            'message', i.safe_message,
                            'metadata', i.metadata
                        ) ORDER BY i.created_at
                    )
                    FROM inventarios.stock_import_row_issues i
                    WHERE i.company_id = r.company_id
                      AND i.import_id = r.import_id
                      AND i.row_id = r.id
                ), '[]'::jsonb)
            ) ORDER BY r.row_index
        )
    END
    INTO v_rows
    FROM inventarios.stock_import_rows r
    WHERE r.company_id = p_company_id AND r.import_id = p_import_id;

    SELECT CASE
        WHEN count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'row_index', i.row_index,
                'severity', i.issue_level,
                'code', i.issue_code,
                'field', i.field,
                'message', i.safe_message,
                'metadata', i.metadata,
                'product_id', r.product_id,
                'resolved_inventory_site_id', r.resolved_inventory_site_id,
                'inventory_site_location_id', r.inventory_site_location_id,
                'entered_site_code', r.entered_site_code,
                'entered_location_code', r.entered_location_code
            ) ORDER BY COALESCE(i.row_index, 2147483647), i.created_at
        )
    END
    INTO v_issues
    FROM inventarios.stock_import_row_issues i
    LEFT JOIN inventarios.stock_import_rows r
      ON r.company_id = i.company_id AND r.import_id = i.import_id AND r.id = i.row_id
    WHERE i.company_id = p_company_id AND i.import_id = p_import_id;

    RETURN pg_catalog.jsonb_build_object(
        'import', v_import,
        'campaign', v_campaign,
        'summary', pg_catalog.jsonb_build_object(
            'total_rows', COALESCE(v_total_rows, 0),
            'valid_rows', COALESCE(v_valid_rows, 0),
            'warning_rows', COALESCE(v_warning_rows, 0),
            'error_rows', COALESCE(v_error_rows, 0),
            'issue_warning_count', COALESCE(v_issue_warning_count, 0),
            'issue_error_count', COALESCE(v_issue_error_count, 0)
        ),
        'rows', COALESCE(v_rows, '[]'::jsonb),
        'issues', COALESCE(v_issues, '[]'::jsonb)
    );
END;
$$;

ALTER FUNCTION inventarios.get_campaign_stock_import(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_campaign_stock_import(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_campaign_stock_import(uuid, uuid) TO authenticated;
