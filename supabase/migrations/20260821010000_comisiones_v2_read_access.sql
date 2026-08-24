-- COMV2-03B: controlled read access for the V2 inspection screen.
-- No V2 write path is exposed to authenticated users in this phase.

INSERT INTO portal.modules (code, name, description, icon, route, sort_order)
VALUES (
    'comercial',
    'Clientes y Ventas',
    'Gestión comercial, clientes, cobranza y comisiones',
    'BriefcaseBusiness',
    '/dashboard/comercial',
    7
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT
    'module.comercial.view',
    'Ver Clientes y Ventas',
    'Acceso al módulo Clientes y Ventas',
    id
FROM portal.modules
WHERE code = 'comercial'
ON CONFLICT (code) DO NOTHING;

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT
    'comisiones.v2.read',
    'Leer Comisiones V2',
    'Consultar líneas comerciales resueltas por el contrato de Comisiones V2',
    id
FROM portal.modules
WHERE code = 'comercial'
ON CONFLICT (code) DO NOTHING;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r
JOIN portal.permissions p ON p.code IN ('module.comercial.view', 'comisiones.v2.read')
WHERE r.name IN ('SUPER_USUARIO', 'GERENCIA', 'FINANZAS', 'VENDEDOR')
ON CONFLICT DO NOTHING;

GRANT USAGE ON SCHEMA comisiones TO authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA comisiones FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA comisiones FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA comisiones FROM anon, authenticated;
GRANT SELECT ON comisiones.vw_sales_line_resolution TO authenticated;
