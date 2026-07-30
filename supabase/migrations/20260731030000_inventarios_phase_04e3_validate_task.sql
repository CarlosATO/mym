CREATE FUNCTION inventarios.get_effective_task_contributions(
    p_company_id uuid,
    p_session_id uuid,
    p_task_id uuid
)
RETURNS TABLE (
    contribution_count_entry_id uuid,
    contribution_source text,
    root_count_entry_id uuid,
    recount_request_id uuid,
    recount_decision_id uuid,
    company_id uuid,
    session_id uuid,
    snapshot_id uuid,
    session_zone_id uuid,
    snapshot_location_id uuid,
    snapshot_product_id uuid,
    task_id uuid,
    task_cycle integer
)
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_cancelled_at timestamptz;
    v_cancelled_by uuid;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_task_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    PERFORM 1 FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
        DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    SELECT t.cancelled_at, t.cancelled_by INTO v_cancelled_at, v_cancelled_by
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.session_id = p_session_id AND t.id = p_task_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
        DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF (v_cancelled_at IS NULL AND v_cancelled_by IS NOT NULL)
       OR (v_cancelled_at IS NOT NULL AND v_cancelled_by IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
    END IF;
    IF v_cancelled_at IS NOT NULL AND v_cancelled_by IS NOT NULL THEN
        RETURN;
    END IF;
    RETURN QUERY
    WITH task_info AS (
        SELECT t.validation_cycle FROM inventarios.tasks t
        WHERE t.id = p_task_id
    ),
    normal_counts AS (
        SELECT ec.effective_count_entry_id, 'NORMAL'::text AS source,
               ec.root_count_entry_id, ec.recount_request_id,
               NULL::uuid AS recount_decision_id,
               ec.company_id, ec.session_id, ec.snapshot_id, ec.session_zone_id,
               ec.snapshot_location_id, ec.snapshot_product_id,
               ec.task_id, ec.task_cycle
        FROM inventarios.get_effective_count_entries(p_company_id, p_session_id, p_task_id, NULL) ec
        JOIN task_info ti ON ec.task_cycle = ti.validation_cycle
    ),
    recount_scopes AS (
        SELECT rd.recount_request_id, rd.recount_decision_id,
               rd.selected_count_entry_id, rd.selected_root_count_entry_id,
               rd.session_zone_id, rd.snapshot_product_id,
               rd.source_task_id, rd.task_cycle,
               rd.session_id, rd.snapshot_id, rd.snapshot_location_id
        FROM inventarios.get_applicable_recount_decisions(p_company_id, p_session_id, p_task_id) rd
    ),
    replaced_scopes AS (
        SELECT DISTINCT rs.session_zone_id, rs.snapshot_product_id, rs.task_cycle
        FROM recount_scopes rs
    ),
    filtered_normal AS (
        SELECT nc.* FROM normal_counts nc
        WHERE NOT EXISTS (
            SELECT 1 FROM replaced_scopes rs
            WHERE rs.session_zone_id = nc.session_zone_id
              AND rs.snapshot_product_id = nc.snapshot_product_id
              AND rs.task_cycle = nc.task_cycle
        )
    ),
    recount_contributions AS (
        SELECT rs.selected_count_entry_id AS contribution_count_entry_id,
               'RECOUNT'::text AS source,
               rs.selected_root_count_entry_id AS root_count_entry_id,
               rs.recount_request_id, rs.recount_decision_id,
               p_company_id, rs.session_id, rs.snapshot_id, rs.session_zone_id,
               rs.snapshot_location_id, rs.snapshot_product_id,
               rs.source_task_id AS task_id, rs.task_cycle
        FROM recount_scopes rs
    ),
    combined AS (
        SELECT * FROM filtered_normal
        UNION ALL
        SELECT * FROM recount_contributions
    )
    SELECT c.contribution_count_entry_id, c.source, c.root_count_entry_id,
           c.recount_request_id, c.recount_decision_id,
           c.company_id, c.session_id, c.snapshot_id, c.session_zone_id,
           c.snapshot_location_id, c.snapshot_product_id,
           c.task_id, c.task_cycle
    FROM combined c
    WHERE EXISTS (
        SELECT 1 FROM inventarios.count_entries ce WHERE ce.id = c.contribution_count_entry_id
          AND ce.company_id = p_company_id
          AND ce.physical_quantity = ce.available_quantity + ce.damaged_quantity + ce.expired_quantity + ce.blocked_quantity + ce.other_unavailable_quantity
          AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
    )
    ORDER BY c.task_cycle, c.session_zone_id, c.snapshot_product_id, c.source, c.root_count_entry_id, c.contribution_count_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION inventarios.validate_inventory_task(
    p_company_id uuid,
    p_task_id uuid,
    p_expected_version integer,
    p_expected_cycle integer,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_session_id uuid;
    v_session_zone_id uuid;
    v_status text;
    v_version integer;
    v_cycle integer;
    v_cv uuid;
    v_cancelled_at timestamptz;
    v_cancelled_by uuid;
    v_va timestamptz;
    v_vb uuid;
    v_sess_status text;
    v_occurred_at timestamptz;
    v_event_id uuid;
    v_payload jsonb;
    v_response jsonb;
    v_cc bigint; v_nc bigint; v_rc bigint;
    v_bic bigint;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL OR p_expected_version IS NULL
       OR p_expected_version < 1 OR p_expected_cycle IS NULL OR p_expected_cycle < 1
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.tasks.validate');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.validate_inventory_task'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_task_id::text)
    );
    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.task.validate','company_id',p_company_id,'task_id',p_task_id,'expected_version',p_expected_version,'expected_cycle',p_expected_cycle);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.task.validate',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT t.session_id, t.session_zone_id, t.status, t.version, t.validation_cycle,
           t.current_validation_event_id, t.cancelled_at, t.cancelled_by,
           t.validated_at, t.validated_by
    INTO v_session_id, v_session_zone_id, v_status, v_version, v_cycle,
         v_cv, v_cancelled_at, v_cancelled_by, v_va, v_vb
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.id = p_task_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
        DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_status <> 'COMPLETED' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE',
        DETAIL=pg_catalog.jsonb_build_object('message','La tarea no permite esta operacion en su estado actual.','retryable',false)::text; END IF;
    IF v_version <> p_expected_version OR v_cycle <> p_expected_cycle THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text;
    END IF;
    IF v_cancelled_at IS NOT NULL OR v_cancelled_by IS NOT NULL THEN
        IF v_cancelled_at IS NULL OR v_cancelled_by IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_ALREADY_CANCELLED',
            DETAIL=pg_catalog.jsonb_build_object('message','La tarea ya fue cancelada.','retryable',false)::text;
    END IF;
    IF v_cv IS NOT NULL OR v_va IS NOT NULL OR v_vb IS NOT NULL THEN
        IF v_cv IS NOT NULL AND v_va IS NOT NULL AND v_vb IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_OPERATION_ALREADY_APPLIED',
                DETAIL=pg_catalog.jsonb_build_object('message','La operacion ya fue finalizada.','retryable',false)::text;
        END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    SELECT s.status INTO v_sess_status FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = v_session_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
        DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_sess_status <> 'UNDER_REVIEW' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
        DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite operaciones de participantes.','retryable',false)::text; END IF;
    PERFORM inventarios.require_session_participant(p_company_id, v_session_id, 'SUPERVISOR');
    SELECT count(*) INTO v_cc FROM inventarios.get_effective_task_contributions(p_company_id, v_session_id, p_task_id) g;
    SELECT count(*) INTO v_nc FROM inventarios.get_effective_task_contributions(p_company_id, v_session_id, p_task_id) g WHERE g.contribution_source = 'NORMAL';
    SELECT count(*) INTO v_rc FROM inventarios.get_effective_task_contributions(p_company_id, v_session_id, p_task_id) g WHERE g.contribution_source = 'RECOUNT';
    IF v_cc < 1 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_NO_EFFECTIVE_COUNTS',
        DETAIL=pg_catalog.jsonb_build_object('message','La tarea no posee conteos efectivos para validar.','retryable',false)::text; END IF;
    SELECT count(*) INTO v_bic FROM inventarios.incidents i
    WHERE i.company_id = p_company_id AND i.task_id = p_task_id
      AND i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW');
    IF v_bic > 0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_BLOCKING_INCIDENTS',
        DETAIL=pg_catalog.jsonb_build_object('message','La tarea posee incidentes bloqueantes pendientes.','retryable',false,'blocking_incident_count',v_bic)::text; END IF;
    v_occurred_at := pg_catalog.now();
    INSERT INTO inventarios.task_events (company_id, session_id, session_zone_id, task_id, event_type, actor_id, cycle, occurred_at, idempotency_key, created_by)
    VALUES (p_company_id, v_session_id, v_session_zone_id, p_task_id, 'VALIDATED', v_actor_id, v_cycle, v_occurred_at, p_idempotency_key, v_actor_id)
    RETURNING id INTO v_event_id;
    UPDATE inventarios.tasks t
    SET current_validation_event_id = v_event_id,
        validated_at = v_occurred_at,
        validated_by = v_actor_id,
        version = t.version + 1,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE t.company_id = p_company_id AND t.id = p_task_id
      AND t.status = 'COMPLETED'
      AND t.validation_cycle = p_expected_cycle
      AND t.version = p_expected_version
      AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
      AND t.current_validation_event_id IS NULL
      AND t.validated_at IS NULL AND t.validated_by IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
        DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    v_response := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.task.validate',
        'entity_id', p_task_id,
        'state', 'COMPLETED',
        'version', v_version + 1,
        'cycle_number', v_cycle,
        'assignment_id', NULL::uuid,
        'event_id', v_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'contribution_count', v_cc,
            'normal_contribution_count', v_nc,
            'recount_contribution_count', v_rc,
            'blocking_incident_count', v_bic
        )
    );
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_task_id, v_response);
END;
$$;

ALTER FUNCTION inventarios.get_effective_task_contributions(uuid, uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.validate_inventory_task(uuid, uuid, integer, integer, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_effective_task_contributions(uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.validate_inventory_task(uuid, uuid, integer, integer, uuid)
FROM PUBLIC, anon, authenticated, service_role;
