CREATE OR REPLACE FUNCTION inventarios.complete_inventory_recount(
    p_company_id uuid,
    p_recount_request_id uuid,
    p_expected_status text,
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
    v_snapshot_id uuid;
    v_zone_id uuid;
    v_prod_id uuid;
    v_task_id uuid;
    v_cycle integer;
    v_app_id uuid;
    v_auser_id uuid;
    v_aat timestamptz;
    v_started_at timestamptz;
    v_task_comp text;
    v_task_ca timestamptz;
    v_task_cb uuid;
    v_task_ve uuid;
    v_task_va timestamptz;
    v_task_vb uuid;
    v_sess text;
    v_completed_at timestamptz;
    v_payload jsonb;
    v_resp jsonb;
    v_linked_cnt bigint;
    v_root_cnt bigint;
    v_eff_cnt bigint;
    v_ord integer;
BEGIN
    IF p_company_id IS NULL OR p_recount_request_id IS NULL
       OR p_expected_status IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF upper(btrim(p_expected_status)) <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.recounts.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.complete_inventory_recount.idempotency'), hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := jsonb_build_object('operation','inventarios.recount.complete','company_id',p_company_id,'recount_request_id',p_recount_request_id,'expected_status','IN_PROGRESS');
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.recount.complete',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.complete_inventory_recount'), hashtext(p_company_id::text || ':' || p_recount_request_id::text));
    SELECT rr.session_id, rr.snapshot_id, rr.session_zone_id, rr.snapshot_product_id,
           rr.source_task_id, rr.cycle_number, rr.assigned_participant_id, rr.assigned_user_id,
           rr.assigned_at, rr.started_at, rr.ordinal
    INTO v_session_id, v_snapshot_id, v_zone_id, v_prod_id,
         v_task_id, v_cycle, v_app_id, v_auser_id,
         v_aat, v_started_at, v_ord
    FROM inventarios.recount_requests rr WHERE rr.company_id = p_company_id AND rr.id = p_recount_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_session_id IS NULL OR v_snapshot_id IS NULL OR v_zone_id IS NULL OR v_prod_id IS NULL
       OR v_task_id IS NULL OR v_cycle IS NULL OR v_cycle < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    IF v_app_id IS NULL OR v_auser_id IS NULL OR v_aat IS NULL OR v_started_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    IF v_auser_id IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_ACTOR_MISMATCH', DETAIL=jsonb_build_object('message','No tienes una asignacion vigente para esta operacion.','retryable',false)::text;
    END IF;
    PERFORM 1 FROM inventarios.session_participants sp
    WHERE sp.id = v_app_id AND sp.company_id = p_company_id AND sp.session_id = v_session_id
      AND sp.user_id = v_actor_id AND sp.functional_role = 'COUNTER'
      AND sp.active_from <= now() AND sp.revoked_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    SELECT t.status, t.cancelled_at, t.cancelled_by, t.current_validation_event_id, t.validated_at, t.validated_by
    INTO v_task_comp, v_task_ca, v_task_cb, v_task_ve, v_task_va, v_task_vb
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.id = v_task_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_task_comp <> 'COMPLETED' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE', DETAIL=jsonb_build_object('message','La tarea no permite esta operacion en su estado actual.','retryable',false)::text; END IF;
    IF v_task_ca IS NOT NULL OR v_task_cb IS NOT NULL THEN
        IF v_task_ca IS NULL OR v_task_cb IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text; END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_ALREADY_CANCELLED', DETAIL=jsonb_build_object('message','La tarea ya fue cancelada.','retryable',false)::text;
    END IF;
    IF v_task_ve IS NOT NULL OR v_task_va IS NOT NULL OR v_task_vb IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    SELECT s.status INTO v_sess FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = v_session_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_sess <> 'UNDER_REVIEW' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE', DETAIL=jsonb_build_object('message','La jornada no permite operaciones de participantes.','retryable',false)::text; END IF;
    PERFORM 1 FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id AND szl.session_id = v_session_id
      AND szl.snapshot_id = v_snapshot_id AND szl.session_zone_id = v_zone_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    SELECT count(*) INTO v_linked_cnt FROM inventarios.count_entries ce
    WHERE ce.company_id = p_company_id AND ce.recount_request_id = p_recount_request_id;
    SELECT count(*) INTO v_root_cnt FROM (
        SELECT ce.id FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id AND ce.recount_request_id = p_recount_request_id
          AND NOT EXISTS (SELECT 1 FROM inventarios.count_entry_corrections cec
                          WHERE cec.company_id = p_company_id AND cec.replacement_count_entry_id = ce.id)
    ) roots;
    SELECT count(*) INTO v_eff_cnt FROM (
        SELECT COALESCE(act.replacement_id, root.id) AS candidate
        FROM (
            SELECT ce.id FROM inventarios.count_entries ce
            WHERE ce.company_id = p_company_id AND ce.recount_request_id = p_recount_request_id
              AND NOT EXISTS (SELECT 1 FROM inventarios.count_entry_corrections cec
                              WHERE cec.company_id = p_company_id AND cec.replacement_count_entry_id = ce.id)
        ) root
        LEFT JOIN LATERAL (
            SELECT cec.replacement_count_entry_id AS replacement_id
            FROM inventarios.count_entry_corrections cec
            WHERE cec.company_id = p_company_id AND cec.root_count_entry_id = root.id
              AND cec.superseded_at IS NULL
        ) act ON true
    ) candidates
    JOIN inventarios.count_entries ce ON ce.id = candidates.candidate
    WHERE ce.company_id = p_company_id
      AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL;
    IF v_eff_cnt < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_NO_COUNTS', DETAIL=jsonb_build_object('message','La solicitud no tiene capturas efectivas validas para completar.','retryable',false)::text;
    END IF;
    v_completed_at := now();
    IF v_completed_at < v_started_at THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    UPDATE inventarios.recount_requests
    SET status = 'COMPLETED', completed_at = v_completed_at,
        updated_at = v_completed_at, updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_recount_request_id
      AND status = 'IN_PROGRESS'
      AND assigned_participant_id IS NOT NULL AND assigned_user_id = v_actor_id
      AND assigned_at IS NOT NULL AND started_at IS NOT NULL
      AND completed_at IS NULL
      AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    v_resp := jsonb_build_object('operation','inventarios.recount.complete','entity_id',p_recount_request_id,'state','COMPLETED','version',NULL::integer,'cycle_number',v_cycle,'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_completed_at,'data',jsonb_build_object('assigned_participant_id',v_app_id,'assigned_user_id',v_auser_id,'assigned_at',v_aat,'started_at',v_started_at,'completed_at',v_completed_at,'session_id',v_session_id,'session_zone_id',v_zone_id,'snapshot_product_id',v_prod_id,'source_task_id',v_task_id,'ordinal',v_ord,'linked_count_entry_count',v_linked_cnt,'root_count_entry_count',v_root_cnt,'effective_count_entry_count',v_eff_cnt));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_recount_request_id, v_resp);
END;
$$;
ALTER FUNCTION inventarios.complete_inventory_recount(uuid, uuid, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.complete_inventory_recount(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
