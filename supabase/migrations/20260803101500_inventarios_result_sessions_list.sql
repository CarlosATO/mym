-- Migration: 20260803101500_inventarios_result_sessions_list.sql
-- Description: Fase 4H.2G4. Listado paginado de jornadas con resultado oficial:
--              APPROVED, EXPORTED, RECONCILED, CANCELLED. No toca la firma de
--              list_inventory_sessions (Operación/Revisión).
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.list_inventory_result_sessions(
    p_company_id uuid,
    p_statuses text[],
    p_search text,
    p_page integer,
    p_page_size integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_statuses text[];
    v_search text;
    v_page integer; v_page_size integer;
    v_offset integer; v_total bigint;
    v_rows jsonb;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    v_statuses := pg_catalog.coalesce(p_statuses, ARRAY['APPROVED','EXPORTED','RECONCILED','CANCELLED']::text[]);
    v_search := pg_catalog.btrim(pg_catalog.coalesce(p_search, ''));
    v_page := pg_catalog.coalesce(p_page, 1);
    v_page_size := pg_catalog.coalesce(p_page_size, 100);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 100; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    SELECT pg_catalog.count(*) INTO v_total
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id
      AND s.status = ANY(v_statuses)
      AND (v_search = '' OR s.name ILIKE '%' || v_search || '%'
           OR s.session_number::text LIKE '%' || v_search || '%');

    SELECT pg_catalog.jsonb_agg(row_data ORDER BY row_data ->> 'created_at' DESC)
    INTO v_rows
    FROM (
        SELECT pg_catalog.jsonb_build_object(
            'id', s.id,
            'session_number', s.session_number,
            'name', s.name,
            'inventory_type', s.inventory_type,
            'status', s.status,
            'scope_mode', s.scope_mode,
            'warehouse_id', s.warehouse_id,
            'warehouse_name', w.name,
            'bsale_office_id', s.bsale_office_id,
            'responsible_user_id', s.responsible_user_id,
            'responsible_name', inventarios.user_display_name(s.responsible_user_id),
            'approved_at', s.approved_at,
            'approved_by_name', inventarios.user_display_name(s.approved_by),
            'exported_at', s.exported_at,
            'reconciled_at', s.reconciled_at,
            'cancelled_at', s.cancelled_at,
            'cancelled_by_name', inventarios.user_display_name(s.cancelled_by),
            'cancellation_reason', s.cancellation_reason,
            'created_at', s.created_at,
            'task_count', (
                SELECT pg_catalog.count(*) FROM inventarios.tasks t
                WHERE t.company_id = s.company_id AND t.session_id = s.id
                  AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
            )
        ) AS row_data
        FROM inventarios.sessions s
        LEFT JOIN adquisiciones.warehouses w
          ON w.id = s.warehouse_id
        WHERE s.company_id = p_company_id
          AND s.status = ANY(v_statuses)
          AND (v_search = '' OR s.name ILIKE '%' || v_search || '%'
               OR s.session_number::text LIKE '%' || v_search || '%')
        ORDER BY s.created_at DESC
        LIMIT v_page_size OFFSET v_offset
    ) AS r;

    RETURN pg_catalog.jsonb_build_object(
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'has_more', v_offset + pg_catalog.jsonb_array_length(CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END) < v_total,
        'sessions', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END
    );
END;
$$;

ALTER FUNCTION inventarios.list_inventory_result_sessions(uuid, text[], text, integer, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.list_inventory_result_sessions(uuid, text[], text, integer, integer)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_result_sessions(uuid, text[], text, integer, integer) TO authenticated;
