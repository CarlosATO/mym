-- Grant the existing warehouse operator role only the operational route-guide
-- permissions it already needs before the conductor RLS migration is applied.

BEGIN;

DO $$
DECLARE
  v_module_id uuid;
  v_role_id uuid;
BEGIN
  SELECT id INTO v_module_id
  FROM portal.modules
  WHERE code = 'logistica' AND is_active = true;

  IF v_module_id IS NULL THEN
    RAISE EXCEPTION 'Required active module logistica is missing';
  END IF;

  SELECT id INTO v_role_id
  FROM portal.roles
  WHERE name = 'OPERADOR_BODEGA' AND is_active = true;

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Required active role OPERADOR_BODEGA is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM core.user_company_access
    WHERE role = 'OPERADOR_BODEGA' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'No active OPERADOR_BODEGA company assignments found';
  END IF;

  INSERT INTO portal.permissions (code, name, description, module_id)
  VALUES
    ('logistica.route_catalogs.manage', 'Gestionar Catálogos de Ruta', 'Puede gestionar vehículos, rutas y personal', v_module_id),
    ('logistica.route_guides.view', 'Ver Guías de Ruta', 'Puede ver las guías de ruta', v_module_id),
    ('logistica.route_guides.create', 'Crear Guías de Ruta', 'Puede crear nuevas guías de ruta', v_module_id),
    ('logistica.route_guides.dispatch', 'Despachar Guías de Ruta', 'Puede confirmar el despacho de una guía', v_module_id)
  ON CONFLICT (code) DO NOTHING;

  IF (
    SELECT count(*)
    FROM portal.permissions
    WHERE code IN (
      'logistica.route_catalogs.manage',
      'logistica.route_guides.view',
      'logistica.route_guides.create',
      'logistica.route_guides.dispatch'
    )
      AND is_active = true
  ) <> 4 THEN
    RAISE EXCEPTION 'Required route-guide permissions are incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM core.user_company_access uca
    WHERE uca.role = 'OPERADOR_BODEGA'
      AND uca.is_active = true
      AND core.resolve_company_role_id(uca.user_id, uca.company_id) IS DISTINCT FROM v_role_id
  ) THEN
    RAISE EXCEPTION 'OPERADOR_BODEGA does not resolve to the expected portal role';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM core.user_company_access uca
    JOIN portal.user_permissions up ON up.user_id = uca.user_id
    JOIN portal.permissions p ON p.id = up.permission_id
    WHERE uca.role = 'OPERADOR_BODEGA'
      AND uca.is_active = true
      AND p.code IN (
        'logistica.route_catalogs.manage',
        'logistica.route_guides.view',
        'logistica.route_guides.create',
        'logistica.route_guides.dispatch'
      )
      AND up.granted = false
  ) THEN
    RAISE EXCEPTION 'An active OPERADOR_BODEGA user has an explicit denial for a required route permission';
  END IF;

  INSERT INTO portal.role_permissions (role_id, permission_id)
  SELECT v_role_id, p.id
  FROM portal.permissions p
  WHERE p.code IN (
    'logistica.route_catalogs.manage',
    'logistica.route_guides.view',
    'logistica.route_guides.create',
    'logistica.route_guides.dispatch'
  )
    AND p.is_active = true
  ON CONFLICT (role_id, permission_id) DO NOTHING;

  IF EXISTS (
    SELECT 1
    FROM core.user_company_access uca
    WHERE uca.role = 'OPERADOR_BODEGA'
      AND uca.is_active = true
      AND (
        NOT core.has_permission_for_company(uca.user_id, uca.company_id, 'logistica.route_catalogs.manage')
        OR NOT core.has_permission_for_company(uca.user_id, uca.company_id, 'logistica.route_guides.view')
        OR NOT core.has_permission_for_company(uca.user_id, uca.company_id, 'logistica.route_guides.create')
        OR NOT core.has_permission_for_company(uca.user_id, uca.company_id, 'logistica.route_guides.dispatch')
      )
  ) THEN
    RAISE EXCEPTION 'Required route-guide permissions are not effective for every active OPERADOR_BODEGA user';
  END IF;
END;
$$;

COMMIT;
