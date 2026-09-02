-- The access table has no updated_by column. Recreate the atomic function with
-- the actual schema while preserving the public contract.
CREATE OR REPLACE FUNCTION portal.sync_user_role_company_access(
  p_user_id uuid,
  p_role_id uuid,
  p_company_ids uuid[],
  p_is_active boolean,
  p_nombre text,
  p_apellido text,
  p_updated_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_role_name text;
  v_current_role_id uuid;
  v_active_company_count integer;
BEGIN
  SELECT r.name INTO v_role_name
  FROM portal.roles r
  WHERE r.id = p_role_id AND r.is_active = true;

  IF v_role_name IS NULL THEN RAISE EXCEPTION 'USER_ROLE_INVALID'; END IF;

  SELECT u.role_id INTO v_current_role_id
  FROM portal.users u
  WHERE u.id = p_user_id;

  IF v_current_role_id IS NULL THEN RAISE EXCEPTION 'USER_PROFILE_NOT_FOUND'; END IF;

  SELECT count(*) INTO v_active_company_count
  FROM core.user_company_access uca
  WHERE uca.user_id = p_user_id AND uca.is_active = true;

  IF v_active_company_count > 1 AND v_current_role_id IS DISTINCT FROM p_role_id THEN
    RAISE EXCEPTION 'USER_ROLE_COMPANY_AMBIGUOUS';
  END IF;

  UPDATE portal.users
  SET nombre = p_nombre, apellido = p_apellido,
      role_id = p_role_id, is_active = p_is_active
  WHERE id = p_user_id;

  UPDATE core.user_company_access
  SET role = v_role_name
  WHERE user_id = p_user_id
    AND is_active = true
    AND company_id = ANY(p_company_ids);

  UPDATE core.user_company_access
  SET is_active = false
  WHERE user_id = p_user_id
    AND is_active = true
    AND NOT (company_id = ANY(p_company_ids));

  INSERT INTO core.user_company_access (
    user_id, company_id, role, is_default, is_active, created_by
  )
  SELECT p_user_id, company_id, v_role_name,
         row_number() OVER (ORDER BY ordinality) = 1,
         true, p_updated_by
  FROM unnest(p_company_ids) WITH ORDINALITY AS selected(company_id, ordinality)
  WHERE NOT EXISTS (
    SELECT 1 FROM core.user_company_access uca
    WHERE uca.user_id = p_user_id
      AND uca.company_id = selected.company_id
      AND uca.is_active = true
  );
END;
$$;

ALTER FUNCTION portal.sync_user_role_company_access(uuid, uuid, uuid[], boolean, text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION portal.sync_user_role_company_access(uuid, uuid, uuid[], boolean, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION portal.sync_user_role_company_access(uuid, uuid, uuid[], boolean, text, text, uuid) TO service_role;
