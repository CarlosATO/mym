-- Read-only route settlement detail grouped by Bsale customer.
-- Legacy receipt fields are exposed separately and never converted into payments.

CREATE OR REPLACE FUNCTION adquisiciones.get_route_settlement_detail(
    p_settlement_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, integraciones, core, portal
AS $$
DECLARE
    v_actor_user_id uuid := auth.uid();
    v_company_id uuid;
    v_result jsonb;
BEGIN
    IF v_actor_user_id IS NULL THEN
        RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE = '28000';
    END IF;

    IF p_settlement_id IS NULL THEN
        RAISE EXCEPTION 'settlement_id es obligatorio.';
    END IF;

    SELECT s.company_id
    INTO v_company_id
    FROM adquisiciones.route_settlements s
    WHERE s.id = p_settlement_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rendición no encontrada.';
    END IF;

    IF NOT core.has_company_access(v_actor_user_id, v_company_id) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa de la rendición.';
    END IF;

    IF NOT portal.user_has_permission(
        v_actor_user_id,
        'adquisiciones.route_settlements.view'
    ) THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para visualizar rendiciones.';
    END IF;

    WITH settlement_scope AS (
        SELECT
            s.id,
            s.company_id,
            s.settlement_number,
            s.route_guide_id,
            s.settlement_date,
            s.workflow_status,
            s.financial_result,
            s.status,
            s.notes,
            g.guide_number AS route_guide_number,
            g.guide_date
        FROM adquisiciones.route_settlements s
        JOIN logistica.route_guides g
          ON g.id = s.route_guide_id
         AND g.company_id = s.company_id
        WHERE s.id = p_settlement_id
          AND s.company_id = v_company_id
    ),
    invoice_facts AS (
        SELECT
            si.company_id,
            si.settlement_id,
            si.id AS settlement_item_id,
            si.route_guide_item_id,
            si.invoice_number,
            si.customer_name,
            si.customer_bsale_id,
            si.expected_payment_method,
            si.expected_amount,
            si.status AS legacy_status,
            si.received_amount AS legacy_received_amount,
            si.difference_amount AS legacy_difference_amount,
            si.notes AS legacy_notes,
            gi.line_number,
            COALESCE(active.applied_amount, 0)::numeric(14,2) AS applied_amount,
            GREATEST(si.expected_amount - COALESCE(active.applied_amount, 0), 0)::numeric(14,2)
                AS pending_amount,
            CASE
                WHEN COALESCE(active.applied_amount, 0) = 0 THEN 'PENDING'
                WHEN COALESCE(active.applied_amount, 0) < si.expected_amount THEN 'PARTIAL'
                ELSE 'PAID'
            END AS allocation_result
        FROM adquisiciones.route_settlement_items si
        JOIN settlement_scope ss
          ON ss.id = si.settlement_id
         AND ss.company_id = si.company_id
        JOIN logistica.route_guide_items gi
          ON gi.id = si.route_guide_item_id
         AND gi.route_guide_id = ss.route_guide_id
         AND gi.company_id = ss.company_id
        LEFT JOIN LATERAL (
            SELECT sum(a.amount_applied) AS applied_amount
            FROM adquisiciones.route_settlement_payment_allocations a
            JOIN adquisiciones.route_settlement_payments p
              ON p.id = a.payment_id
             AND p.company_id = a.company_id
             AND p.settlement_id = a.settlement_id
             AND p.customer_bsale_id = a.customer_bsale_id
            WHERE a.company_id = si.company_id
              AND a.settlement_id = si.settlement_id
              AND a.settlement_item_id = si.id
              AND a.voided_at IS NULL
              AND p.verification_status <> 'VOIDED'
        ) active ON true
    ),
    invoice_payloads AS (
        SELECT
            i.customer_bsale_id,
            jsonb_agg(
                jsonb_build_object(
                    'settlement_item_id', i.settlement_item_id,
                    'route_guide_item_id', i.route_guide_item_id,
                    'invoice_number', i.invoice_number,
                    'expected_payment_method', i.expected_payment_method,
                    'expected_amount', i.expected_amount,
                    'customer_bsale_id', i.customer_bsale_id,
                    'applied_amount', i.applied_amount,
                    'pending_amount', i.pending_amount,
                    'result', i.allocation_result,
                    'legacy_status', i.legacy_status,
                    'legacy_received_amount', i.legacy_received_amount,
                    'legacy_difference_amount', i.legacy_difference_amount,
                    'legacy_notes', i.legacy_notes
                ) ORDER BY i.line_number, i.invoice_number, i.settlement_item_id
            ) AS invoices
        FROM invoice_facts i
        GROUP BY i.customer_bsale_id
    ),
    payment_facts AS (
        SELECT
            p.company_id,
            p.settlement_id,
            p.customer_bsale_id,
            p.id,
            p.payment_method_received,
            p.amount_received,
            p.verification_status,
            p.received_at,
            p.reference_number,
            p.bank_name,
            p.check_number,
            p.check_date,
            p.notes,
            p.custody_user_id,
            p.custody_received_at,
            p.voided_at,
            p.void_reason,
            COALESCE(active.applied_amount, 0)::numeric(14,2) AS active_applied_amount,
            COALESCE(allocation_history.allocations, '[]'::jsonb) AS allocations
        FROM adquisiciones.route_settlement_payments p
        JOIN settlement_scope ss
          ON ss.id = p.settlement_id
         AND ss.company_id = p.company_id
        LEFT JOIN LATERAL (
            SELECT sum(a.amount_applied) AS applied_amount
            FROM adquisiciones.route_settlement_payment_allocations a
            WHERE a.company_id = p.company_id
              AND a.settlement_id = p.settlement_id
              AND a.payment_id = p.id
              AND a.voided_at IS NULL
              AND p.verification_status <> 'VOIDED'
        ) active ON true
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'allocation_id', a.id,
                    'settlement_item_id', a.settlement_item_id,
                    'invoice_number', si.invoice_number,
                    'amount_applied', a.amount_applied,
                    'voided_at', a.voided_at
                ) ORDER BY a.created_at, a.id
            ) AS allocations
            FROM adquisiciones.route_settlement_payment_allocations a
            JOIN adquisiciones.route_settlement_items si
              ON si.id = a.settlement_item_id
             AND si.company_id = a.company_id
             AND si.settlement_id = a.settlement_id
             AND si.customer_bsale_id = a.customer_bsale_id
            WHERE a.company_id = p.company_id
              AND a.settlement_id = p.settlement_id
              AND a.payment_id = p.id
        ) allocation_history ON true
    ),
    payment_payloads AS (
        SELECT
            p.customer_bsale_id,
            count(*) FILTER (WHERE p.verification_status <> 'VOIDED')::integer AS payment_count,
            jsonb_agg(
                jsonb_build_object(
                    'id', p.id,
                    'payment_method_received', p.payment_method_received,
                    'amount_received', p.amount_received,
                    'amount_applied', p.active_applied_amount,
                    'unallocated_amount', CASE
                        WHEN p.verification_status = 'VOIDED' THEN 0::numeric
                        ELSE GREATEST(p.amount_received - p.active_applied_amount, 0)::numeric(14,2)
                    END,
                    'verification_status', p.verification_status,
                    'received_at', p.received_at,
                    'reference_number', p.reference_number,
                    'bank_name', p.bank_name,
                    'check_number', p.check_number,
                    'check_date', p.check_date,
                    'notes', p.notes,
                    'custody_user_id', p.custody_user_id,
                    'custody_received_at', p.custody_received_at,
                    'voided_at', p.voided_at,
                    'void_reason', p.void_reason,
                    'allocations', p.allocations
                ) ORDER BY p.received_at, p.id
            ) AS payments
        FROM payment_facts p
        GROUP BY p.customer_bsale_id
    ),
    client_rollup AS (
        SELECT
            i.customer_bsale_id,
            min(i.line_number) AS first_line_number,
            (array_agg(i.customer_name ORDER BY i.line_number, i.settlement_item_id))[1] AS customer_name,
            count(*)::integer AS invoice_count,
            sum(i.expected_amount)::numeric(14,2) AS expected_amount,
            sum(i.applied_amount)::numeric(14,2) AS applied_amount,
            sum(i.pending_amount)::numeric(14,2) AS pending_amount,
            CASE
                WHEN sum(i.applied_amount) = 0 THEN 'PENDING'
                WHEN sum(i.applied_amount) < sum(i.expected_amount) THEN 'PARTIAL'
                ELSE 'PAID'
            END AS summary_status
        FROM invoice_facts i
        GROUP BY i.customer_bsale_id
    ),
    client_payloads AS (
        SELECT jsonb_agg(
            jsonb_build_object(
                'customer_bsale_id', c.customer_bsale_id,
                'customer_name', c.customer_name,
                'rut', NULLIF(bc.code, ''),
                'invoice_count', c.invoice_count,
                'expected_amount', c.expected_amount,
                'applied_amount', c.applied_amount,
                'pending_amount', c.pending_amount,
                'payment_count', COALESCE(pp.payment_count, 0),
                'status', c.summary_status,
                'invoices', COALESCE(ip.invoices, '[]'::jsonb),
                'payments', COALESCE(pp.payments, '[]'::jsonb)
            ) ORDER BY c.first_line_number, c.customer_bsale_id
        ) AS clients
        FROM client_rollup c
        LEFT JOIN invoice_payloads ip
          ON ip.customer_bsale_id IS NOT DISTINCT FROM c.customer_bsale_id
        LEFT JOIN payment_payloads pp
          ON pp.customer_bsale_id IS NOT DISTINCT FROM c.customer_bsale_id
        LEFT JOIN integraciones.bsale_clients bc
          ON bc.company_id = v_company_id
         AND bc.bsale_client_id = c.customer_bsale_id
    ),
    settlement_totals AS (
        SELECT
            count(*)::integer AS invoice_count,
            count(DISTINCT customer_bsale_id)::integer AS customer_count,
            sum(expected_amount)::numeric(14,2) AS expected_amount,
            sum(applied_amount)::numeric(14,2) AS applied_amount,
            sum(pending_amount)::numeric(14,2) AS pending_amount
        FROM invoice_facts
    )
    SELECT jsonb_build_object(
        'settlement', jsonb_build_object(
            'id', ss.id,
            'settlement_number', ss.settlement_number,
            'route_guide_id', ss.route_guide_id,
            'route_guide_number', ss.route_guide_number,
            'guide_date', ss.guide_date,
            'settlement_date', ss.settlement_date,
            'workflow_status', ss.workflow_status,
            'financial_result', ss.financial_result,
            'status', ss.status,
            'customer_count', st.customer_count,
            'invoice_count', st.invoice_count,
            'total_expected', st.expected_amount,
            'total_applied_new', st.applied_amount,
            'total_pending_new', st.pending_amount,
            -- The new allocation model has no legacy difference concept.
            -- Allocation constraints prevent unexplained over-application.
            'total_difference_new', 0::numeric(14,2),
            'notes', ss.notes
        ),
        'clients', COALESCE(cp.clients, '[]'::jsonb)
    )
    INTO v_result
    FROM settlement_scope ss
    CROSS JOIN settlement_totals st
    CROSS JOIN client_payloads cp;

    RETURN COALESCE(v_result, jsonb_build_object(
        'settlement', NULL,
        'clients', '[]'::jsonb
    ));
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail(uuid)
    FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION adquisiciones.get_route_settlement_detail(uuid)
    TO authenticated;

COMMENT ON FUNCTION adquisiciones.get_route_settlement_detail(uuid) IS
    'Read-only route settlement detail grouped by Bsale customer; legacy receipt facts remain separate from new payments and allocations.';
