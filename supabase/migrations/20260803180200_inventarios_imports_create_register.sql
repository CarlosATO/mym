-- Migration: 20260803180200_inventarios_imports_create_register.sql
-- Description: Fase 4I.3A. RPCs de creacion y registro de importaciones de
--              stock/costo: create_stock_import, register_stock_import_file,
--              replace_stock_import_file y fail_stock_import.
-- Author: Assistant

-- ============================================================
-- 1. CREATE STOCK IMPORT
--    Crea una importacion DRAFT para una unidad inventariable y una
--    modalidad GENERAL | POR_UBICACION. Para INTERNAL_WAREHOUSE el
--    warehouse_id se deriva desde inventory_sites; nunca se acepta una
--    combinacion arbitraria enviada por el cliente.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.create_stock_import(
    p_company_id uuid,
    p_inventory_site_id uuid,
    p_modality text,
    p_cutoff_at timestamptz,
    p_original_filename text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_modality text;
    v_filename text;
    v_site_type text;
    v_warehouse_id uuid;
    v_import_id uuid;
    v_occurred_at timestamptz;
BEGIN
    v_modality := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_modality, '')));
    v_filename := pg_catalog.btrim(COALESCE(p_original_filename, ''));
    IF p_company_id IS NULL OR p_inventory_site_id IS NULL OR p_cutoff_at IS NULL
       OR v_modality NOT IN ('GENERAL', 'POR_UBICACION')
       OR v_filename = '' OR pg_catalog.char_length(v_filename) > 255 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.manage');
    v_occurred_at := pg_catalog.now();

    SELECT site_type, warehouse_id INTO v_site_type, v_warehouse_id
    FROM inventarios.inventory_sites
    WHERE company_id = p_company_id AND id = p_inventory_site_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La unidad inventariable no existe.','retryable',false)::text;
    END IF;

    -- warehouse_id siempre se deriva del sitio (nunca del cliente)
    IF v_site_type = 'INTERNAL_WAREHOUSE' THEN
        IF v_warehouse_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                DETAIL=pg_catalog.jsonb_build_object('message','La bodega interna no tiene bodega asociada.','retryable',false)::text;
        END IF;
    ELSE
        v_warehouse_id := NULL;
    END IF;

    INSERT INTO inventarios.stock_imports (
        company_id, warehouse_id, modality, cutoff_at, original_filename,
        inventory_site_id, status, created_at, created_by, updated_at, updated_by
    ) VALUES (
        p_company_id, v_warehouse_id, v_modality, p_cutoff_at, v_filename,
        p_inventory_site_id, 'DRAFT', v_occurred_at, v_actor_id, v_occurred_at, v_actor_id
    )
    RETURNING id INTO v_import_id;

    RETURN pg_catalog.jsonb_build_object(
        'entity_id', v_import_id,
        'import_id', v_import_id,
        'state', 'DRAFT',
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'import_id', v_import_id,
            'inventory_site_id', p_inventory_site_id,
            'warehouse_id', v_warehouse_id,
            'modality', v_modality,
            'cutoff_at', p_cutoff_at,
            'storage_prefix', p_company_id::text || '/stock-imports/' || v_import_id::text || '/'
        )
    );
END;
$$;

-- ============================================================
-- 2. REGISTER STOCK IMPORT FILE
--    Registra la ruta de storage y los metadatos del archivo que el
--    navegador ya subio al bucket privado inventario-imports.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.register_stock_import_file(
    p_company_id uuid,
    p_import_id uuid,
    p_storage_path text,
    p_original_filename text,
    p_mime_type text,
    p_file_size bigint
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_occurred_at timestamptz;
    v_import_status text;
    v_path text;
    v_filename text;
    v_mime text;
    v_expected_prefix text;
    v_response jsonb;
BEGIN
    v_path := pg_catalog.btrim(COALESCE(p_storage_path, ''));
    v_filename := pg_catalog.btrim(COALESCE(p_original_filename, ''));
    v_mime := pg_catalog.btrim(COALESCE(p_mime_type, ''));
    v_expected_prefix := p_company_id::text || '/stock-imports/' || p_import_id::text || '/';

    IF p_company_id IS NULL OR p_import_id IS NULL OR v_path = ''
       OR v_filename = '' OR p_file_size IS NULL OR p_file_size <= 0
       OR pg_catalog.strpos(v_path, v_expected_prefix) <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La ruta del archivo no corresponde a la importacion.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.manage');
    v_occurred_at := pg_catalog.now();

    SELECT status INTO v_import_status
    FROM inventarios.stock_imports
    WHERE company_id = p_company_id AND id = p_import_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no existe.','retryable',false)::text;
    END IF;
    IF v_import_status = 'CONSUMED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_CONSUMED',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion ya fue consumida.','retryable',false)::text;
    END IF;

    UPDATE inventarios.stock_imports
    SET storage_path = v_path,
        original_filename = v_filename,
        mime_type = NULLIF(v_mime, ''),
        file_size = p_file_size,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_import_id;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_import_id, 'state', 'FILE_REGISTERED', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('import_id', p_import_id, 'storage_path', v_path)
    );
    RETURN v_response;
END;
$$;

