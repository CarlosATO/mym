-- Migration: 20260803104000_qa_probe_coalesce_fix.sql
-- PRUEBA: redefine list_inventory_sessions con casts explícitos para validar el fix
-- de coalesce(text, unknown). Se reemplazará por la corrección definitiva.

CREATE OR REPLACE FUNCTION inventarios.list_inventory_sessions(
    p_company_id uuid,
    p_status text,
    p_warehouse_id uuid,
    p_date_from date,
    p_date_to date,
    p_search text,
    p_page integer,
    p_page_size integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_status text; v_search text;
    v_page integer; v_page_size integer;
    v_offset integer; v_total bigint;
    v_rows jsonb;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    v_status := pg_catalog.upper(pg_catalog.btrim(coalesce(p_status, ''::text)));
    v_search := pg_catalog.btrim(coalesce(p_search, ''::text));
    v_page := coalesce(p_page, 1::integer);
    v_page_size := coalesce(p_page_size, 25::integer);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 25; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    SELECT pg_catalog.count(*) INTO v_total
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id
      AND (v_status = '' OR s.status = v_status)
      AND (p_warehouse_id IS NULL OR s.warehouse_id = p_warehouse_id)
      AND (p_date_from IS NULL OR s.created_at >= p_date_from::timestamptz)
      AND (p_date_to IS NULL OR s.created_at < (p_date_to + 1)::timestamptz)
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
            'prepared_at', s.prepared_at,
            'started_at', s.started_at,
            'reviewed_at', s.reviewed_at,
            'approved_at', s.approved_at,
            'cancelled_at', s.cancelled_at,
            'created_at', s.created_at,
            'created_by', s.created_by,
            'zone_count', (
                SELECT pg_catalog.count(*) FROM inventarios.session_zones sz
                WHERE sz.company_id = s.company_id AND sz.session_id = s.id
            ),
            'task_count', (
                SELECT pg_catalog.count(*) FROM inventarios.tasks t
                WHERE t.company_id = s.company_id AND t.session_id = s.id
                  AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
            ),
            'task_completed_count', (
                SELECT pg_catalog.count(*) FROM inventarios.tasks t
                WHERE t.company_id = s.company_id AND t.session_id = s.id
                  AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
                  AND t.status = 'COMPLETED'
            ),
            'count_entry_count', (
                SELECT pg_catalog.count(*) FROM inventarios.count_entries ce
                WHERE ce.company_id = s.company_id AND ce.session_id = s.id
            ),
            'blocking_incident_count', (
                SELECT pg_catalog.count(*) FROM inventarios.incidents i
                WHERE i.company_id = s.company_id AND i.session_id = s.id
                  AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW')
            )
        ) AS row_data
        FROM inventarios.sessions s
        LEFT JOIN adquisiciones.warehouses w
          ON w.id = s.warehouse_id
        WHERE s.company_id = p_company_id
          AND (v_status = '' OR s.status = v_status)
          AND (p_warehouse_id IS NULL OR s.warehouse_id = p_warehouse_id)
          AND (p_date_from IS NULL OR s.created_at >= p_date_from::timestamptz)
          AND (p_date_to IS NULL OR s.created_at < (p_date_to + 1)::timestamptz)
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

ALTER FUNCTION inventarios.list_inventory_sessions(uuid, text, uuid, date, date, text, integer, integer) OWNER TO postgres;
