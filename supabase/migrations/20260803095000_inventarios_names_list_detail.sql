-- Migration: 20260803095000_inventarios_names_list_detail.sql
-- Description: Fase 4H.2E. Resuelve nombres visibles de usuarios en las RPCs de
--              lectura (responsable, participantes, asignaciones, actores de
--              auditoria) mediante display_name. Redefine list_inventory_sessions
--              y get_inventory_session_detail.
-- Author: Assistant

-- ============================================================
-- 1. HELPER: user_display_name
--    Devuelve 'Nombre Apellido' para un usuario o NULL si no existe.
-- ============================================================
CREATE FUNCTION inventarios.user_display_name(
    p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_name text;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT pg_catalog.concat_ws(' ', pg_catalog.btrim(u.nombre), pg_catalog.btrim(u.apellido))
    INTO v_name
    FROM portal.users u
    WHERE u.id = p_user_id AND u.deleted_at IS NULL;
    IF v_name = '' THEN
        RETURN NULL;
    END IF;
    RETURN v_name;
END;
$$;

ALTER FUNCTION inventarios.user_display_name(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.user_display_name(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- 2. list_inventory_sessions: agrega responsible_name
-- ============================================================
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
    v_status := pg_catalog.upper(pg_catalog.btrim(pg_catalog.coalesce(p_status, '')));
    v_search := pg_catalog.btrim(pg_catalog.coalesce(p_search, ''));
    v_page := pg_catalog.coalesce(p_page, 1);
    v_page_size := pg_catalog.coalesce(p_page_size, 25);
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

-- ============================================================
-- 3. get_inventory_session_detail: agrega nombres de usuarios
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_detail(
    p_company_id uuid,
    p_session_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_session jsonb;
    v_snapshot jsonb;
    v_participants jsonb;
    v_zones jsonb;
    v_tasks jsonb;
    v_incidents jsonb;
    v_recounts jsonb;
    v_counts jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT pg_catalog.jsonb_build_object(
        'id', s.id, 'company_id', s.company_id, 'session_number', s.session_number,
        'name', s.name, 'inventory_type', s.inventory_type, 'status', s.status,
        'scope_mode', s.scope_mode, 'warehouse_id', s.warehouse_id,
        'warehouse_name', w.name,
        'bsale_office_id', s.bsale_office_id, 'responsible_user_id', s.responsible_user_id,
        'responsible_name', inventarios.user_display_name(s.responsible_user_id),
        'notes', s.notes,
        'prepared_at', s.prepared_at, 'started_at', s.started_at,
        'reviewed_at', s.reviewed_at, 'approved_at', s.approved_at,
        'approved_by', s.approved_by, 'approved_by_name', inventarios.user_display_name(s.approved_by),
        'exported_at', s.exported_at, 'reconciled_at', s.reconciled_at,
        'cancelled_at', s.cancelled_at, 'cancelled_by', s.cancelled_by,
        'cancelled_by_name', inventarios.user_display_name(s.cancelled_by),
        'cancellation_reason', s.cancellation_reason,
        'created_at', s.created_at, 'created_by', s.created_by,
        'created_by_name', inventarios.user_display_name(s.created_by),
        'updated_at', s.updated_at, 'updated_by', s.updated_by
    )
    INTO v_session
    FROM inventarios.sessions s
    LEFT JOIN adquisiciones.warehouses w
      ON w.id = s.warehouse_id
    WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF v_session IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.jsonb_build_object(
        'id', os.id, 'snapshot_version', os.snapshot_version,
        'completion_status', os.completion_status, 'content_hash', os.content_hash,
        'captured_at', os.captured_at, 'captured_by', os.captured_by,
        'captured_by_name', inventarios.user_display_name(os.captured_by)
    )
    INTO v_snapshot
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', sp.id, 'user_id', sp.user_id, 'user_name', inventarios.user_display_name(sp.user_id),
                'functional_role', sp.functional_role,
                'active_from', sp.active_from, 'revoked_at', sp.revoked_at,
                'created_at', sp.created_at, 'created_by', sp.created_by
            )
            ORDER BY sp.functional_role, sp.user_id
        )
    END
    INTO v_participants
    FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = p_session_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', sz.id, 'zone_code', sz.zone_code, 'scan_code', sz.scan_code,
                'display_name', sz.display_name, 'priority', sz.priority,
                'is_enabled', sz.is_enabled, 'created_at', sz.created_at,
                'locations', (
                    SELECT CASE
                        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                        ELSE pg_catalog.jsonb_agg(
                            pg_catalog.jsonb_build_object(
                                'location_id', szl.location_id,
                                'snapshot_location_id', szl.snapshot_location_id,
                                'code', sll.code, 'name', sll.name,
                                'aisle', sll.aisle, 'rack', sll.rack,
                                'level', sll.level, 'position', sll.position,
                                'is_active', sll.is_active
                            )
                            ORDER BY sll.code
                        )
                    END
                    FROM inventarios.session_zone_locations szl
                    JOIN inventarios.snapshot_locations sll
                      ON sll.company_id = szl.company_id
                     AND sll.snapshot_id = szl.snapshot_id
                     AND sll.location_id = szl.location_id
                    WHERE szl.company_id = sz.company_id
                      AND szl.session_id = sz.session_id
                      AND szl.session_zone_id = sz.id
                )
            )
            ORDER BY sz.priority, sz.zone_code
        )
    END
    INTO v_zones
    FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = p_session_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', t.id, 'session_zone_id', t.session_zone_id,
                'task_kind', t.task_kind, 'status', t.status,
                'version', t.version, 'validation_cycle', t.validation_cycle,
                'current_assignment_id', t.current_assignment_id,
                'validated_at', t.validated_at, 'validated_by', t.validated_by,
                'validated_by_name', inventarios.user_display_name(t.validated_by),
                'cancelled_at', t.cancelled_at, 'cancelled_by', t.cancelled_by,
                'cancelled_by_name', inventarios.user_display_name(t.cancelled_by),
                'created_at', t.created_at, 'created_by', t.created_by,
                'assignment', (
                    SELECT pg_catalog.jsonb_build_object(
                        'assignment_id', ta.id, 'user_id', ta.user_id,
                        'user_name', inventarios.user_display_name(ta.user_id),
                        'session_participant_id', ta.session_participant_id,
                        'functional_role', sp.functional_role,
                        'assigned_at', ta.assigned_at, 'assigned_by', ta.assigned_by
                    )
                    FROM inventarios.task_assignments ta
                    LEFT JOIN inventarios.session_participants sp
                      ON sp.company_id = ta.company_id
                     AND sp.session_id = ta.session_id
                     AND sp.id = ta.session_participant_id
                    WHERE ta.company_id = t.company_id AND ta.task_id = t.id
                      AND ta.released_at IS NULL
                    LIMIT 1
                )
            )
            ORDER BY t.created_at
        )
    END
    INTO v_tasks
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', i.id, 'category_code', i.category_code, 'severity', i.severity,
                'status', i.status, 'is_blocking', i.is_blocking,
                'affected_quantity', i.affected_quantity, 'description', i.description,
                'task_id', i.task_id, 'snapshot_product_id', i.snapshot_product_id,
                'reported_by', i.reported_by, 'reported_by_name', inventarios.user_display_name(i.reported_by),
                'reported_at', i.reported_at
            )
            ORDER BY i.reported_at DESC
        )
    END
    INTO v_incidents
    FROM inventarios.incidents i
    WHERE i.company_id = p_company_id AND i.session_id = p_session_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', rr.id, 'status', rr.status, 'ordinal', rr.ordinal,
                'cycle_number', rr.cycle_number, 'session_zone_id', rr.session_zone_id,
                'snapshot_product_id', rr.snapshot_product_id,
                'source_task_id', rr.source_task_id,
                'assigned_user_id', rr.assigned_user_id,
                'assigned_user_name', inventarios.user_display_name(rr.assigned_user_id),
                'started_at', rr.started_at, 'completed_at', rr.completed_at,
                'cancelled_at', rr.cancelled_at, 'cancelled_by', rr.cancelled_by,
                'cancelled_by_name', inventarios.user_display_name(rr.cancelled_by),
                'cancellation_reason', rr.cancellation_reason,
                'reason', rr.reason, 'created_at', rr.created_at, 'created_by', rr.created_by
            )
            ORDER BY rr.ordinal
        )
    END
    INTO v_recounts
    FROM inventarios.recount_requests rr
    WHERE rr.company_id = p_company_id AND rr.session_id = p_session_id;

    SELECT pg_catalog.jsonb_build_object(
        'count_entry_count', (
            SELECT pg_catalog.count(*) FROM inventarios.count_entries ce
            WHERE ce.company_id = p_company_id AND ce.session_id = p_session_id
        ),
        'effective_contribution_count', (
            SELECT pg_catalog.count(*) FROM inventarios.count_entries ce
            WHERE ce.company_id = p_company_id AND ce.session_id = p_session_id
              AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL
              AND ce.invalidation_reason IS NULL
        ),
        'blocking_incident_count', (
            SELECT pg_catalog.count(*) FROM inventarios.incidents i
            WHERE i.company_id = p_company_id AND i.session_id = p_session_id
              AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW')
        ),
        'pending_recount_count', (
            SELECT pg_catalog.count(*) FROM inventarios.recount_requests rr
            WHERE rr.company_id = p_company_id AND rr.session_id = p_session_id
              AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS')
        )
    )
    INTO v_counts;

    RETURN pg_catalog.jsonb_build_object(
        'session', v_session,
        'snapshot', v_snapshot,
        'participants', v_participants,
        'zones', v_zones,
        'tasks', v_tasks,
        'incidents', v_incidents,
        'recounts', v_recounts,
        'counts', v_counts
    );
END;
$$;

-- ============================================================
-- 4. OWNER Y GRANTS
-- ============================================================
ALTER FUNCTION inventarios.list_inventory_sessions(uuid, text, uuid, date, date, text, integer, integer) OWNER TO postgres;
ALTER FUNCTION inventarios.get_inventory_session_detail(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.list_inventory_sessions(uuid, text, uuid, date, date, text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_inventory_session_detail(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.list_inventory_sessions(uuid, text, uuid, date, date, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_detail(uuid, uuid) TO authenticated;
