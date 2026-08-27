-- The pending-funds read model needs the internal V1 history table to exclude
-- terminal checks, but callers must not receive direct table access.
CREATE OR REPLACE FUNCTION adquisiciones.get_pending_route_fund_groups(p_company_id uuid)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, integraciones, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'No autorizado.';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'No tiene acceso a la empresa solicitada.';
    END IF;
    IF NOT portal.user_has_permission(v_actor, 'adquisiciones.route_fund_closures.view') THEN
        RAISE EXCEPTION 'No tiene permisos para consultar cierres de fondos.';
    END IF;

    RETURN QUERY
    WITH physical AS (
        SELECT p.id AS payment_id, NULL::uuid AS post_payment_id,
               p.settlement_id, p.customer_bsale_id, p.payment_method_received,
               p.amount_received, p.custody_user_id, p.custody_received_at, p.received_at
        FROM adquisiciones.route_settlement_payments p
        JOIN adquisiciones.route_settlements s ON s.id = p.settlement_id
           AND s.company_id = p.company_id AND s.workflow_status = 'CLOSED'
        WHERE p.company_id = p_company_id
          AND p.verification_status = 'CONFIRMED'
          AND p.voided_at IS NULL
          AND p.payment_method_received IN ('CASH', 'CHECK')
          AND NOT EXISTS (
              SELECT 1
              FROM adquisiciones.route_settlement_check_status_history h
              WHERE h.payment_id = p.id
                AND h.status IN ('DEPOSITADO', 'ANULADO')
                AND h.id = (
                    SELECT h2.id
                    FROM adquisiciones.route_settlement_check_status_history h2
                    WHERE h2.payment_id = p.id
                    ORDER BY h2.changed_at DESC, h2.id DESC
                    LIMIT 1
                )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM adquisiciones.route_fund_closure_items i
              JOIN adquisiciones.route_fund_closures f ON f.id = i.fund_closure_id
              WHERE i.payment_id = p.id AND i.released_at IS NULL AND f.status <> 'CANCELLED'
          )
        UNION ALL
        SELECT NULL::uuid, p.id, p.route_settlement_id, p.customer_bsale_id,
               p.payment_method_received, p.amount_received, p.custody_user_id,
               p.custody_received_at, p.received_at
        FROM adquisiciones.post_settlement_payments p
        JOIN adquisiciones.route_settlements s ON s.id = p.route_settlement_id
           AND s.company_id = p.company_id AND s.workflow_status = 'CLOSED'
        WHERE p.company_id = p_company_id AND p.verification_status = 'CONFIRMED'
          AND p.voided_at IS NULL AND p.payment_method_received IN ('CASH', 'CHECK')
          AND NOT EXISTS (
              SELECT 1
              FROM adquisiciones.route_fund_closure_items i
              JOIN adquisiciones.route_fund_closures f ON f.id = i.fund_closure_id
              WHERE i.post_settlement_payment_id = p.id
                AND i.released_at IS NULL AND f.status <> 'CANCELLED'
          )
    ), expenses AS (
        SELECT route_settlement_id,
               COALESCE(sum(amount) FILTER (WHERE status = 'ACTIVE' AND voided_at IS NULL), 0)::numeric(14,2) AS active_route_expenses
        FROM adquisiciones.route_fund_closure_expenses
        WHERE company_id = p_company_id
        GROUP BY route_settlement_id
    ), grouped AS (
        SELECT p.settlement_id, s.settlement_number, s.settlement_date, s.route_guide_id,
               g.guide_number, p.custody_user_id, max(p.custody_received_at) AS custody_received_at,
               sum(p.amount_received) FILTER (WHERE p.payment_method_received = 'CASH') AS cash_received,
               sum(p.amount_received) FILTER (WHERE p.payment_method_received = 'CHECK') AS checks_received,
               count(*) FILTER (WHERE p.payment_method_received = 'CHECK')::integer AS check_count,
               COALESCE(e.active_route_expenses, 0)::numeric(14,2) AS active_route_expenses,
               jsonb_agg(p.payment_id) FILTER (WHERE p.payment_id IS NOT NULL) AS payment_ids,
               jsonb_agg(p.post_payment_id) FILTER (WHERE p.post_payment_id IS NOT NULL) AS post_settlement_payment_ids,
               jsonb_agg(jsonb_build_object(
                   'source_type', CASE WHEN p.post_payment_id IS NULL THEN 'ROUTE_SETTLEMENT_PAYMENT' ELSE 'POST_SETTLEMENT_PAYMENT' END,
                   'payment_id', p.payment_id, 'post_settlement_payment_id', p.post_payment_id,
                   'customer_bsale_id', p.customer_bsale_id, 'received_at', p.received_at,
                   'amount', p.amount_received, 'payment_method', p.payment_method_received
               ) ORDER BY p.received_at, p.payment_id, p.post_payment_id) AS physical_items
        FROM physical p
        JOIN adquisiciones.route_settlements s ON s.id = p.settlement_id
        JOIN logistica.route_guides g ON g.id = s.route_guide_id AND g.company_id = s.company_id
        LEFT JOIN expenses e ON e.route_settlement_id = p.settlement_id
        GROUP BY p.settlement_id, s.settlement_number, s.settlement_date, s.route_guide_id,
                 g.guide_number, p.custody_user_id, e.active_route_expenses
    )
    SELECT jsonb_build_object(
        'route_settlement_id', settlement_id, 'settlement_number', settlement_number,
        'settlement_date', settlement_date, 'route_guide_id', route_guide_id,
        'guide_number', guide_number, 'custody_user_id', custody_user_id,
        'custody_received_at', custody_received_at, 'cash_received', COALESCE(cash_received, 0),
        'checks_received', COALESCE(checks_received, 0), 'check_count', check_count,
        'active_route_expenses', active_route_expenses,
        'net_cash_pending', GREATEST(COALESCE(cash_received, 0) - active_route_expenses, 0),
        'payment_ids', COALESCE(payment_ids, '[]'::jsonb),
        'post_settlement_payment_ids', COALESCE(post_settlement_payment_ids, '[]'::jsonb),
        'physical_items', physical_items
    )
    FROM grouped
    ORDER BY settlement_date, settlement_number, custody_user_id;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_pending_route_fund_groups(uuid)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_pending_route_fund_groups(uuid)
    TO authenticated;
