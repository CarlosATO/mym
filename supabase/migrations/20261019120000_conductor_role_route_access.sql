-- PETGROUP: conductor identity, assigned route read access, and legacy RPC guards.

BEGIN;

INSERT INTO portal.roles (name, description, is_system, is_active)
VALUES ('CONDUCTOR', 'Acceso móvil a las guías de ruta asignadas', false, true)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description, is_active = true;

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT permission_code, permission_name, permission_description, m.id
FROM (VALUES
  ('logistica.driver_app.view', 'Acceso a App de Conductores', 'Puede acceder a la aplicación de conductores'),
  ('logistica.driver_routes.view_assigned', 'Ver Guías Asignadas', 'Puede consultar únicamente sus guías despachadas')
) AS permissions(permission_code, permission_name, permission_description)
JOIN portal.modules m ON m.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name, description = EXCLUDED.description, module_id = EXCLUDED.module_id, is_active = true;

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'logistica.driver_deliveries.confirm', 'Confirmar Entregas', 'Puede confirmar entregas desde la app de conductores', m.id
FROM portal.modules m
WHERE m.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name, description = EXCLUDED.description, module_id = EXCLUDED.module_id, is_active = true;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r
JOIN portal.permissions p ON p.code IN (
  'logistica.driver_app.view',
  'logistica.driver_routes.view_assigned'
)
WHERE r.name = 'CONDUCTOR'
ON CONFLICT (role_id, permission_id) DO NOTHING;

ALTER TABLE logistica.route_personnel
  ADD COLUMN IF NOT EXISTS portal_user_id uuid REFERENCES portal.users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_route_personnel_portal_user_company
  ON logistica.route_personnel (company_id, portal_user_id)
  WHERE portal_user_id IS NOT NULL AND person_type = 'DRIVER' AND is_active = true;

CREATE OR REPLACE FUNCTION logistica.link_route_driver_user(
  p_company_id uuid,
  p_driver_id uuid,
  p_portal_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_driver_company uuid;
  v_driver_type text;
  v_user_active boolean;
  v_has_company boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'INV_UNAUTHENTICATED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM portal.users u
    WHERE u.id = v_actor AND u.is_active = true AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'PORTAL_USER_INACTIVE';
  END IF;
  IF NOT core.has_company_access(v_actor, p_company_id)
     OR NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.route_catalogs.manage') THEN
    RAISE EXCEPTION 'INV_PERMISSION_REQUIRED';
  END IF;

  SELECT company_id, person_type INTO v_driver_company, v_driver_type
  FROM logistica.route_personnel
  WHERE id = p_driver_id AND is_active = true;
  IF v_driver_company IS DISTINCT FROM p_company_id OR v_driver_type IS DISTINCT FROM 'DRIVER' THEN
    RAISE EXCEPTION 'DRIVER_NOT_FOUND';
  END IF;

  IF p_portal_user_id IS NOT NULL THEN
    SELECT u.is_active AND u.deleted_at IS NULL INTO v_user_active
    FROM portal.users u
    WHERE u.id = p_portal_user_id;
    IF v_user_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'PORTAL_USER_INACTIVE';
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM core.user_company_access a
      WHERE a.user_id = p_portal_user_id AND a.company_id = p_company_id AND a.is_active = true
    ) INTO v_has_company;
    IF NOT v_has_company THEN
      RAISE EXCEPTION 'PORTAL_USER_COMPANY_ACCESS_DENIED';
    END IF;

    IF EXISTS (
      SELECT 1 FROM logistica.route_personnel other
      WHERE other.company_id = p_company_id
        AND other.person_type = 'DRIVER'
        AND other.is_active = true
        AND other.portal_user_id = p_portal_user_id
        AND other.id <> p_driver_id
    ) THEN
      RAISE EXCEPTION 'DRIVER_USER_ALREADY_LINKED';
    END IF;
  END IF;

  UPDATE logistica.route_personnel
  SET portal_user_id = p_portal_user_id, updated_at = now()
  WHERE id = p_driver_id AND company_id = p_company_id AND person_type = 'DRIVER' AND is_active = true;

  RETURN jsonb_build_object('success', true, 'driver_id', p_driver_id, 'portal_user_id', p_portal_user_id);
