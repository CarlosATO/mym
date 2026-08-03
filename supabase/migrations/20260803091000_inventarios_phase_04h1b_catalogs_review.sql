-- Migration: 20260803091000_inventarios_phase_04h1b_catalogs_review.sql
-- Description: Fase 4H.1b. Catalogos autorizados para crear/configurar jornadas
--              y consulta de revision UNDER_REVIEW. Asigna sessions.read a
--              GERENCIA (solo lectura, sin permisos de configuracion).
-- Author: Assistant

-- ============================================================
-- 1. GERENCIA: permiso de lectura (sin configuracion)
--    Conserva unicamente aprobacion + lectura de jornadas.
-- ============================================================
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
    ('GERENCIA', 'inventarios.sessions.read')
) AS m(role_name, perm_code)
JOIN portal.roles r ON r.name = m.role_name AND r.is_active = true
JOIN portal.permissions p ON p.code = m.perm_code AND p.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- 2. RPC: get_inventory_session_catalogs
--    Solo opciones autorizadas para crear/configurar jornadas.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_catalogs(
    p_company_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_warehouses jsonb;
    v_offices jsonb;
    v_locations jsonb;
    v_users jsonb;
    v_roles jsonb;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', w.id, 'code', w.code, 'name', w.name,
                'warehouse_type', w.warehouse_type, 'is_default', w.is_default
            )
            ORDER BY w.code
        )
    END
    INTO v_warehouses
    FROM adquisiciones.warehouses w
    WHERE w.company_id = p_company_id AND w.is_active = true AND w.status = 'ACTIVE';

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'bsale_id', bo.bsale_id, 'name', bo.name, 'code', bo.code
            )
            ORDER BY bo.name
        )
    END
    INTO v_offices
    FROM integraciones.bsale_offices bo
    WHERE bo.company_id = p_company_id AND bo.is_active = true;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', l.id, 'warehouse_id', l.warehouse_id, 'code', l.code,
                'name', l.name, 'aisle', l.aisle, 'rack', l.rack,
                'level', l.level, 'position', l.position
            )
            ORDER BY l.code
        )
    END
    INTO v_locations
    FROM logistica.locations l
    WHERE l.company_id = p_company_id AND l.is_active = true;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', u.id, 'email', u.email, 'nombre', u.nombre, 'apellido', u.apellido
            )
            ORDER BY u.nombre, u.apellido
        )
    END
    INTO v_users
    FROM portal.users u
    JOIN core.user_company_access uca
      ON uca.user_id = u.id AND uca.company_id = p_company_id AND uca.is_active = true
    WHERE u.is_active = true AND u.deleted_at IS NULL;

    v_roles := '["COUNTER","SUPERVISOR","ADMINISTRATOR","MANAGER"]'::jsonb;

    RETURN pg_catalog.jsonb_build_object(
        'warehouses', v_warehouses,
        'offices', v_offices,
        'locations', v_locations,
        'users', v_users,
        'functional_roles', v_roles
    );
END;
$$;

