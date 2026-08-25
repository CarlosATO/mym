-- Keep allocation history in the database, but expose only current active
-- allocations as the payment's operational coverage.

ALTER FUNCTION adquisiciones.get_route_settlement_detail(uuid)
    RENAME TO get_route_settlement_detail_active_state_base;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail_active_state_base(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION adquisiciones.filter_route_settlement_payment_allocations(p_base jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
    SELECT jsonb_set(
        p_base,
        '{clients}',
        COALESCE(jsonb_agg(
            c.value || jsonb_build_object(
                'payments', COALESCE((
                    SELECT jsonb_agg(
                        p.value || jsonb_build_object(
                            'allocations', COALESCE((
                                SELECT jsonb_agg(a.value ORDER BY a.ordinality)
                                FROM jsonb_array_elements(p.value->'allocations') WITH ORDINALITY AS a(value, ordinality)
                                WHERE a.value->>'voided_at' IS NULL
                            ), '[]'::jsonb),
                            'allocation_history', COALESCE(p.value->'allocations', '[]'::jsonb)
                        ) ORDER BY p.ordinality
                    )
                    FROM jsonb_array_elements(c.value->'payments') WITH ORDINALITY AS p(value, ordinality)
                ), '[]'::jsonb)
            ) ORDER BY c.ordinality
        ), '[]'::jsonb)
    )
    FROM jsonb_array_elements(p_base->'clients') WITH ORDINALITY AS c(value, ordinality);
$$;

CREATE OR REPLACE FUNCTION adquisiciones.get_route_settlement_detail(
    p_settlement_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
BEGIN
    RETURN adquisiciones.filter_route_settlement_payment_allocations(
        adquisiciones.get_route_settlement_detail_active_state_base(p_settlement_id)
    );
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail(uuid)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_route_settlement_detail(uuid) TO authenticated;
