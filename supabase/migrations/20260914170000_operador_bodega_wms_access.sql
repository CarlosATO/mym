-- Allow OPERADOR_BODEGA to enter the WMS container without granting any
-- functional WMS capability.
DO $$
DECLARE
  v_role_id uuid;
  v_permission_id uuid;
BEGIN
  SELECT id INTO v_role_id
  FROM portal.roles
  WHERE name = 'OPERADOR_BODEGA' AND is_active = true;

  SELECT id INTO v_permission_id
  FROM portal.permissions
  WHERE code = 'module.logistica.view' AND is_active = true;

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'OPERADOR_BODEGA_ROLE_MISSING';
  END IF;
  IF v_permission_id IS NULL THEN
    RAISE EXCEPTION 'MODULE_LOGISTICA_VIEW_PERMISSION_MISSING';
  END IF;

  INSERT INTO portal.role_permissions (role_id, permission_id)
  VALUES (v_role_id, v_permission_id)
  ON CONFLICT (role_id, permission_id) DO NOTHING;
END;
$$;
