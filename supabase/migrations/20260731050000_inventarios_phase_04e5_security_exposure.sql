DO $$ BEGIN
    PERFORM 1 FROM portal.permissions WHERE code = 'inventarios.sessions.approve';
    IF NOT FOUND THEN RAISE EXCEPTION 'INVENTORY_4E5_PERMISSION_MISSING'; END IF;
END $$;

REVOKE ALL ON SCHEMA inventarios FROM PUBLIC, anon, service_role;
GRANT USAGE ON SCHEMA inventarios TO authenticated;
REVOKE CREATE ON SCHEMA inventarios FROM authenticated;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA inventarios FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA inventarios FROM PUBLIC, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios REVOKE ALL ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios REVOKE ALL ON TABLES FROM service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios REVOKE ALL ON SEQUENCES FROM authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios REVOKE ALL ON SEQUENCES FROM service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios REVOKE EXECUTE ON FUNCTIONS FROM authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA inventarios REVOKE EXECUTE ON FUNCTIONS FROM service_role;

-- OPERATIONAL RPCS: grant EXECUTE to authenticated
GRANT EXECUTE ON FUNCTION inventarios.reassign_inventory_task(uuid,uuid,integer,integer,uuid,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.start_inventory_task(uuid,uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.pause_inventory_task(uuid,uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.resume_inventory_task(uuid,uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.complete_inventory_task(uuid,uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.validate_inventory_task(uuid,uuid,integer,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.invalidate_inventory_task(uuid,uuid,integer,integer,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.reopen_inventory_task(uuid,uuid,integer,integer,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.cancel_inventory_task(uuid,uuid,integer,integer,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.record_inventory_count(uuid,uuid,integer,uuid,uuid,jsonb,text,text,text,uuid,text,timestamptz,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.correct_inventory_count(uuid,uuid,uuid,jsonb,text,text,uuid,text,timestamptz,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.invalidate_inventory_count(uuid,uuid,uuid,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.report_inventory_incident(uuid,uuid,integer,text,text,text,numeric,uuid,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.resolve_inventory_incident(uuid,uuid,text,text,uuid,text,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.request_inventory_recount(uuid,uuid,integer,uuid,uuid,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.assign_inventory_recount(uuid,uuid,text,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.start_inventory_recount(uuid,uuid,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.record_inventory_recount(uuid,uuid,text,jsonb,text,text,text,uuid,text,timestamptz,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.complete_inventory_recount(uuid,uuid,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.cancel_inventory_recount(uuid,uuid,text,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.decide_inventory_recount(uuid,uuid,text,uuid,text,numeric,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.approve_inventory_session(uuid,uuid,uuid) TO authenticated;

-- INTERNAL HELPERS: affirm revokes
REVOKE ALL PRIVILEGES ON FUNCTION inventarios.require_actor() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL PRIVILEGES ON FUNCTION inventarios.require_company_access(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL PRIVILEGES ON FUNCTION inventarios.require_permission(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL PRIVILEGES ON FUNCTION inventarios.require_session_participant(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL PRIVILEGES ON FUNCTION inventarios.compute_request_hash(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL PRIVILEGES ON FUNCTION inventarios.begin_idempotent_operation(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL PRIVILEGES ON FUNCTION inventarios.complete_idempotent_operation(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL PRIVILEGES ON FUNCTION inventarios.get_effective_count_entries(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL PRIVILEGES ON FUNCTION inventarios.get_applicable_recount_decisions(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL PRIVILEGES ON FUNCTION inventarios.get_effective_task_contributions(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
