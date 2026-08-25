-- COMV2-23A: Comisiones V2 must use real Bsale collections only.
-- The global commercial receivables view intentionally remains unchanged.

CREATE OR REPLACE VIEW comisiones.vw_v2_real_invoice_receivables
WITH (security_invoker = true)
AS
WITH payment_events AS (
    SELECT
        dp.company_id,
        dp.bsale_document_id,
        dp.bsale_payment_id,
        dp.amount_applied,
        dp.payment_record_date
    FROM integraciones.bsale_document_payments dp
    JOIN integraciones.bsale_payments p
      ON p.company_id = dp.company_id
     AND p.bsale_payment_id = dp.bsale_payment_id
    LEFT JOIN integraciones.bsale_payment_types pt
      ON pt.company_id = p.company_id
     AND pt.bsale_payment_type_id = COALESCE(p.payment_type_bsale_id, p.payment_type_id)
    WHERE p.state = 0
      AND dp.amount_applied > 0
      AND dp.payment_record_date IS NOT NULL
      AND (
          p.is_credit_payment IS TRUE
          OR (
              p.is_credit_payment IS FALSE
              AND pt.raw_json ->> 'isClientCredit' = '0'
          )
      )
), ordered_events AS (
    SELECT
        pe.*,
        SUM(pe.amount_applied) OVER (
            PARTITION BY pe.company_id, pe.bsale_document_id
            ORDER BY pe.payment_record_date, pe.bsale_payment_id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS accumulated_amount
    FROM payment_events pe
), payment_totals AS (
    SELECT
        oe.company_id,
        oe.bsale_document_id,
        SUM(oe.amount_applied) AS paid_amount,
        COUNT(DISTINCT oe.bsale_payment_id) AS payments_count,
        MIN(oe.payment_record_date) FILTER (
            WHERE oe.accumulated_amount >= ROUND(COALESCE(d.total_amount, 0), 0) - 1
        ) AS full_payment_date
    FROM ordered_events oe
    JOIN integraciones.bsale_documents d
      ON d.company_id = oe.company_id
     AND d.bsale_id = oe.bsale_document_id
    GROUP BY oe.company_id, oe.bsale_document_id, d.total_amount
), amounts AS (
    SELECT
        r.*,
        ROUND(COALESCE(r.total_amount, 0), 0) - ROUND(COALESCE(pt.paid_amount, 0), 0) AS raw_pending_amount,
        COALESCE(pt.paid_amount, 0) AS real_paid_amount,
        pt.payments_count AS real_payments_count,
        pt.full_payment_date AS real_full_payment_date
    FROM comercial.vw_customer_invoice_receivables r
    LEFT JOIN payment_totals pt
      ON pt.company_id = r.company_id
     AND pt.bsale_document_id = r.bsale_document_id
), classified AS (
    SELECT
        a.*,
        CASE WHEN ABS(a.raw_pending_amount) <= 1 THEN 0::numeric
             ELSE GREATEST(a.raw_pending_amount, 0) END AS real_pending_amount
    FROM amounts a
)
SELECT
    c.company_id,
    c.bsale_client_id,
    c.customer_id,
    c.client_name,
    c.bsale_document_id,
    c.document_number,
    c.document_type_id,
    c.emission_date,
    c.expiration_date,
    c.total_amount,
    c.real_paid_amount AS paid_amount,
    c.real_pending_amount AS pending_amount,
    c.real_pending_amount = 0 AS is_paid,
    c.real_paid_amount > 0 AND c.real_pending_amount > 1 AS is_partially_paid,
    c.real_pending_amount > 1 AS is_pending,
    c.real_pending_amount > 1 AND c.expiration_date < current_date AS is_overdue,
    CASE WHEN c.real_pending_amount > 1 AND c.expiration_date < current_date
         THEN current_date - c.expiration_date ELSE 0 END AS days_overdue,
    CASE
        WHEN c.real_pending_amount = 0 THEN 'PAGADA'
        WHEN c.expiration_date IS NULL THEN 'SIN_VENCIMIENTO'
        WHEN c.real_pending_amount > 1 AND c.expiration_date < current_date THEN 'VENCIDA'
        WHEN c.real_paid_amount > 0 AND c.real_pending_amount > 1 THEN 'PAGO_PARCIAL'
        WHEN c.real_pending_amount > 1 THEN 'PENDIENTE'
        ELSE 'PAGADA'
    END AS receivable_status,
    c.real_full_payment_date AS last_payment_date,
    COALESCE(c.real_payments_count, 0) AS payments_count,
    c.sale_condition_id,
    c.sale_condition_name,
    c.raw_commercial_state,
    c.customer_classification,
    c.commercial_group_id,
    c.commercial_group_name,
    c.commercial_group_code,
    c.commercial_relationship_type,
    c.account_type,
    c.relationship_type,
    c.reporting_channel,
    c.reporting_seller_name,
    c.is_internal_account,
    c.is_commissionable,
    c.exclude_from_external_reports
FROM classified c;

GRANT SELECT ON comisiones.vw_v2_real_invoice_receivables TO authenticated, service_role;
REVOKE ALL ON comisiones.vw_v2_real_invoice_receivables FROM anon;

-- Preserve the currently deployed V2 contracts while changing only their payment source.
DO $$
DECLARE
    function_definition text;
BEGIN
    SELECT pg_get_functiondef('comisiones.get_sales_line_payment_eligibility(uuid,bigint,date,date)'::regprocedure)
      INTO function_definition;
    function_definition := replace(
        function_definition,
        'comercial.vw_customer_invoice_receivables',
        'comisiones.vw_v2_real_invoice_receivables'
    );
    EXECUTE function_definition;

    SELECT pg_get_functiondef('comisiones.get_sales_period_simulation(uuid,date,date)'::regprocedure)
      INTO function_definition;
    function_definition := replace(
        function_definition,
        'comercial.vw_customer_invoice_receivables',
        'comisiones.vw_v2_real_invoice_receivables'
    );
    function_definition := replace(
        function_definition,
        '(r.last_payment_date AT TIME ZONE ''America/Santiago'')::date',
        'r.last_payment_date::date'
    );
    EXECUTE function_definition;
END;
$$;

COMMENT ON VIEW comisiones.vw_v2_real_invoice_receivables IS
    'Comisiones V2-only Bsale payment interpretation: valid active payments, client-credit discrimination, accumulated completion date, and CLP tolerance.';
