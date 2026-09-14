-- Create the progressive Mermas-only warehouse operator profile.
-- Company-aware resolution uses the implicit portal role name mapping.

INSERT INTO portal.roles (name, description, is_system, is_active)
VALUES (
  'OPERADOR_BODEGA',
  'Perfil operativo para trabajadores de Bodega. Sus permisos se asignan de forma progresiva según las funciones habilitadas.',
  false,
  true
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    is_active = true;

DO $$
DECLARE
  v_role_id uuid;
  v_missing text;
BEGIN
  SELECT id INTO v_role_id
  FROM portal.roles
  WHERE name = 'OPERADOR_BODEGA' AND is_active = true;

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'OPERADOR_BODEGA_ROLE_MISSING';
  END IF;

  SELECT string_agg(required_permission.code, ', ' ORDER BY required_permission.code)
    INTO v_missing
  FROM (VALUES
    ('logistica.mermas.view'),
    ('logistica.mermas.request.create'),
    ('logistica.mermas.warehouse.view'),
    ('logistica.mermas.internal_sale.create')
  ) AS required_permission(code)
  WHERE NOT EXISTS (
    SELECT 1
    FROM portal.permissions p
    WHERE p.code = required_permission.code AND p.is_active = true
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'OPERADOR_BODEGA_PERMISSION_MISSING: %', v_missing;
  END IF;

  INSERT INTO portal.role_permissions (role_id, permission_id)
  SELECT v_role_id, p.id
  FROM portal.permissions p
  WHERE p.code IN (
    'logistica.mermas.view',
    'logistica.mermas.request.create',
    'logistica.mermas.warehouse.view',
    'logistica.mermas.internal_sale.create'
  )
    AND p.is_active = true
  ON CONFLICT (role_id, permission_id) DO NOTHING;

  -- Keep this profile strictly limited to the approved Mermas surface if it
  -- already existed in a partially configured local environment.
  DELETE FROM portal.role_permissions rp
  USING portal.permissions p
  WHERE rp.role_id = v_role_id
    AND rp.permission_id = p.id
    AND p.code NOT IN (
      'logistica.mermas.view',
      'logistica.mermas.request.create',
      'logistica.mermas.warehouse.view',
      'logistica.mermas.internal_sale.create'
    );
END;
$$;
