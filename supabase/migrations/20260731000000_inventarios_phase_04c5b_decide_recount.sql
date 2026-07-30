CREATE OR REPLACE FUNCTION inventarios.decide_inventory_recount(
    p_company_id uuid,
    p_recount_request_id uuid,
    p_expected_status text,
    p_selected_count_entry_id uuid,
    p_justification text,
    p_confidence_score numeric,
    p_expected_current_decision_id uuid,
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
    v_just text;
    v_sid uuid; v_szid uuid; v_rid uuid; v_pid uuid; v_tid uuid; v_cyc integer; v_ord integer;
    v_task_comp text; v_task_ca timestamptz; v_task_cb uuid; v_task_ve uuid; v_task_va timestamptz; v_task_vb uuid;
    v_sess text;
    v_cur_dec_id uuid;
    v_csid uuid; v_cszid uuid; v_ctid uuid; v_ccyc integer; v_cpid uuid; v_crid uuid;
    v_cinv_at timestamptz; v_cinv_by uuid; v_cinv_rs text;
    v_decided_at timestamptz;
    v_new_dec_id uuid;
    v_payload jsonb; v_resp jsonb;
    v_eff bigint;
BEGIN
    IF p_company_id IS NULL OR p_recount_request_id IS NULL OR p_expected_status IS NULL
       OR p_selected_count_entry_id IS NULL OR p_justification IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF upper(btrim(p_expected_status)) <> 'COMPLETED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_just := btrim(p_justification);
    IF length(v_just) < 5 OR length(v_just) > 1000 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF p_confidence_score IS NOT NULL AND (p_confidence_score < 0 OR p_confidence_score > 100 OR round(p_confidence_score, 2) <> p_confidence_score) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.recounts.decide');
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.decide_inventory_recount.idempotency'), hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := jsonb_build_object('operation','inventarios.recount.decide','company_id',p_company_id,'recount_request_id',p_recount_request_id,'expected_status','COMPLETED','selected_count_entry_id',p_selected_count_entry_id,'justification',v_just,'confidence_score',p_confidence_score,'expected_current_decision_id',p_expected_current_decision_id);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.recount.decide',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.decide_inventory_recount'), hashtext(p_company_id::text || ':' || p_recount_request_id::text));
    SELECT rr.session_id, rr.snapshot_id, rr.session_zone_id, rr.snapshot_product_id,
           rr.source_task_id, rr.cycle_number, rr.ordinal
    INTO v_sid, v_szid, v_rid, v_pid, v_tid, v_cyc, v_ord
    FROM inventarios.recount_requests rr WHERE rr.company_id = p_company_id AND rr.id = p_recount_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_sid IS NULL OR v_szid IS NULL OR v_rid IS NULL OR v_pid IS NULL OR v_tid IS NULL OR v_cyc IS NULL OR v_cyc < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    SELECT t.status, t.cancelled_at, t.cancelled_by, t.current_validation_event_id, t.validated_at, t.validated_by
    INTO v_task_comp, v_task_ca, v_task_cb, v_task_ve, v_task_va, v_task_vb
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.id = v_tid FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_task_comp <> 'COMPLETED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE', DETAIL=jsonb_build_object('message','La tarea no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    IF v_task_ca IS NOT NULL OR v_task_cb IS NOT NULL THEN
        IF v_task_ca IS NULL OR v_task_cb IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text; END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_ALREADY_CANCELLED', DETAIL=jsonb_build_object('message','La tarea ya fue cancelada.','retryable',false)::text;
    END IF;
    IF v_task_ve IS NOT NULL OR v_task_va IS NOT NULL OR v_task_vb IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    SELECT s.status INTO v_sess FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = v_sid FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_sess <> 'UNDER_REVIEW' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE', DETAIL=jsonb_build_object('message','La jornada no permite operaciones de participantes.','retryable',false)::text; END IF;
    PERFORM inventarios.require_session_participant(p_company_id, v_sid, 'SUPERVISOR');
    SELECT rd.id INTO v_cur_dec_id FROM inventarios.recount_decisions rd
    WHERE rd.company_id = p_company_id AND rd.recount_request_id = p_recount_request_id AND rd.superseded_at IS NULL FOR UPDATE;
    IF p_expected_current_decision_id IS NULL AND FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true,'current_decision_id',v_cur_dec_id)::text;
    END IF;
    IF p_expected_current_decision_id IS NOT NULL THEN
        IF NOT FOUND OR v_cur_dec_id IS DISTINCT FROM p_expected_current_decision_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true,'current_decision_id',v_cur_dec_id)::text;
        END IF;
    END IF;
    SELECT ce.session_id, ce.session_zone_id, ce.task_id, ce.task_cycle, ce.snapshot_product_id, ce.recount_request_id,
           ce.invalidated_at, ce.invalidated_by, ce.invalidation_reason
    INTO v_csid, v_cszid, v_ctid, v_ccyc, v_cpid, v_crid,
         v_cinv_at, v_cinv_by, v_cinv_rs
    FROM inventarios.count_entries ce WHERE ce.company_id = p_company_id AND ce.id = p_selected_count_entry_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_csid IS DISTINCT FROM v_sid OR v_cszid IS DISTINCT FROM v_rid
       OR v_ctid IS DISTINCT FROM v_tid OR v_ccyc IS DISTINCT FROM v_cyc
       OR v_cpid IS DISTINCT FROM v_pid OR v_crid IS DISTINCT FROM p_recount_request_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
    END IF;
    IF v_cinv_at IS NOT NULL OR v_cinv_by IS NOT NULL OR v_cinv_rs IS NOT NULL THEN
        IF v_cinv_at IS NULL OR v_cinv_by IS NULL OR v_cinv_rs IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
        END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_COUNT_NOT_EFFECTIVE', DETAIL=jsonb_build_object('message','El conteo seleccionado no es un aporte efectivo valido.','retryable',false)::text;
    END IF;
    WITH effective_candidates AS (
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
    )
    SELECT count(*) INTO v_eff FROM effective_candidates ec
    JOIN inventarios.count_entries ce ON ce.id = ec.candidate
    WHERE ce.company_id = p_company_id AND ec.candidate = p_selected_count_entry_id;
    IF v_eff = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECOUNT_COUNT_NOT_EFFECTIVE', DETAIL=jsonb_build_object('message','El conteo seleccionado no es un aporte efectivo valido.','retryable',false)::text;
    END IF;
    v_decided_at := now();
    IF p_expected_current_decision_id IS NOT NULL THEN
        UPDATE inventarios.recount_decisions SET superseded_at = v_decided_at
        WHERE company_id = p_company_id AND id = p_expected_current_decision_id
          AND recount_request_id = p_recount_request_id AND superseded_at IS NULL;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    END IF;
    INSERT INTO inventarios.recount_decisions (company_id,session_id,session_zone_id,snapshot_product_id,recount_request_id,selected_count_entry_id,supersedes_decision_id,cycle_number,decided_by,decided_at,justification,confidence_score,created_by)
    VALUES (p_company_id,v_sid,v_rid,v_pid,p_recount_request_id,p_selected_count_entry_id,p_expected_current_decision_id,v_cyc,v_actor_id,v_decided_at,v_just,p_confidence_score,v_actor_id)
    RETURNING id INTO v_new_dec_id;
    v_resp := jsonb_build_object('operation','inventarios.recount.decide','entity_id',v_new_dec_id,'state',NULL::text,'version',NULL::integer,'cycle_number',v_cyc,'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_decided_at,'data',jsonb_build_object('recount_request_id',p_recount_request_id,'selected_count_entry_id',p_selected_count_entry_id,'supersedes_decision_id',p_expected_current_decision_id,'previous_current_decision_id',v_cur_dec_id,'justification',v_just,'confidence_score',p_confidence_score,'decided_by',v_actor_id,'decided_at',v_decided_at,'session_id',v_sid,'session_zone_id',v_rid,'snapshot_product_id',v_pid,'source_task_id',v_tid,'ordinal',v_ord));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_new_dec_id, v_resp);
END;
$$;
ALTER FUNCTION inventarios.decide_inventory_recount(uuid, uuid, text, uuid, text, numeric, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.decide_inventory_recount(uuid, uuid, text, uuid, text, numeric, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
