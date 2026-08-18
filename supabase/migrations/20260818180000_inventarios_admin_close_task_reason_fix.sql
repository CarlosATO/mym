-- Fix the administrative campaign close contract against the actual task model.
-- Task cancellation reasons belong to task_events.reason; tasks stores only the
-- current cancellation state and actor/timestamp.
-- Schema affected exclusively: inventarios.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
    v_old text := $$                cancelled_by = v_actor_id,
                cancellation_reason = 'CIERRE_ADMIN_GLOBAL_NO_CONTADA',
                active_user_id = NULL,$$;
    v_new text := $$                cancelled_by = v_actor_id,
                active_user_id = NULL,$$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.admin_close_inventory_campaign(uuid,uuid,text,uuid,boolean)'::regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION 'admin close task cancellation assignment not found';
    END IF;
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
    EXECUTE v_definition;
END;
$migration$;

ALTER FUNCTION inventarios.admin_close_inventory_campaign(uuid, uuid, text, uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.admin_close_inventory_campaign(uuid, uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.admin_close_inventory_campaign(uuid, uuid, text, uuid, boolean) TO authenticated, service_role;

COMMIT;
