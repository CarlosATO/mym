-- Restrict the existing profile-creation RPC to the trusted backend.
-- No row data, roles, or unrelated functions are modified.
REVOKE EXECUTE ON FUNCTION portal.create_user_profile(
  uuid, character varying, character varying, character varying, uuid, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION portal.create_user_profile(
  uuid, character varying, character varying, character varying, uuid, uuid
) TO service_role;

DO $acl_guard$
DECLARE
  target oid := 'portal.create_user_profile(uuid,character varying,character varying,character varying,uuid,uuid)'::regprocedure::oid;
BEGIN
  IF has_function_privilege('anon', target, 'EXECUTE')
    OR has_function_privilege('authenticated', target, 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL guard failed: client roles still have permission';
  END IF;
  IF NOT has_function_privilege('service_role', target, 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL guard failed: backend role lost permission';
  END IF;
END;
$acl_guard$;
