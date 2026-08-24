-- COMV2-08B: expose only the aggregate historical usage needed by plan management.

CREATE OR REPLACE FUNCTION comisiones.get_family_fixed_plan_issued_usage(
    p_company_id uuid,
    p_plan_ids uuid[]
)
RETURNS TABLE (plan_id uuid, has_issued_usage boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones
AS $$
    SELECT requested.plan_id,
           EXISTS (
               SELECT 1
               FROM comisiones.settlement_lines sl
               JOIN comisiones.settlements st
                 ON st.company_id = sl.company_id
                AND st.id = sl.settlement_id
               WHERE sl.company_id = p_company_id
                 AND sl.plan_id = requested.plan_id
                 AND st.status = 'ISSUED'
           ) AS has_issued_usage
    FROM unnest(COALESCE(p_plan_ids, ARRAY[]::uuid[])) AS requested(plan_id)
    WHERE auth.uid() IS NOT NULL
      AND (
          portal.has_permission('system.admin')
          OR portal.has_permission('comisiones.v2.read')
          OR portal.has_permission('comisiones.v2.plans.manage')
      )
      AND core.has_company_access(auth.uid(), p_company_id);
$$;

REVOKE ALL ON FUNCTION comisiones.get_family_fixed_plan_issued_usage(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_family_fixed_plan_issued_usage(uuid, uuid[]) TO authenticated, service_role;
