-- Mermas: resolve warehouse costs in one batch through the canonical cost rule.

CREATE OR REPLACE FUNCTION mermas.get_internal_sale_costs(
  p_company_id uuid,
  p_variant_ids integer[]
) RETURNS TABLE (
  variant_id integer,
  average_cost numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, mermas
AS $$
  SELECT requested.variant_id,
         mermas.resolve_internal_sale_cost(p_company_id, requested.variant_id)
  FROM unnest(coalesce(p_variant_ids, '{}'::integer[])) AS requested(variant_id)
$$;

REVOKE ALL ON FUNCTION mermas.get_internal_sale_costs(uuid, integer[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.get_internal_sale_costs(uuid, integer[]) TO service_role;
