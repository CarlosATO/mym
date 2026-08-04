-- Migration: 20260803180000_inventarios_imports_permissions.sql
-- Description: Fase 4I.3A. Permisos del modulo de importaciones de stock/costo.
--              inventarios.imports.read y inventarios.imports.manage.
--              SUPER_USUARIO y BODEGA administran; GERENCIA solo lee; FINANZAS no accede.
--              El acceso a las tablas se revoca: solo via RPC SECURITY DEFINER.
-- Author: Assistant

-- ============================================================
-- 1. PERMISOS NUEVOS
-- ============================================================
INSERT INTO portal.permissions (code, name, module_id)
SELECT permission.code, permission.name, module.id
FROM (
    VALUES
        ('inventarios.imports.read', 'Leer importaciones de stock'),
        ('inventarios.imports.manage', 'Gestionar importaciones de stock')
) AS permission(code, name)
CROSS JOIN (SELECT id FROM portal.modules WHERE code = 'inventarios') AS module
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name, module_id = EXCLUDED.module_id;

-- ============================================================
-- 2. ASIGNACION DE ROLES
--    SUPER_USUARIO: read + manage
--    BODEGA: read + manage
--    GERENCIA: read
--    FINANZAS: ninguno
-- ============================================================
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
    ('SUPER_USUARIO', 'inventarios.imports.read'),
    ('SUPER_USUARIO', 'inventarios.imports.manage'),
    ('BODEGA', 'inventarios.imports.read'),
    ('BODEGA', 'inventarios.imports.manage'),
    ('GERENCIA', 'inventarios.imports.read')
) AS m(role_name, perm_code)
JOIN portal.roles r ON r.name = m.role_name AND r.is_active = true
JOIN portal.permissions p ON p.code = m.perm_code AND p.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Limpieza defensiva: ningun rol no autorizado puede administrar importaciones.
DELETE FROM portal.role_permissions rp
USING portal.roles r, portal.permissions p
WHERE rp.role_id = r.id AND rp.permission_id = p.id
  AND p.code = 'inventarios.imports.manage'
  AND r.name NOT IN ('SUPER_USUARIO', 'BODEGA');

-- ============================================================
-- 3. SIN ACCESO DIRECTO A TABLAS (solo via RPC)
--    Se revoca todo el acceso de authenticated/anon/public a las
--    tres tablas de importacion. El acceso se resuelve por RPC
--    SECURITY DEFINER con verificacion de permiso por empresa.
-- ============================================================
REVOKE ALL ON TABLE inventarios.stock_imports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE inventarios.stock_import_rows FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE inventarios.stock_import_row_issues FROM PUBLIC, anon, authenticated;

-- El servicio puede seguir administrando las tablas para tareas de soporte.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE inventarios.stock_imports TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE inventarios.stock_import_rows TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE inventarios.stock_import_row_issues TO service_role;
