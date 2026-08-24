-- COMV2-11: read-only set-based listing for V2 settlement drafts.

CREATE OR REPLACE FUNCTION comisiones.list_settlement_drafts(
    p_company_id uuid
)
RETURNS TABLE (
    settlement_id uuid,
    seller_bsale_id bigint,
    seller_name_snapshot text,
    period_from date,
    period_to date,
    status text,
    settlement_kind text,
    total_net_amount numeric,
    total_commission_amount numeric,
    created_at timestamptz,
    lines_count bigint
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones
AS $$
DECLARE
    v_actor uuid := auth.uid();
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.read')) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'COMPANY_ACCESS_DENIED';
    END IF;

    RETURN QUERY
    SELECT s.id, s.seller_bsale_id, s.seller_name_snapshot, s.period_from,
           s.period_to, s.status, s.settlement_kind, s.total_net_amount,
           s.total_commission_amount, s.created_at, count(sl.id)::bigint
    FROM comisiones.settlements s
    LEFT JOIN comisiones.settlement_lines sl
      ON sl.company_id = s.company_id AND sl.settlement_id = s.id
    WHERE s.company_id = p_company_id
      AND s.settlement_kind = 'NORMAL'
    GROUP BY s.id
    ORDER BY s.created_at DESC, s.id DESC;
END;
$$;

REVOKE ALL ON FUNCTION comisiones.list_settlement_drafts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.list_settlement_drafts(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION comisiones.list_settlement_drafts(uuid) IS
    'COMV2-11 read-only set-based settlement draft listing; never reads V1 settlement tables.';
