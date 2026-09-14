-- MERMAS: minimal operational profile for LOGISTICA_BODEGUERO.

INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT permission.code, permission.name, permission.description, module.id, true
FROM portal.modules module
CROSS JOIN (VALUES
  (
    'logistica.mermas.request.create',
    'Crear solicitudes de traspaso a Mermas',
    'Crear solicitudes normales de traspaso a Mermas con sus evidencias.'
  ),
  (
    'logistica.mermas.account.view',
    'Ver cuenta corriente de trabajadores',
    'Consultar la cuenta corriente de trabajadores de la empresa activa.'
  )
) AS permission(code, name, description)
WHERE module.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    module_id = EXCLUDED.module_id,
    is_active = true;

-- Preserve every existing role grant for normal request creation.
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, target.id
FROM portal.role_permissions rp
JOIN portal.permissions legacy
  ON legacy.id = rp.permission_id
 AND legacy.code = 'logistica.mermas.create'
JOIN portal.permissions target
  ON target.code = 'logistica.mermas.request.create'
 AND target.is_active
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Preserve every existing role grant for account reads.
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, target.id
FROM portal.role_permissions rp
JOIN portal.permissions legacy
  ON legacy.id = rp.permission_id
 AND legacy.code = 'logistica.mermas.view'
JOIN portal.permissions target
  ON target.code = 'logistica.mermas.account.view'
 AND target.is_active
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Preserve direct user overrides, including explicit denials.
INSERT INTO portal.user_permissions (user_id, permission_id, granted)
SELECT up.user_id, target.id, up.granted
FROM portal.user_permissions up
JOIN portal.permissions legacy
  ON legacy.id = up.permission_id
 AND legacy.code = 'logistica.mermas.create'
JOIN portal.permissions target
  ON target.code = 'logistica.mermas.request.create'
 AND target.is_active
ON CONFLICT (user_id, permission_id) DO NOTHING;

INSERT INTO portal.user_permissions (user_id, permission_id, granted)
SELECT up.user_id, target.id, up.granted
FROM portal.user_permissions up
JOIN portal.permissions legacy
  ON legacy.id = up.permission_id
 AND legacy.code = 'logistica.mermas.view'
JOIN portal.permissions target
  ON target.code = 'logistica.mermas.account.view'
 AND target.is_active
ON CONFLICT (user_id, permission_id) DO NOTHING;

-- Approved operational surface for the portal role. No legacy create/account/payment
-- capability is granted to this role.
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM portal.roles role
CROSS JOIN portal.permissions permission
WHERE role.name = 'LOGISTICA_BODEGUERO'
  AND role.is_active
  AND permission.code IN (
    'logistica.mermas.view',
    'logistica.mermas.request.create',
    'logistica.mermas.warehouse.view'
  )
  AND permission.is_active
ON CONFLICT (role_id, permission_id) DO NOTHING;
