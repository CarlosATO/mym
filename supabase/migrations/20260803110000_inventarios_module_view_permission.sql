-- Migration: 20260803110000_inventarios_module_view_permission.sql
-- Description: Fase 4I.2C. Crea el permiso module.inventarios.view y lo asigna
--              solo a SUPER_USUARIO, BODEGA y GERENCIA. Cierra el acceso indebido
--              por URL directa (FINANZAS no recibe el permiso).
-- Author: Assistant

INSERT INTO portal.permissions (code, name, module_id)
SELECT permission.code, permission.name, module.id
FROM (
    VALUES
        ('module.inventarios.view', 'Ver el modulo de Inventarios')
) AS permission(code, name)
CROSS JOIN (SELECT id FROM portal.modules WHERE code = 'inventarios') AS module
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name, module_id = EXCLUDED.module_id;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
    ('SUPER_USUARIO', 'module.inventarios.view'),
    ('BODEGA', 'module.inventarios.view'),
    ('GERENCIA', 'module.inventarios.view')
) AS m(role_name, perm_code)
JOIN portal.roles r ON r.name = m.role_name AND r.is_active = true
JOIN portal.permissions p ON p.code = m.perm_code AND p.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Limpieza defensiva: garantizar que ningun otro rol tenga el permiso de vista.
DELETE FROM portal.role_permissions rp
USING portal.roles r, portal.permissions p
WHERE rp.role_id = r.id AND rp.permission_id = p.id
  AND p.code = 'module.inventarios.view'
  AND r.name NOT IN ('SUPER_USUARIO', 'BODEGA', 'GERENCIA');
