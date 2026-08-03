-- Migration: 20260803091500_inventarios_phase_04h1c_fix_detail_query.sql
-- Description: Fase 4H.1c (correccion). Redefine get_inventory_session_detail
--              corrigiendo el subquery de assignment que mezclaba count(*) con
--              columnas no agregadas. Comportamiento identico al contrato.
-- Author: Assistant

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
        'bsale_office_id', s.bsale_office_id, 'responsible_user_id', s.responsible_user_id,
        'notes', s.notes,
        'prepared_at', s.prepared_at, 'started_at', s.started_at,
        'reviewed_at', s.reviewed_at, 'approved_at', s.approved_at,
        'approved_by', s.approved_by, 'exported_at', s.exported_at,
        'reconciled_at', s.reconciled_at,
        'cancelled_at', s.cancelled_at, 'cancelled_by', s.cancelled_by,
        'cancellation_reason', s.cancellation_reason,
        'created_at', s.created_at, 'created_by', s.created_by,
        'updated_at', s.updated_at, 'updated_by', s.updated_by
    )
    INTO v_session
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF v_session IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.jsonb_build_object(
        'id', os.id, 'snapshot_version', os.snapshot_version,
        'completion_status', os.completion_status, 'content_hash', os.content_hash,
        'captured_at', os.captured_at, 'captured_by', os.captured_by
    )
    INTO v_snapshot
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', sp.id, 'user_id', sp.user_id, 'functional_role', sp.functional_role,
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
                'cancelled_at', t.cancelled_at, 'cancelled_by', t.cancelled_by,
                'created_at', t.created_at, 'created_by', t.created_by,
                'assignment', (
                    SELECT pg_catalog.jsonb_build_object(
                        'assignment_id', ta.id, 'user_id', ta.user_id,
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
                'reported_by', i.reported_by, 'reported_at', i.reported_at
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
                'started_at', rr.started_at, 'completed_at', rr.completed_at,
                'cancelled_at', rr.cancelled_at, 'cancelled_by', rr.cancelled_by,
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

ALTER FUNCTION inventarios.get_inventory_session_detail(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_session_detail(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_detail(uuid, uuid) TO authenticated;
