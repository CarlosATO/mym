-- MERMAS: granular permission for internal worker sales.

INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT
  'logistica.mermas.internal_sale.create',
  'Realizar ventas internas de Mermas',
  'Realizar ventas internas de Mermas a trabajadores.',
  module.id,
  true
FROM portal.modules module
WHERE module.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    module_id = EXCLUDED.module_id,
    is_active = true;

-- Preserve existing role grants for the internal-sale flow.
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, target.id
FROM portal.role_permissions rp
JOIN portal.permissions legacy
  ON legacy.id = rp.permission_id
 AND legacy.code = 'logistica.mermas.create'
JOIN portal.permissions target
  ON target.code = 'logistica.mermas.internal_sale.create'
 AND target.is_active
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Preserve direct user overrides, including explicit denials.
INSERT INTO portal.user_permissions (user_id, permission_id, granted)
SELECT up.user_id, target.id, up.granted
FROM portal.user_permissions up
JOIN portal.permissions legacy
  ON legacy.id = up.permission_id
 AND legacy.code = 'logistica.mermas.create'
JOIN portal.permissions target
  ON target.code = 'logistica.mermas.internal_sale.create'
 AND target.is_active
ON CONFLICT (user_id, permission_id) DO NOTHING;

-- LOGISTICA_BODEGUERO receives only the approved internal-sale capability.
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM portal.roles role
CROSS JOIN portal.permissions permission
WHERE role.name = 'LOGISTICA_BODEGUERO'
  AND role.is_active
  AND permission.code = 'logistica.mermas.internal_sale.create'
  AND permission.is_active
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Replace only the permission guard in the already-versioned internal-sale RPCs.
-- The occurrence assertion prevents silently changing commercial logic or a
-- shared function if its definition differs from the audited contract.
DO $$
DECLARE
  v_definition text;
  v_occurrences integer;
BEGIN
  SELECT pg_get_functiondef('mermas.search_active_employees_for_internal_sale(uuid, uuid, text, integer, uuid)'::regprocedure)
    INTO v_definition;
  v_occurrences := (length(v_definition) - length(replace(v_definition, 'logistica.mermas.create', ''))) / length('logistica.mermas.create');
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'Unexpected internal-sale employee search guard count: %', v_occurrences;
  END IF;
  EXECUTE replace(v_definition, 'logistica.mermas.create', 'logistica.mermas.internal_sale.create');

  SELECT pg_get_functiondef('mermas.create_internal_sale(uuid, uuid, uuid, jsonb)'::regprocedure)
    INTO v_definition;
  v_occurrences := (length(v_definition) - length(replace(v_definition, 'logistica.mermas.create', ''))) / length('logistica.mermas.create');
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'Unexpected internal-sale creation guard count: %', v_occurrences;
  END IF;
  EXECUTE replace(v_definition, 'logistica.mermas.create', 'logistica.mermas.internal_sale.create');
END;
$$;
