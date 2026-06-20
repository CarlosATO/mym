INSERT INTO portal.roles (name, description, is_system) VALUES
    ('SUPER_USUARIO', 'Acceso total al sistema', true),
    ('GERENCIA', 'Acceso a visión general y reportes', true),
    ('FINANZAS', 'Acceso a módulo financiero', true),
    ('BODEGA', 'Acceso a módulo de inventario y bodega', true),
    ('VENDEDOR', 'Acceso a ventas y clientes', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO portal.modules (code, name, description, icon, route, sort_order) VALUES
    ('dashboard', 'Dashboard', 'Panel principal del sistema', 'LayoutDashboard', '/dashboard', 1),
    ('usuarios', 'Usuarios', 'Gestión de usuarios del sistema', 'Users', '/dashboard/usuarios', 2),
    ('roles', 'Roles', 'Gestión de roles y permisos', 'Shield', '/dashboard/roles', 3),
    ('adquisiciones', 'Adquisiciones', 'Módulo de adquisiciones y compras', 'ShoppingCart', '/dashboard/adquisiciones', 4),
    ('auditoria', 'Auditoría', 'Registro de auditoría del sistema', 'ClipboardList', '/dashboard/auditoria', 5),
    ('seguridad', 'Seguridad', 'Eventos de seguridad y accesos', 'Lock', '/dashboard/seguridad', 6)
ON CONFLICT (code) DO NOTHING;

INSERT INTO portal.permissions (code, name, description, module_id) VALUES
    ('system.admin', 'Administrador Global', 'Acceso total al sistema', NULL),
    ('dashboard.view', 'Ver Dashboard', 'Acceso al panel principal', (SELECT id FROM portal.modules WHERE code = 'dashboard')),
    ('usuarios.view', 'Ver Usuarios', 'Ver listado de usuarios', (SELECT id FROM portal.modules WHERE code = 'usuarios')),
    ('usuarios.create', 'Crear Usuarios', 'Crear nuevos usuarios', (SELECT id FROM portal.modules WHERE code = 'usuarios')),
    ('usuarios.update', 'Actualizar Usuarios', 'Editar usuarios existentes', (SELECT id FROM portal.modules WHERE code = 'usuarios')),
    ('usuarios.deactivate', 'Desactivar Usuarios', 'Activar o desactivar usuarios', (SELECT id FROM portal.modules WHERE code = 'usuarios')),
    ('roles.view', 'Ver Roles', 'Ver listado de roles', (SELECT id FROM portal.modules WHERE code = 'roles')),
    ('roles.assign', 'Asignar Roles', 'Asignar roles a usuarios', (SELECT id FROM portal.modules WHERE code = 'roles')),
    ('modules.view', 'Ver Módulos', 'Ver módulos del sistema', NULL),
    ('modules.manage', 'Gestionar Módulos', 'Administrar módulos del sistema', NULL),
    ('audit.view', 'Ver Auditoría', 'Acceso a registros de auditoría', (SELECT id FROM portal.modules WHERE code = 'auditoria')),
    ('security.view', 'Ver Seguridad', 'Acceso a eventos de seguridad', (SELECT id FROM portal.modules WHERE code = 'seguridad'))
ON CONFLICT (code) DO NOTHING;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r, portal.permissions p
WHERE r.name = 'SUPER_USUARIO'
ON CONFLICT DO NOTHING;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r, portal.permissions p
WHERE r.name = 'GERENCIA'
    AND p.code IN ('dashboard.view', 'usuarios.view', 'roles.view', 'modules.view', 'audit.view', 'security.view')
ON CONFLICT DO NOTHING;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r, portal.permissions p
WHERE r.name = 'FINANZAS'
    AND p.code IN ('dashboard.view')
ON CONFLICT DO NOTHING;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r, portal.permissions p
WHERE r.name = 'BODEGA'
    AND p.code IN ('dashboard.view')
ON CONFLICT DO NOTHING;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r, portal.permissions p
WHERE r.name = 'VENDEDOR'
    AND p.code IN ('dashboard.view')
ON CONFLICT DO NOTHING;
