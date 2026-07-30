CREATE OR REPLACE FUNCTION inventarios.invalidate_inventory_count(
    p_company_id uuid,
    p_root_count_entry_id uuid,
    p_expected_current_count_entry_id uuid,
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
    v_active_correction_id uuid;
    v_current_count_entry_id uuid;
    v_sid uuid; v_szid uuid; v_rid uuid; v_tid uuid; v_cyc integer;
    v_pid uuid; v_vid integer; v_lid uuid;
    v_root_inv_at timestamptz;
    v_eff_inv_at timestamptz;
    v_eff_inv_by uuid;
    v_eff_inv_rs text;
    v_task_status text;
    v_task_cancelled_at timestamptz;
    v_task_cancelled_by uuid;
    v_task_vc integer;
    v_task_ca uuid;
    v_task_au uuid;
    v_task_ve uuid;
    v_task_va timestamptz;
    v_task_vb uuid;
    v_sess_status text;
    v_invalidated_at timestamptz;
    v_payload jsonb;
    v_resp jsonb;
    v_is_counter boolean;
    v_is_super boolean;
BEGIN
    IF p_company_id IS NULL OR p_root_count_entry_id IS NULL
       OR p_expected_current_count_entry_id IS NULL
       OR p_reason IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_reason := btrim(p_reason);
    IF v_reason = '' OR length(v_reason) < 5 OR length(v_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.counts.correct');
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.invalidate_inventory_count'), hashtext(p_company_id::text || ':' || p_root_count_entry_id::text));
    v_payload := jsonb_build_object('operation', 'inventarios.count.invalidate', 'company_id', p_company_id, 'root_count_entry_id', p_root_count_entry_id, 'expected_current_count_entry_id', p_expected_current_count_entry_id, 'reason', v_reason);
    v_operation := inventarios.begin_idempotent_operation(p_company_id, 'inventarios.count.invalidate', p_idempotency_key, inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT ce.session_id, ce.snapshot_id, ce.session_zone_id, ce.task_id, ce.task_cycle,
           ce.snapshot_product_id, ce.bsale_variant_id, ce.snapshot_location_id, ce.invalidated_at
    INTO v_sid, v_szid, v_rid, v_tid, v_cyc, v_pid, v_vid, v_lid, v_root_inv_at
    FROM inventarios.count_entries ce WHERE ce.company_id = p_company_id AND ce.id = p_root_count_entry_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    PERFORM 1 FROM inventarios.count_entry_corrections cec WHERE cec.company_id = p_company_id AND cec.replacement_count_entry_id = p_root_count_entry_id;
    IF FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text; END IF;
    IF v_root_inv_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COUNT_ALREADY_INVALIDATED', DETAIL=jsonb_build_object('message','El conteo ya ha sido invalidado.','retryable',false,'count_entry_id',p_root_count_entry_id)::text;
    END IF;
    SELECT cec.id, cec.replacement_count_entry_id INTO v_active_correction_id, v_current_count_entry_id
    FROM inventarios.count_entry_corrections cec
    WHERE cec.company_id = p_company_id AND cec.root_count_entry_id = p_root_count_entry_id AND cec.superseded_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        v_current_count_entry_id := p_root_count_entry_id;
        v_active_correction_id := NULL;
    END IF;
    IF p_expected_current_count_entry_id IS DISTINCT FROM v_current_count_entry_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true,'current_count_entry_id',v_current_count_entry_id)::text;
    END IF;
    SELECT ce.invalidated_at, ce.invalidated_by, ce.invalidation_reason
    INTO v_eff_inv_at, v_eff_inv_by, v_eff_inv_rs
    FROM inventarios.count_entries ce WHERE ce.company_id = p_company_id AND ce.id = v_current_count_entry_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_eff_inv_at IS NOT NULL AND v_eff_inv_by IS NOT NULL AND v_eff_inv_rs IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COUNT_ALREADY_INVALIDATED', DETAIL=jsonb_build_object('message','El conteo ya ha sido invalidado.','retryable',false,'count_entry_id',v_current_count_entry_id)::text;
    END IF;
    IF v_eff_inv_at IS NOT NULL OR v_eff_inv_by IS NOT NULL OR v_eff_inv_rs IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    SELECT t.status, t.cancelled_at, t.cancelled_by, t.validation_cycle, t.current_assignment_id,
           t.active_user_id, t.current_validation_event_id, t.validated_at, t.validated_by
    INTO v_task_status, v_task_cancelled_at, v_task_cancelled_by, v_task_vc, v_task_ca,
         v_task_au, v_task_ve, v_task_va, v_task_vb
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.id = v_tid FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    SELECT s.status INTO v_sess_status FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = v_sid FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_task_vc IS DISTINCT FROM v_cyc THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
    END IF;
    IF v_task_cancelled_at IS NOT NULL OR v_task_cancelled_by IS NOT NULL THEN
        IF v_task_cancelled_at IS NULL OR v_task_cancelled_by IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text; END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_ALREADY_CANCELLED', DETAIL=jsonb_build_object('message','La tarea ya fue cancelada.','retryable',false)::text;
    END IF;
    v_is_counter := (v_task_status = 'IN_PROGRESS' AND v_sess_status = 'COUNTING');
    v_is_super := (v_task_status = 'COMPLETED' AND v_sess_status = 'UNDER_REVIEW' AND v_task_ve IS NULL AND v_task_va IS NULL AND v_task_vb IS NULL);
    IF NOT v_is_counter AND NOT v_is_super THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE', DETAIL=jsonb_build_object('message','La tarea no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    IF v_is_counter THEN
        PERFORM inventarios.require_session_participant(p_company_id, v_sid, 'COUNTER');
        IF v_task_ca IS NULL OR v_task_au IS NULL OR v_task_au IS DISTINCT FROM v_actor_id THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED', DETAIL=jsonb_build_object('message','No tienes una asignacion vigente para esta tarea.','retryable',false)::text; END IF;
        SELECT ta.user_id INTO v_auid FROM inventarios.task_assignments ta WHERE ta.company_id = p_company_id AND ta.session_id = v_sid AND ta.task_id = v_tid AND ta.id = v_task_ca AND ta.released_at IS NULL FOR SHARE;
        IF NOT FOUND OR v_auid IS DISTINCT FROM v_actor_id THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED', DETAIL=jsonb_build_object('message','No tienes una asignacion vigente para esta tarea.','retryable',false)::text; END IF;
    END IF;
    IF v_is_super THEN
        PERFORM inventarios.require_session_participant(p_company_id, v_sid, 'SUPERVISOR');
    END IF;
    v_invalidated_at := pg_catalog.now();
    UPDATE inventarios.count_entries SET invalidated_at = v_invalidated_at, invalidated_by = v_actor_id, invalidation_reason = v_reason
    WHERE company_id = p_company_id AND id = v_current_count_entry_id AND invalidated_at IS NULL AND invalidated_by IS NULL AND invalidation_reason IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    v_resp := jsonb_build_object('operation', 'inventarios.count.invalidate', 'entity_id', v_current_count_entry_id, 'state', NULL::text, 'version', NULL::integer, 'cycle_number', v_cyc, 'assignment_id', NULL::uuid, 'event_id', NULL::uuid, 'replayed', false, 'occurred_at', v_invalidated_at, 'data', jsonb_build_object('root_count_entry_id', p_root_count_entry_id, 'count_entry_id', v_current_count_entry_id, 'active_correction_id', v_active_correction_id, 'reason', v_reason));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_current_count_entry_id, v_resp);
END;
$$;
ALTER FUNCTION inventarios.invalidate_inventory_count(uuid, uuid, uuid, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.invalidate_inventory_count(uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
