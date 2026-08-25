-- COMV2-24A.4: operational list and historical-use preflight contract.
-- Historical rows remain queryable for the archive view, but are not part of
-- the normal operational rule list.

CREATE OR REPLACE FUNCTION comisiones.get_plan_historical_usage(
    p_company_id uuid,
    p_plan_ids uuid[]
)
RETURNS TABLE (
    plan_id uuid,
    has_historical_usage boolean,
    has_plan_reference boolean,
    has_family_rate_reference boolean,
    has_tier_reference boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones
AS $$
    SELECT requested.plan_id,
           EXISTS (
               SELECT 1
               FROM comisiones.settlement_lines sl
               WHERE sl.company_id = p_company_id
                 AND sl.plan_id = requested.plan_id
           )
           OR EXISTS (
               SELECT 1
               FROM comisiones.settlement_lines sl
               JOIN comisiones.commission_plan_family_rates fr
                 ON fr.company_id = sl.company_id
                AND fr.id = sl.family_rate_id
               WHERE sl.company_id = p_company_id
                 AND fr.plan_id = requested.plan_id
           )
           OR EXISTS (
               SELECT 1
               FROM comisiones.settlement_lines sl
               JOIN comisiones.commission_plan_tiers t
                 ON t.company_id = sl.company_id
                AND t.id = sl.tier_id
               WHERE sl.company_id = p_company_id
                 AND t.plan_id = requested.plan_id
           ),
           EXISTS (
               SELECT 1 FROM comisiones.settlement_lines sl
               WHERE sl.company_id = p_company_id AND sl.plan_id = requested.plan_id
           ),
           EXISTS (
               SELECT 1
               FROM comisiones.settlement_lines sl
               JOIN comisiones.commission_plan_family_rates fr
                 ON fr.company_id = sl.company_id AND fr.id = sl.family_rate_id
               WHERE sl.company_id = p_company_id AND fr.plan_id = requested.plan_id
           ),
           EXISTS (
               SELECT 1
               FROM comisiones.settlement_lines sl
               JOIN comisiones.commission_plan_tiers t
                 ON t.company_id = sl.company_id AND t.id = sl.tier_id
               WHERE sl.company_id = p_company_id AND t.plan_id = requested.plan_id
           )
    FROM unnest(COALESCE(p_plan_ids, ARRAY[]::uuid[])) AS requested(plan_id)
    WHERE auth.uid() IS NOT NULL
      AND (portal.has_permission('system.admin')
           OR portal.has_permission('comisiones.v2.read')
           OR portal.has_permission('comisiones.v2.plans.manage'))
      AND core.has_company_access(auth.uid(), p_company_id);
$$;

REVOKE ALL ON FUNCTION comisiones.get_plan_historical_usage(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_plan_historical_usage(uuid, uuid[]) TO authenticated, service_role;

-- Repair only an impossible pre-existing duplicate. The greatest version is
-- the operational row; no settlement_lines or configuration snapshots are
-- deleted. The partial unique index remains the concurrency guard.
WITH duplicate_active AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY company_id, supplier_id, plan_code, plan_type
               ORDER BY version_no DESC, updated_at DESC, id DESC
           ) AS position
    FROM comisiones.commission_plans
    WHERE active IS TRUE
)
UPDATE comisiones.commission_plans cp
SET status = 'RETIRED', active = false, updated_at = now()
FROM duplicate_active d
WHERE cp.id = d.id AND d.position > 1;

COMMENT ON INDEX comisiones.uq_comisiones_plans_one_active_logical_rule IS
    'Exactly one ACTIVE rule per company, supplier, plan_code and plan_type';
