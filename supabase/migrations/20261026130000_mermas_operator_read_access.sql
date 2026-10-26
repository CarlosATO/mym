-- Mermas: read-only access for OPERADOR_BODEGA.
-- Existing grants are intentionally preserved; this migration only adds views.

INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT permission.code, permission.name, permission.description, module.id, true
FROM portal.modules module
CROSS JOIN (VALUES
  ('logistica.mermas.stock_exit.view', 'Ver salidas de Mermas', 'Consultar historial, detalle y trazabilidad de salidas.'),
  ('logistica.mermas.authorization.view', 'Ver pendientes de autorización de Mermas', 'Consultar pendientes, evidencias y detalles sin mutar.'),
  ('logistica.mermas.settings.view', 'Ver configuración de Mermas', 'Consultar valores actuales sin modificarlos.')
) AS permission(code, name, description)
WHERE module.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name, description = EXCLUDED.description,
    module_id = EXCLUDED.module_id, is_active = true;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM portal.roles role
CROSS JOIN portal.permissions permission
WHERE role.name = 'OPERADOR_BODEGA'
  AND role.is_active
  AND permission.code IN (
    'logistica.mermas.account.view', 'logistica.mermas.pending.view',
    'logistica.mermas.stock_exit.view', 'logistica.mermas.authorization.view',
    'logistica.mermas.settings.view'
  )
  AND permission.is_active
ON CONFLICT (role_id, permission_id) DO NOTHING;
