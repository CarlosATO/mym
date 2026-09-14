-- Keep the global role and selected company roles synchronized, with an
-- explicit audit record because this function is called through service_role.
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
  v_old_user jsonb;
  v_old_access jsonb;
BEGIN
  SELECT r.name INTO v_role_name
  FROM portal.roles r
  WHERE r.id = p_role_id AND r.is_active = true;
  IF v_role_name IS NULL THEN RAISE EXCEPTION 'USER_ROLE_INVALID'; END IF;

  SELECT jsonb_build_object('role_id', u.role_id, 'nombre', u.nombre,
                            'apellido', u.apellido, 'is_active', u.is_active),
         u.role_id
    INTO v_old_user, v_current_role_id
  FROM portal.users u
  WHERE u.id = p_user_id;
  IF v_current_role_id IS NULL THEN RAISE EXCEPTION 'USER_PROFILE_NOT_FOUND'; END IF;

  SELECT count(*) INTO v_active_company_count
  FROM core.user_company_access uca
  WHERE uca.user_id = p_user_id AND uca.is_active = true;
  IF v_active_company_count > 1 AND v_current_role_id IS DISTINCT FROM p_role_id THEN
    RAISE EXCEPTION 'USER_ROLE_COMPANY_AMBIGUOUS';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'company_id', uca.company_id, 'role', uca.role,
    'is_default', uca.is_default) ORDER BY uca.created_at), '[]'::jsonb)
    INTO v_old_access
  FROM core.user_company_access uca
  WHERE uca.user_id = p_user_id AND uca.is_active = true;

  UPDATE portal.users
  SET nombre = p_nombre, apellido = p_apellido,
      role_id = p_role_id, is_active = p_is_active
  WHERE id = p_user_id;

  UPDATE core.user_company_access
  SET role = v_role_name
  WHERE user_id = p_user_id AND is_active = true
    AND company_id = ANY(p_company_ids);

  UPDATE core.user_company_access
  SET is_active = false
  WHERE user_id = p_user_id AND is_active = true
    AND NOT (company_id = ANY(p_company_ids));

  INSERT INTO core.user_company_access (user_id, company_id, role, is_default, is_active, created_by)
  SELECT p_user_id, selected.company_id, v_role_name,
         row_number() OVER (ORDER BY selected.ordinality) = 1, true, p_updated_by
  FROM unnest(p_company_ids) WITH ORDINALITY AS selected(company_id, ordinality)
  WHERE NOT EXISTS (
    SELECT 1 FROM core.user_company_access uca
    WHERE uca.user_id = p_user_id AND uca.company_id = selected.company_id
      AND uca.is_active = true
  );

  INSERT INTO portal.audit_logs (table_name, record_id, action, old_data, new_data, performed_by)
  VALUES (
    'users_company_role', p_user_id, 'ROLE_SYNC',
    jsonb_build_object('user', v_old_user, 'company_access', v_old_access),
    jsonb_build_object('role_id', p_role_id, 'role', v_role_name,
                       'company_ids', to_jsonb(p_company_ids), 'is_active', p_is_active),
    p_updated_by
  );
END;
$$;

ALTER FUNCTION portal.sync_user_role_company_access(uuid, uuid, uuid[], boolean, text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION portal.sync_user_role_company_access(uuid, uuid, uuid[], boolean, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION portal.sync_user_role_company_access(uuid, uuid, uuid[], boolean, text, text, uuid) TO service_role;
