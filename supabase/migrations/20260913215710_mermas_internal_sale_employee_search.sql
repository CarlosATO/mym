-- MERMAS: lectura mínima y autorizada de trabajadores activos para venta interna.

CREATE OR REPLACE FUNCTION mermas.search_active_employees_for_internal_sale(
  p_company_id uuid,
  p_user_id uuid,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_employee_id uuid DEFAULT NULL
) RETURNS TABLE (
  employee_id uuid,
  rut text,
  nombres text,
  apellido_paterno text,
  apellido_materno text,
  cargo text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, rrhh
AS $$
DECLARE
  v_search text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, '')));
  v_search_names text;
  v_search_rut text;
  v_limit integer := pg_catalog.least(pg_catalog.greatest(coalesce(p_limit, 20), 1), 50);
BEGIN
  IF p_company_id IS NULL OR p_user_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM portal.users u
       WHERE u.id = p_user_id
         AND u.is_active
         AND u.deleted_at IS NULL
     )
     OR NOT EXISTS (
       SELECT 1
       FROM core.companies c
       WHERE c.id = p_company_id
         AND c.is_active
     )
     OR NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.create') THEN
    RAISE EXCEPTION 'No autorizado para consultar trabajadores de Venta a trabajadores';
  END IF;

  v_search_names := pg_catalog.translate(v_search, 'áéíóúüñ', 'aeiouun');
  v_search_rut := pg_catalog.translate(v_search, '.- ', '');

  RETURN QUERY
  SELECT
    e.id,
    e.rut,
    e.nombres,
    e.apellido_paterno,
    e.apellido_materno,
    e.cargo
  FROM rrhh.employees e
  WHERE e.estado = 'ACTIVO'
    AND (p_employee_id IS NULL OR e.id = p_employee_id)
    AND (
      v_search = ''
      OR pg_catalog.translate(pg_catalog.lower(pg_catalog.concat_ws(' ', e.nombres, e.apellido_paterno, e.apellido_materno)), 'áéíóúüñ', 'aeiouun') LIKE '%' || v_search_names || '%'
      OR pg_catalog.translate(pg_catalog.lower(coalesce(e.rut, '')), '.- ', '') LIKE '%' || v_search_rut || '%'
    )
  ORDER BY e.nombres, e.apellido_paterno, e.apellido_materno
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION mermas.search_active_employees_for_internal_sale(uuid, uuid, text, integer, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mermas.search_active_employees_for_internal_sale(uuid, uuid, text, integer, uuid)
  TO service_role;
