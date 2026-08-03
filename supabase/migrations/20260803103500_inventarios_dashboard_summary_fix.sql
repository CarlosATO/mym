-- Migration: 20260803103500_inventarios_dashboard_summary_fix.sql
-- Description: Fase 4H.2G5. Corrige get_inventory_dashboard_summary: calcula el
--              avance de conteo con conteos reales de tareas (sessions no tiene
--              task_count) y desambigua aliases.
-- Author: Assistant

CREATE OR REPLACE FUNCTION inventarios.get_inventory_dashboard_summary(
    p_company_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_kpis jsonb;
    v_attention jsonb;
    v_alerts jsonb;
    v_active_count bigint;
    v_counting_count bigint;
    v_review_count bigint;
    v_blocking_count bigint;
    v_avg_progress numeric;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT
        pg_catalog.count(*) FILTER (WHERE s.status IN ('PREPARED','COUNTING')),
        pg_catalog.count(*) FILTER (WHERE s.status = 'COUNTING'),
        pg_catalog.count(*) FILTER (WHERE s.status = 'UNDER_REVIEW')
    INTO v_active_count, v_counting_count, v_review_count
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id;

    SELECT pg_catalog.count(*) INTO v_blocking_count
    FROM inventarios.incidents i
    WHERE i.company_id = p_company_id
      AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW');

    SELECT pg_catalog.coalesce(pg_catalog.avg(x.progress), 0)
    INTO v_avg_progress
    FROM (
        SELECT CASE
            WHEN t.total > 0 THEN
                pg_catalog.round((t.completed::numeric / t.total::numeric) * 100, 1)
            ELSE 0
        END AS progress
        FROM inventarios.sessions s
        CROSS JOIN LATERAL (
            SELECT
                pg_catalog.count(*) AS total,
                pg_catalog.count(*) FILTER (WHERE st.status = 'COMPLETED') AS completed
            FROM inventarios.tasks st
            WHERE st.company_id = s.company_id AND st.session_id = s.id
              AND st.cancelled_at IS NULL AND st.superseded_at IS NULL
        ) t
        WHERE s.company_id = p_company_id AND s.status = 'COUNTING'
    ) x;

    v_kpis := pg_catalog.jsonb_build_object(
        'active_count', v_active_count,
        'counting_count', v_counting_count,
        'review_count', v_review_count,
        'blocking_count', v_blocking_count,
        'average_progress', v_avg_progress
    );

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', sess.id,
                'session_number', sess.session_number,
                'name', sess.name,
                'status', sess.status,
                'inventory_type', sess.inventory_type,
                'scope_mode', sess.scope_mode,
                'warehouse_name', w.name,
                'responsible_name', inventarios.user_display_name(sess.responsible_user_id),
                'task_count', sess.task_count,
                'task_completed_count', sess.task_completed_count,
                'blocking_incident_count', (
                    SELECT pg_catalog.count(*) FROM inventarios.incidents i
                    WHERE i.company_id = sess.company_id AND i.session_id = sess.id
                      AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW')
                ),
                'created_at', sess.created_at
            )
            ORDER BY
                CASE sess.status WHEN 'UNDER_REVIEW' THEN 1 WHEN 'COUNTING' THEN 2 ELSE 3 END,
                sess.created_at DESC
        )
    END
    INTO v_attention
    FROM (
        SELECT sess.*,
               (SELECT pg_catalog.count(*) FROM inventarios.tasks t
                WHERE t.company_id = sess.company_id AND t.session_id = sess.id
                  AND t.cancelled_at IS NULL AND t.superseded_at IS NULL) AS task_count,
               (SELECT pg_catalog.count(*) FROM inventarios.tasks t
                WHERE t.company_id = sess.company_id AND t.session_id = sess.id
                  AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
                  AND t.status = 'COMPLETED') AS task_completed_count
        FROM inventarios.sessions sess
        WHERE sess.company_id = p_company_id
          AND sess.status IN ('PREPARED','COUNTING','UNDER_REVIEW')
    ) sess
    LEFT JOIN adquisiciones.warehouses w ON w.id = sess.warehouse_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', i.id,
                'session_id', i.session_id,
                'session_number', s.session_number,
                'session_name', s.name,
                'category_code', i.category_code,
                'severity', i.severity,
                'status', i.status,
                'is_blocking', i.is_blocking,
                'affected_quantity', i.affected_quantity,
                'description', i.description,
                'reported_by_name', inventarios.user_display_name(i.reported_by),
                'reported_at', i.reported_at
            )
            ORDER BY i.reported_at DESC
        )
    END
    INTO v_alerts
    FROM (
        SELECT i.id, i.session_id, i.category_code, i.severity, i.status,
               i.is_blocking, i.affected_quantity, i.description, i.reported_by, i.reported_at
        FROM inventarios.incidents i
        JOIN inventarios.sessions s ON s.company_id = i.company_id AND s.id = i.session_id
        WHERE i.company_id = p_company_id
          AND s.status IN ('PREPARED','COUNTING','UNDER_REVIEW')
          AND i.status IN ('OPEN','UNDER_REVIEW')
        ORDER BY i.reported_at DESC
        LIMIT 8
    ) i
    JOIN inventarios.sessions s ON s.company_id = p_company_id AND s.id = i.session_id;

    RETURN pg_catalog.jsonb_build_object(
        'kpis', v_kpis,
        'attention_sessions', CASE WHEN v_attention IS NULL THEN '[]'::jsonb ELSE v_attention END,
        'recent_alerts', CASE WHEN v_alerts IS NULL THEN '[]'::jsonb ELSE v_alerts END
    );
END;
$$;

ALTER FUNCTION inventarios.get_inventory_dashboard_summary(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_dashboard_summary(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_dashboard_summary(uuid) TO authenticated;
