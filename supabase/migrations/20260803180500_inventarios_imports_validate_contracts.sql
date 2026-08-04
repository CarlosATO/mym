-- Migration: 20260803180310_inventarios_imports_validate_contracts.sql
-- Description: Fase 4I.3A. Contratos publicos de validacion de importaciones
--              de stock/costo: validate_stock_import y revalidate_stock_import.
--              Ambos delegan en el nucleo _process_stock_import_rows.
-- Author: Assistant

-- ============================================================
-- VALIDATE STOCK IMPORT
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.validate_stock_import(
    p_company_id uuid,
    p_import_id uuid,
    p_file_sha256 char(64),
    p_file_issues jsonb,
    p_rows jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    RETURN inventarios._process_stock_import_rows(
        p_company_id, p_import_id, p_file_sha256, p_file_issues, p_rows, 'VALIDATE'
    );
END;
$$;

-- ============================================================
-- REVALIDATE STOCK IMPORT
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.revalidate_stock_import(
    p_company_id uuid,
    p_import_id uuid,
    p_file_sha256 char(64),
    p_file_issues jsonb,
    p_rows jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    RETURN inventarios._process_stock_import_rows(
        p_company_id, p_import_id, p_file_sha256, p_file_issues, p_rows, 'REVALIDATE'
    );
END;
$$;

-- ============================================================
-- GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios._process_stock_import_rows(uuid, uuid, char, jsonb, jsonb, text) OWNER TO postgres;
ALTER FUNCTION inventarios.validate_stock_import(uuid, uuid, char, jsonb, jsonb) OWNER TO postgres;
ALTER FUNCTION inventarios.revalidate_stock_import(uuid, uuid, char, jsonb, jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios._process_stock_import_rows(uuid, uuid, char, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.validate_stock_import(uuid, uuid, char, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.revalidate_stock_import(uuid, uuid, char, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.validate_stock_import(uuid, uuid, char, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.revalidate_stock_import(uuid, uuid, char, jsonb, jsonb) TO authenticated;
