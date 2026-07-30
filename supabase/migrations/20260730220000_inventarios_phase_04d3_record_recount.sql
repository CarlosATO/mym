CREATE OR REPLACE FUNCTION inventarios.record_inventory_recount(
    p_company_id uuid,
    p_recount_request_id uuid,
    p_expected_status text,
    p_quantities jsonb,
    p_identification_method text,
    p_scanned_code text,
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
    v_started_at timestamptz;
    v_loc_id uuid;
    v_variant_id integer;
    v_phys numeric(14,3);
    v_avail numeric(14,3); v_dam numeric(14,3); v_exp numeric(14,3);
    v_blk numeric(14,3); v_oth numeric(14,3);
    v_ident text; v_scanned text; v_csource text; v_devid text;
    v_cap timestamptz; v_serv timestamptz;
    v_entry_id uuid;
    v_payload jsonb; v_resp jsonb;
    v_keys text[];
    v_qk text[] := ARRAY['available_quantity','blocked_quantity','damaged_quantity','expired_quantity','other_unavailable_quantity'];
    v_k text; v_val numeric; v_kc integer; v_cnt bigint;
    v_task_comp text; v_task_ca timestamptz; v_task_cb uuid; v_task_ve uuid; v_task_va timestamptz; v_task_vb uuid;
    v_sess text;
BEGIN
    IF p_company_id IS NULL OR p_recount_request_id IS NULL OR p_expected_status IS NULL
       OR p_quantities IS NULL OR p_identification_method IS NULL OR p_capture_source IS NULL
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF upper(btrim(p_expected_status)) <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_csource := upper(btrim(p_capture_source));
    IF v_csource NOT IN ('MOBILE','WEB') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_ident := btrim(p_identification_method);
    IF v_ident = '' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text; END IF;
    IF p_scanned_code IS NOT NULL THEN v_scanned := btrim(p_scanned_code); IF v_scanned = '' THEN v_scanned := NULL; END IF; END IF;
    IF p_device_id IS NOT NULL THEN v_devid := btrim(p_device_id); IF v_devid = '' THEN v_devid := NULL; END IF; END IF;
    IF v_csource = 'MOBILE' THEN
        IF p_offline_id IS NULL OR v_devid IS NULL OR p_captured_at IS NULL OR p_idempotency_key IS DISTINCT FROM p_offline_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
        END IF;
    END IF;
    IF jsonb_typeof(p_quantities) <> 'object' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text; END IF;
    v_keys := ARRAY(SELECT jsonb_object_keys(p_quantities) ORDER BY 1);
    v_kc := array_length(v_keys, 1);
    IF v_kc IS DISTINCT FROM 5 OR v_keys <> v_qk THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text; END IF;
    FOREACH v_k IN ARRAY v_qk LOOP
        IF jsonb_typeof(p_quantities -> v_k) <> 'number' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text; END IF;
        v_val := (p_quantities ->> v_k)::numeric;
        IF v_val < 0 OR v_val > 99999999999.999 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text; END IF;
        CASE v_k WHEN 'available_quantity' THEN v_avail := v_val; WHEN 'damaged_quantity' THEN v_dam := v_val; WHEN 'expired_quantity' THEN v_exp := v_val; WHEN 'blocked_quantity' THEN v_blk := v_val; WHEN 'other_unavailable_quantity' THEN v_oth := v_val; END CASE;
    END LOOP;
    v_phys := v_avail + v_dam + v_exp + v_blk + v_oth;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.recounts.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.record_inventory_recount.idempotency'), hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    IF p_offline_id IS NOT NULL THEN
        SELECT count(*) INTO v_cnt FROM inventarios.count_entries ce WHERE ce.company_id = p_company_id AND ce.offline_id = p_offline_id;
        IF v_cnt > 0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_OFFLINE_CAPTURE_CONFLICT', DETAIL=jsonb_build_object('message','La captura offline ya fue registrada.','retryable',false)::text; END IF;
    END IF;
    v_payload := jsonb_build_object('operation','inventarios.recount.record','company_id',p_company_id,'recount_request_id',p_recount_request_id,'expected_status','IN_PROGRESS','quantities',p_quantities,'identification_method',v_ident,'scanned_code',v_scanned,'capture_source',v_csource,'offline_id',p_offline_id,'device_id',v_devid,'captured_at',p_captured_at);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.recount.record',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.record_inventory_recount'), hashtext(p_company_id::text || ':' || p_recount_request_id::text));
    SELECT rr.session_id, rr.snapshot_id, rr.session_zone_id, rr.snapshot_product_id,
           rr.source_task_id, rr.cycle_number, rr.assigned_participant_id, rr.assigned_user_id,
           rr.started_at
    INTO v_session_id, v_snapshot_id, v_zone_id, v_prod_id,
         v_task_id, v_cycle, v_app_id, v_auser_id, v_started_at
    FROM inventarios.recount_requests rr WHERE rr.company_id = p_company_id AND rr.id = p_recount_request_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_session_id IS NULL OR v_snapshot_id IS NULL OR v_zone_id IS NULL OR v_prod_id IS NULL
       OR v_task_id IS NULL OR v_cycle IS NULL OR v_cycle < 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;
    IF v_app_id IS NULL OR v_auser_id IS NULL OR v_started_at IS NULL THEN
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
    SELECT sp.bsale_variant_id INTO v_variant_id FROM inventarios.snapshot_products sp
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id AND sp.id = v_prod_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    SELECT szl.snapshot_location_id INTO v_loc_id FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id AND szl.session_id = v_session_id
      AND szl.snapshot_id = v_snapshot_id AND szl.session_zone_id = v_zone_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    v_serv := now();
    v_cap := COALESCE(p_captured_at, v_serv);
    IF v_cap < v_started_at THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text; END IF;
    INSERT INTO inventarios.count_entries (company_id,session_id,snapshot_id,session_zone_id,task_id,task_cycle,session_participant_id,counted_by,snapshot_product_id,snapshot_location_id,bsale_variant_id,identification_method,scanned_code,capture_source,offline_id,device_id,captured_at,server_received_at,synced_at,synced_by,physical_quantity,available_quantity,damaged_quantity,expired_quantity,blocked_quantity,other_unavailable_quantity,recount_request_id,created_by)
    VALUES (p_company_id,v_session_id,v_snapshot_id,v_zone_id,v_task_id,v_cycle,v_app_id,v_actor_id,v_prod_id,v_loc_id,v_variant_id,v_ident,v_scanned,v_csource,p_offline_id,v_devid,v_cap,v_serv,v_serv,v_actor_id,v_phys,v_avail,v_dam,v_exp,v_blk,v_oth,p_recount_request_id,v_actor_id)
    RETURNING id INTO v_entry_id;
    v_resp := jsonb_build_object('operation','inventarios.recount.record','entity_id',v_entry_id,'state',NULL::text,'version',NULL::integer,'cycle_number',v_cycle,'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_cap,'data',jsonb_build_object('recount_request_id',p_recount_request_id,'session_id',v_session_id,'session_zone_id',v_zone_id,'snapshot_product_id',v_prod_id,'source_task_id',v_task_id,'assigned_participant_id',v_app_id,'identification_method',v_ident,'scanned_code',v_scanned,'capture_source',v_csource,'offline_id',p_offline_id,'device_id',v_devid,'captured_at',v_cap,'server_received_at',v_serv,'available_quantity',v_avail,'damaged_quantity',v_dam,'expired_quantity',v_exp,'blocked_quantity',v_blk,'other_unavailable_quantity',v_oth,'physical_quantity',v_phys));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_entry_id, v_resp);
END;
$$;
ALTER FUNCTION inventarios.record_inventory_recount(uuid, uuid, text, jsonb, text, text, text, uuid, text, timestamptz, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.record_inventory_recount(uuid, uuid, text, jsonb, text, text, text, uuid, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated, service_role;
