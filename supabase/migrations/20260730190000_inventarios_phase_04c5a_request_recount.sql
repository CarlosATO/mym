CREATE OR REPLACE FUNCTION inventarios.request_inventory_recount(
    p_company_id uuid,
    p_task_id uuid,
    p_expected_cycle integer,
    p_snapshot_product_id uuid,
    p_source_count_entry_id uuid,
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
    v_session_id uuid;
    v_session_zone_id uuid;
    v_snapshot_id uuid;
    v_task_status text;
    v_task_cycle integer;
    v_task_cancelled_at timestamptz;
    v_task_cancelled_by uuid;
    v_task_ca uuid;
    v_task_au uuid;
    v_task_ve uuid;
    v_task_va timestamptz;
    v_task_vb uuid;
    v_sess_status text;
    v_ordinal integer;
    v_created_at timestamptz;
    v_request_id uuid;
    v_payload jsonb;
    v_resp jsonb;
    v_aid uuid;
    v_cnt bigint;
    v_active_id uuid;
    v_active_status text;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL OR p_expected_cycle IS NULL OR p_expected_cycle < 1
       OR p_snapshot_product_id IS NULL OR p_reason IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_reason := btrim(p_reason);
    IF v_reason = '' OR length(v_reason) < 5 OR length(v_reason) > 1000 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.recounts.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.request_inventory_recount.idempotency'), hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := jsonb_build_object('operation','inventarios.recount.request','company_id',p_company_id,'task_id',p_task_id,'expected_cycle',p_expected_cycle,'snapshot_product_id',p_snapshot_product_id,'source_count_entry_id',p_source_count_entry_id,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.recount.request',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT t.session_id, t.session_zone_id, t.status, t.validation_cycle,
           t.cancelled_at, t.cancelled_by, t.current_assignment_id, t.active_user_id,
           t.current_validation_event_id, t.validated_at, t.validated_by
    INTO v_session_id, v_session_zone_id, v_task_status, v_task_cycle,
         v_task_cancelled_at, v_task_cancelled_by, v_task_ca, v_task_au,
         v_task_ve, v_task_va, v_task_vb
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.id = p_task_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_task_cycle IS DISTINCT FROM p_expected_cycle THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text;
    END IF;
    IF v_task_cancelled_at IS NOT NULL OR v_task_cancelled_by IS NOT NULL THEN
        IF v_task_cancelled_at IS NULL OR v_task_cancelled_by IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text; END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_ALREADY_CANCELLED', DETAIL=jsonb_build_object('message','La tarea ya fue cancelada.','retryable',false)::text;
    END IF;
    SELECT s.status INTO v_sess_status FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = v_session_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_task_status = 'IN_PROGRESS' AND v_sess_status = 'COUNTING' THEN
        PERFORM inventarios.require_session_participant(p_company_id, v_session_id, 'COUNTER');
        IF v_task_ca IS NULL OR v_task_au IS NULL OR v_task_au IS DISTINCT FROM v_actor_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED', DETAIL=jsonb_build_object('message','No tienes una asignacion vigente para esta tarea.','retryable',false)::text;
        END IF;
        SELECT ta.id INTO v_aid FROM inventarios.task_assignments ta
        WHERE ta.company_id = p_company_id AND ta.session_id = v_session_id AND ta.task_id = p_task_id
          AND ta.id = v_task_ca AND ta.user_id = v_actor_id AND ta.released_at IS NULL FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED', DETAIL=jsonb_build_object('message','No tienes una asignacion vigente para esta tarea.','retryable',false)::text; END IF;
    ELSIF v_task_status = 'COMPLETED' AND v_sess_status = 'UNDER_REVIEW'
          AND v_task_ve IS NULL AND v_task_va IS NULL AND v_task_vb IS NULL THEN
        PERFORM inventarios.require_session_participant(p_company_id, v_session_id, 'SUPERVISOR');
    ELSE
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE', DETAIL=jsonb_build_object('message','La tarea no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    SELECT sz.snapshot_id INTO v_snapshot_id FROM inventarios.session_zones sz
    WHERE sz.company_id = p_company_id AND sz.session_id = v_session_id AND sz.id = v_session_zone_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    PERFORM 1 FROM inventarios.snapshot_products sp
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id AND sp.id = p_snapshot_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF p_source_count_entry_id IS NOT NULL THEN
        PERFORM 1 FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id AND ce.id = p_source_count_entry_id
          AND ce.session_id = v_session_id AND ce.snapshot_id = v_snapshot_id
          AND ce.session_zone_id = v_session_zone_id AND ce.task_id = p_task_id
          AND ce.task_cycle = p_expected_cycle AND ce.snapshot_product_id = p_snapshot_product_id FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.recount.request.product_zone'), hashtext(p_company_id::text || ':' || v_session_id::text || ':' || v_session_zone_id::text || ':' || p_snapshot_product_id::text));
    SELECT count(*) INTO v_cnt FROM inventarios.recount_requests rr
    WHERE rr.company_id = p_company_id AND rr.session_id = v_session_id
      AND rr.session_zone_id = v_session_zone_id AND rr.snapshot_product_id = p_snapshot_product_id
      AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS');
    IF v_cnt > 1 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    IF v_cnt = 1 THEN
        SELECT rr.id, rr.status INTO v_active_id, v_active_status FROM inventarios.recount_requests rr
        WHERE rr.company_id = p_company_id AND rr.session_id = v_session_id
          AND rr.session_zone_id = v_session_zone_id AND rr.snapshot_product_id = p_snapshot_product_id
          AND rr.status IN ('REQUESTED','ASSIGNED','IN_PROGRESS');
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_ALREADY_REQUESTED', DETAIL=jsonb_build_object('message','Ya existe una solicitud de recuento activa para este producto.','retryable',false,'recount_request_id',v_active_id,'status',v_active_status)::text;
    END IF;
    SELECT COALESCE(max(rr.ordinal), 0) + 1 INTO v_ordinal FROM inventarios.recount_requests rr
    WHERE rr.company_id = p_company_id AND rr.session_id = v_session_id
      AND rr.session_zone_id = v_session_zone_id AND rr.snapshot_product_id = p_snapshot_product_id;
    v_created_at := now();
    INSERT INTO inventarios.recount_requests (company_id,session_id,snapshot_id,session_zone_id,snapshot_product_id,source_task_id,source_count_entry_id,reason,ordinal,cycle_number,status,requested_by,requested_at,created_at,created_by,updated_at,updated_by)
    VALUES (p_company_id,v_session_id,v_snapshot_id,v_session_zone_id,p_snapshot_product_id,p_task_id,p_source_count_entry_id,v_reason,v_ordinal,p_expected_cycle,'REQUESTED',v_actor_id,v_created_at,v_created_at,v_actor_id,v_created_at,v_actor_id)
    RETURNING id INTO v_request_id;
    v_resp := jsonb_build_object('operation','inventarios.recount.request','entity_id',v_request_id,'state','REQUESTED','version',NULL::integer,'cycle_number',p_expected_cycle,'assignment_id',v_aid,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_created_at,'data',jsonb_build_object('snapshot_product_id',p_snapshot_product_id,'source_task_id',p_task_id,'source_count_entry_id',p_source_count_entry_id,'session_zone_id',v_session_zone_id,'ordinal',v_ordinal,'reason',v_reason));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_request_id, v_resp);
END;
$$;
ALTER FUNCTION inventarios.request_inventory_recount(uuid, uuid, integer, uuid, uuid, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.request_inventory_recount(uuid, uuid, integer, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
