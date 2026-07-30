CREATE OR REPLACE FUNCTION inventarios.assign_inventory_recount(
    p_company_id uuid,
    p_recount_request_id uuid,
    p_expected_status text,
    p_counter_user_id uuid,
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
    v_expected text;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_zone_id uuid;
    v_prod_id uuid;
    v_task_id uuid;
    v_cycle integer;
    v_task_status text;
    v_task_cancelled_at timestamptz;
    v_task_cancelled_by uuid;
    v_task_ve uuid;
    v_task_va timestamptz;
    v_task_vb uuid;
    v_sess_status text;
    v_participant_id uuid;
    v_assigned_at timestamptz;
    v_payload jsonb;
    v_resp jsonb;
BEGIN
    IF p_company_id IS NULL OR p_recount_request_id IS NULL
       OR p_expected_status IS NULL OR p_counter_user_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_expected := upper(btrim(p_expected_status));
    IF v_expected <> 'REQUESTED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.recounts.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.assign_inventory_recount.idempotency'), hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := jsonb_build_object('operation','inventarios.recount.assign','company_id',p_company_id,'recount_request_id',p_recount_request_id,'expected_status','REQUESTED','counter_user_id',p_counter_user_id);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.recount.assign',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.assign_inventory_recount'), hashtext(p_company_id::text || ':' || p_recount_request_id::text));
    SELECT rr.session_id, rr.snapshot_id, rr.session_zone_id, rr.snapshot_product_id,
           rr.source_task_id, rr.cycle_number
    INTO v_session_id, v_snapshot_id, v_zone_id, v_prod_id, v_task_id, v_cycle
    FROM inventarios.recount_requests rr WHERE rr.company_id = p_company_id AND rr.id = p_recount_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_session_id IS NULL OR v_snapshot_id IS NULL OR v_zone_id IS NULL
       OR v_prod_id IS NULL OR v_task_id IS NULL OR v_cycle IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    SELECT t.status, t.cancelled_at, t.cancelled_by, t.current_validation_event_id,
           t.validated_at, t.validated_by
    INTO v_task_status, v_task_cancelled_at, v_task_cancelled_by,
         v_task_ve, v_task_va, v_task_vb
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.id = v_task_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_task_cancelled_at IS NOT NULL OR v_task_cancelled_by IS NOT NULL THEN
        IF v_task_cancelled_at IS NULL OR v_task_cancelled_by IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text; END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_ALREADY_CANCELLED', DETAIL=jsonb_build_object('message','La tarea ya fue cancelada.','retryable',false)::text;
    END IF;
    IF v_task_status <> 'COMPLETED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE', DETAIL=jsonb_build_object('message','La tarea no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    IF v_task_ve IS NOT NULL OR v_task_va IS NOT NULL OR v_task_vb IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    SELECT s.status INTO v_sess_status FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = v_session_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_sess_status <> 'UNDER_REVIEW' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE', DETAIL=jsonb_build_object('message','La jornada no permite operaciones de participantes.','retryable',false)::text;
    END IF;
    PERFORM inventarios.require_session_participant(p_company_id, v_session_id, 'SUPERVISOR');
    SELECT sp.id INTO v_participant_id FROM inventarios.session_participants sp
    WHERE sp.company_id = p_company_id AND sp.session_id = v_session_id
      AND sp.user_id = p_counter_user_id AND sp.functional_role = 'COUNTER'
      AND sp.active_from <= now() AND sp.revoked_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    v_assigned_at := now();
    UPDATE inventarios.recount_requests
    SET status = 'ASSIGNED',
        assigned_participant_id = v_participant_id,
        assigned_user_id = p_counter_user_id,
        assigned_at = v_assigned_at,
        updated_at = v_assigned_at,
        updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_recount_request_id
      AND status = 'REQUESTED'
      AND assigned_participant_id IS NULL AND assigned_user_id IS NULL AND assigned_at IS NULL
      AND started_at IS NULL AND completed_at IS NULL
      AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    v_resp := jsonb_build_object('operation','inventarios.recount.assign','entity_id',p_recount_request_id,'state','ASSIGNED','version',NULL::integer,'cycle_number',v_cycle,'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_assigned_at,'data',jsonb_build_object('assigned_participant_id',v_participant_id,'assigned_user_id',p_counter_user_id,'session_id',v_session_id,'session_zone_id',v_zone_id,'snapshot_product_id',v_prod_id,'source_task_id',v_task_id,'ordinal',(SELECT rr.ordinal FROM inventarios.recount_requests rr WHERE rr.id = p_recount_request_id)));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_recount_request_id, v_resp);
END;
$$;
ALTER FUNCTION inventarios.assign_inventory_recount(uuid, uuid, text, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.assign_inventory_recount(uuid, uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
