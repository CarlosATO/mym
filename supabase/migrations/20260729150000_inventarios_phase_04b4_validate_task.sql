CREATE FUNCTION inventarios.validate_inventory_task(p_company_id uuid,p_task_id uuid,p_expected_version integer,p_expected_cycle integer,p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog PARALLEL UNSAFE AS $$
DECLARE a uuid;o jsonb;oi uuid;s uuid;z uuid;st text;v integer;c integer;cv uuid;ve uuid;at timestamptz;payload jsonb;response jsonb;ev_company uuid;ev_session uuid;ev_zone uuid;ev_task uuid;ev_cycle integer;ev_type text;
BEGIN
 IF p_company_id IS NULL OR p_task_id IS NULL OR p_expected_version IS NULL OR p_expected_version<1 OR p_expected_cycle IS NULL OR p_expected_cycle<1 OR p_idempotency_key IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INV_INVALID_REQUEST_PAYLOAD',DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text; END IF;
 a:=inventarios.require_permission(p_company_id,'inventarios.tasks.validate');
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('inventarios.validate_inventory_task'),pg_catalog.hashtext(p_company_id::text||':'||p_task_id::text));
 payload:=pg_catalog.jsonb_build_object('operation','inventarios.task.validate','company_id',p_company_id,'task_id',p_task_id,'expected_version',p_expected_version,'expected_cycle',p_expected_cycle);
 o:=inventarios.begin_idempotent_operation(p_company_id,'inventarios.task.validate',p_idempotency_key,inventarios.compute_request_hash(payload));
 IF o->>'mode'='REPLAY' THEN RETURN o->'response_payload'; END IF; oi:=(o->>'operation_id')::uuid;
 SELECT t.session_id,t.session_zone_id,t.status,t.version,t.validation_cycle,t.current_validation_event_id INTO s,z,st,v,c,cv FROM inventarios.tasks t WHERE t.company_id=p_company_id AND t.id=p_task_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INV_NOT_FOUND',DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
 IF st<>'COMPLETED' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INV_TASK_INVALID_STATE',DETAIL=pg_catalog.jsonb_build_object('message','La tarea no permite esta operacion en su estado actual.','retryable',false)::text; END IF;
 IF v<>p_expected_version OR c<>p_expected_cycle THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INV_CONCURRENT_MODIFICATION',DETAIL=pg_catalog.jsonb_build_object('message','La tarea fue modificada por otra operacion.','retryable',true)::text; END IF;
 PERFORM inventarios.require_session_participant(p_company_id,s,'SUPERVISOR');
 IF cv IS NOT NULL THEN SELECT e.company_id,e.session_id,e.session_zone_id,e.task_id,e.cycle,e.event_type INTO ev_company,ev_session,ev_zone,ev_task,ev_cycle,ev_type FROM inventarios.task_events e WHERE e.id=cv; IF NOT FOUND OR ev_company<>p_company_id OR ev_session<>s OR ev_zone<>z OR ev_task<>p_task_id OR ev_cycle<>c OR ev_type<>'VALIDATED' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INV_CONCURRENT_MODIFICATION',DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text; END IF; RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INV_OPERATION_ALREADY_APPLIED',DETAIL=pg_catalog.jsonb_build_object('message','La operacion ya fue finalizada.','retryable',false)::text; END IF;
 at:=pg_catalog.now();
 INSERT INTO inventarios.task_events(company_id,session_id,session_zone_id,task_id,event_type,actor_id,cycle,occurred_at,idempotency_key,created_by) VALUES(p_company_id,s,z,p_task_id,'VALIDATED',a,c,at,p_idempotency_key,a) RETURNING id INTO ve;
 UPDATE inventarios.tasks t SET current_validation_event_id=ve,validated_at=at,validated_by=a,version=t.version+1,updated_at=at,updated_by=a WHERE t.company_id=p_company_id AND t.id=p_task_id;
 response:=pg_catalog.jsonb_build_object('operation','inventarios.task.validate','entity_id',p_task_id,'state','COMPLETED','version',v+1,'cycle_number',c,'assignment_id',NULL::uuid,'event_id',ve,'replayed',false,'occurred_at',at,'data',pg_catalog.jsonb_build_object());
 RETURN inventarios.complete_idempotent_operation(p_company_id,oi,p_task_id,response);
END;$$;
ALTER FUNCTION inventarios.validate_inventory_task(uuid,uuid,integer,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.validate_inventory_task(uuid,uuid,integer,integer,uuid) FROM PUBLIC,anon,authenticated,service_role;
