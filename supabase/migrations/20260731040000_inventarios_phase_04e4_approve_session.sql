CREATE TABLE inventarios.official_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    version_number integer NOT NULL,
    task_count integer NOT NULL,
    contribution_count integer NOT NULL,
    normal_contribution_count integer NOT NULL,
    recount_contribution_count integer NOT NULL,
    item_count integer NOT NULL,
    approved_at timestamptz NOT NULL,
    approved_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    supersedes_version_id uuid,
    superseded_at timestamptz,
    superseded_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL,
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_official_versions_company_session
        FOREIGN KEY (company_id, session_id)
        REFERENCES inventarios.sessions(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_official_versions_snapshot
        FOREIGN KEY (company_id, session_id, snapshot_id)
        REFERENCES inventarios.operational_snapshots(company_id, session_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_official_versions_supersedes
        FOREIGN KEY (supersedes_version_id)
        REFERENCES inventarios.official_versions(id) ON DELETE RESTRICT,
    CONSTRAINT uq_official_versions_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_official_versions_session_version UNIQUE (company_id, session_id, version_number),
    CONSTRAINT chk_official_versions_version CHECK (version_number >= 1),
    CONSTRAINT chk_official_versions_counts CHECK (
        task_count >= 1 AND contribution_count >= 1
        AND normal_contribution_count >= 0 AND recount_contribution_count >= 0
        AND normal_contribution_count + recount_contribution_count = contribution_count
        AND item_count >= 1
    ),
    CONSTRAINT chk_official_versions_supersede CHECK (
        (supersedes_version_id IS NULL AND superseded_at IS NULL AND superseded_by IS NULL)
        OR (supersedes_version_id IS NOT NULL AND superseded_at IS NOT NULL AND superseded_by IS NOT NULL)
    ),
    CONSTRAINT chk_official_versions_not_self CHECK (
        supersedes_version_id IS NULL OR supersedes_version_id <> id
    )
);

CREATE UNIQUE INDEX uq_official_versions_current_session
    ON inventarios.official_versions(company_id, session_id)
    WHERE superseded_at IS NULL;

CREATE TABLE inventarios.official_version_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    official_version_id uuid NOT NULL,
    session_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    bsale_variant_id integer NOT NULL,
    available_quantity numeric(14,3) NOT NULL,
    damaged_quantity numeric(14,3) NOT NULL,
    expired_quantity numeric(14,3) NOT NULL,
    blocked_quantity numeric(14,3) NOT NULL,
    other_unavailable_quantity numeric(14,3) NOT NULL,
    physical_quantity numeric(14,3) NOT NULL,
    contribution_count integer NOT NULL,
    normal_contribution_count integer NOT NULL,
    recount_contribution_count integer NOT NULL,
    contribution_manifest jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_official_items_version
        FOREIGN KEY (official_version_id)
        REFERENCES inventarios.official_versions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_official_items_session
        FOREIGN KEY (company_id, session_id)
        REFERENCES inventarios.sessions(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_official_items_snapshot_product
        FOREIGN KEY (company_id, snapshot_id, snapshot_product_id)
        REFERENCES inventarios.snapshot_products(company_id, snapshot_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_official_items_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_official_items_version_product UNIQUE (company_id, official_version_id, snapshot_product_id),
    CONSTRAINT chk_official_items_quantities CHECK (
        available_quantity >= 0 AND damaged_quantity >= 0 AND expired_quantity >= 0
        AND blocked_quantity >= 0 AND other_unavailable_quantity >= 0
        AND physical_quantity >= 0
        AND physical_quantity = available_quantity + damaged_quantity + expired_quantity
            + blocked_quantity + other_unavailable_quantity
    ),
    CONSTRAINT chk_official_items_counts CHECK (
        contribution_count >= 1 AND normal_contribution_count >= 0 AND recount_contribution_count >= 0
        AND normal_contribution_count + recount_contribution_count = contribution_count
    ),
    CONSTRAINT chk_official_items_manifest CHECK (jsonb_typeof(contribution_manifest) = 'array')
);

ALTER TABLE inventarios.official_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.official_version_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON inventarios.official_versions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON inventarios.official_version_items FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios.approve_inventory_session(
    p_company_id uuid,
    p_session_id uuid,
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
    v_sess_status text;
    v_snapshot_id uuid;
    v_approved_at timestamptz;
    v_official_id uuid;
    v_item_id uuid;
    v_payload jsonb;
    v_resp jsonb;
    v_task_count bigint; v_cc bigint; v_nc bigint; v_rc bigint; v_ic bigint;
    v_pending_task_count bigint;
    v_blocking_inc_count bigint;
    v_prev_ver uuid;
    v_task_row record;
    v_contrib_row record;
    v_item_row record;
    v_expected_updated_at timestamptz;
    v_actual_updated_at timestamptz;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.start');
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.approve_inventory_session.idempotency'), hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.session.approve','company_id',p_company_id,'session_id',p_session_id);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.session.approve',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.approve_inventory_session'), hashtext(p_company_id::text || ':' || p_session_id::text));
    FOR v_task_row IN SELECT t.id, t.validation_cycle, t.current_validation_event_id, t.validated_at, t.validated_by
                      FROM inventarios.tasks t
                      WHERE t.company_id = p_company_id AND t.session_id = p_session_id
                        AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
                      ORDER BY t.id FOR UPDATE LOOP
        IF v_task_row.current_validation_event_id IS NULL OR v_task_row.validated_at IS NULL OR v_task_row.validated_by IS NULL THEN
            v_pending_task_count := v_pending_task_count + 1;
        END IF;
        v_task_count := v_task_count + 1;
    END LOOP;
    IF v_task_count = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_CONSOLIDATED',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no se puede consolidar.','retryable',false,'reason','NO_ACTIVE_TASKS')::text;
    END IF;
    IF v_pending_task_count > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_TASKS_NOT_VALIDATED',
            DETAIL=pg_catalog.jsonb_build_object('message','Existen tareas sin validacion vigente.','retryable',false,'pending_task_count',v_pending_task_count)::text;
    END IF;
    SELECT s.status, s.updated_at INTO v_sess_status, v_expected_updated_at
    FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
        DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_sess_status <> 'UNDER_REVIEW' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
        DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion.','retryable',false)::text; END IF;
    PERFORM inventarios.require_session_participant(p_company_id, p_session_id, 'MANAGER');
    SELECT os.id INTO v_snapshot_id FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_CONSOLIDATED',
        DETAIL=pg_catalog.jsonb_build_object('message','La jornada no se puede consolidar.','retryable',false,'reason','SNAPSHOT_MISSING')::text; END IF;
    SELECT count(*) INTO v_blocking_inc_count FROM inventarios.incidents i
    WHERE i.company_id = p_company_id AND i.session_id = p_session_id
      AND i.task_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM inventarios.tasks t WHERE t.id = i.task_id AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL)
      AND (
          (i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW'))
          OR (i.severity = 'CRITICAL' AND i.status IN ('OPEN','UNDER_REVIEW'))
      );
    IF v_blocking_inc_count > 0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_BLOCKING_INCIDENTS',
        DETAIL=pg_catalog.jsonb_build_object('message','Existen incidentes bloqueantes pendientes.','retryable',false,'blocking_incident_count',v_blocking_inc_count)::text; END IF;
    v_approved_at := pg_catalog.now();
    INSERT INTO inventarios.official_versions (company_id, session_id, snapshot_id, version_number, task_count, contribution_count, normal_contribution_count, recount_contribution_count, item_count, approved_at, approved_by, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_snapshot_id, 1, 0, 0, 0, 0, 0, v_approved_at, v_actor_id, v_approved_at, v_actor_id)
    RETURNING id INTO v_official_id;
    FOR v_task_row IN SELECT t.id FROM inventarios.tasks t
                      WHERE t.company_id = p_company_id AND t.session_id = p_session_id
                        AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
                      ORDER BY t.id
    LOOP
        FOR v_contrib_row IN
            SELECT ec.contribution_count_entry_id, ec.contribution_source,
                   ec.root_count_entry_id, ec.recount_request_id, ec.recount_decision_id,
                   ec.snapshot_product_id, ec.snapshot_id, ec.session_zone_id, ec.task_id, ec.task_cycle,
                   ce.bsale_variant_id,
                   ce.available_quantity, ce.damaged_quantity, ce.expired_quantity,
                   ce.blocked_quantity, ce.other_unavailable_quantity, ce.physical_quantity
            FROM inventarios.get_effective_task_contributions(p_company_id, p_session_id, v_task_row.id) ec
            JOIN inventarios.count_entries ce ON ce.id = ec.contribution_count_entry_id
        LOOP
            v_cc := v_cc + 1;
            IF v_contrib_row.contribution_source = 'NORMAL' THEN v_nc := v_nc + 1; END IF;
            IF v_contrib_row.contribution_source = 'RECOUNT' THEN v_rc := v_rc + 1; END IF;
            INSERT INTO inventarios.official_version_items (
                company_id, official_version_id, session_id, snapshot_id, snapshot_product_id,
                bsale_variant_id, available_quantity, damaged_quantity, expired_quantity,
                blocked_quantity, other_unavailable_quantity, physical_quantity,
                contribution_count, normal_contribution_count, recount_contribution_count,
                contribution_manifest, created_at, created_by
            ) VALUES (
                p_company_id, v_official_id, p_session_id, v_contrib_row.snapshot_id, v_contrib_row.snapshot_product_id,
                v_contrib_row.bsale_variant_id, v_contrib_row.available_quantity, v_contrib_row.damaged_quantity, v_contrib_row.expired_quantity,
                v_contrib_row.blocked_quantity, v_contrib_row.other_unavailable_quantity, v_contrib_row.physical_quantity,
                1, CASE WHEN v_contrib_row.contribution_source = 'NORMAL' THEN 1 ELSE 0 END,
                CASE WHEN v_contrib_row.contribution_source = 'RECOUNT' THEN 1 ELSE 0 END,
                pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
                    'contribution_count_entry_id', v_contrib_row.contribution_count_entry_id,
                    'contribution_source', v_contrib_row.contribution_source,
                    'root_count_entry_id', v_contrib_row.root_count_entry_id,
                    'recount_request_id', v_contrib_row.recount_request_id,
                    'recount_decision_id', v_contrib_row.recount_decision_id,
                    'task_id', v_task_row.id,
                    'task_cycle', v_contrib_row.task_cycle,
                    'session_zone_id', v_contrib_row.session_zone_id
                )),
                v_approved_at, v_actor_id
            ) RETURNING id INTO v_item_id;
            v_ic := v_ic + 1;
        END LOOP;
    END LOOP;
    UPDATE inventarios.official_versions
    SET task_count = v_task_count, contribution_count = v_cc,
        normal_contribution_count = v_nc, recount_contribution_count = v_rc,
        item_count = v_ic
    WHERE id = v_official_id;
    UPDATE inventarios.sessions
    SET status = 'APPROVED', approved_at = v_approved_at, approved_by = v_actor_id,
        updated_at = v_approved_at, updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_session_id
      AND status = 'UNDER_REVIEW';
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
        DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    v_resp := pg_catalog.jsonb_build_object(
        'operation', 'inventarios.session.approve',
        'entity_id', p_session_id,
        'state', 'APPROVED',
        'version', NULL::integer,
        'cycle_number', NULL::integer,
        'assignment_id', NULL::uuid,
        'event_id', NULL::uuid,
        'replayed', false,
        'occurred_at', v_approved_at,
        'data', pg_catalog.jsonb_build_object(
            'official_version_id', v_official_id,
            'official_version_number', 1,
            'snapshot_id', v_snapshot_id,
            'task_count', v_task_count,
            'contribution_count', v_cc,
            'normal_contribution_count', v_nc,
            'recount_contribution_count', v_rc,
            'item_count', v_ic,
            'approved_by', v_actor_id,
            'approved_at', v_approved_at
        )
    );
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_resp);
END;
$$;
ALTER FUNCTION inventarios.approve_inventory_session(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.approve_inventory_session(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