END;
$$;

ALTER FUNCTION logistica.link_route_driver_user(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.link_route_driver_user(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.link_route_driver_user(uuid, uuid, uuid) TO authenticated;

-- The driver app reads through this RPC, never through a client-supplied user id.
CREATE OR REPLACE FUNCTION logistica.list_my_assigned_route_guides()
RETURNS TABLE (
  id uuid,
  company_id uuid,
  guide_number text,
  guide_date date,
  status text,
  route_name text,
  vehicle_name text,
  driver_name text,
  total_invoices integer,
  total_amount numeric,
  dispatched_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'INV_UNAUTHENTICATED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM portal.users u
    WHERE u.id = v_actor AND u.is_active = true AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'PORTAL_USER_INACTIVE';
  END IF;

  RETURN QUERY
  SELECT g.id, g.company_id, g.guide_number, g.guide_date, g.status,
         g.route_name_snapshot, g.vehicle_name_snapshot, g.driver_name_snapshot,
         g.total_invoices, g.total_amount, g.dispatched_at
  FROM logistica.route_guides g
  JOIN logistica.route_personnel d
    ON d.id = g.driver_id
   AND d.company_id = g.company_id
   AND d.person_type = 'DRIVER'
   AND d.is_active = true
   AND d.portal_user_id = v_actor
  WHERE g.status = 'DISPATCHED'
    AND core.has_company_access(v_actor, g.company_id)
    AND core.has_permission_for_company(v_actor, g.company_id, 'logistica.driver_app.view')
    AND core.has_permission_for_company(v_actor, g.company_id, 'logistica.driver_routes.view_assigned')
  ORDER BY g.guide_date DESC, g.guide_number DESC;
END;
$$;

ALTER FUNCTION logistica.list_my_assigned_route_guides() OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.list_my_assigned_route_guides() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.list_my_assigned_route_guides() TO authenticated;

-- Block direct table access for the conductor role; the assigned-read RPC is the only route entry point.
DROP POLICY IF EXISTS rls_route_guides_select ON logistica.route_guides;
CREATE POLICY rls_route_guides_select ON logistica.route_guides FOR SELECT TO authenticated
USING (
  portal.has_permission('system.admin') OR
  core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.view')
);

DROP POLICY IF EXISTS rls_route_guide_items_select ON logistica.route_guide_items;
CREATE POLICY rls_route_guide_items_select ON logistica.route_guide_items FOR SELECT TO authenticated
USING (
  portal.has_permission('system.admin') OR
  core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.view')
);

DROP POLICY IF EXISTS rls_route_personnel_select ON logistica.route_personnel;
CREATE POLICY rls_route_personnel_select ON logistica.route_personnel FOR SELECT TO authenticated
USING (
  portal.has_permission('system.admin') OR
  core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_catalogs.manage') OR
  core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.view')
);

DROP POLICY IF EXISTS rls_route_vehicles_select ON logistica.route_vehicles;
CREATE POLICY rls_route_vehicles_select ON logistica.route_vehicles FOR SELECT TO authenticated
USING (
  portal.has_permission('system.admin') OR
  core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.view') OR
  core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_catalogs.manage')
);
DROP POLICY IF EXISTS rls_delivery_routes_select ON logistica.delivery_routes;
CREATE POLICY rls_delivery_routes_select ON logistica.delivery_routes FOR SELECT TO authenticated
USING (
  portal.has_permission('system.admin') OR
  core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.view') OR
  core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_catalogs.manage')
);

DROP POLICY IF EXISTS rls_route_vehicles_insert ON logistica.route_vehicles;
CREATE POLICY rls_route_vehicles_insert ON logistica.route_vehicles FOR INSERT TO authenticated
WITH CHECK (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_catalogs.manage'));
DROP POLICY IF EXISTS rls_route_vehicles_update ON logistica.route_vehicles;
CREATE POLICY rls_route_vehicles_update ON logistica.route_vehicles FOR UPDATE TO authenticated
USING (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_catalogs.manage'))
WITH CHECK (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_catalogs.manage'));
DROP POLICY IF EXISTS rls_delivery_routes_insert ON logistica.delivery_routes;
CREATE POLICY rls_delivery_routes_insert ON logistica.delivery_routes FOR INSERT TO authenticated
WITH CHECK (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_catalogs.manage'));
DROP POLICY IF EXISTS rls_delivery_routes_update ON logistica.delivery_routes;
CREATE POLICY rls_delivery_routes_update ON logistica.delivery_routes FOR UPDATE TO authenticated
USING (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_catalogs.manage'))
WITH CHECK (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_catalogs.manage'));

DROP POLICY IF EXISTS rls_route_personnel_insert ON logistica.route_personnel;
CREATE POLICY rls_route_personnel_insert ON logistica.route_personnel FOR INSERT TO authenticated
WITH CHECK (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_catalogs.manage'));
DROP POLICY IF EXISTS rls_route_personnel_update ON logistica.route_personnel;
CREATE POLICY rls_route_personnel_update ON logistica.route_personnel FOR UPDATE TO authenticated
USING (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_catalogs.manage'))
WITH CHECK (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_catalogs.manage'));

DROP POLICY IF EXISTS rls_route_guides_insert ON logistica.route_guides;
CREATE POLICY rls_route_guides_insert ON logistica.route_guides FOR INSERT TO authenticated
WITH CHECK (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.create'));
DROP POLICY IF EXISTS rls_route_guides_update ON logistica.route_guides;
CREATE POLICY rls_route_guides_update ON logistica.route_guides FOR UPDATE TO authenticated
USING (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.update_draft'))
WITH CHECK (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.update_draft'));

DROP POLICY IF EXISTS rls_route_guide_items_insert ON logistica.route_guide_items;
CREATE POLICY rls_route_guide_items_insert ON logistica.route_guide_items FOR INSERT TO authenticated
WITH CHECK (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.create'));
DROP POLICY IF EXISTS rls_route_guide_items_update ON logistica.route_guide_items;
CREATE POLICY rls_route_guide_items_update ON logistica.route_guide_items FOR UPDATE TO authenticated
USING (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.update_draft'))
WITH CHECK (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.update_draft'));
DROP POLICY IF EXISTS rls_route_guide_items_delete ON logistica.route_guide_items;
CREATE POLICY rls_route_guide_items_delete ON logistica.route_guide_items FOR DELETE TO authenticated
USING (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.update_draft'));

DROP POLICY IF EXISTS rls_route_guide_counters_insert ON logistica.route_guide_counters;
CREATE POLICY rls_route_guide_counters_insert ON logistica.route_guide_counters FOR INSERT TO authenticated
WITH CHECK (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.create'));
DROP POLICY IF EXISTS rls_route_guide_counters_update ON logistica.route_guide_counters;
CREATE POLICY rls_route_guide_counters_update ON logistica.route_guide_counters FOR UPDATE TO authenticated
USING (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.create'))
WITH CHECK (portal.has_permission('system.admin') OR core.has_permission_for_company(auth.uid(), company_id, 'logistica.route_guides.create'));

-- Preserve the existing RPC signatures while putting authorization in front of
-- the historical SECURITY DEFINER implementations.
ALTER FUNCTION logistica.create_route_vehicle_inline(uuid, text, uuid)
  RENAME TO create_route_vehicle_inline_unchecked;
ALTER FUNCTION logistica.create_delivery_route_inline(uuid, text, uuid)
  RENAME TO create_delivery_route_inline_unchecked;
ALTER FUNCTION logistica.create_route_person_inline(uuid, text, text, uuid)
  RENAME TO create_route_person_inline_unchecked;
ALTER FUNCTION logistica.create_route_guide_draft(uuid, jsonb, jsonb, uuid)
  RENAME TO create_route_guide_draft_unchecked;
ALTER FUNCTION logistica.update_route_guide_draft(uuid, uuid, jsonb, jsonb, uuid)
  RENAME TO update_route_guide_draft_unchecked;
ALTER FUNCTION logistica.dispatch_route_guide(uuid, uuid, uuid)
  RENAME TO dispatch_route_guide_unchecked;
ALTER FUNCTION logistica.delete_route_guide_draft(uuid, uuid)
  RENAME TO delete_route_guide_draft_unchecked;

CREATE OR REPLACE FUNCTION logistica.create_route_vehicle_inline(p_company_id uuid, p_vehicle_name text, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.route_catalogs.manage') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No autorizado');
  END IF;
  RETURN logistica.create_route_vehicle_inline_unchecked(p_company_id, p_vehicle_name, p_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION logistica.create_delivery_route_inline(p_company_id uuid, p_route_name text, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.route_catalogs.manage') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No autorizado');
  END IF;
  RETURN logistica.create_delivery_route_inline_unchecked(p_company_id, p_route_name, p_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION logistica.create_route_person_inline(p_company_id uuid, p_person_name text, p_person_type text, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.route_catalogs.manage') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No autorizado');
  END IF;
  RETURN logistica.create_route_person_inline_unchecked(p_company_id, p_person_name, p_person_type, p_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION logistica.create_route_guide_draft(p_company_id uuid, p_guide_data jsonb, p_items_data jsonb, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.route_guides.create') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No autorizado');
  END IF;
  RETURN logistica.create_route_guide_draft_unchecked(p_company_id, p_guide_data, p_items_data, p_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION logistica.update_route_guide_draft(p_company_id uuid, p_guide_id uuid, p_guide_data jsonb, p_items_data jsonb, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.route_guides.edit_unsettled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No autorizado');
  END IF;
  RETURN logistica.update_route_guide_draft_unchecked(p_company_id, p_guide_id, p_guide_data, p_items_data, p_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION logistica.dispatch_route_guide(p_company_id uuid, p_guide_id uuid, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.route_guides.dispatch') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No autorizado');
  END IF;
  RETURN logistica.dispatch_route_guide_unchecked(p_company_id, p_guide_id, p_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION logistica.delete_route_guide_draft(p_guide_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_company_id uuid;
BEGIN
  SELECT company_id INTO v_company_id FROM logistica.route_guides WHERE id = p_guide_id;
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id
     OR v_company_id IS NULL
     OR NOT core.has_company_access(p_user_id, v_company_id)
     OR NOT core.has_permission_for_company(p_user_id, v_company_id, 'logistica.route_guides.edit_unsettled') THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;
  PERFORM logistica.delete_route_guide_draft_unchecked(p_guide_id, p_user_id);
END;
$$;

ALTER FUNCTION logistica.create_route_vehicle_inline_unchecked(uuid, text, uuid) OWNER TO postgres;
ALTER FUNCTION logistica.create_delivery_route_inline_unchecked(uuid, text, uuid) OWNER TO postgres;
ALTER FUNCTION logistica.create_route_person_inline_unchecked(uuid, text, text, uuid) OWNER TO postgres;
ALTER FUNCTION logistica.create_route_guide_draft_unchecked(uuid, jsonb, jsonb, uuid) OWNER TO postgres;
ALTER FUNCTION logistica.update_route_guide_draft_unchecked(uuid, uuid, jsonb, jsonb, uuid) OWNER TO postgres;
ALTER FUNCTION logistica.dispatch_route_guide_unchecked(uuid, uuid, uuid) OWNER TO postgres;
ALTER FUNCTION logistica.delete_route_guide_draft_unchecked(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION logistica.create_route_vehicle_inline_unchecked(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.create_delivery_route_inline_unchecked(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.create_route_person_inline_unchecked(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.create_route_guide_draft_unchecked(uuid, jsonb, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.update_route_guide_draft_unchecked(uuid, uuid, jsonb, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.dispatch_route_guide_unchecked(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.delete_route_guide_draft_unchecked(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION logistica.create_route_vehicle_inline(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION logistica.create_delivery_route_inline(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION logistica.create_route_person_inline(uuid, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION logistica.create_route_guide_draft(uuid, jsonb, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION logistica.update_route_guide_draft(uuid, uuid, jsonb, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION logistica.dispatch_route_guide(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION logistica.delete_route_guide_draft(uuid, uuid) TO authenticated;

COMMIT;
