-- Migration: 20260805162000_inventarios_campaign_import_storage_path_fix.sql
-- Description: Endurece la ruta de Storage para importaciones de campana.
-- Author: Assistant

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
    v_expected_path text;
    v_safe_filename text;
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
    v_safe_filename := pg_catalog.regexp_replace(v_filename, '[^A-Za-z0-9._-]', '_', 'g');
    v_expected_path := v_expected_prefix || p_import_id::text || '-' || v_safe_filename;
    IF pg_catalog.btrim(p_storage_path) <> v_expected_path THEN
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
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_import_id;

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
        'data', pg_catalog.jsonb_build_object('import_id', p_import_id, 'storage_path', pg_catalog.btrim(p_storage_path), 'original_filename', v_filename, 'mime_type', NULLIF(v_mime, ''), 'file_size', p_file_size)
    );

    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_import_id, v_response);
END;
$$;

ALTER FUNCTION inventarios.register_campaign_stock_import_file(uuid, uuid, text, text, text, bigint, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.register_campaign_stock_import_file(uuid, uuid, text, text, text, bigint, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.register_campaign_stock_import_file(uuid, uuid, text, text, text, bigint, uuid) TO authenticated;
