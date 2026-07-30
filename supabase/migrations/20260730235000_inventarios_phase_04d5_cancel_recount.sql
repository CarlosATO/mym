CREATE OR REPLACE FUNCTION inventarios.cancel_inventory_recount(
    p_company_id uuid,
    p_recount_request_id uuid,
    p_expected_status text,
    p_reason text,
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
    v_reason text;
    v_expected text;
    v_session_id uuid;
    v_snapshot_id uuid;
    v_zone_id uuid;
    v_prod_id uuid;
    v_task_id uuid;
    v_cycle integer;
    v_ord integer;
    v_app_id uuid;
    v_auser_id uuid;
    v_aat timestamptz;
    v_started_at timestamptz;
    v_sess text;
    v_cancelled_at timestamptz;
    v_linked_cnt bigint;
    v_dec_cnt bigint;
    v_payload jsonb;
    v_resp jsonb;
BEGIN
    IF p_company_id IS NULL OR p_recount_request_id IS NULL
       OR p_expected_status IS NULL OR p_reason IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_expected := upper(btrim(p_expected_status));
    IF v_expected NOT IN ('REQUESTED','ASSIGNED','IN_PROGRESS') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_reason := btrim(p_reason);
    IF length(v_reason) < 5 OR length(v_reason) > 1000 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.recounts.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.cancel_inventory_recount.idempotency'), hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := jsonb_build_object('operation','inventarios.recount.cancel','company_id',p_company_id,'recount_request_id',p_recount_request_id,'expected_status',v_expected,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.recount.cancel',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.cancel_inventory_recount'), hashtext(p_company_id::text || ':' || p_recount_request_id::text));
    SELECT rr.session_id, rr.snapshot_id, rr.session_zone_id, rr.snapshot_product_id,
           rr.source_task_id, rr.cycle_number, rr.ordinal,
           rr.assigned_participant_id, rr.assigned_user_id, rr.assigned_at, rr.started_at
    INTO v_session_id, v_snapshot_id, v_zone_id, v_prod_id,
         v_task_id, v_cycle, v_ord,
         v_app_id, v_auser_id, v_aat, v_started_at
    FROM inventarios.recount_requests rr WHERE rr.company_id = p_company_id AND rr.id = p_recount_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_session_id IS NULL OR v_snapshot_id IS NULL OR v_zone_id IS NULL OR v_prod_id IS NULL
       OR v_task_id IS NULL OR v_cycle IS NULL OR v_cycle < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    SELECT s.status INTO v_sess FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = v_session_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_sess NOT IN ('COUNTING','UNDER_REVIEW') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE', DETAIL=jsonb_build_object('message','La jornada no permite operaciones de participantes.','retryable',false)::text;
    END IF;
    PERFORM inventarios.require_session_participant(p_company_id, v_session_id, 'SUPERVISOR');
    PERFORM 1 FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.id = v_task_id
      AND t.session_id = v_session_id AND t.session_zone_id = v_zone_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_expected = 'REQUESTED' THEN
        IF v_app_id IS NOT NULL OR v_auser_id IS NOT NULL OR v_aat IS NOT NULL OR v_started_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
        END IF;
    END IF;
    IF v_expected = 'ASSIGNED' THEN
        IF v_app_id IS NULL OR v_auser_id IS NULL OR v_aat IS NULL OR v_started_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
        END IF;
    END IF;
    IF v_expected = 'IN_PROGRESS' THEN
        IF v_app_id IS NULL OR v_auser_id IS NULL OR v_aat IS NULL OR v_started_at IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
        END IF;
    END IF;
    SELECT count(*) INTO v_linked_cnt FROM inventarios.count_entries ce
    WHERE ce.company_id = p_company_id AND ce.recount_request_id = p_recount_request_id;
    IF v_expected IN ('REQUESTED','ASSIGNED') AND v_linked_cnt > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    SELECT count(*) INTO v_dec_cnt FROM inventarios.recount_decisions rd
    WHERE rd.company_id = p_company_id AND rd.recount_request_id = p_recount_request_id;
    IF v_dec_cnt > 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
    END IF;
    v_cancelled_at := now();
    UPDATE inventarios.recount_requests
    SET status = 'CANCELLED', cancelled_at = v_cancelled_at, cancelled_by = v_actor_id,
        cancellation_reason = v_reason, updated_at = v_cancelled_at, updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_recount_request_id
      AND status = v_expected
      AND completed_at IS NULL
      AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    v_resp := jsonb_build_object('operation','inventarios.recount.cancel','entity_id',p_recount_request_id,'state','CANCELLED','version',NULL::integer,'cycle_number',v_cycle,'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_cancelled_at,'data',jsonb_build_object('previous_status',v_expected,'assigned_participant_id',v_app_id,'assigned_user_id',v_auser_id,'assigned_at',v_aat,'started_at',v_started_at,'cancelled_at',v_cancelled_at,'cancelled_by',v_actor_id,'cancellation_reason',v_reason,'session_id',v_session_id,'session_zone_id',v_zone_id,'snapshot_product_id',v_prod_id,'source_task_id',v_task_id,'ordinal',v_ord,'linked_count_entry_count',v_linked_cnt));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_recount_request_id, v_resp);
END;
$$;
ALTER FUNCTION inventarios.cancel_inventory_recount(uuid, uuid, text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.cancel_inventory_recount(uuid, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
