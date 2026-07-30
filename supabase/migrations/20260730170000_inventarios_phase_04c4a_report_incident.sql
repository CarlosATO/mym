CREATE OR REPLACE FUNCTION inventarios.report_inventory_incident(
    p_company_id uuid,
    p_task_id uuid,
    p_expected_cycle integer,
    p_category_code text,
    p_severity text,
    p_description text,
    p_affected_quantity numeric,
    p_snapshot_product_id uuid,
    p_count_entry_id uuid,
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
    v_category text;
    v_severity text;
    v_description text;
    v_is_blocking boolean;
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
    v_count_pid uuid;
    v_reported_at timestamptz;
    v_incident_id uuid;
    v_payload jsonb;
    v_resp jsonb;
    v_aid uuid;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL OR p_expected_cycle IS NULL OR p_expected_cycle < 1
       OR p_category_code IS NULL OR p_severity IS NULL OR p_description IS NULL
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF p_snapshot_product_id IS NOT NULL AND p_count_entry_id IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_category := upper(btrim(p_category_code));
    IF v_category NOT IN ('UNKNOWN_PRODUCT_CODE','EXPECTED_PRODUCT_NOT_FOUND','PRODUCT_LOCATION_MISMATCH','UNKNOWN_LOCATION','DAMAGED_PRODUCT','EXPIRED_PRODUCT','BLOCKED_PRODUCT','QUANTITY_DISCREPANCY','LABEL_OR_BARCODE_ISSUE','OPERATIONAL_ISSUE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_severity := upper(btrim(p_severity));
    IF v_severity NOT IN ('INFORMATIONAL','OPERATIONAL','CRITICAL','BLOCKING') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_is_blocking := (v_severity = 'BLOCKING');
    v_description := btrim(p_description);
    IF length(v_description) < 5 OR length(v_description) > 2000 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF p_affected_quantity IS NOT NULL AND (p_affected_quantity < 0 OR p_affected_quantity > 99999999999.999) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF v_category IN ('EXPECTED_PRODUCT_NOT_FOUND','PRODUCT_LOCATION_MISMATCH','DAMAGED_PRODUCT','EXPIRED_PRODUCT','BLOCKED_PRODUCT','QUANTITY_DISCREPANCY','LABEL_OR_BARCODE_ISSUE')
       AND p_snapshot_product_id IS NULL AND p_count_entry_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.incidents.manage');
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('inventarios.report_inventory_incident'), hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := jsonb_build_object('operation','inventarios.incident.report','company_id',p_company_id,'task_id',p_task_id,'expected_cycle',p_expected_cycle,'category_code',v_category,'severity',v_severity,'description',v_description,'affected_quantity',p_affected_quantity,'snapshot_product_id',p_snapshot_product_id,'count_entry_id',p_count_entry_id);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.incident.report',p_idempotency_key,inventarios.compute_request_hash(v_payload));
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
    IF p_count_entry_id IS NOT NULL THEN
        SELECT ce.snapshot_product_id INTO v_count_pid FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id AND ce.id = p_count_entry_id
          AND ce.session_id = v_session_id AND ce.snapshot_id = v_snapshot_id
          AND ce.session_zone_id = v_session_zone_id AND ce.task_id = p_task_id
          AND ce.task_cycle = p_expected_cycle FOR SHARE;
        IF NOT FOUND OR v_count_pid IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    ELSIF p_snapshot_product_id IS NOT NULL THEN
        PERFORM 1 FROM inventarios.snapshot_products sp
        WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id AND sp.id = p_snapshot_product_id;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    END IF;
    v_reported_at := now();
    INSERT INTO inventarios.incidents (company_id,session_id,snapshot_id,session_zone_id,task_id,count_entry_id,snapshot_product_id,category_code,severity,status,affected_quantity,description,is_blocking,reported_by,reported_at,created_at,created_by,updated_at,updated_by)
    VALUES (p_company_id,v_session_id,v_snapshot_id,v_session_zone_id,p_task_id,p_count_entry_id,COALESCE(v_count_pid,p_snapshot_product_id),v_category,v_severity,'OPEN',p_affected_quantity,v_description,v_is_blocking,v_actor_id,v_reported_at,v_reported_at,v_actor_id,v_reported_at,v_actor_id)
    RETURNING id INTO v_incident_id;
    v_resp := jsonb_build_object('operation','inventarios.incident.report','entity_id',v_incident_id,'state','OPEN','version',NULL::integer,'cycle_number',v_task_cycle,'assignment_id',CASE WHEN v_aid IS NOT NULL THEN v_aid ELSE NULL::uuid END,'event_id',NULL::uuid,'replayed',false,'occurred_at',v_reported_at,'data',jsonb_build_object('category_code',v_category,'severity',v_severity,'description',v_description,'affected_quantity',p_affected_quantity,'snapshot_product_id',COALESCE(v_count_pid,p_snapshot_product_id),'count_entry_id',p_count_entry_id,'is_blocking',v_is_blocking));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_incident_id, v_resp);
END;
$$;
ALTER FUNCTION inventarios.report_inventory_incident(uuid, uuid, integer, text, text, text, numeric, uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.report_inventory_incident(uuid, uuid, integer, text, text, text, numeric, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
