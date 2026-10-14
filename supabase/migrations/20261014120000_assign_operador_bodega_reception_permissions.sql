-- Enable only the operational Recepciones surface for OPERADOR_BODEGA.
-- Existing role grants remain untouched; this migration is intentionally additive.
DO $$
DECLARE
  v_role_id uuid;
  v_missing text;
  v_assignment_count integer;
BEGIN
  SELECT id
    INTO v_role_id
  FROM portal.roles
  WHERE name = 'OPERADOR_BODEGA'
    AND is_active = true;

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'OPERADOR_BODEGA_ROLE_MISSING_OR_INACTIVE';
  END IF;

  SELECT string_agg(required_permission.code, ', ' ORDER BY required_permission.code)
    INTO v_missing
  FROM (VALUES
    ('logistica.receptions.create'),
    ('logistica.locations.view')
  ) AS required_permission(code)
  WHERE NOT EXISTS (
    SELECT 1
    FROM portal.permissions p
    WHERE p.code = required_permission.code
      AND p.is_active = true
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'OPERADOR_BODEGA_PERMISSION_MISSING_OR_INACTIVE: %', v_missing;
  END IF;

  INSERT INTO portal.role_permissions (role_id, permission_id)
  SELECT v_role_id, p.id
  FROM portal.permissions p
  WHERE p.code IN (
    'logistica.receptions.create',
    'logistica.locations.view'
  )
    AND p.is_active = true
  ON CONFLICT (role_id, permission_id) DO NOTHING;

  SELECT count(*)
    INTO v_assignment_count
  FROM portal.role_permissions rp
  JOIN portal.permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = v_role_id
    AND p.code IN (
      'logistica.receptions.create',
      'logistica.locations.view'
    )
    AND p.is_active = true;

  IF v_assignment_count <> 2 THEN
    RAISE EXCEPTION 'OPERADOR_BODEGA_RECEPTION_ASSIGNMENT_INVALID: expected 2 assignments, got %', v_assignment_count;
  END IF;
END;
$$;
