DO $$
DECLARE
    v_ov bigint; v_oi bigint;
BEGIN
    SELECT count(*) INTO v_ov FROM inventarios.official_versions;
    SELECT count(*) INTO v_oi FROM inventarios.official_version_items;
    IF v_ov > 0 OR v_oi > 0 THEN
        RAISE EXCEPTION 'INVENTORY_4E4_HOTFIX_REQUIRES_EMPTY_OFFICIAL_TABLES';
    END IF;
END $$;

INSERT INTO portal.permissions (code, name, module_id)
SELECT 'inventarios.sessions.approve', 'Aprobar jornadas de inventario', module.id
FROM (SELECT id FROM portal.modules WHERE code = 'inventarios') AS module
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, module_id = EXCLUDED.module_id;

DROP TABLE IF EXISTS inventarios.official_version_items CASCADE;

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
    CONSTRAINT fk_official_items_version FOREIGN KEY (official_version_id) REFERENCES inventarios.official_versions(id) ON DELETE RESTRICT,
    CONSTRAINT fk_official_items_session FOREIGN KEY (company_id, session_id) REFERENCES inventarios.sessions(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_official_items_snapshot_product FOREIGN KEY (company_id, snapshot_id, snapshot_product_id) REFERENCES inventarios.snapshot_products(company_id, snapshot_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_official_items_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_official_items_version_product UNIQUE (company_id, official_version_id, snapshot_product_id),
    CONSTRAINT chk_official_items_qty CHECK (available_quantity >= 0 AND damaged_quantity >= 0 AND expired_quantity >= 0 AND blocked_quantity >= 0 AND other_unavailable_quantity >= 0 AND physical_quantity >= 0 AND physical_quantity = available_quantity + damaged_quantity + expired_quantity + blocked_quantity + other_unavailable_quantity),
    CONSTRAINT chk_official_items_cnt CHECK (contribution_count >= 1 AND normal_contribution_count >= 0 AND recount_contribution_count >= 0 AND normal_contribution_count + recount_contribution_count = contribution_count),
    CONSTRAINT chk_official_items_manifest CHECK (jsonb_typeof(contribution_manifest) = 'array')
);

ALTER TABLE inventarios.official_version_items ENABLE ROW LEVEL SECURITY;
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
    v_payload jsonb;
    v_resp jsonb;
    v_task_count bigint; v_cc bigint; v_nc bigint; v_rc bigint; v_ic bigint;
    v_pending_task_count bigint;
    v_blocking_inc_count bigint;
    v_task_row record;
    v_contrib_row record;
    v_prod_key text;
    v_products jsonb := '[]'::jsonb;
    v_prod jsonb;
    v_manifest jsonb;
    v_item_id uuid;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.approve');
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.approve_inventory_session.idempotency'), hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.session.approve','company_id',p_company_id,'session_id',p_session_id);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.session.approve',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.approve_inventory_session'), hashtext(p_company_id::text || ':' || p_session_id::text));
    FOR v_task_row IN SELECT t.id FROM inventarios.tasks t
                      WHERE t.company_id = p_company_id AND t.session_id = p_session_id
                        AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
                      ORDER BY t.id FOR UPDATE LOOP
        v_task_count := v_task_count + 1;
    END LOOP;
    IF v_task_count = 0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_CONSOLIDATED',
        DETAIL=pg_catalog.jsonb_build_object('message','La jornada no se puede consolidar.','retryable',false,'reason','NO_ACTIVE_TASKS')::text; END IF;
    FOR v_task_row IN SELECT t.id, t.current_validation_event_id, t.validated_at, t.validated_by
                      FROM inventarios.tasks t
                      WHERE t.company_id = p_company_id AND t.session_id = p_session_id
                        AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
                      ORDER BY t.id FOR UPDATE LOOP
        IF v_task_row.current_validation_event_id IS NULL OR v_task_row.validated_at IS NULL OR v_task_row.validated_by IS NULL THEN
            v_pending_task_count := v_pending_task_count + 1;
        END IF;
    END LOOP;
    IF v_pending_task_count > 0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_TASKS_NOT_VALIDATED',
        DETAIL=pg_catalog.jsonb_build_object('message','Existen tareas sin validacion vigente.','retryable',false,'pending_task_count',v_pending_task_count)::text; END IF;
    SELECT s.status INTO v_sess_status
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
      AND ((i.is_blocking = true AND i.status IN ('OPEN','UNDER_REVIEW')) OR (i.severity = 'CRITICAL' AND i.status IN ('OPEN','UNDER_REVIEW')));
    IF v_blocking_inc_count > 0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_BLOCKING_INCIDENTS',
        DETAIL=pg_catalog.jsonb_build_object('message','Existen incidentes bloqueantes pendientes.','retryable',false,'blocking_incident_count',v_blocking_inc_count)::text; END IF;
    v_approved_at := pg_catalog.now();
    FOR v_task_row IN SELECT t.id FROM inventarios.tasks t
                      WHERE t.company_id = p_company_id AND t.session_id = p_session_id
                        AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
                      ORDER BY t.id LOOP
        FOR v_contrib_row IN
            SELECT ec.contribution_count_entry_id, ec.contribution_source,
                   ec.root_count_entry_id, ec.recount_request_id, ec.recount_decision_id,
                   ec.snapshot_product_id, ec.snapshot_id, ec.session_zone_id, ec.task_id, ec.task_cycle,
                   ce.bsale_variant_id,
                   ce.available_quantity, ce.damaged_quantity, ce.expired_quantity,
                   ce.blocked_quantity, ce.other_unavailable_quantity, ce.physical_quantity
            FROM inventarios.get_effective_task_contributions(p_company_id, p_session_id, v_task_row.id) ec
            JOIN inventarios.count_entries ce ON ce.id = ec.contribution_count_entry_id
            ORDER BY ec.task_id, ec.task_cycle, ec.session_zone_id, ec.contribution_source, ec.root_count_entry_id, ec.contribution_count_entry_id
        LOOP
            v_prod_key := v_contrib_row.snapshot_product_id::text;
            v_prod := NULL;
            SELECT value INTO v_prod FROM jsonb_array_elements(v_products) WHERE value->>'key' = v_prod_key;
            IF v_prod IS NULL THEN
                v_prod := pg_catalog.jsonb_build_object('key', v_prod_key, 'snapshot_product_id', v_contrib_row.snapshot_product_id, 'snapshot_id', v_contrib_row.snapshot_id, 'bsale_variant_id', v_contrib_row.bsale_variant_id, 'available_quantity', 0, 'damaged_quantity', 0, 'expired_quantity', 0, 'blocked_quantity', 0, 'other_unavailable_quantity', 0, 'physical_quantity', 0, 'contribution_count', 0, 'normal_contribution_count', 0, 'recount_contribution_count', 0, 'manifest', '[]'::jsonb);
                v_products := v_products || v_prod;
            END IF;
            SELECT value INTO v_prod FROM jsonb_array_elements(v_products) WHERE value->>'key' = v_prod_key;
            v_prod := v_prod || jsonb_build_object(
                'available_quantity', (v_prod->>'available_quantity')::numeric + v_contrib_row.available_quantity,
                'damaged_quantity', (v_prod->>'damaged_quantity')::numeric + v_contrib_row.damaged_quantity,
                'expired_quantity', (v_prod->>'expired_quantity')::numeric + v_contrib_row.expired_quantity,
                'blocked_quantity', (v_prod->>'blocked_quantity')::numeric + v_contrib_row.blocked_quantity,
                'other_unavailable_quantity', (v_prod->>'other_unavailable_quantity')::numeric + v_contrib_row.other_unavailable_quantity,
                'physical_quantity', (v_prod->>'physical_quantity')::numeric + v_contrib_row.physical_quantity,
                'contribution_count', (v_prod->>'contribution_count')::integer + 1,
                'normal_contribution_count', (v_prod->>'normal_contribution_count')::integer + CASE WHEN v_contrib_row.contribution_source = 'NORMAL' THEN 1 ELSE 0 END,
                'recount_contribution_count', (v_prod->>'recount_contribution_count')::integer + CASE WHEN v_contrib_row.contribution_source = 'RECOUNT' THEN 1 ELSE 0 END
            );
            v_manifest := v_prod->'manifest';
            v_manifest := v_manifest || jsonb_build_object(
                'contribution_count_entry_id', v_contrib_row.contribution_count_entry_id,
                'contribution_source', v_contrib_row.contribution_source,
                'root_count_entry_id', v_contrib_row.root_count_entry_id,
                'recount_request_id', v_contrib_row.recount_request_id,
                'recount_decision_id', v_contrib_row.recount_decision_id,
                'task_id', v_task_row.id,
                'task_cycle', v_contrib_row.task_cycle,
                'session_zone_id', v_contrib_row.session_zone_id
            );
            v_prod := v_prod || jsonb_build_object('manifest', v_manifest);
            v_products := (
                SELECT jsonb_agg(CASE WHEN elem->>'key' = v_prod_key THEN v_prod ELSE elem END ORDER BY elem->>'key')
                FROM jsonb_array_elements(v_products) elem
            );
            v_cc := v_cc + 1;
            IF v_contrib_row.contribution_source = 'NORMAL' THEN v_nc := v_nc + 1; END IF;
            IF v_contrib_row.contribution_source = 'RECOUNT' THEN v_rc := v_rc + 1; END IF;
        END LOOP;
    END LOOP;
    IF v_cc = 0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_CONSOLIDATED',
        DETAIL=pg_catalog.jsonb_build_object('message','La jornada no se puede consolidar.','retryable',false)::text; END IF;
    INSERT INTO inventarios.official_versions (company_id, session_id, snapshot_id, version_number, task_count, contribution_count, normal_contribution_count, recount_contribution_count, item_count, approved_at, approved_by, created_at, created_by)
    VALUES (p_company_id, p_session_id, v_snapshot_id, 1, v_task_count, v_cc, v_nc, v_rc, 0, v_approved_at, v_actor_id, v_approved_at, v_actor_id)
    RETURNING id INTO v_official_id;
    FOR v_prod IN SELECT * FROM jsonb_array_elements(v_products) ORDER BY (value->>'key') LOOP
        INSERT INTO inventarios.official_version_items (company_id, official_version_id, session_id, snapshot_id, snapshot_product_id, bsale_variant_id, available_quantity, damaged_quantity, expired_quantity, blocked_quantity, other_unavailable_quantity, physical_quantity, contribution_count, normal_contribution_count, recount_contribution_count, contribution_manifest, created_at, created_by)
        VALUES (p_company_id, v_official_id, p_session_id, (v_prod->>'snapshot_id')::uuid, (v_prod->>'snapshot_product_id')::uuid, (v_prod->>'bsale_variant_id')::integer, (v_prod->>'available_quantity')::numeric, (v_prod->>'damaged_quantity')::numeric, (v_prod->>'expired_quantity')::numeric, (v_prod->>'blocked_quantity')::numeric, (v_prod->>'other_unavailable_quantity')::numeric, (v_prod->>'physical_quantity')::numeric, (v_prod->>'contribution_count')::integer, (v_prod->>'normal_contribution_count')::integer, (v_prod->>'recount_contribution_count')::integer, v_prod->'manifest', v_approved_at, v_actor_id)
        RETURNING id INTO v_item_id;
        v_ic := v_ic + 1;
    END LOOP;
    UPDATE inventarios.official_versions SET item_count = v_ic WHERE id = v_official_id;
    UPDATE inventarios.sessions SET status = 'APPROVED', approved_at = v_approved_at, approved_by = v_actor_id, updated_at = v_approved_at, updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_session_id AND status = 'UNDER_REVIEW';
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
        DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    v_resp := pg_catalog.jsonb_build_object('operation','inventarios.session.approve','entity_id',p_session_id,'state','APPROVED','version',NULL::integer,'cycle_number',NULL::integer,'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_approved_at,'data',pg_catalog.jsonb_build_object('official_version_id',v_official_id,'official_version_number',1,'snapshot_id',v_snapshot_id,'task_count',v_task_count,'contribution_count',v_cc,'normal_contribution_count',v_nc,'recount_contribution_count',v_rc,'item_count',v_ic,'approved_by',v_actor_id,'approved_at',v_approved_at));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_resp);
END;
$$;
ALTER FUNCTION inventarios.approve_inventory_session(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.approve_inventory_session(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
