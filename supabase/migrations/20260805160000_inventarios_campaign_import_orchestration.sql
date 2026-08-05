-- Migration: 20260805160000_inventarios_campaign_import_orchestration.sql
-- Description: Orquestacion backend para importacion unica por campana:
--              create_campaign_stock_import, register_campaign_stock_import_file
--              y sobrecarga de validate_campaign_stock_import con hash real.
-- Author: Assistant

ALTER TABLE inventarios.stock_imports
    ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ============================================================
-- 1. CREATE CAMPAIGN STOCK IMPORT
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.create_campaign_stock_import(
    p_company_id uuid,
    p_campaign_id uuid,
    p_theoretical_scope text,
    p_cutoff_at timestamptz,
    p_currency text,
    p_original_filename text,
    p_mime_type text,
    p_file_size bigint,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_now timestamptz := pg_catalog.now();
    v_campaign_status text;
    v_scope text;
    v_currency text;
    v_filename text;
    v_mime text;
    v_ext text;
    v_import_id uuid;
    v_storage_prefix text;
BEGIN
    v_scope := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_theoretical_scope, '')));
    v_currency := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_currency, 'CLP')));
    v_filename := pg_catalog.btrim(COALESCE(p_original_filename, ''));
    v_mime := pg_catalog.btrim(COALESCE(p_mime_type, ''));
    v_ext := pg_catalog.lower(COALESCE((pg_catalog.regexp_match(v_filename, '\\.([^.]+)$'))[1], ''));

    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_cutoff_at IS NULL OR p_idempotency_key IS NULL
       OR v_scope NOT IN ('TOTAL_CAMPAIGN', 'BY_SITE', 'BY_LOCATION')
       OR v_currency <> 'CLP'
       OR v_filename = '' OR pg_catalog.char_length(v_filename) > 255
       OR p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > 20971520
       OR (
            v_mime NOT IN (
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.ms-excel',
                'text/csv',
                'application/csv'
            )
            AND NOT (v_mime = 'application/octet-stream' AND v_ext IN ('xlsx', 'xls', 'csv'))
          )
    THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.manage');
    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.create_campaign_stock_import',
        'company_id', p_company_id,
        'campaign_id', p_campaign_id,
        'theoretical_scope', v_scope,
        'cutoff_at', p_cutoff_at,
        'currency', v_currency,
        'original_filename', v_filename,
        'mime_type', v_mime,
        'file_size', p_file_size,
        'idempotency_key', p_idempotency_key
    );
    v_operation := inventarios.begin_idempotent_operation(p_company_id, 'inventarios.create_campaign_stock_import', p_idempotency_key, inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT ic.status
    INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_EDITABLE',
            DETAIL=pg_catalog.jsonb_build_object('message','La campana no admite nuevas importaciones.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    INSERT INTO inventarios.stock_imports (
        company_id, campaign_id, theoretical_scope, cutoff_at, currency,
        original_filename, mime_type, file_size, status,
        created_at, created_by, updated_at, updated_by, metadata
    ) VALUES (
        p_company_id, p_campaign_id, v_scope, p_cutoff_at, v_currency,
        v_filename, NULLIF(v_mime, ''), p_file_size, 'DRAFT',
        v_now, v_actor_id, v_now, v_actor_id,
        pg_catalog.jsonb_build_object(
            'source', 'CAMPAIGN_IMPORT',
            'campaign_id', p_campaign_id,
            'theoretical_scope', v_scope,
            'currency', v_currency,
            'original_filename', v_filename,
            'mime_type', NULLIF(v_mime, ''),
            'file_size', p_file_size
        )
    )
    RETURNING id INTO v_import_id;

    v_storage_prefix := p_company_id::text || '/campaign-stock-imports/' || p_campaign_id::text || '/' || v_import_id::text || '/';
    UPDATE inventarios.stock_imports
    SET metadata = COALESCE(metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object('storage_prefix', v_storage_prefix),
        updated_at = v_now,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = v_import_id;

    RETURN inventarios.complete_idempotent_operation(
        p_company_id,
        v_operation_id,
        v_import_id,
        pg_catalog.jsonb_build_object(
            'operation', 'inventarios.create_campaign_stock_import',
            'entity_id', v_import_id,
            'state', 'DRAFT',
            'version', NULL::integer,
            'cycle_number', NULL::integer,
            'assignment_id', NULL::uuid,
            'event_id', NULL::uuid,
            'replayed', false,
            'occurred_at', v_now,
            'data', pg_catalog.jsonb_build_object(
                'import_id', v_import_id,
                'campaign_id', p_campaign_id,
                'theoretical_scope', v_scope,
                'cutoff_at', p_cutoff_at,
                'currency', v_currency,
                'storage_prefix', v_storage_prefix
            )
        )
    );
END;
$$;

-- ============================================================
-- 2. REGISTER CAMPAIGN STOCK IMPORT FILE
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.register_campaign_stock_import_file(
    p_company_id uuid,
    p_import_id uuid,
    p_storage_path text,
    p_original_filename text,
    p_mime_type text,
    p_file_size bigint,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_now timestamptz := pg_catalog.now();
    v_import_status text;
    v_campaign_id uuid;
    v_theoretical_scope text;
    v_current_path text;
    v_previous_path text;
    v_previous_sha char(64);
    v_filename text;
    v_mime text;
    v_expected_prefix text;
    v_response jsonb;
BEGIN
    v_filename := pg_catalog.btrim(COALESCE(p_original_filename, ''));
    v_mime := pg_catalog.btrim(COALESCE(p_mime_type, ''));

    IF p_company_id IS NULL OR p_import_id IS NULL OR p_storage_path IS NULL OR pg_catalog.btrim(p_storage_path) = ''
       OR v_filename = '' OR pg_catalog.char_length(v_filename) > 255
       OR p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > 20971520
       OR (
            v_mime NOT IN (
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.ms-excel',
                'text/csv',
                'application/csv'
            )
            AND NOT (v_mime = 'application/octet-stream' AND pg_catalog.lower(COALESCE((pg_catalog.regexp_match(v_filename, '\\.([^.]+)$'))[1], '')) IN ('xlsx', 'xls', 'csv'))
          )
    THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.manage');
    v_payload := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.register_campaign_stock_import_file',
        'company_id', p_company_id,
        'import_id', p_import_id,
        'storage_path', p_storage_path,
        'original_filename', v_filename,
        'mime_type', v_mime,
        'file_size', p_file_size,
        'idempotency_key', p_idempotency_key
    );
    v_operation := inventarios.begin_idempotent_operation(p_company_id, 'inventarios.register_campaign_stock_import_file', p_idempotency_key, inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT si.status, si.campaign_id, si.theoretical_scope, si.storage_path, si.file_sha256
    INTO v_import_status, v_campaign_id, v_theoretical_scope, v_current_path, v_previous_sha
    FROM inventarios.stock_imports si
    WHERE si.company_id = p_company_id AND si.id = p_import_id
    FOR UPDATE OF si;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_id IS NULL OR v_theoretical_scope IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no pertenece a una campana valida.','retryable',false)::text;
    END IF;
    IF v_import_status = 'CONSUMED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_CONSUMED',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion ya fue consumida.','retryable',false)::text;
    END IF;

    v_expected_prefix := p_company_id::text || '/campaign-stock-imports/' || v_campaign_id::text || '/' || p_import_id::text || '/';
    IF pg_catalog.strpos(pg_catalog.btrim(p_storage_path), v_expected_prefix) <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_STORAGE_PATH',
            DETAIL=pg_catalog.jsonb_build_object('message','La ruta del archivo no corresponde a la importacion.','retryable',false)::text;
    END IF;

    IF v_current_path IS NOT NULL AND v_current_path <> pg_catalog.btrim(p_storage_path) THEN
        v_previous_path := v_current_path;
    END IF;

    UPDATE inventarios.stock_imports
    SET previous_storage_path = v_previous_path,
        previous_file_sha256 = v_previous_sha,
        storage_path = pg_catalog.btrim(p_storage_path),
        original_filename = v_filename,
        mime_type = NULLIF(v_mime, ''),
        file_size = p_file_size,
        status = 'DRAFT',
        row_count = 0,
        error_count = 0,
        warning_count = 0,
        file_issues = '[]'::jsonb,
        validated_at = NULL,
        validated_by = NULL,
        updated_at = v_now,
        updated_by = v_actor_id,
        metadata = COALESCE(metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
            'storage_path', pg_catalog.btrim(p_storage_path),
            'registered_at', v_now,
            'original_filename', v_filename,
            'mime_type', NULLIF(v_mime, ''),
            'file_size', p_file_size
        )
    WHERE company_id = p_company_id AND id = p_import_id;

    DELETE FROM inventarios.stock_import_row_issues WHERE company_id = p_company_id AND import_id = p_import_id;
    DELETE FROM inventarios.stock_import_rows WHERE company_id = p_company_id AND import_id = p_import_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.register_campaign_stock_import_file',
        'entity_id', p_import_id,
        'state', 'FILE_REGISTERED',
        'version', NULL::integer,
        'cycle_number', NULL::integer,
        'assignment_id', NULL::uuid,
        'event_id', NULL::uuid,
        'replayed', false,
        'occurred_at', v_now,
        'data', pg_catalog.jsonb_build_object(
            'import_id', p_import_id,
            'campaign_id', v_campaign_id,
            'storage_path', pg_catalog.btrim(p_storage_path),
            'original_filename', v_filename,
            'mime_type', NULLIF(v_mime, ''),
            'file_size', p_file_size
        )
    );

    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_import_id, v_response);
END;
$$;

-- ============================================================
-- 3. VALIDATE CAMPAIGN STOCK IMPORT CON HASH
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.validate_campaign_stock_import(
    p_company_id uuid,
    p_import_id uuid,
    p_file_sha256 char(64),
    p_file_issues jsonb,
    p_rows jsonb,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_import_status text;
    v_import_campaign_id uuid;
    v_import_theoretical_scope text;
    v_import_consumed_campaign_id uuid;
    v_import_cutoff_at timestamptz;
    v_campaign_product_scope text;
    v_import_storage_path text;
    v_existing_import_id uuid;
    v_existing_status text;
    v_now timestamptz := pg_catalog.now();
BEGIN
    IF p_file_sha256 IS NOT NULL AND p_file_sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.manage');

    SELECT si.status, si.campaign_id, si.theoretical_scope, si.consumed_campaign_id, si.cutoff_at, si.storage_path, ic.product_scope
    INTO v_import_status, v_import_campaign_id, v_import_theoretical_scope, v_import_consumed_campaign_id, v_import_cutoff_at, v_import_storage_path, v_campaign_product_scope
    FROM inventarios.stock_imports si
    JOIN inventarios.inventory_campaigns ic ON ic.company_id = si.company_id AND ic.id = si.campaign_id
    WHERE si.company_id = p_company_id AND si.id = p_import_id
    FOR UPDATE OF si;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no existe.','retryable',false)::text;
    END IF;
    IF v_import_campaign_id IS NULL OR v_import_theoretical_scope IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no pertenece a una campana valida.','retryable',false)::text;
    END IF;
    IF v_import_consumed_campaign_id IS NOT NULL OR v_import_status = 'CONSUMED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_CONSUMED',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion ya fue consumida.','retryable',false)::text;
    END IF;

    IF v_import_status IN ('VALIDATED', 'REJECTED') AND p_file_sha256 IS NOT NULL AND v_import_status IS NOT NULL THEN
        IF (SELECT si.file_sha256 FROM inventarios.stock_imports si WHERE si.company_id = p_company_id AND si.id = p_import_id) = p_file_sha256 THEN
            RETURN pg_catalog.jsonb_build_object(
                'operation', 'inventarios.validate_campaign_stock_import',
                'entity_id', p_import_id,
                'state', v_import_status,
                'version', NULL::integer,
                'cycle_number', NULL::integer,
                'assignment_id', NULL::uuid,
                'event_id', NULL::uuid,
                'replayed', true,
                'occurred_at', v_now,
                'data', pg_catalog.jsonb_build_object(
                    'import_id', p_import_id,
                    'campaign_id', v_import_campaign_id,
                    'theoretical_scope', v_import_theoretical_scope,
                    'status', v_import_status,
                    'storage_path_to_remove', NULL::text
                )
            );
        END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no admite validacion en su estado actual.','retryable',false,'status',v_import_status)::text;
    END IF;

    IF p_file_sha256 IS NOT NULL THEN
        SELECT si.id, si.status
        INTO v_existing_import_id, v_existing_status
        FROM inventarios.stock_imports si
        WHERE si.company_id = p_company_id
          AND si.campaign_id = v_import_campaign_id
          AND si.theoretical_scope = v_import_theoretical_scope
          AND si.cutoff_at = v_import_cutoff_at
          AND si.file_sha256 = p_file_sha256
          AND si.status <> 'CONSUMED'
          AND si.id <> p_import_id
        ORDER BY si.created_at
        LIMIT 1;

        IF v_existing_import_id IS NOT NULL THEN
            DELETE FROM inventarios.stock_import_row_issues WHERE company_id = p_company_id AND import_id = p_import_id;
            DELETE FROM inventarios.stock_import_rows WHERE company_id = p_company_id AND import_id = p_import_id;
            DELETE FROM inventarios.stock_imports WHERE company_id = p_company_id AND id = p_import_id;

            RETURN pg_catalog.jsonb_build_object(
                'operation', 'inventarios.validate_campaign_stock_import',
                'entity_id', v_existing_import_id,
                'state', v_existing_status,
                'version', NULL::integer,
                'cycle_number', NULL::integer,
                'assignment_id', NULL::uuid,
                'event_id', NULL::uuid,
                'replayed', true,
                'occurred_at', v_now,
                'data', pg_catalog.jsonb_build_object(
                    'import_id', v_existing_import_id,
                    'campaign_id', v_import_campaign_id,
                    'theoretical_scope', v_import_theoretical_scope,
                    'status', v_existing_status,
                    'storage_path_to_remove', v_import_storage_path
                )
            );
        END IF;

        UPDATE inventarios.stock_imports
            SET file_sha256 = p_file_sha256,
            metadata = COALESCE(metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
                'file_sha256', p_file_sha256,
                'sealed_at', v_now
            ),
            updated_at = v_now,
            updated_by = v_actor_id
        WHERE company_id = p_company_id AND id = p_import_id;
    END IF;

    RETURN inventarios.validate_campaign_stock_import(p_company_id, p_import_id, p_file_issues, p_rows, p_idempotency_key);
END;
$$;

-- ============================================================
-- 4. GET CAMPAIGN STOCK IMPORT (amplia metadatos de archivo)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_campaign_stock_import(
    p_company_id uuid,
    p_import_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
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

    PERFORM inventarios.require_permission(p_company_id, 'inventarios.imports.read');

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
        'mime_type', si.mime_type,
        'file_size', si.file_size,
        'file_sha256', si.file_sha256,
        'storage_path', si.storage_path,
        'previous_storage_path', si.previous_storage_path,
        'previous_file_sha256', si.previous_file_sha256,
        'metadata', COALESCE(si.metadata, '{}'::jsonb),
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

ALTER FUNCTION inventarios.create_campaign_stock_import(uuid, uuid, text, timestamptz, text, text, text, bigint, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.register_campaign_stock_import_file(uuid, uuid, text, text, text, bigint, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.validate_campaign_stock_import(uuid, uuid, char, jsonb, jsonb, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.get_campaign_stock_import(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.create_campaign_stock_import(uuid, uuid, text, timestamptz, text, text, text, bigint, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.register_campaign_stock_import_file(uuid, uuid, text, text, text, bigint, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.validate_campaign_stock_import(uuid, uuid, char, jsonb, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_campaign_stock_import(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.create_campaign_stock_import(uuid, uuid, text, timestamptz, text, text, text, bigint, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.register_campaign_stock_import_file(uuid, uuid, text, text, text, bigint, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.validate_campaign_stock_import(uuid, uuid, char, jsonb, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_campaign_stock_import(uuid, uuid) TO authenticated;
