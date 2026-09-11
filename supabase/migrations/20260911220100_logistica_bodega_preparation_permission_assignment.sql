-- Assign Order Preparation management only to the two authorized WMS roles.
DO $$
DECLARE
  v_permission_id uuid;
  v_super_role_id uuid;
  v_bodeguero_role_id uuid;
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM portal.permissions
  WHERE code = 'logistica.preparation.manage';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'LOGISTICA_PREPARATION_PERMISSION_MISSING: logistica.preparation.manage';
  END IF;

  SELECT id INTO v_permission_id
  FROM portal.permissions
  WHERE code = 'logistica.preparation.manage'
    AND is_active = true;

  IF v_permission_id IS NULL THEN
    RAISE EXCEPTION 'LOGISTICA_PREPARATION_PERMISSION_INACTIVE: logistica.preparation.manage';
  END IF;

  SELECT count(*) INTO v_count
  FROM portal.roles
  WHERE name = 'SUPER_USUARIO';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'LOGISTICA_PREPARATION_ROLE_MISSING: SUPER_USUARIO';
  END IF;

  SELECT id INTO v_super_role_id
  FROM portal.roles
  WHERE name = 'SUPER_USUARIO'
    AND is_active = true;

  IF v_super_role_id IS NULL THEN
    RAISE EXCEPTION 'LOGISTICA_PREPARATION_ROLE_INACTIVE: SUPER_USUARIO';
  END IF;

  SELECT count(*) INTO v_count
  FROM portal.roles
  WHERE name = 'LOGISTICA_BODEGUERO';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'LOGISTICA_PREPARATION_ROLE_MISSING: LOGISTICA_BODEGUERO';
  END IF;

  SELECT id INTO v_bodeguero_role_id
  FROM portal.roles
  WHERE name = 'LOGISTICA_BODEGUERO'
    AND is_active = true;

  IF v_bodeguero_role_id IS NULL THEN
    RAISE EXCEPTION 'LOGISTICA_PREPARATION_ROLE_INACTIVE: LOGISTICA_BODEGUERO';
  END IF;

  INSERT INTO portal.role_permissions (role_id, permission_id)
  VALUES
    (v_super_role_id, v_permission_id),
    (v_bodeguero_role_id, v_permission_id)
  ON CONFLICT (role_id, permission_id) DO NOTHING;

  SELECT count(*) INTO v_count
  FROM portal.role_permissions rp
  WHERE rp.permission_id = v_permission_id
    AND rp.role_id IN (v_super_role_id, v_bodeguero_role_id);

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'LOGISTICA_PREPARATION_ASSIGNMENT_INVALID: expected 2 authorized role assignments, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM portal.role_permissions rp
  JOIN portal.roles r ON r.id = rp.role_id
  WHERE rp.permission_id = v_permission_id
    AND r.name NOT IN ('SUPER_USUARIO', 'LOGISTICA_BODEGUERO');

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'LOGISTICA_PREPARATION_UNAUTHORIZED_ASSIGNMENT: found % unauthorized role assignments', v_count;
  END IF;
END $$;
