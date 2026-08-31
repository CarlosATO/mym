-- Restrict self-service profile updates to personal fields only.
REVOKE UPDATE ON portal.users FROM authenticated;
GRANT UPDATE (nombre, apellido, telefono) ON portal.users TO authenticated;

-- Keep the forced-password completion path controlled without exposing the
-- security flag to direct authenticated table updates.
DROP FUNCTION IF EXISTS portal.complete_forced_password_change();

CREATE OR REPLACE FUNCTION portal.complete_forced_password_change(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, portal
AS $$
BEGIN
    UPDATE portal.users
    SET must_change_password = false
    WHERE id = p_user_id
      AND is_active = true
      AND deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROFILE_NOT_FOUND_OR_INACTIVE';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION portal.complete_forced_password_change(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal.complete_forced_password_change(uuid) TO service_role;
