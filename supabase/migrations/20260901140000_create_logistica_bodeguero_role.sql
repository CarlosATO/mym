-- ERP role for controlled WMS warehouse operations.
-- The role is intentionally not assigned to any user.

DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(required_permission.code, ', ' ORDER BY required_permission.code)
  INTO v_missing
  FROM (VALUES
    ('module.logistica.view'),
    ('adquisiciones.warehouses.view'),
    ('logistica.locations.view'),
    ('logistica.locations.create'),
    ('logistica.locations.create_bulk'),
    ('logistica.locations.update'),
    ('logistica.locations.deactivate'),
    ('logistica.locations.delete'),
    ('logistica.locations.layout.view'),
    ('logistica.locations.layout.manage'),
    ('logistica.stock.view'),
    ('logistica.kardex.view')
  ) AS required_permission(code)
  WHERE NOT EXISTS (
    SELECT 1
    FROM portal.permissions p
    WHERE p.code = required_permission.code
      AND p.is_active = true
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'LOGISTICA_BODEGUERO_PERMISSION_MISSING: %', v_missing;
  END IF;
END $$;

INSERT INTO portal.roles (name, description, is_active, is_system)
VALUES (
  'LOGISTICA_BODEGUERO',
  'Acceso operativo a bodegas, ubicaciones, stock y Kardex, con administración controlada de ubicaciones.',
  true,
  false
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    is_active = true,
    is_system = false;

-- Keep this role's matrix exact if the migration is rerun after a partial setup.
DELETE FROM portal.role_permissions rp
USING portal.roles r
WHERE rp.role_id = r.id
  AND r.name = 'LOGISTICA_BODEGUERO'
  AND NOT EXISTS (
    SELECT 1
    FROM portal.permissions p
    WHERE p.id = rp.permission_id
      AND p.code IN (
        'module.logistica.view',
        'adquisiciones.warehouses.view',
        'logistica.locations.view',
        'logistica.locations.create',
        'logistica.locations.create_bulk',
        'logistica.locations.update',
        'logistica.locations.deactivate',
        'logistica.locations.delete',
        'logistica.locations.layout.view',
        'logistica.locations.layout.manage',
        'logistica.stock.view',
        'logistica.kardex.view'
      )
  );

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r
CROSS JOIN portal.permissions p
WHERE r.name = 'LOGISTICA_BODEGUERO'
  AND p.code IN (
    'module.logistica.view',
    'adquisiciones.warehouses.view',
    'logistica.locations.view',
    'logistica.locations.create',
    'logistica.locations.create_bulk',
    'logistica.locations.update',
    'logistica.locations.deactivate',
    'logistica.locations.delete',
    'logistica.locations.layout.view',
    'logistica.locations.layout.manage',
    'logistica.stock.view',
    'logistica.kardex.view'
  )
  AND p.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;
