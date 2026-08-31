-- Register Análisis Comercial as an independent module.
INSERT INTO portal.modules (code, name, description, icon, route, sort_order, is_active)
VALUES (
    'analisis-comercial',
    'Análisis Comercial',
    'Análisis por proveedor, producto, ventas, stock, clientes y recepción versus venta.',
    'BarChart3',
    '/dashboard/analisis-comercial',
    9,
    true
)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    icon = EXCLUDED.icon,
    route = EXCLUDED.route,
    sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active,
    updated_at = pg_catalog.now();

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT
    'module.analisis-comercial.view',
    'Ver Análisis Comercial',
    'Acceso al módulo Análisis Comercial',
    id
FROM portal.modules
WHERE code = 'analisis-comercial'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    module_id = EXCLUDED.module_id;
