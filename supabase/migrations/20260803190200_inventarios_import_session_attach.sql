-- Migration: 20260803190200_inventarios_import_session_attach.sql
-- Description: Fase 4I.3B. Asociacion de importaciones EXCEL_IMPORT validadas
--              con sesiones de inventario DRAFT.
--              1) list_validated_stock_imports_for_session: importaciones
--                 elegibles (VALIDATED, mismo sitio, no consumidas, no
--                 asociadas, archivo registrado).
--              2) attach_stock_import_to_session: valida reglas de asociacion
--                 y vincula la importacion a la sesion (stock_source,
--                 stock_import_id, inventory_site_id, warehouse_id derivado).
-- Author: Assistant

-- ============================================================
-- 1. LIST VALIDATED STOCK IMPORTS FOR SESSION
--    Devuelve las importaciones EXCEL_IMPORT elegibles para una sesion
--    DRAFT. Solo VALIDATED, misma empresa, mismo inventory_site, no
--    CONSUMED, sin consumed_session_id y con archivo registrado.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_validated_stock_imports_for_session(
    p_company_id uuid,
    p_session_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_site_id uuid;
    v_session_status text;
    v_rows jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT s.inventory_site_id, s.status INTO v_site_id, v_session_status
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no existe.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RETURN pg_catalog.jsonb_build_object('imports', '[]'::jsonb, 'total', 0, 'site_id', v_site_id);
    END IF;

    SELECT pg_catalog.jsonb_agg(jb)
    INTO v_rows
    FROM (
        SELECT pg_catalog.jsonb_build_object(
            'id', si.id,
            'original_filename', si.original_filename,
            'modality', si.modality,
            'cutoff_at', si.cutoff_at,
            'row_count', si.row_count,
            'error_count', si.error_count,
            'warning_count', si.warning_count,
            'validated_at', si.validated_at,
            'created_at', si.created_at,
            'created_by_name', inventarios.user_display_name(si.created_by),
            'status', si.status,
            'cost_coverage', CASE
                WHEN agg.row_total = 0 THEN 0
                ELSE (100 * agg.row_with_cost / agg.row_total)
            END,
            'products_with_cost', agg.row_with_cost,
            'products_without_cost', agg.row_total - agg.row_with_cost
        ) AS jb
        FROM inventarios.stock_imports si
        JOIN (
            SELECT r.import_id,
                   pg_catalog.count(*) AS row_total,
                   pg_catalog.count(*) FILTER (WHERE r.unit_cost > 0) AS row_with_cost
            FROM inventarios.stock_import_rows r
            WHERE r.company_id = p_company_id
              AND r.row_status IN ('VALID', 'WARNING')
            GROUP BY r.import_id
        ) agg ON agg.import_id = si.id
        WHERE si.company_id = p_company_id
          AND si.inventory_site_id = v_site_id
          AND si.status = 'VALIDATED'
          AND si.consumed_session_id IS NULL
          AND si.storage_path IS NOT NULL
          AND si.file_sha256 IS NOT NULL
        ORDER BY si.cutoff_at DESC
    ) x;

    RETURN pg_catalog.jsonb_build_object(
        'imports', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END,
        'total', CASE WHEN v_rows IS NULL THEN 0 ELSE pg_catalog.jsonb_array_length(v_rows) END,
        'site_id', v_site_id
    );
END;
$$;

-- ============================================================
-- 2. ATTACH STOCK IMPORT TO SESSION
--    Valida las reglas de asociacion y vincula la importacion a la
--    sesion DRAFT:
--      - importacion VALIDATED, misma empresa, mismo inventory_site
--      - no CONSUMED, sin consumed_session_id, archivo registrado
--      - sesion DRAFT y pertenece al campaign_site correspondiente
--      - stock_source = EXCEL_IMPORT
--    warehouse_id se deriva del sitio interno (nunca del cliente).
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.attach_stock_import_to_session(
    p_company_id uuid,
    p_session_id uuid,
    p_stock_import_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_operation jsonb; v_operation_id uuid;
    v_occurred_at timestamptz;
    v_session_status text;
    v_session_site_id uuid;
    v_session_campaign_id uuid;
    v_import_status text;
    v_import_site_id uuid;
    v_import_consumed_session_id uuid;
    v_import_storage_path text;
    v_import_sha char(64);
    v_import_modality text;
    v_import_cutoff timestamptz;
    v_import_filename text;
    v_import_warehouse_id uuid;
    v_site_type text;
    v_warehouse_id uuid;
    v_response jsonb;
    v_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_stock_import_id IS NULL
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.configure');
    v_occurred_at := pg_catalog.now();

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.attach_stock_import_to_session'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.attach_stock_import','company_id',p_company_id,
        'session_id',p_session_id,'stock_import_id',p_stock_import_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.attach_stock_import',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT s.status, s.inventory_site_id, s.campaign_id
    INTO v_session_status, v_session_site_id, v_session_campaign_id
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no existe.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no esta en estado DRAFT.','retryable',false,'status',v_session_status)::text;
    END IF;

    SELECT si.status, si.inventory_site_id, si.consumed_session_id, si.storage_path,
           si.file_sha256, si.modality, si.cutoff_at, si.original_filename, si.warehouse_id
    INTO v_import_status, v_import_site_id, v_import_consumed_session_id, v_import_storage_path,
         v_import_sha, v_import_modality, v_import_cutoff, v_import_filename, v_import_warehouse_id
    FROM inventarios.stock_imports si
    WHERE si.company_id = p_company_id AND si.id = p_stock_import_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no existe.','retryable',false)::text;
    END IF;

    IF v_import_status <> 'VALIDATED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_NOT_VALIDATED',
            DETAIL=pg_catalog.jsonb_build_object('message','Solo se puede asociar una importacion VALIDATED.','retryable',false,'status',v_import_status)::text;
    END IF;
    IF v_import_site_id IS DISTINCT FROM v_session_site_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_SITE_MISMATCH',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no pertenece a la unidad de la jornada.','retryable',false)::text;
    END IF;
    IF v_import_consumed_session_id IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_ALREADY_ASSIGNED',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion ya esta asociada a otra jornada.','retryable',false)::text;
    END IF;
    IF v_import_storage_path IS NULL OR v_import_sha IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_SCOPE_MISMATCH',
            DETAIL=pg_catalog.jsonb_build_object('message','La importacion no tiene un archivo registrado.','retryable',false)::text;
    END IF;

    -- La sesion debe pertenecer al campaign_site correspondiente (si viene de campana)
    IF v_session_campaign_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_campaign_sites ics
        WHERE ics.company_id = p_company_id AND ics.campaign_id = v_session_campaign_id
          AND ics.inventory_site_id = v_session_site_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_IMPORT_SCOPE_MISMATCH',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no pertenece a la unidad de la campana.','retryable',false)::text;
    END IF;

    -- warehouse_id se deriva del sitio (nunca del cliente)
    SELECT site_type, warehouse_id INTO v_site_type, v_warehouse_id
    FROM inventarios.inventory_sites
    WHERE company_id = p_company_id AND id = v_session_site_id;
    IF v_site_type = 'INTERNAL_WAREHOUSE' AND v_warehouse_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La bodega interna no tiene bodega asociada.','retryable',false)::text;
    END IF;
    IF v_site_type <> 'INTERNAL_WAREHOUSE' THEN
        v_warehouse_id := NULL;
    END IF;

    UPDATE inventarios.sessions
    SET stock_source = 'EXCEL_IMPORT',
        stock_import_id = p_stock_import_id,
        inventory_site_id = v_session_site_id,
        warehouse_id = v_warehouse_id,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_session_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.attach_stock_import','entity_id',p_session_id,
        'state','DRAFT','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('session_id',p_session_id,
            'stock_import_id',p_stock_import_id,'inventory_site_id',v_session_site_id,
            'warehouse_id',v_warehouse_id,'stock_source','EXCEL_IMPORT',
            'modality',v_import_modality,'cutoff_at',v_import_cutoff,
            'filename',v_import_filename,'status',v_import_status));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_response);
END;
$$;

-- ============================================================
-- GRANTS / OWNER
-- ============================================================
ALTER FUNCTION inventarios.list_validated_stock_imports_for_session(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.attach_stock_import_to_session(uuid, uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.list_validated_stock_imports_for_session(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.attach_stock_import_to_session(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.list_validated_stock_imports_for_session(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.attach_stock_import_to_session(uuid, uuid, uuid, uuid) TO authenticated;
