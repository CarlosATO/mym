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
    v_prev_correction_id uuid;
    v_current_id uuid;
    v_root_session_id uuid;
    v_root_snapshot_id uuid;
    v_root_zone_id uuid;
    v_root_task_id uuid;
    v_root_cycle integer;
    v_root_product_id uuid;
    v_root_variant_id integer;
    v_root_location_id uuid;
    v_root_inv_at timestamptz;
    v_eff_session_id uuid;
    v_eff_snapshot_id uuid;
    v_eff_zone_id uuid;
    v_eff_task_id uuid;
    v_eff_cycle integer;
    v_eff_product_id uuid;
    v_eff_variant_id integer;
    v_eff_location_id uuid;
    v_eff_inv_at timestamptz;
    v_eff_inv_by uuid;
    v_eff_inv_reason text;
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
    v_inv_at timestamptz;
    v_payload jsonb;
    v_resp jsonb;
    v_cnt bigint;
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
    v_payload := jsonb_build_object('operation','inventarios.count.invalidate','company_id',p_company_id,'root_count_entry_id',p_root_count_entry_id,'expected_current_count_entry_id',p_expected_current_count_entry_id,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.count.invalidate',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT ce.session_id, ce.snapshot_id, ce.session_zone_id, ce.task_id, ce.task_cycle,
           ce.snapshot_product_id, ce.bsale_variant_id, ce.snapshot_location_id, ce.invalidated_at
    INTO v_root_session_id, v_root_snapshot_id, v_root_zone_id, v_root_task_id, v_root_cycle,
         v_root_product_id, v_root_variant_id, v_root_location_id, v_root_inv_at
    FROM inventarios.count_entries ce WHERE ce.company_id = p_company_id AND ce.id = p_root_count_entry_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    SELECT count(*) INTO v_cnt FROM inventarios.count_entry_corrections cec WHERE cec.company_id = p_company_id AND cec.replacement_count_entry_id = p_root_count_entry_id;
    IF v_cnt > 0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text; END IF;
    IF v_root_inv_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COUNT_ALREADY_INVALIDATED', DETAIL=jsonb_build_object('message','La captura ya fue invalidada.','retryable',false,'count_entry_id',p_root_count_entry_id)::text;
    END IF;
    SELECT cec.id INTO v_prev_correction_id FROM inventarios.count_entry_corrections cec
    WHERE cec.company_id = p_company_id AND cec.root_count_entry_id = p_root_count_entry_id AND cec.superseded_at IS NULL FOR UPDATE;
    IF FOUND THEN
        SELECT cec.replacement_count_entry_id INTO v_current_id FROM inventarios.count_entry_corrections cec WHERE cec.id = v_prev_correction_id;
    ELSE
        v_current_id := p_root_count_entry_id;
        v_prev_correction_id := NULL;
    END IF;
    IF v_current_id IS DISTINCT FROM p_expected_current_count_entry_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','current_count_entry_id',v_current_id)::text;
    END IF;
    SELECT ce.session_id, ce.snapshot_id, ce.session_zone_id, ce.task_id, ce.task_cycle,
           ce.snapshot_product_id, ce.bsale_variant_id, ce.snapshot_location_id,
           ce.invalidated_at, ce.invalidated_by, ce.invalidation_reason
    INTO v_eff_session_id, v_eff_snapshot_id, v_eff_zone_id, v_eff_task_id, v_eff_cycle,
         v_eff_product_id, v_eff_variant_id, v_eff_location_id,
         v_eff_inv_at, v_eff_inv_by, v_eff_inv_reason
    FROM inventarios.count_entries ce WHERE ce.company_id = p_company_id AND ce.id = v_current_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_root_session_id IS DISTINCT FROM v_eff_session_id OR v_root_snapshot_id IS DISTINCT FROM v_eff_snapshot_id
       OR v_root_zone_id IS DISTINCT FROM v_eff_zone_id OR v_root_task_id IS DISTINCT FROM v_eff_task_id
       OR v_root_cycle IS DISTINCT FROM v_eff_cycle OR v_root_product_id IS DISTINCT FROM v_eff_product_id
       OR v_root_variant_id IS DISTINCT FROM v_eff_variant_id OR v_root_location_id IS DISTINCT FROM v_eff_location_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    IF v_eff_inv_at IS NOT NULL OR v_eff_inv_by IS NOT NULL OR v_eff_inv_reason IS NOT NULL THEN
        IF v_eff_inv_at IS NULL OR v_eff_inv_by IS NULL OR v_eff_inv_reason IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
        END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COUNT_ALREADY_INVALIDATED', DETAIL=jsonb_build_object('message','La captura ya fue invalidada.','retryable',false,'count_entry_id',v_current_id)::text;
    END IF;
    SELECT t.status, t.cancelled_at, t.cancelled_by, t.validation_cycle, t.current_assignment_id,
           t.active_user_id, t.current_validation_event_id, t.validated_at, t.validated_by
    INTO v_task_status, v_task_cancelled_at, v_task_cancelled_by, v_task_vc, v_task_ca,
         v_task_au, v_task_ve, v_task_va, v_task_vb
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.id = v_root_task_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    SELECT s.status INTO v_sess_status FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = v_root_session_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_task_cancelled_at IS NOT NULL OR v_task_cancelled_by IS NOT NULL THEN
        IF v_task_cancelled_at IS NULL OR v_task_cancelled_by IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text;
        END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_ALREADY_CANCELLED', DETAIL=jsonb_build_object('message','La tarea ya fue cancelada.','retryable',false)::text;
    END IF;
    IF v_task_vc IS DISTINCT FROM v_root_cycle THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
    END IF;
    IF v_task_status = 'IN_PROGRESS' AND v_sess_status = 'COUNTING' THEN
        v_participant_id := inventarios.require_session_participant(p_company_id, v_root_session_id, 'COUNTER');
        IF v_task_ca IS NULL OR v_task_au IS NULL OR v_task_au IS DISTINCT FROM v_actor_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED', DETAIL=jsonb_build_object('message','No tienes una asignacion vigente para esta tarea.','retryable',false)::text;
        END IF;
        SELECT ta.id, ta.user_id INTO v_aid, v_auid FROM inventarios.task_assignments ta
        WHERE ta.company_id = p_company_id AND ta.session_id = v_root_session_id AND ta.task_id = v_root_task_id
          AND ta.id = v_task_ca AND ta.released_at IS NULL FOR SHARE;
        IF NOT FOUND OR v_auid IS DISTINCT FROM v_actor_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED', DETAIL=jsonb_build_object('message','No tienes una asignacion vigente para esta tarea.','retryable',false)::text;
        END IF;
    ELSIF v_task_status = 'COMPLETED' AND v_sess_status = 'UNDER_REVIEW'
          AND v_task_ve IS NULL AND v_task_va IS NULL AND v_task_vb IS NULL THEN
        v_participant_id := inventarios.require_session_participant(p_company_id, v_root_session_id, 'SUPERVISOR');
    ELSE
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE', DETAIL=jsonb_build_object('message','La tarea no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    v_inv_at := now();
    UPDATE inventarios.count_entries
    SET invalidated_at = v_inv_at, invalidated_by = v_actor_id, invalidation_reason = v_reason
    WHERE company_id = p_company_id AND id = v_current_id
      AND invalidated_at IS NULL AND invalidated_by IS NULL AND invalidation_reason IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    v_resp := jsonb_build_object('operation','inventarios.count.invalidate','entity_id',v_current_id,'state',NULL::text,'version',NULL::integer,'cycle_number',v_root_cycle,'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_inv_at,'data',jsonb_build_object('root_count_entry_id',p_root_count_entry_id,'count_entry_id',v_current_id,'active_correction_id',v_prev_correction_id,'reason',v_reason));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_current_id, v_resp);
END;
$$;
ALTER FUNCTION inventarios.invalidate_inventory_count(uuid, uuid, uuid, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.invalidate_inventory_count(uuid, uuid, uuid, text, uuid)
FROM PUBLIC, anon, authenticated, service_role;
