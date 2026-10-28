-- Allow OPERADOR_BODEGA to view only the receipt amount summary.
-- This is intentionally separate from adquisiciones.po.view.
INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT
  'logistica.receptions.amounts.view',
  'Consultar montos de recepción',
  'Consultar montos económicos de recepción para cuadrar documentación del proveedor.',
  module.id,
  true
FROM portal.modules AS module
WHERE module.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    module_id = EXCLUDED.module_id,
    is_active = true;

DO $$
DECLARE
  v_role_id uuid;
  v_permission_id uuid;
BEGIN
  SELECT id INTO v_role_id
  FROM portal.roles
  WHERE name = 'OPERADOR_BODEGA'
    AND is_active = true;

  SELECT id INTO v_permission_id
  FROM portal.permissions
  WHERE code = 'logistica.receptions.amounts.view'
    AND is_active = true;

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'OPERADOR_BODEGA_ROLE_MISSING_OR_INACTIVE';
  END IF;
  IF v_permission_id IS NULL THEN
    RAISE EXCEPTION 'RECEIPT_AMOUNTS_PERMISSION_MISSING_OR_INACTIVE';
  END IF;

  INSERT INTO portal.role_permissions (role_id, permission_id)
  VALUES (v_role_id, v_permission_id)
  ON CONFLICT (role_id, permission_id) DO NOTHING;
END;
$$;
