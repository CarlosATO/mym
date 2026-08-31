-- Register functional permissions for Order Preparation in Logística.
INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT
  'logistica.preparation.manage',
  'Gestionar Preparación de Pedidos',
  'Permite mover y gestionar tarjetas del flujo de preparación.',
  m.id,
  true
FROM portal.modules AS m
WHERE m.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    module_id = EXCLUDED.module_id,
    is_active = true;

INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT
  'logistica.preparation.authorize_exception',
  'Autorizar Excepciones de Preparación',
  'Permite autorizar excepciones operativas en Preparación de Pedidos.',
  m.id,
  true
FROM portal.modules AS m
WHERE m.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    module_id = EXCLUDED.module_id,
    is_active = true;
