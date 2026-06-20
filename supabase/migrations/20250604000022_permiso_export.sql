INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'adquisiciones.products.export', 'Exportar catálogo', 'Exportar productos del catálogo a Excel', id
FROM portal.modules WHERE code = 'adquisiciones'
AND NOT EXISTS (SELECT 1 FROM portal.permissions WHERE code = 'adquisiciones.products.export');

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r, portal.permissions p
WHERE r.name = 'SUPER_USUARIO' AND p.code = 'adquisiciones.products.export'
AND NOT EXISTS (SELECT 1 FROM portal.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);
