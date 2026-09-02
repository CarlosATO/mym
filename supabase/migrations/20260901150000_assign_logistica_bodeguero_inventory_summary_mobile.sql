-- Grant only the permissions needed for the inventory summary and mobile APK.
-- This intentionally does not assign INVENTARIOS_LECTURA or any operational permission.
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(required_permission.code, ', ' ORDER BY required_permission.code)
  INTO v_missing
  FROM (VALUES
    ('module.inventarios.view'),
    ('inventarios.sessions.read'),
    ('inventarios.mobile_app.download')
  ) AS required_permission(code)
  WHERE NOT EXISTS (
    SELECT 1
    FROM portal.permissions p
    WHERE p.code = required_permission.code
      AND p.is_active = true
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'LOGISTICA_BODEGUERO_INVENTORY_PERMISSION_MISSING: %', v_missing;
  END IF;
END $$;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r
CROSS JOIN portal.permissions p
WHERE r.name = 'LOGISTICA_BODEGUERO'
  AND r.is_active = true
  AND p.code IN (
    'module.inventarios.view',
    'inventarios.sessions.read',
    'inventarios.mobile_app.download'
  )
  AND p.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;
