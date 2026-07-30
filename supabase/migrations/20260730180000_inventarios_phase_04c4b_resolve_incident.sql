CREATE OR REPLACE FUNCTION inventarios.resolve_inventory_incident(
    p_company_id uuid,
    p_incident_id uuid,
    p_next_status text,
    p_expected_current_status text,
    p_expected_current_resolution_id uuid,
    p_resolution_type text,
    p_description text,
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
    v_expected_status text;
    v_next_status text;
    v_description text;
    v_res_type text;
    v_inc_session_id uuid;
    v_inc_task_id uuid;
    v_inc_status text;
    v_inc_severity text;
    v_inc_blocking boolean;
    v_inc_resp_user uuid;
    v_cur_res_id uuid;
    v_cur_next_status text;
    v_task_status text;
    v_task_cancelled_at timestamptz;
    v_task_cancelled_by uuid;
    v_task_ve uuid;
    v_task_va timestamptz;
    v_task_vb uuid;
    v_task_vc integer;
    v_sess_status text;
    v_resolved_at timestamptz;
    v_resolution_id uuid;
    v_payload jsonb;
    v_resp jsonb;
BEGIN
    IF p_company_id IS NULL OR p_incident_id IS NULL OR p_next_status IS NULL
       OR p_expected_current_status IS NULL OR p_description IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_expected_status := upper(btrim(p_expected_current_status));
    v_next_status := upper(btrim(p_next_status));
    IF v_expected_status NOT IN ('OPEN','UNDER_REVIEW','RESOLVED') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF v_next_status NOT IN ('UNDER_REVIEW','RESOLVED','CLOSED') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF v_next_status = v_expected_status THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INCIDENT_INVALID_STATE', DETAIL=jsonb_build_object('message','El incidente no permite esta transicion.','retryable',false)::text;
    END IF;
    IF v_expected_status = 'OPEN' AND v_next_status NOT IN ('UNDER_REVIEW','RESOLVED') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INCIDENT_INVALID_STATE', DETAIL=jsonb_build_object('message','El incidente no permite esta transicion.','retryable',false)::text;
    END IF;
    IF v_expected_status = 'UNDER_REVIEW' AND v_next_status <> 'RESOLVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INCIDENT_INVALID_STATE', DETAIL=jsonb_build_object('message','El incidente no permite esta transicion.','retryable',false)::text;
    END IF;
    IF v_expected_status = 'RESOLVED' AND v_next_status <> 'CLOSED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INCIDENT_INVALID_STATE', DETAIL=jsonb_build_object('message','El incidente no permite esta transicion.','retryable',false)::text;
    END IF;
    IF v_expected_status = 'OPEN' AND p_expected_current_resolution_id IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF v_expected_status IN ('UNDER_REVIEW','RESOLVED') AND p_expected_current_resolution_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF v_next_status = 'UNDER_REVIEW' THEN
        v_res_type := 'REVIEW_STARTED';
    ELSIF v_next_status = 'CLOSED' THEN
        v_res_type := 'CLOSURE_CONFIRMED';
    ELSIF v_next_status = 'RESOLVED' THEN
        IF p_resolution_type IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text; END IF;
        v_res_type := upper(btrim(p_resolution_type));
        IF v_res_type NOT IN ('COUNT_CORRECTED','COUNT_INVALIDATED','RECOUNT_REQUESTED','PRODUCT_IDENTIFIED','LOCATION_CONFIRMED','DISMISSED','NO_ACTION_REQUIRED','OTHER') THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
        END IF;
    END IF;
    v_description := btrim(p_description);
    IF length(v_description) < 5 OR length(v_description) > 2000 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.incidents.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.resolve_inventory_incident'), hashtext(p_company_id::text || ':' || p_incident_id::text));
    v_payload := jsonb_build_object('operation','inventarios.incident.resolve','company_id',p_company_id,'incident_id',p_incident_id,'expected_current_status',v_expected_status,'expected_current_resolution_id',p_expected_current_resolution_id,'next_status',v_next_status,'resolution_type',v_res_type,'description',v_description);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.incident.resolve',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;
    SELECT i.status, i.severity, i.is_blocking, i.responsible_user_id, i.session_id, i.task_id
    INTO v_inc_status, v_inc_severity, v_inc_blocking, v_inc_resp_user, v_inc_session_id, v_inc_task_id
    FROM inventarios.incidents i WHERE i.company_id = p_company_id AND i.id = p_incident_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_inc_status IS DISTINCT FROM v_expected_status THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true,'current_status',v_inc_status,'current_resolution_id',NULL::uuid)::text;
    END IF;
    SELECT ir.id, ir.next_status INTO v_cur_res_id, v_cur_next_status
    FROM inventarios.incident_resolutions ir
    WHERE ir.company_id = p_company_id AND ir.session_id = v_inc_session_id AND ir.incident_id = p_incident_id AND ir.superseded_at IS NULL FOR UPDATE;
    IF v_expected_status = 'OPEN' AND FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true,'current_status',v_inc_status,'current_resolution_id',v_cur_res_id)::text;
    END IF;
    IF v_expected_status IN ('UNDER_REVIEW','RESOLVED') THEN
        IF NOT FOUND OR v_cur_res_id IS DISTINCT FROM p_expected_current_resolution_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true,'current_status',v_inc_status,'current_resolution_id',COALESCE(v_cur_res_id,NULL::uuid))::text;
        END IF;
        IF v_cur_next_status IS DISTINCT FROM v_inc_status THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
        END IF;
    END IF;
    IF v_inc_task_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    SELECT t.status, t.cancelled_at, t.cancelled_by, t.validation_cycle,
           t.current_validation_event_id, t.validated_at, t.validated_by
    INTO v_task_status, v_task_cancelled_at, v_task_cancelled_by, v_task_vc,
         v_task_ve, v_task_va, v_task_vb
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.id = v_inc_task_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_task_cancelled_at IS NOT NULL OR v_task_cancelled_by IS NOT NULL THEN
        IF v_task_cancelled_at IS NULL OR v_task_cancelled_by IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text; END IF;
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_ALREADY_CANCELLED', DETAIL=jsonb_build_object('message','La tarea ya fue cancelada.','retryable',false)::text;
    END IF;
    SELECT s.status INTO v_sess_status FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = v_inc_session_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF v_task_status <> 'COMPLETED' OR v_sess_status <> 'UNDER_REVIEW'
       OR v_task_ve IS NOT NULL OR v_task_va IS NOT NULL OR v_task_vb IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE', DETAIL=jsonb_build_object('message','La tarea no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    PERFORM inventarios.require_session_participant(p_company_id, v_inc_session_id, 'SUPERVISOR');
    v_resolved_at := now();
    IF v_cur_res_id IS NOT NULL THEN
        UPDATE inventarios.incident_resolutions SET superseded_at = v_resolved_at
        WHERE company_id = p_company_id AND session_id = v_inc_session_id AND incident_id = p_incident_id
          AND id = v_cur_res_id AND superseded_at IS NULL;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    END IF;
    INSERT INTO inventarios.incident_resolutions (company_id,session_id,incident_id,resolution_type,previous_status,next_status,description,resolved_by,resolved_at,supersedes_resolution_id)
    VALUES (p_company_id,v_inc_session_id,p_incident_id,v_res_type,v_inc_status,v_next_status,v_description,v_actor_id,v_resolved_at,v_cur_res_id)
    RETURNING id INTO v_resolution_id;
    UPDATE inventarios.incidents SET status = v_next_status,
        responsible_user_id = CASE WHEN v_inc_status = 'OPEN' AND v_next_status IN ('UNDER_REVIEW','RESOLVED') THEN v_actor_id ELSE v_inc_resp_user END,
        updated_at = v_resolved_at, updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_incident_id AND status = v_inc_status;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    v_resp := jsonb_build_object('operation','inventarios.incident.resolve','entity_id',p_incident_id,'state',v_next_status,'version',NULL::integer,'cycle_number',v_task_vc,'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_resolved_at,'data',jsonb_build_object('resolution_id',v_resolution_id,'previous_status',v_inc_status,'next_status',v_next_status,'resolution_type',v_res_type,'description',v_description,'supersedes_resolution_id',v_cur_res_id,'responsible_user_id',COALESCE(v_actor_id,v_inc_resp_user),'severity',v_inc_severity,'is_blocking',v_inc_blocking));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_incident_id, v_resp);
END;
$$;
ALTER FUNCTION inventarios.resolve_inventory_incident(uuid, uuid, text, text, uuid, text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.resolve_inventory_incident(uuid, uuid, text, text, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
