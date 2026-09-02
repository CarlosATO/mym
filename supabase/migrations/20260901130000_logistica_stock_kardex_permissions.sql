-- Functional read permissions for WMS stock and Kardex.
-- This migration registers permissions only; it creates no role assignments.

INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT permission.code, permission.name, permission.description, m.id, true
FROM portal.modules AS m
CROSS JOIN (VALUES
  ('logistica.stock.view', 'Consultar Stock', 'Permite consultar existencias, cantidades, costos, lotes y vencimientos.'),
  ('logistica.kardex.view', 'Consultar Kardex', 'Permite consultar movimientos y sus filtros contextuales de inventario.')
) AS permission(code, name, description)
WHERE m.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    module_id = EXCLUDED.module_id,
    is_active = true;