-- ============================================================
-- 3. RPC: get_inventory_session_review
--    Datos de revision UNDER_REVIEW: contribuciones efectivas, tareas por
--    validar, incidencias bloqueantes, recuentos/decisiones e indicadores.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_review(
    p_company_id uuid,
    p_session_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_session_status text;
    v_tasks jsonb;
    v_contributions jsonb;
    v_incidents jsonb;
    v_recounts jsonb;
    v_indicators jsonb;
    v_pending_validation bigint;
    v_effective_contribution bigint;
    v_blocking_incident bigint;
    v_pending_recount bigint;
    v_undecided_recount bigint;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT s.status INTO v_session_status
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', t.id, 'session_zone_id', t.session_zone_id,
                'task_kind', t.task_kind, 'status', t.status,
                'validation_cycle', t.validation_cycle,
                'validated_at', t.validated_at, 'validated_by', t.validated_by,
                'current_validation_event_id', t.current_validation_event_id,
                'pending_validation', (
                    t.current_validation_event_id IS NULL
                    OR t.validated_at IS NULL OR t.validated_by IS NULL
                )
            )
            ORDER BY t.created_at
        )
    END
    INTO v_tasks
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL;

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'task_id', g.task_id, 'task_cycle', g.task_cycle,
                'session_zone_id', g.session_zone_id,
                'snapshot_product_id', g.snapshot_product_id,
                'snapshot_location_id', g.snapshot_location_id,
                'contribution_source', g.contribution_source,
                'contribution_count_entry_id', g.contribution_count_entry_id,
                'root_count_entry_id', g.root_count_entry_id,
                'recount_request_id', g.recount_request_id,
                'recount_decision_id', g.recount_decision_id
            )
            ORDER BY g.task_cycle, g.session_zone_id, g.snapshot_product_id, g.contribution_source
        )
    END
    INTO v_contributions
    FROM (
        SELECT t.id AS task_id
        FROM inventarios.tasks t
        WHERE t.company_id = p_company_id AND t.session_id = p_session_id
          AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ) t
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(
        p_company_id, p_session_id, t.task_id
    ) g;

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
                'cancelled_at', rr.cancelled_at, 'reason', rr.reason,
                'decision_count', (
                    SELECT pg_catalog.count(*) FROM inventarios.recount_decisions rd
                    WHERE rd.company_id = rr.company_id AND rd.recount_request_id = rr.id
                )
            )
            ORDER BY rr.ordinal
        )
    END
    INTO v_recounts
    FROM inventarios.recount_requests rr
    WHERE rr.company_id = p_company_id AND rr.session_id = p_session_id;

    SELECT pg_catalog.count(*) INTO v_pending_validation
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = p_session_id
      AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
      AND (t.current_validation_event_id IS NULL OR t.validated_at IS NULL OR t.validated_by IS NULL);

    SELECT pg_catalog.count(*) INTO v_effective_contribution
    FROM (
        SELECT g.contribution_count_entry_id
        FROM inventarios.tasks t
        CROSS JOIN LATERAL inventarios.get_effective_task_contributions(
            p_company_id, p_session_id, t.id
        ) g
        WHERE t.company_id = p_company_id AND t.session_id = p_session_id
          AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    ) x;

    SELECT pg_catalog.count(*) INTO v_blocking_incident
    FROM inventarios.incidents i
    WHERE i.company_id = p_company_id AND i.session_id = p_session_id
      AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW');

    SELECT pg_catalog.count(*) INTO v_pending_recount
    FROM inventarios.recount_requests rr
    WHERE rr.company_id = p_company_id AND rr.session_id = p_session_id
      AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS');

    SELECT pg_catalog.count(*) INTO v_undecided_recount
    FROM inventarios.recount_requests rr
    WHERE rr.company_id = p_company_id AND rr.session_id = p_session_id
      AND rr.status = 'COMPLETED'
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.recount_decisions rd
          WHERE rd.company_id = rr.company_id AND rd.recount_request_id = rr.id
      );

    v_indicators := pg_catalog.jsonb_build_object(
        'session_status', v_session_status,
        'pending_validation_count', v_pending_validation,
        'effective_contribution_count', v_effective_contribution,
        'blocking_incident_count', v_blocking_incident,
        'pending_recount_count', v_pending_recount,
        'undecided_recount_count', v_undecided_recount,
        'ready_to_approve', (
            v_session_status = 'UNDER_REVIEW'
            AND v_pending_validation = 0
            AND v_blocking_incident = 0
            AND v_pending_recount = 0
            AND v_undecided_recount = 0
            AND v_effective_contribution > 0
        )
    );

    RETURN pg_catalog.jsonb_build_object(
        'tasks', v_tasks,
        'contributions', v_contributions,
        'incidents', v_incidents,
        'recounts', v_recounts,
        'indicators', v_indicators
    );
END;
$$;

-- ============================================================
-- 4. OWNER, REVOKES Y GRANT
-- ============================================================
ALTER FUNCTION inventarios.get_inventory_session_catalogs(uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.get_inventory_session_review(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_inventory_session_catalogs(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_inventory_session_review(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_catalogs(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_review(uuid, uuid) TO authenticated;
