-- MIGRATION: 20260630050000_backfill_route_settlement_payment_flags_and_totals.sql
-- Normaliza flags de pago antiguos y recalcula totales/estados de rendiciones existentes.

-- 1) Normalizar items existentes. Idempotente: repetirlo no cambia resultados ya correctos.
UPDATE adquisiciones.route_settlement_items
SET
    transfer_confirmed = CASE
        WHEN status = 'TRANSFER_CONFIRMED' THEN true
        ELSE transfer_confirmed
    END,
    check_received = CASE
        WHEN status = 'CHECK_RECEIVED' THEN true
        ELSE check_received
    END,
    received_amount = CASE
        WHEN status = 'TRANSFER_CONFIRMED' AND COALESCE(received_amount, 0) = 0 THEN expected_amount
        WHEN status = 'CHECK_RECEIVED' AND COALESCE(received_amount, 0) = 0 THEN expected_amount
        ELSE COALESCE(received_amount, 0)
    END,
    difference_amount = CASE
        WHEN status = 'TRANSFER_CONFIRMED' THEN 0
        WHEN status = 'CHECK_RECEIVED' AND difference_amount IS NULL THEN 0
        WHEN status = 'PAID_CASH' AND COALESCE(received_amount, 0) = expected_amount THEN 0
        ELSE COALESCE(difference_amount, expected_amount - COALESCE(received_amount, 0))
    END,
    is_pending = CASE
        WHEN status IN ('PAID_CASH', 'TRANSFER_CONFIRMED', 'CHECK_RECEIVED') THEN false
        ELSE COALESCE(is_pending, false)
    END
WHERE status IN ('PAID_CASH', 'TRANSFER_CONFIRMED', 'CHECK_RECEIVED')
   OR transfer_confirmed IS NULL
   OR check_received IS NULL
   OR received_amount IS NULL
   OR difference_amount IS NULL
   OR is_pending IS NULL;

