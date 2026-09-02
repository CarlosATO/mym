-- Functional permissions for the WMS warehouse and location domain.
-- This migration registers permissions only; it intentionally creates no role
-- and does not assign them to existing roles.

INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT permission.code, permission.name, permission.description, m.id, true
FROM portal.modules AS m
CROSS JOIN (VALUES
  ('logistica.locations.view', 'Ver Ubicaciones', 'Permite consultar ubicaciones logísticas.'),
  ('logistica.locations.create', 'Crear Ubicación', 'Permite crear una ubicación logística.'),
  ('logistica.locations.create_bulk', 'Crear Ubicaciones Masivamente', 'Permite crear ubicaciones logísticas masivamente.'),
  ('logistica.locations.update', 'Editar Ubicación', 'Permite editar la estructura y datos de una ubicación.'),
  ('logistica.locations.deactivate', 'Activar o Desactivar Ubicación', 'Permite cambiar el estado de una ubicación.'),
  ('logistica.locations.delete', 'Eliminar Ubicación', 'Permite eliminar una ubicación.'),
  ('logistica.locations.layout.view', 'Ver Estructura de Ubicaciones', 'Permite consultar la estructura visual y layout de ubicaciones.'),
  ('logistica.locations.layout.manage', 'Gestionar Estructura de Ubicaciones', 'Permite modificar el layout visual de ubicaciones.')
) AS permission(code, name, description)
WHERE m.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    module_id = EXCLUDED.module_id,
    is_active = true;