-- ============================================================
-- 3. REPLACE STOCK IMPORT FILE
--    Reemplaza el archivo de una importacion no consumida. Conserva
--    trazabilidad del archivo anterior y registra el evento de reemplazo.
--    Vuelve la importacion a DRAFT y elimina filas/issues previos.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.replace_stock_import_file(
    p_company_id uuid,
    p_import_id uuid,
    p_storage_path text,
    p_original_filename text,
    p_mime_type text,
    p_file_size bigint
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_occurred_at timestamptz;
    v_path text;
    v_filename text;
    v_mime text;
    v_expected_prefix text;
    v_old_path text;
    v_old_sha char(64);
    v_old_filename text;
    v_old_mime text;
    v_old_size bigint;
    v_import_status text;
    v_response jsonb;
BEGIN
    v_path := pg_catalog.btrim(COALESCE(p_storage_path, ''));
    v_filename := pg_catalog.btrim(COALESCE(p_original_filename, ''));
    v_mime := pg_catalog.btrim(COALESCE(p_mime_type, ''));
    v_expected_prefix := p_company_id::text || '/stock-imports/' || p_import_id::text || '/';

    IF p_company_id IS NULL OR p_import_id IS NULL OR v_path = ''
       OR v_filename = '' OR p_file_size IS NULL OR p_file_size <= 0
       OR pg_catalog.strpos(v_path, v_expected_prefix) <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La ruta del archivo no corresponde a la importacion.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.manage');
    v_occurred_at := pg_catalog.now();

    SELECT storage_path, file_sha256, original_filename, mime_type, file_size, status
    INTO v_old_path, v_old_sha, v_old_filename, v_old_mime, v_old_size, v_import_status
    FROM inventarios.stock_imports
    WHERE company_id = p_company_id AND id = p_import_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no existe.','retryable',false)::text;
    END IF;
    IF v_import_status = 'CONSUMED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_CONSUMED',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion ya fue consumida.','retryable',false)::text;
    END IF;

    -- Trazabilidad del archivo anterior
    UPDATE inventarios.stock_imports
    SET previous_storage_path = v_old_path,
        previous_file_sha256 = v_old_sha,
        storage_path = v_path,
        original_filename = v_filename,
        mime_type = NULLIF(v_mime, ''),
        file_size = p_file_size,
        file_sha256 = NULL,
        status = 'DRAFT',
        row_count = 0,
        error_count = 0,
        warning_count = 0,
        file_issues = '[]'::jsonb,
        validated_at = NULL,
        validated_by = NULL,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_import_id;

    -- Elimina filas/issues anteriores (reemplazo controlado)
    DELETE FROM inventarios.stock_import_rows
    WHERE company_id = p_company_id AND import_id = p_import_id;

    -- Auditoria del reemplazo
    INSERT INTO portal.audit_logs (
        schema_name, module_code, table_name, record_id, action,
        old_data, new_data, performed_by, event_type, severity
    ) VALUES (
        'inventarios', 'inventarios', 'stock_imports', p_import_id, 'REPLACE_FILE',
        pg_catalog.jsonb_build_object('storage_path', v_old_path, 'file_sha256', v_old_sha, 'filename', v_old_filename, 'mime', v_old_mime, 'size', v_old_size),
        pg_catalog.jsonb_build_object('storage_path', v_path, 'filename', v_filename, 'mime', v_mime, 'size', p_file_size),
        v_actor_id, 'stock_import_file_replaced', 'INFO'
    );

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_import_id, 'state', 'DRAFT', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('import_id', p_import_id, 'storage_path', v_path,
            'previous_storage_path', v_old_path, 'previous_file_sha256', v_old_sha)
    );
    RETURN v_response;
END;
$$;

-- ============================================================
-- 4. FAIL STOCK IMPORT
--    Marca una importacion como REJECTED ante un error de nivel de archivo
--    (hoja Datos ausente, archivo ilegible, etc.) y registra el issue.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.fail_stock_import(
    p_company_id uuid,
    p_import_id uuid,
    p_issue_code text,
    p_safe_message text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_occurred_at timestamptz;
    v_code text;
    v_message text;
    v_import_status text;
    v_response jsonb;
BEGIN
    v_code := pg_catalog.btrim(COALESCE(p_issue_code, ''));
    v_message := pg_catalog.btrim(COALESCE(p_safe_message, ''));
    IF p_company_id IS NULL OR p_import_id IS NULL OR v_code = '' OR v_message = ''
       OR pg_catalog.char_length(v_message) > 500 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.imports.manage');
    v_occurred_at := pg_catalog.now();

    SELECT status INTO v_import_status
    FROM inventarios.stock_imports
    WHERE company_id = p_company_id AND id = p_import_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no existe.','retryable',false)::text;
    END IF;
    IF v_import_status = 'CONSUMED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_CONSUMED',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion ya fue consumida.','retryable',false)::text;
    END IF;

    UPDATE inventarios.stock_imports
    SET file_issues = file_issues || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('level', 'ERROR', 'code', v_code, 'message', v_message)
        ),
        status = 'REJECTED',
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_import_id;

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', p_import_id, 'state', 'REJECTED', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('import_id', p_import_id, 'status', 'REJECTED')
    );
    RETURN v_response;
END;
$$;

-- ============================================================
-- 5. GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.create_stock_import(uuid, uuid, text, timestamptz, text) OWNER TO postgres;
ALTER FUNCTION inventarios.register_stock_import_file(uuid, uuid, text, text, text, bigint) OWNER TO postgres;
ALTER FUNCTION inventarios.replace_stock_import_file(uuid, uuid, text, text, text, bigint) OWNER TO postgres;
ALTER FUNCTION inventarios.fail_stock_import(uuid, uuid, text, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.create_stock_import(uuid, uuid, text, timestamptz, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.register_stock_import_file(uuid, uuid, text, text, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.replace_stock_import_file(uuid, uuid, text, text, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.fail_stock_import(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.create_stock_import(uuid, uuid, text, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.register_stock_import_file(uuid, uuid, text, text, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.replace_stock_import_file(uuid, uuid, text, text, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.fail_stock_import(uuid, uuid, text, text) TO authenticated;