-- 2) Recalcular totales y estado para todas las rendiciones no terminales.
WITH settlement_summary AS (
    SELECT
        s.id AS settlement_id,
        COALESCE(SUM(i.expected_amount), 0) AS total_route_amount,
        COALESCE(SUM(i.expected_amount) FILTER (WHERE i.expected_payment_method = 'CASH'), 0) AS total_cash_expected,
        COALESCE(SUM(i.expected_amount) FILTER (WHERE i.expected_payment_method = 'CHECK'), 0) AS total_check_expected,
        COALESCE(SUM(i.expected_amount) FILTER (WHERE i.expected_payment_method = 'TRANSFER'), 0) AS total_transfer_expected,
        COALESCE(SUM(i.expected_amount) FILTER (WHERE i.expected_payment_method = 'CREDIT'), 0) AS total_credit_amount,
        COALESCE(SUM(i.received_amount) FILTER (WHERE i.expected_payment_method = 'CASH'), 0) AS total_cash_received,
        COALESCE(SUM(i.received_amount) FILTER (WHERE i.expected_payment_method = 'CHECK'), 0) AS total_check_received,
        COALESCE(SUM(i.expected_amount) FILTER (
            WHERE i.expected_payment_method = 'TRANSFER'
              AND (i.status = 'TRANSFER_CONFIRMED' OR COALESCE(i.transfer_confirmed, false) = true)
        ), 0) AS total_transfer_confirmed,
        COALESCE(SUM(i.difference_amount) FILTER (WHERE i.expected_payment_method = 'CASH'), 0) AS total_cash_difference,
        COALESCE(SUM(i.difference_amount) FILTER (WHERE i.expected_payment_method = 'CHECK'), 0) AS total_check_difference,
        COALESCE(SUM(i.expected_amount) FILTER (
            WHERE i.expected_payment_method = 'TRANSFER'
              AND i.status <> 'TRANSFER_CONFIRMED'
              AND COALESCE(i.transfer_confirmed, false) = false
        ), 0) AS total_transfer_pending,
        COALESCE(SUM(i.expected_amount) FILTER (
            WHERE i.expected_payment_method IN ('CASH', 'CHECK')
              AND (
                COALESCE(i.is_pending, false) = true
                OR i.status IN ('PENDING_PAYMENT', 'CHECK_PENDING', 'REVIEW_REQUIRED')
                OR COALESCE(i.difference_amount, 0) <> 0
              )
        ), 0) AS total_cash_check_pending,
        COUNT(i.id) AS total_invoices,
        COUNT(i.id) FILTER (WHERE i.expected_payment_method IN ('CASH', 'TRANSFER', 'CHECK')) AS total_rendible_count,
        COUNT(*) FILTER (
            WHERE (i.expected_payment_method = 'CASH' AND i.status = 'PAID_CASH')
               OR (i.expected_payment_method = 'TRANSFER' AND i.status = 'TRANSFER_CONFIRMED')
               OR (i.expected_payment_method = 'CHECK' AND i.status = 'CHECK_RECEIVED')
        ) AS paid_rendible_count,
        COUNT(*) FILTER (
            WHERE i.expected_payment_method IN ('CASH', 'TRANSFER', 'CHECK')
              AND COALESCE(i.is_pending, false) = true
        ) AS pending_count,
        COUNT(*) FILTER (
            WHERE i.expected_payment_method = 'TRANSFER'
              AND i.status <> 'TRANSFER_CONFIRMED'
              AND COALESCE(i.transfer_confirmed, false) = false
        ) AS transfer_pending_count,
        COUNT(*) FILTER (
            WHERE i.expected_payment_method = 'CHECK'
              AND i.status = 'CHECK_RECEIVED'
        ) AS check_count,
        COUNT(*) FILTER (
            WHERE i.expected_payment_method IN ('CASH', 'TRANSFER', 'CHECK')
              AND (
                i.status IN ('PARTIAL_PAYMENT', 'DIFFERENCE', 'NOT_DELIVERED', 'REVIEW_REQUIRED')
                OR COALESCE(i.requires_followup, false) = true
                OR (i.expected_payment_method IN ('CASH', 'CHECK') AND COALESCE(i.difference_amount, 0) <> 0)
              )
        ) AS blocking_difference_count,
        COUNT(*) FILTER (
            WHERE i.expected_payment_method IN ('CASH', 'TRANSFER', 'CHECK')
              AND (
                COALESCE(i.is_pending, false) = true
                OR i.status IN ('PENDING_PAYMENT', 'TRANSFER_PENDING', 'CHECK_PENDING', 'REVIEW_REQUIRED')
                OR (i.expected_payment_method = 'CASH' AND (i.status <> 'PAID_CASH' OR COALESCE(i.received_amount, 0) <> i.expected_amount OR COALESCE(i.difference_amount, 0) <> 0))
                OR (i.expected_payment_method = 'TRANSFER' AND (i.status <> 'TRANSFER_CONFIRMED' OR COALESCE(i.transfer_confirmed, false) = false))
                OR (i.expected_payment_method = 'CHECK' AND (i.status <> 'CHECK_RECEIVED' OR COALESCE(i.check_received, false) = false OR COALESCE(i.difference_amount, 0) <> 0))
              )
        ) AS blocking_pending_count
    FROM adquisiciones.route_settlements s
    LEFT JOIN adquisiciones.route_settlement_items i ON i.settlement_id = s.id
    GROUP BY s.id
), recalculated AS (
    SELECT
        *,
        total_cash_difference + total_check_difference AS total_difference,
        total_transfer_pending + total_cash_check_pending AS total_pending,
        CASE
            WHEN total_rendible_count = 0 THEN 'IN_REVIEW'
            WHEN blocking_difference_count > 0 THEN 'SETTLED_WITH_DIFFERENCE'
            WHEN blocking_pending_count > 0 THEN 'IN_REVIEW'
            ELSE 'SETTLED'
        END AS recalculated_status
    FROM settlement_summary
)
UPDATE adquisiciones.route_settlements s
SET
    status = CASE
        WHEN s.status IN ('CLOSED', 'CANCELLED') THEN s.status
        ELSE r.recalculated_status
    END,
    total_route_amount = r.total_route_amount,
    total_cash_expected = r.total_cash_expected,
    total_check_expected = r.total_check_expected,
    total_transfer_expected = r.total_transfer_expected,
    total_credit_amount = r.total_credit_amount,
    total_cash_received = r.total_cash_received,
    total_check_received = r.total_check_received,
    total_transfer_confirmed = r.total_transfer_confirmed,
    total_cash_difference = r.total_cash_difference,
    total_check_difference = r.total_check_difference,
    total_transfer_pending = r.total_transfer_pending,
    total_pending = r.total_pending,
    total_difference = r.total_difference,
    total_invoices = r.total_invoices,
    paid_count = r.paid_rendible_count,
    pending_count = r.pending_count,
    difference_count = r.blocking_difference_count,
    transfer_pending_count = r.transfer_pending_count,
    check_count = r.check_count
FROM recalculated r
WHERE s.id = r.settlement_id;
