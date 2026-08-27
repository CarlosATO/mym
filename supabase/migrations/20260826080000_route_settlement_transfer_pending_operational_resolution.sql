-- A complete PENDING transfer allocation resolves the invoice operationally,
-- while remaining excluded from confirmed financial coverage.

ALTER FUNCTION adquisiciones.get_route_settlement_detail(uuid)
    RENAME TO get_route_settlement_detail_transfer_review_base;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail_transfer_review_base(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION adquisiciones.get_route_settlement_detail(uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, integraciones, core, portal
AS $$
DECLARE v_base jsonb; v_result jsonb;
BEGIN
    v_base := adquisiciones.get_route_settlement_detail_transfer_review_base($1);
    WITH clients AS (
        SELECT c.ordinality AS client_order, c.value AS client,
            (SELECT jsonb_agg(i.value || jsonb_build_object(
                'invoice_result', CASE WHEN x.confirmed_amount >= (i.value->>'expected_amount')::numeric THEN 'PAID'
                    WHEN x.pending_review_amount >= (i.value->>'expected_amount')::numeric THEN 'TRANSFER_PENDING_REVIEW'
                    WHEN i.value->>'resolution_type' IS NOT NULL THEN i.value->>'invoice_result'
                    WHEN x.confirmed_amount > 0 THEN 'PENDING_PAYMENT' ELSE 'PENDING' END,
                'applied_amount', x.confirmed_amount,
                'pending_amount', GREATEST((i.value->>'expected_amount')::numeric - x.confirmed_amount, 0),
                'unapplied_amount', GREATEST((i.value->>'expected_amount')::numeric - x.confirmed_amount, 0),
                'remaining_amount', GREATEST((i.value->>'expected_amount')::numeric - x.confirmed_amount, 0),
                'result', CASE WHEN x.confirmed_amount >= (i.value->>'expected_amount')::numeric THEN 'PAID' WHEN x.confirmed_amount > 0 THEN 'PARTIAL' ELSE 'PENDING' END,
                'resolved_for_settlement', CASE WHEN x.confirmed_amount >= (i.value->>'expected_amount')::numeric THEN true
                    WHEN x.pending_review_amount >= (i.value->>'expected_amount')::numeric THEN true
                    WHEN i.value->>'resolution_type' IN ('PENDING_PAYMENT','CREDIT','NOT_DELIVERED') THEN true
                    WHEN i.value->>'resolution_type' IS NULL AND x.confirmed_amount > 0 AND x.confirmed_amount < (i.value->>'expected_amount')::numeric THEN true ELSE false END
            ) ORDER BY i.ordinality)
            FROM jsonb_array_elements(c.value->'invoices') WITH ORDINALITY i(value, ordinality)
            LEFT JOIN LATERAL (
                SELECT COALESCE(sum((a.value->>'amount_applied')::numeric) FILTER (WHERE p.value->>'verification_status' = 'CONFIRMED'), 0)::numeric(14,2) AS confirmed_amount,
                    COALESCE(sum((a.value->>'amount_applied')::numeric) FILTER (WHERE p.value->>'verification_status' = 'PENDING' AND p.value->>'payment_method_received' = 'TRANSFER'), 0)::numeric(14,2) AS pending_review_amount
                FROM jsonb_array_elements(c.value->'payments') p(value) CROSS JOIN LATERAL jsonb_array_elements(p.value->'allocations') a(value)
                WHERE a.value->>'voided_at' IS NULL AND a.value->>'settlement_item_id' = i.value->>'settlement_item_id'
            ) x ON true) AS invoices, c.value->'payments' AS payments
        FROM jsonb_array_elements(v_base->'clients') WITH ORDINALITY c(value, ordinality)
    ), rollup AS (
        SELECT client_order, client || jsonb_build_object('invoices', invoices, 'payments', payments) AS client,
            COALESCE((SELECT sum((i->>'expected_amount')::numeric) FROM jsonb_array_elements(invoices) i),0) AS expected_amount,
            COALESCE((SELECT sum((i->>'applied_amount')::numeric) FROM jsonb_array_elements(invoices) i),0) AS applied_amount,
            COALESCE((SELECT sum((i->>'unapplied_amount')::numeric) FROM jsonb_array_elements(invoices) i),0) AS pending_amount,
            COALESCE((SELECT count(*) FROM jsonb_array_elements(invoices) i WHERE i->>'resolved_for_settlement' = 'true'),0) AS resolved_count,
            COALESCE((SELECT count(*) FROM jsonb_array_elements(invoices) i WHERE COALESCE(i->>'resolved_for_settlement','false') <> 'true'),0) AS unresolved_count,
            COALESCE((SELECT count(*) FROM jsonb_array_elements(invoices) i WHERE i->>'resolution_type' = 'REVIEW_REQUIRED'),0) AS review_count
        FROM clients
    ), summary AS (
        SELECT jsonb_agg(client || jsonb_build_object('expected_amount', expected_amount, 'applied_amount', applied_amount, 'pending_amount', pending_amount, 'resolved_invoice_count', resolved_count, 'unresolved_invoice_count', unresolved_count, 'review_required_count', review_count, 'status', CASE WHEN applied_amount = 0 THEN 'PENDING' WHEN applied_amount < expected_amount THEN 'PARTIAL' ELSE 'PAID' END) ORDER BY client_order) AS clients,
            sum(expected_amount) AS expected_amount, sum(applied_amount) AS applied_amount, sum(pending_amount) AS pending_amount, sum(resolved_count)::integer AS resolved_count, sum(unresolved_count)::integer AS unresolved_count, sum(review_count)::integer AS review_count
        FROM rollup
    )
    SELECT jsonb_set(jsonb_set(v_base, '{clients}', s.clients), '{settlement}', (v_base->'settlement') || jsonb_build_object(
        'total_expected', s.expected_amount, 'total_applied_new', s.applied_amount, 'total_pending_new', s.pending_amount, 'resolved_invoice_count', s.resolved_count, 'unresolved_invoice_count', s.unresolved_count, 'review_required_count', s.review_count,
        'pending_payment_count', (SELECT count(*) FROM jsonb_array_elements(s.clients) c CROSS JOIN LATERAL jsonb_array_elements(c->'invoices') i WHERE i->>'invoice_result' = 'PENDING_PAYMENT'),
        'paid_count', (SELECT count(*) FROM jsonb_array_elements(s.clients) c CROSS JOIN LATERAL jsonb_array_elements(c->'invoices') i WHERE i->>'invoice_result' = 'PAID'),
        'partial_count', (SELECT count(*) FROM jsonb_array_elements(s.clients) c CROSS JOIN LATERAL jsonb_array_elements(c->'invoices') i WHERE i->>'invoice_result' = 'PARTIAL'),
        'can_close', s.unresolved_count = 0 AND COALESCE(v_base->'settlement'->>'workflow_status','') NOT IN ('CLOSED','CANCELLED'),
        'derived_workflow_status', CASE WHEN v_base->'settlement'->>'workflow_status' IN ('CLOSED','CANCELLED') THEN v_base->'settlement'->>'workflow_status' WHEN s.unresolved_count = 0 THEN 'READY_TO_CLOSE' ELSE 'IN_PROGRESS' END,
        'derived_financial_result', CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(s.clients) c CROSS JOIN LATERAL jsonb_array_elements(c->'invoices') i WHERE i->>'invoice_result' = 'TRANSFER_PENDING_REVIEW') THEN 'WITH_PENDING' ELSE 'BALANCED' END
    )) INTO v_result FROM summary s;
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_route_settlement_detail(uuid) TO authenticated;
