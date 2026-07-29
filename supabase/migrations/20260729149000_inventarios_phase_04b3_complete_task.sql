CREATE FUNCTION inventarios.complete_inventory_task(
    p_company_id uuid, p_task_id uuid, p_expected_version integer, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
PARALLEL UNSAFE
AS $$
DECLARE
    a uuid; p uuid; o jsonb; oi uuid; s uuid; z uuid; st text; v integer; c integer; ca uuid;
    ac bigint; ai uuid; au uuid; ap uuid; at timestamptz; payload jsonb; response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_task_id IS NULL OR p_expected_version IS NULL OR p_expected_version <= 0 OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD', DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    a := inventarios.require_permission(p_company_id, 'inventarios.tasks.execute');
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.complete_inventory_task'), pg_catalog.hashtext(p_company_id::text || ':' || a::text));
    payload := pg_catalog.jsonb_build_object('operation','inventarios.task.complete','company_id',p_company_id,'task_id',p_task_id,'expected_version',p_expected_version);
    o := inventarios.begin_idempotent_operation(p_company_id,'inventarios.task.complete',p_idempotency_key,inventarios.compute_request_hash(payload));
    IF o ->> 'mode' = 'REPLAY' THEN RETURN o -> 'response_payload'; END IF;
    oi := (o ->> 'operation_id')::uuid;
    SELECT t.session_id,t.session_zone_id,t.status,t.version,t.validation_cycle,t.current_assignment_id INTO s,z,st,v,c,ca FROM inventarios.tasks t WHERE t.company_id=p_company_id AND t.id=p_task_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF st <> 'IN_PROGRESS' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_TASK_INVALID_STATE', DETAIL=pg_catalog.jsonb_build_object('message','La tarea no permite esta operacion en su estado actual.','retryable',false)::text; END IF;
    IF v <> p_expected_version THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=pg_catalog.jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text; END IF;
    p := inventarios.require_session_participant(p_company_id,s,'COUNTER');
    SELECT pg_catalog.count(*),(pg_catalog.array_agg(ta.id ORDER BY ta.id))[1],(pg_catalog.array_agg(ta.user_id ORDER BY ta.id))[1],(pg_catalog.array_agg(ta.session_participant_id ORDER BY ta.id))[1] INTO ac,ai,au,ap FROM inventarios.task_assignments ta WHERE ta.company_id=p_company_id AND ta.session_id=s AND ta.task_id=p_task_id AND ta.released_at IS NULL;
    IF ac=0 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND', DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF ac>1 THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION', DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF;
    IF ca IS DISTINCT FROM ai OR au IS DISTINCT FROM a OR ap IS DISTINCT FROM p THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ASSIGNMENT_REQUIRED', DETAIL=pg_catalog.jsonb_build_object('message','No tienes una asignacion vigente para esta tarea.','retryable',false)::text; END IF;
    at := pg_catalog.now();
    UPDATE inventarios.tasks t SET status='COMPLETED',version=t.version+1,completed_at=at,completed_by=a,active_user_id=NULL,updated_at=at,updated_by=a WHERE t.company_id=p_company_id AND t.id=p_task_id;
    INSERT INTO inventarios.task_state_transitions(company_id,session_id,session_zone_id,task_id,assignment_id,operation_idempotency_id,transition_type,previous_status,next_status,previous_version,next_version,previous_cycle,next_cycle,actor_id,occurred_at)
    VALUES(p_company_id,s,z,p_task_id,ai,oi,'COMPLETED','IN_PROGRESS','COMPLETED',v,v+1,c,c,a,at);
    response := pg_catalog.jsonb_build_object('operation','inventarios.task.complete','entity_id',p_task_id,'state','COMPLETED','version',v+1,'cycle_number',c,'assignment_id',ai,'event_id',NULL::uuid,'replayed',false,'occurred_at',at,'data',pg_catalog.jsonb_build_object());
    RETURN inventarios.complete_idempotent_operation(p_company_id,oi,p_task_id,response);
END;
$$;

ALTER FUNCTION inventarios.complete_inventory_task(uuid,uuid,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.complete_inventory_task(uuid,uuid,integer,uuid)
FROM PUBLIC, anon, authenticated, service_role;
