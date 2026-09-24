-- Record the production hardening for the finance API database helpers.
-- The custom runtime role is optional in local and preview environments.

ALTER FUNCTION core.has_company_access(uuid, uuid)
    SET search_path = pg_catalog;

REVOKE EXECUTE ON FUNCTION core.has_company_access(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.has_permission_for_company(uuid, uuid, text) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'petgroup_backend_runtime') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA core TO petgroup_backend_runtime';
        EXECUTE 'GRANT EXECUTE ON FUNCTION core.has_company_access(uuid, uuid) TO petgroup_backend_runtime';
        EXECUTE 'GRANT EXECUTE ON FUNCTION core.has_permission_for_company(uuid, uuid, text) TO petgroup_backend_runtime';
    END IF;
END
$$;
