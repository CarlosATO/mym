-- Satisfy the existing task_events reason guard for OPENED_BY_MISTAKE.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios._resolve_my_counting_location(uuid,uuid,text,text,uuid)'::regprocedure
    ) INTO v_definition;
    v_definition := pg_catalog.replace(
        v_definition,
        'company_id,session_id,session_zone_id,task_id,event_type,actor_id,cycle,',
        'company_id,session_id,session_zone_id,task_id,event_type,reason,actor_id,cycle,'
    );
    v_definition := pg_catalog.replace(
        v_definition,
        'CASE WHEN p_resolution_status=''EMPTY_REVIEWED'' THEN ''LOCATION_CLOSED'' ELSE ''CANCELLED'' END,
        v_actor_id,v_task_cycle,',
        'CASE WHEN p_resolution_status=''EMPTY_REVIEWED'' THEN ''LOCATION_CLOSED'' ELSE ''CANCELLED'' END,
        pg_catalog.btrim(coalesce(p_reason,p_resolution_status)),v_actor_id,v_task_cycle,'
    );
    EXECUTE v_definition;
END;
$migration$;

COMMIT;
