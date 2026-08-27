-- Read model for the operational queue of funds still available for deposit.
-- Deposit amount is the total cash plus selected checks. Cash deposited is
-- therefore the deposit total minus the checks explicitly linked to it.

CREATE OR REPLACE FUNCTION adquisiciones.get_pending_route_fund_deposits(
    p_company_id uuid,
    p_closure_number text DEFAULT NULL,
    p_custody_user_id uuid DEFAULT NULL,
    p_situation text DEFAULT NULL,
    p_date_from date DEFAULT NULL,
    p_date_to date DEFAULT NULL
) RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_situation text := NULLIF(upper(btrim(p_situation)), '');
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'No autorizado.'; END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'No tiene acceso a la empresa solicitada.';
    END IF;
    IF NOT portal.user_has_permission(v_actor, 'adquisiciones.route_fund_closures.view') THEN
        RAISE EXCEPTION 'No tiene permisos para consultar depósitos pendientes.';
    END IF;
    IF v_situation IS NOT NULL AND v_situation NOT IN ('PENDING', 'PARTIAL') THEN
        RAISE EXCEPTION 'Situación de depósito no permitida.';
    END IF;
    IF p_date_from IS NOT NULL AND p_date_to IS NOT NULL AND p_date_from > p_date_to THEN
        RAISE EXCEPTION 'Rango de fecha inválido.';
    END IF;

    RETURN QUERY
    WITH eligible_closures AS (
        SELECT f.*
        FROM adquisiciones.route_fund_closures f
        WHERE f.company_id = p_company_id
          AND f.status IN ('CLOSED', 'WITH_DIFFERENCE')
          AND f.closed_at IS NOT NULL
          AND (p_closure_number IS NULL OR f.closure_number ILIKE '%' || p_closure_number || '%')
          AND (p_custody_user_id IS NULL OR f.custody_user_id = p_custody_user_id)
          AND (p_date_from IS NULL OR f.created_at::date >= p_date_from)
          AND (p_date_to IS NULL OR f.created_at::date <= p_date_to)
    ), valid_checks AS (
        SELECT DISTINCT ON (i.fund_closure_id, p.id)
            i.fund_closure_id,
            p.id AS payment_id,
            i.customer_name,
            p.check_number,
            p.bank_name,
            p.check_date,
            p.amount_received
        FROM adquisiciones.route_fund_closure_items i
        JOIN eligible_closures f ON f.id = i.fund_closure_id
        JOIN adquisiciones.route_settlement_payments p ON p.id = i.payment_id
        WHERE i.released_at IS NULL
          AND i.payment_method = 'CHECK'
          AND p.payment_method_received = 'CHECK'
          AND p.company_id = p_company_id
          AND p.verification_status <> 'VOIDED'
          AND p.voided_at IS NULL
        ORDER BY i.fund_closure_id, p.id, i.created_at DESC
    ), active_check_links AS (
        SELECT DISTINCT ON (dc.payment_id)
            d.fund_closure_id,
            dc.payment_id,
            d.id AS deposit_id,
            d.amount AS deposit_amount
        FROM adquisiciones.route_fund_closure_deposit_checks dc
        JOIN adquisiciones.route_fund_closure_deposits d ON d.id = dc.deposit_id
        JOIN valid_checks c ON c.payment_id = dc.payment_id AND c.fund_closure_id = d.fund_closure_id
        WHERE d.company_id = p_company_id
          AND d.status = 'ACTIVE'
        ORDER BY dc.payment_id, d.deposit_date DESC, d.created_at DESC, d.id DESC
    ), check_totals AS (
        SELECT c.fund_closure_id,
               count(*)::integer AS checks_total_count,
               COALESCE(sum(c.amount_received), 0)::numeric(14,2) AS checks_total_amount,
               count(l.payment_id)::integer AS checks_deposited_count,
               COALESCE(sum(c.amount_received) FILTER (WHERE l.payment_id IS NOT NULL), 0)::numeric(14,2) AS checks_deposited_amount
        FROM valid_checks c
        LEFT JOIN active_check_links l ON l.payment_id = c.payment_id
        GROUP BY c.fund_closure_id
    ), deposit_facts AS (
        SELECT d.id,
               d.fund_closure_id,
               d.amount,
               d.deposit_date,
               count(l.payment_id)::integer AS linked_check_count,
               COALESCE(sum(c.amount_received), 0)::numeric(14,2) AS linked_check_amount
        FROM adquisiciones.route_fund_closure_deposits d
        JOIN eligible_closures f ON f.id = d.fund_closure_id
        LEFT JOIN active_check_links l ON l.deposit_id = d.id
        LEFT JOIN valid_checks c ON c.payment_id = l.payment_id
        WHERE d.company_id = p_company_id
          AND d.status = 'ACTIVE'
        GROUP BY d.id, d.fund_closure_id, d.amount, d.deposit_date
    ), deposit_totals AS (
        SELECT df.fund_closure_id AS fund_closure_id,
               count(*)::integer AS active_deposit_count,
               max(deposit_date) AS last_deposit_date,
               bool_or(linked_check_count = 0 AND COALESCE(ct.checks_total_count, 0) > 0) AS legacy_unresolved,
               COALESCE(sum(amount - linked_check_amount), 0)::numeric(14,2) AS cash_deposited
        FROM deposit_facts df
        LEFT JOIN check_totals ct ON ct.fund_closure_id = df.fund_closure_id
        GROUP BY df.fund_closure_id
    ), calculated AS (
        SELECT f.id,
               f.closure_number,
               f.created_at,
               f.custody_user_id,
               f.cash_delivered,
               u.nombre,
               u.apellido,
               COALESCE(ct.checks_total_count, 0) AS checks_total_count,
               COALESCE(ct.checks_total_amount, 0)::numeric(14,2) AS checks_total_amount,
               COALESCE(ct.checks_deposited_count, 0) AS checks_deposited_count,
               COALESCE(ct.checks_deposited_amount, 0)::numeric(14,2) AS checks_deposited_amount,
               COALESCE(dt.active_deposit_count, 0) AS active_deposit_count,
               dt.last_deposit_date,
               COALESCE(dt.legacy_unresolved, false) AS legacy_unresolved,
               COALESCE(dt.cash_deposited, 0)::numeric(14,2) AS cash_deposited,
               (COALESCE(ct.checks_total_count, 0) - COALESCE(ct.checks_deposited_count, 0))::integer AS checks_pending_count,
               (COALESCE(ct.checks_total_amount, 0) - COALESCE(ct.checks_deposited_amount, 0))::numeric(14,2) AS checks_pending_amount
        FROM eligible_closures f
        LEFT JOIN portal.users u ON u.id = f.custody_user_id
        LEFT JOIN check_totals ct ON ct.fund_closure_id = f.id
        LEFT JOIN deposit_totals dt ON dt.fund_closure_id = f.id
    ), safe_calculated AS (
        SELECT c.*,
               GREATEST(COALESCE(c.cash_delivered, 0) - COALESCE(c.cash_deposited, 0), 0)::numeric(14,2) AS cash_pending,
               (GREATEST(COALESCE(c.cash_delivered, 0) - COALESCE(c.cash_deposited, 0), 0) + c.checks_pending_amount)::numeric(14,2) AS total_pending
        FROM calculated c
        WHERE NOT c.legacy_unresolved
    ), available AS (
        SELECT s.*,
               COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                       'payment_id', c.payment_id,
                       'customer_name', c.customer_name,
                       'check_number', c.check_number,
                       'bank', c.bank_name,
                       'check_date', c.check_date,
                       'amount', c.amount_received
                   ) ORDER BY c.check_date, c.payment_id)
                   FROM valid_checks c
                   LEFT JOIN active_check_links l ON l.payment_id = c.payment_id
                   WHERE c.fund_closure_id = s.id AND l.payment_id IS NULL
               ), '[]'::jsonb) AS available_checks
        FROM safe_calculated s
        WHERE s.total_pending > 0
          AND (v_situation IS NULL OR (v_situation = 'PENDING' AND s.active_deposit_count = 0) OR (v_situation = 'PARTIAL' AND s.active_deposit_count > 0))
    )
    SELECT jsonb_build_object(
        'fund_closure_id', a.id,
        'fund_closure_number', a.closure_number,
        'created_at', a.created_at,
        'custodian_id', a.custody_user_id,
        'custodian_name', NULLIF(btrim(concat_ws(' ', a.nombre, a.apellido)), ''),
        'cash_delivered', a.cash_delivered,
        'cash_deposited', a.cash_deposited,
        'cash_pending', a.cash_pending,
        'checks_total_count', a.checks_total_count,
        'checks_total_amount', a.checks_total_amount,
        'checks_deposited_count', a.checks_deposited_count,
        'checks_deposited_amount', a.checks_deposited_amount,
        'checks_pending_count', a.checks_pending_count,
        'checks_pending_amount', a.checks_pending_amount,
        'total_pending', a.total_pending,
        'active_deposit_count', a.active_deposit_count,
        'last_deposit_date', a.last_deposit_date,
        'situation', CASE WHEN a.active_deposit_count = 0 THEN 'PENDING' ELSE 'PARTIAL' END,
        'reconciliation_status', 'RECONCILED',
        'available_checks', a.available_checks
    )
    FROM available a
    ORDER BY a.created_at DESC, a.id;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_pending_route_fund_deposits(uuid, text, uuid, text, date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_pending_route_fund_deposits(uuid, text, uuid, text, date, date) TO authenticated;
