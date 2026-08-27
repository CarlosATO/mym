-- Only active allocations backed by active CONFIRMED payments reduce the
-- current receivable. Pending, rejected and voided payments remain history.
CREATE OR REPLACE FUNCTION adquisiciones.get_current_receivable_by_invoice(
    p_settlement_item_id uuid
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones
AS $$
WITH item AS (
    SELECT
        si.id,
        si.expected_amount,
        si.invoice_number,
        si.customer_bsale_id,
        si.settlement_id,
        si.route_guide_item_id
    FROM adquisiciones.route_settlement_items si
    WHERE si.id = $1
),
rr AS (
    SELECT COALESCE(sum(a.amount_applied), 0) AS amount
    FROM item i
    JOIN adquisiciones.route_settlement_payment_allocations a
      ON a.settlement_item_id = i.id
     AND a.voided_at IS NULL
    JOIN adquisiciones.route_settlement_payments p
      ON p.id = a.payment_id
     AND p.company_id = a.company_id
     AND p.verification_status = 'CONFIRMED'
     AND p.voided_at IS NULL
),
post AS (
    SELECT COALESCE(sum(a.amount_applied), 0) AS amount
    FROM item i
    JOIN adquisiciones.post_settlement_payment_allocations a
      ON a.settlement_item_id = i.id
     AND a.voided_at IS NULL
    JOIN adquisiciones.post_settlement_payments p
      ON p.id = a.payment_id
     AND p.company_id = a.company_id
     AND p.verification_status = 'CONFIRMED'
     AND p.voided_at IS NULL
),
history AS (
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'payment_id', p.id,
                'payment_method_received', p.payment_method_received,
                'amount_received', p.amount_received,
                'amount_applied', a.amount_applied,
                'received_at', p.received_at,
                'custody_user_id', p.custody_user_id,
                'verification_status', p.verification_status,
                'voided_at', p.voided_at
            ) ORDER BY p.received_at, p.id
        ),
        '[]'::jsonb
    ) AS payments
    FROM adquisiciones.post_settlement_payment_allocations a
    JOIN adquisiciones.post_settlement_payments p ON p.id = a.payment_id
    WHERE a.settlement_item_id = $1
)
SELECT jsonb_build_object(
    'settlement_item_id', i.id,
    'invoice_number', i.invoice_number,
    'original_amount', i.expected_amount,
    'during_settlement_confirmed', rr.amount,
    'post_settlement_confirmed', post.amount,
    'current_outstanding_amount', GREATEST(i.expected_amount - rr.amount - post.amount, 0),
    'post_settlement_history', history.payments
)
FROM item i
CROSS JOIN rr
CROSS JOIN post
CROSS JOIN history;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_current_receivable_by_invoice(uuid)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_current_receivable_by_invoice(uuid)
TO authenticated;
