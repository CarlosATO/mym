CREATE OR REPLACE FUNCTION inventarios.correct_inventory_count(
    p_company_id uuid,
    p_root_count_entry_id uuid,
    p_expected_current_count_entry_id uuid,
    p_quantities jsonb,
    p_reason text,
    p_capture_source text,
    p_offline_id uuid,
    p_device_id text,
    p_captured_at timestamptz,
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
    v_participant_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_correction_id uuid;
    v_prev_correction_id uuid;
    v_prev_revision integer;
    v_revision_number integer;
    v_current_id uuid;
    v_rid uuid; v_sid uuid; v_szid uuid; v_tid uuid; v_cyc integer;
    v_pid uuid; v_vid integer; v_lid uuid;
    v_root_inv_at timestamptz;
    v_eff_inv_at timestamptz;
    v_a numeric(14,3); v_d numeric(14,3); v_e numeric(14,3);
    v_b numeric(14,3); v_o numeric(14,3);
    v_eff_ident text; v_eff_scanned text; v_eff_recount uuid;
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
    v_auid uuid;
    v_aid uuid;
    v_phys numeric(14,3);
    v_avail numeric(14,3); v_dam numeric(14,3); v_exp numeric(14,3);
    v_blk numeric(14,3); v_oth numeric(14,3);
    v_reason text;
    v_csource text;
    v_devid text;
    v_occ timestamptz;
    v_cap timestamptz;
    v_repl uuid;
    v_payload jsonb;
    v_resp jsonb;
    v_keys text[];
    v_qk text[] := ARRAY['available_quantity','blocked_quantity','damaged_quantity','expired_quantity','other_unavailable_quantity'];
    v_k text;
    v_val numeric;
    v_kc integer;
    v_cnt bigint;
    v_is_counter boolean;
    v_is_super boolean;
BEGIN
    IF p_company_id IS NULL OR p_root_count_entry_id IS NULL
       OR p_expected_current_count_entry_id IS NULL
       OR p_quantities IS NULL OR p_reason IS NULL
       OR p_capture_source IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_reason := btrim(p_reason);
    IF v_reason = '' OR length(v_reason) < 5 OR length(v_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_csource := upper(btrim(p_capture_source));
    IF v_csource NOT IN ('MOBILE','WEB') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF p_device_id IS NOT NULL THEN
        v_devid := btrim(p_device_id);
        IF v_devid = '' THEN v_devid := NULL; END IF;
    END IF;
    IF v_csource = 'MOBILE' THEN
        IF p_offline_id IS NULL OR v_devid IS NULL OR p_captured_at IS NULL
           OR p_idempotency_key IS DISTINCT FROM p_offline_id THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                DETAIL = jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
        END IF;
    END IF;
    IF jsonb_typeof(p_quantities) <> 'object' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_keys := ARRAY(SELECT jsonb_object_keys(p_quantities) ORDER BY 1);
    v_kc := array_length(v_keys, 1);
    IF v_kc IS DISTINCT FROM 5 OR NOT (v_keys = v_qk) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
            DETAIL = jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    FOREACH v_k IN ARRAY v_qk LOOP
        IF jsonb_typeof(p_quantities -> v_k) <> 'number' THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                DETAIL = jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
        END IF;
        v_val := (p_quantities ->> v_k)::numeric;
        IF v_val < 0 OR v_val > 99999999999.999 THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD',
                DETAIL = jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
        END IF;
        CASE v_k
            WHEN 'available_quantity' THEN v_avail := v_val;
            WHEN 'damaged_quantity' THEN v_dam := v_val;
            WHEN 'expired_quantity' THEN v_exp := v_val;
            WHEN 'blocked_quantity' THEN v_blk := v_val;
            WHEN 'other_unavailable_quantity' THEN v_oth := v_val;
        END CASE;
    END LOOP;
    v_phys := v_avail + v_dam + v_exp + v_blk + v_oth;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.counts.correct');
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.correct_inventory_count'), hashtext(p_company_id::text || ':' || p_root_count_entry_id::text));
    v_payload := jsonb_build_object('operation','inventarios.count.correct','company_id',p_company_id,'root_count_entry_id',p_root_count_entry_id,'expected_current_count_entry_id',p_expected_current_count_entry_id,'quantities',p_quantities,'reason',v_reason,'capture_source',v_csource,'offline_id',p_offline_id,'device_id',v_devid,'captured_at',p_captured_at);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.count.correct',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT ce.session_id, ce.snapshot_id, ce.session_zone_id, ce.task_id, ce.task_cycle,
           ce.snapshot_product_id, ce.bsale_variant_id, ce.snapshot_location_id, ce.invalidated_at
    INTO v_sid, v_szid, v_rid, v_tid, v_cyc, v_pid, v_vid, v_lid, v_root_inv_at
    FROM inventarios.count_entries ce WHERE ce.company_id = p_company_id AND ce.id = p_root_count_entry_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    SELECT count(*) INTO v_cnt FROM inventarios.count_entry_corrections cec WHERE cec.company_id = p_company_id AND cec.replacement_count_entry_id = p_root_count_entry_id;
    IF v_cnt > 0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text; END IF;
    SELECT cec.id, cec.revision_number INTO v_prev_correction_id, v_prev_revision
    FROM inventarios.count_entry_corrections cec
    WHERE cec.company_id = p_company_id AND cec.root_count_entry_id = p_root_count_entry_id AND cec.superseded_at IS NULL FOR UPDATE;
    IF FOUND THEN
        SELECT cec.replacement_count_entry_id INTO v_current_id FROM inventarios.count_entry_corrections cec WHERE cec.id = v_prev_correction_id;
        v_revision_number := v_prev_revision + 1;
    ELSE
        v_current_id := p_root_count_entry_id;
        v_prev_correction_id := NULL;
        v_revision_number := 1;
    END IF;
    IF v_current_id IS DISTINCT FROM p_expected_current_count_entry_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','current_count_entry_id',v_current_id)::text;
    END IF;
    SELECT ce.invalidated_at, ce.available_quantity, ce.damaged_quantity, ce.expired_quantity,
           ce.blocked_quantity, ce.other_unavailable_quantity, ce.identification_method, ce.scanned_code, ce.recount_request_id
    INTO v_eff_inv_at, v_a, v_d, v_e, v_b, v_o, v_eff_ident, v_eff_scanned, v_eff_recount
    FROM inventarios.count_entries ce WHERE ce.company_id = p_company_id AND ce.id = v_current_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_root_inv_at IS NOT NULL OR v_eff_inv_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
    END IF;
    SELECT t.status, t.cancelled_at, t.cancelled_by, t.validation_cycle, t.current_assignment_id,
           t.active_user_id, t.current_validation_event_id, t.validated_at, t.validated_by
    INTO v_task_status, v_task_cancelled_at, v_task_cancelled_by, v_task_vc, v_task_ca,
         v_task_au, v_task_ve, v_task_va, v_task_vb
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.id = v_tid FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    SELECT s.status INTO v_sess_status FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = v_sid FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_task_cancelled_at IS NOT NULL OR v_task_cancelled_by IS NOT NULL THEN
        IF v_task_cancelled_at IS NULL OR v_task_cancelled_by IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text;
        END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_ALREADY_CANCELLED', DETAIL=jsonb_build_object('message','La tarea ya fue cancelada.','retryable',false)::text;
    END IF;
    IF v_task_vc IS DISTINCT FROM v_cyc THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
    END IF;
    v_is_counter := (v_task_status = 'IN_PROGRESS' AND v_sess_status = 'COUNTING');
    v_is_super := (v_task_status = 'COMPLETED' AND v_sess_status = 'UNDER_REVIEW'
                   AND v_task_ve IS NULL AND v_task_va IS NULL AND v_task_vb IS NULL);
    IF NOT v_is_counter AND NOT v_is_super THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE', DETAIL=jsonb_build_object('message','La tarea no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    IF v_is_counter THEN
        v_participant_id := inventarios.require_session_participant(p_company_id, v_sid, 'COUNTER');
        IF v_task_ca IS NULL OR v_task_au IS NULL OR v_task_au IS DISTINCT FROM v_actor_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED', DETAIL=jsonb_build_object('message','No tienes una asignacion vigente para esta tarea.','retryable',false)::text;
        END IF;
        SELECT ta.id, ta.user_id INTO v_aid, v_auid FROM inventarios.task_assignments ta
        WHERE ta.company_id = p_company_id AND ta.session_id = v_sid AND ta.task_id = v_tid
          AND ta.id = v_task_ca AND ta.released_at IS NULL FOR SHARE;
        IF NOT FOUND OR v_auid IS DISTINCT FROM v_actor_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED', DETAIL=jsonb_build_object('message','No tienes una asignacion vigente para esta tarea.','retryable',false)::text;
        END IF;
    END IF;
    IF v_is_super THEN
        v_participant_id := inventarios.require_session_participant(p_company_id, v_sid, 'SUPERVISOR');
        IF v_task_ca IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
        SELECT ta.id INTO v_aid FROM inventarios.task_assignments ta
        WHERE ta.company_id = p_company_id AND ta.session_id = v_sid AND ta.task_id = v_tid
          AND ta.id = v_task_ca AND ta.released_at IS NULL FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    END IF;
    IF v_avail = v_a AND v_dam = v_d AND v_exp = v_e AND v_blk = v_b AND v_oth = v_o THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COUNT_QUANTITY_MISMATCH', DETAIL=jsonb_build_object('message','Las cantidades ingresadas no son validas para esta operacion.','retryable',false)::text;
    END IF;
    IF p_offline_id IS NOT NULL THEN
        SELECT count(*) INTO v_cnt FROM inventarios.count_entries ce WHERE ce.company_id = p_company_id AND ce.offline_id = p_offline_id;
        IF v_cnt > 0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_OFFLINE_CAPTURE_CONFLICT', DETAIL=jsonb_build_object('message','La captura offline ya fue registrada.','retryable',false)::text; END IF;
    END IF;
    v_occ := now(); v_cap := COALESCE(p_captured_at, v_occ);
    INSERT INTO inventarios.count_entries (company_id,session_id,snapshot_id,session_zone_id,task_id,task_cycle,session_participant_id,counted_by,snapshot_product_id,snapshot_location_id,bsale_variant_id,identification_method,scanned_code,capture_source,offline_id,device_id,captured_at,server_received_at,synced_at,synced_by,physical_quantity,available_quantity,damaged_quantity,expired_quantity,blocked_quantity,other_unavailable_quantity,recount_request_id,created_by)
    VALUES (p_company_id,v_sid,v_szid,v_rid,v_tid,v_cyc,v_participant_id,v_actor_id,v_pid,v_lid,v_vid,v_eff_ident,v_eff_scanned,v_csource,p_offline_id,v_devid,v_cap,v_occ,v_occ,v_actor_id,v_phys,v_avail,v_dam,v_exp,v_blk,v_oth,v_eff_recount,v_actor_id)
    RETURNING id INTO v_repl;
    IF v_prev_correction_id IS NOT NULL THEN
        UPDATE inventarios.count_entry_corrections SET superseded_at = v_occ
        WHERE id = v_prev_correction_id AND company_id = p_company_id AND superseded_at IS NULL;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    END IF;
    INSERT INTO inventarios.count_entry_corrections (company_id,session_id,task_id,snapshot_product_id,root_count_entry_id,previous_count_entry_id,replacement_count_entry_id,supersedes_correction_id,revision_number,reason,corrected_by,corrected_at)
    VALUES (p_company_id,v_sid,v_tid,v_pid,p_root_count_entry_id,v_current_id,v_repl,v_prev_correction_id,v_revision_number,v_reason,v_actor_id,v_occ)
    RETURNING id INTO v_correction_id;
    v_resp := jsonb_build_object('operation','inventarios.count.correct','entity_id',v_repl,'state',NULL::text,'version',NULL::integer,'cycle_number',v_cyc,'assignment_id',v_aid,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_occ,'data',jsonb_build_object('correction_id',v_correction_id,'root_count_entry_id',p_root_count_entry_id,'previous_count_entry_id',v_current_id,'replacement_count_entry_id',v_repl,'supersedes_correction_id',v_prev_correction_id,'revision_number',v_revision_number,'physical_quantity',v_phys,'available_quantity',v_avail,'damaged_quantity',v_dam,'expired_quantity',v_exp,'blocked_quantity',v_blk,'other_unavailable_quantity',v_oth,'reason',v_reason,'capture_source',v_csource,'offline_id',p_offline_id,'captured_at',v_cap));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_repl, v_resp);
END;
$$;
ALTER FUNCTION inventarios.correct_inventory_count(uuid, uuid, uuid, jsonb, text, text, uuid, text, timestamptz, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.correct_inventory_count(uuid, uuid, uuid, jsonb, text, text, uuid, text, timestamptz, uuid)
FROM PUBLIC, anon, authenticated, service_role;
