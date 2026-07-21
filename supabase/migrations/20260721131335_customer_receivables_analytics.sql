-- Fase 3E.2: Base analitica de cobranza para Cliente 360 y Consultas.
-- Las notas de credito no se descuentan todavia: se incorporaran cuando exista
-- una relacion certificada NC -> factura.

CREATE OR REPLACE VIEW comercial.vw_customer_invoice_receivables
WITH (security_invoker = true)
AS
WITH payment_agg AS (
  SELECT
    dp.company_id,
    dp.bsale_document_id,
    SUM(dp.amount_applied) AS paid_amount,
    MAX(dp.payment_record_date) AS last_payment_date,
    COUNT(DISTINCT dp.bsale_payment_id) AS payments_count
  FROM integraciones.bsale_document_payments dp
  GROUP BY dp.company_id, dp.bsale_document_id
), ranked_customers AS (
  SELECT
    c.*,
    ROW_NUMBER() OVER (
      PARTITION BY c.company_id, c.bsale_client_id
      ORDER BY
        c.is_active DESC NULLS LAST,
        c.last_bsale_sync_at DESC NULLS LAST,
        c.updated_at DESC NULLS LAST,
        c.created_at DESC NULLS LAST,
        c.id DESC
    ) AS rn
  FROM comercial.customers c
  WHERE c.source = 'BSALE'
    AND c.bsale_client_id IS NOT NULL
), invoice_base AS (
  SELECT
    d.company_id,
    d.client_id AS bsale_client_id,
    rc.id AS customer_id,
    COALESCE(NULLIF(rc.business_name, ''), NULLIF(rc.fantasy_name, ''), 'Cliente Bsale ' || d.client_id::text) AS client_name,
    d.bsale_id AS bsale_document_id,
    d.number AS document_number,
    d.document_type_id,
    d.emission_date::date AS emission_date,
    to_timestamp(NULLIF(d.raw_json ->> 'expirationDate', '')::double precision)::date AS expiration_date,
    COALESCE(d.total_amount, 0) AS total_amount,
    COALESCE(pa.paid_amount, 0) AS paid_amount,
    GREATEST(COALESCE(d.total_amount, 0) - COALESCE(pa.paid_amount, 0), 0) AS pending_amount,
    pa.last_payment_date,
    COALESCE(pa.payments_count, 0) AS payments_count,
    NULLIF(COALESCE(d.raw_json -> 'sale_condition' ->> 'id', d.raw_json -> 'saleCondition' ->> 'id'), '')::integer AS sale_condition_id,
    d.raw_json ->> 'commercialState' AS raw_commercial_state
  FROM integraciones.bsale_documents d
  LEFT JOIN payment_agg pa
    ON pa.company_id = d.company_id
   AND pa.bsale_document_id = d.bsale_id
  LEFT JOIN ranked_customers rc
    ON rc.company_id = d.company_id
   AND rc.bsale_client_id = d.client_id
   AND rc.rn = 1
  WHERE d.document_type_id = 5
    AND d.client_id IS NOT NULL
)
SELECT
  ib.company_id,
  ib.bsale_client_id,
  ib.customer_id,
  ib.client_name,
  ib.bsale_document_id,
  ib.document_number,
  ib.document_type_id,
  ib.emission_date,
  ib.expiration_date,
  ib.total_amount,
  ib.paid_amount,
  ib.pending_amount,
  ib.pending_amount <= 0 AS is_paid,
  ib.paid_amount > 0 AND ib.pending_amount > 0 AS is_partially_paid,
  ib.pending_amount > 0 AS is_pending,
  ib.pending_amount > 0 AND ib.expiration_date < current_date AS is_overdue,
  CASE
    WHEN ib.pending_amount > 0 AND ib.expiration_date < current_date THEN current_date - ib.expiration_date
    ELSE 0
  END AS days_overdue,
  CASE
    WHEN ib.pending_amount <= 0 THEN 'PAGADA'
    WHEN ib.expiration_date IS NULL THEN 'SIN_VENCIMIENTO'
    WHEN ib.pending_amount > 0 AND ib.expiration_date < current_date THEN 'VENCIDA'
    WHEN ib.paid_amount > 0 AND ib.pending_amount > 0 THEN 'PAGO_PARCIAL'
    WHEN ib.pending_amount > 0 THEN 'PENDIENTE'
    ELSE 'SIN_PAGO'
  END AS receivable_status,
  ib.last_payment_date,
  ib.payments_count,
  ib.sale_condition_id,
  sc.name AS sale_condition_name,
  ib.raw_commercial_state
FROM invoice_base ib
LEFT JOIN integraciones.bsale_sale_conditions sc
  ON sc.company_id = ib.company_id
 AND sc.bsale_id = ib.sale_condition_id;

CREATE OR REPLACE VIEW comercial.vw_customer_receivables
WITH (security_invoker = true)
AS
WITH customer_totals AS (
  SELECT
    r.company_id,
    r.bsale_client_id,
    r.customer_id,
    r.client_name,
    SUM(r.total_amount) AS total_invoiced,
    SUM(r.paid_amount) AS total_paid,
    SUM(r.pending_amount) AS total_pending,
    SUM(r.pending_amount) FILTER (WHERE r.is_overdue) AS overdue_amount,
    COUNT(*) FILTER (WHERE r.is_pending) AS pending_invoices_count,
    COUNT(*) FILTER (WHERE r.is_overdue) AS overdue_invoices_count,
    COUNT(*) FILTER (WHERE r.is_paid) AS paid_invoices_count,
    COUNT(*) FILTER (WHERE r.is_partially_paid) AS partial_payment_invoices_count,
    MAX(r.emission_date) AS last_invoice_date,
    MAX(r.last_payment_date) AS last_payment_date,
    AVG((r.last_payment_date::date - r.emission_date)::numeric) FILTER (
      WHERE r.is_paid AND r.last_payment_date IS NOT NULL AND r.emission_date IS NOT NULL
    ) AS avg_days_to_pay,
    MAX(r.days_overdue) AS max_days_overdue
  FROM comercial.vw_customer_invoice_receivables r
  GROUP BY r.company_id, r.bsale_client_id, r.customer_id, r.client_name
)
SELECT
  ct.company_id,
  ct.bsale_client_id,
  ct.customer_id,
  ct.client_name,
  COALESCE(ct.total_invoiced, 0) AS total_invoiced,
  COALESCE(ct.total_paid, 0) AS total_paid,
  COALESCE(ct.total_pending, 0) AS total_pending,
  COALESCE(ct.overdue_amount, 0) AS overdue_amount,
  ct.pending_invoices_count,
  ct.overdue_invoices_count,
  ct.paid_invoices_count,
  ct.partial_payment_invoices_count,
  ct.last_invoice_date,
  ct.last_payment_date,
  ct.avg_days_to_pay,
  COALESCE(ct.max_days_overdue, 0) AS max_days_overdue,
  CASE
    WHEN COALESCE(ct.total_pending, 0) <= 0 THEN 'SIN_DEUDA'
    WHEN COALESCE(ct.total_pending, 0) > 0 AND COALESCE(ct.overdue_amount, 0) = 0 THEN 'BAJO'
    WHEN COALESCE(ct.overdue_amount, 0) > 0 AND COALESCE(ct.max_days_overdue, 0) <= 30 THEN 'MEDIO'
    WHEN COALESCE(ct.max_days_overdue, 0) BETWEEN 31 AND 60 THEN 'ALTO'
    WHEN COALESCE(ct.max_days_overdue, 0) > 60 THEN 'CRITICO'
    ELSE 'BAJO'
  END AS risk_status,
  CASE
    WHEN COALESCE(ct.total_pending, 0) <= 0 THEN 'SIN_DEUDA_VIGENTE'
    WHEN COALESCE(ct.total_paid, 0) <= 0 AND ct.paid_invoices_count = 0 THEN 'SIN_DATOS_PAGO'
    WHEN COALESCE(ct.max_days_overdue, 0) > 60 THEN 'DEUDA_CRITICA'
    WHEN ct.overdue_invoices_count >= 2 OR COALESCE(ct.max_days_overdue, 0) > 30 THEN 'ATRASO_RECURRENTE'
    WHEN COALESCE(ct.overdue_amount, 0) > 0 THEN 'ATRASO_LEVE'
    ELSE 'PAGO_REGULAR'
  END AS payment_behavior_label
FROM customer_totals ct;

CREATE OR REPLACE VIEW comercial.vw_customer_payment_monthly_behavior
WITH (security_invoker = true)
AS
WITH ranked_customers AS (
  SELECT
    c.*,
    ROW_NUMBER() OVER (
      PARTITION BY c.company_id, c.bsale_client_id
      ORDER BY
        c.is_active DESC NULLS LAST,
        c.last_bsale_sync_at DESC NULLS LAST,
        c.updated_at DESC NULLS LAST,
        c.created_at DESC NULLS LAST,
        c.id DESC
    ) AS rn
  FROM comercial.customers c
  WHERE c.source = 'BSALE'
    AND c.bsale_client_id IS NOT NULL
), invoice_months AS (
  SELECT
    d.company_id,
    d.client_id AS bsale_client_id,
    date_trunc('month', d.emission_date)::date AS month,
    SUM(COALESCE(d.total_amount, 0)) AS invoiced_amount,
    COUNT(*) AS invoices_count
  FROM integraciones.bsale_documents d
  WHERE d.document_type_id = 5
    AND d.client_id IS NOT NULL
  GROUP BY d.company_id, d.client_id, date_trunc('month', d.emission_date)::date
), payment_months AS (
  SELECT
    dp.company_id,
    dp.client_id AS bsale_client_id,
    date_trunc('month', dp.payment_record_date)::date AS month,
    SUM(dp.amount_applied) AS paid_amount,
    COUNT(DISTINCT dp.bsale_payment_id) AS payments_count
  FROM integraciones.bsale_document_payments dp
  WHERE dp.client_id IS NOT NULL
    AND dp.payment_record_date IS NOT NULL
  GROUP BY dp.company_id, dp.client_id, date_trunc('month', dp.payment_record_date)::date
), combined AS (
  SELECT
    COALESCE(i.company_id, p.company_id) AS company_id,
    COALESCE(i.bsale_client_id, p.bsale_client_id) AS bsale_client_id,
    COALESCE(i.month, p.month) AS month,
    COALESCE(i.invoiced_amount, 0) AS invoiced_amount,
    COALESCE(p.paid_amount, 0) AS paid_amount
  FROM invoice_months i
  FULL JOIN payment_months p
    ON p.company_id = i.company_id
   AND p.bsale_client_id = i.bsale_client_id
   AND p.month = i.month
)
SELECT
  c.company_id,
  c.bsale_client_id,
  rc.id AS customer_id,
  COALESCE(NULLIF(rc.business_name, ''), NULLIF(rc.fantasy_name, ''), 'Cliente Bsale ' || c.bsale_client_id::text) AS client_name,
  c.month,
  c.invoiced_amount,
  c.paid_amount,
  c.invoiced_amount - c.paid_amount AS net_cash_gap
FROM combined c
LEFT JOIN ranked_customers rc
  ON rc.company_id = c.company_id
 AND rc.bsale_client_id = c.bsale_client_id
 AND rc.rn = 1;

CREATE OR REPLACE VIEW comercial.vw_receivables_monthly_summary
WITH (security_invoker = true)
AS
WITH invoice_months AS (
  SELECT
    d.company_id,
    date_trunc('month', d.emission_date)::date AS month,
    SUM(COALESCE(d.total_amount, 0)) AS invoiced_amount,
    COUNT(*) AS invoices_count
  FROM integraciones.bsale_documents d
  WHERE d.document_type_id = 5
  GROUP BY d.company_id, date_trunc('month', d.emission_date)::date
), payment_months AS (
  SELECT
    dp.company_id,
    date_trunc('month', dp.payment_record_date)::date AS month,
    SUM(dp.amount_applied) AS paid_amount,
    COUNT(DISTINCT dp.bsale_payment_id) AS payments_count
  FROM integraciones.bsale_document_payments dp
  WHERE dp.payment_record_date IS NOT NULL
  GROUP BY dp.company_id, date_trunc('month', dp.payment_record_date)::date
), combined AS (
  SELECT
    COALESCE(i.company_id, p.company_id) AS company_id,
    COALESCE(i.month, p.month) AS month,
    COALESCE(i.invoiced_amount, 0) AS invoiced_amount,
    COALESCE(p.paid_amount, 0) AS paid_amount,
    COALESCE(i.invoices_count, 0) AS invoices_count,
    COALESCE(p.payments_count, 0) AS payments_count
  FROM invoice_months i
  FULL JOIN payment_months p
    ON p.company_id = i.company_id
   AND p.month = i.month
)
SELECT
  c.company_id,
  c.month,
  c.invoiced_amount,
  c.paid_amount,
  c.invoiced_amount - c.paid_amount AS net_cash_gap,
  SUM(c.invoiced_amount - c.paid_amount) OVER (
    PARTITION BY c.company_id
    ORDER BY c.month
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS cumulative_pending,
  c.invoices_count,
  c.payments_count
FROM combined c;

GRANT SELECT ON comercial.vw_customer_invoice_receivables TO authenticated;
GRANT SELECT ON comercial.vw_customer_invoice_receivables TO service_role;
GRANT SELECT ON comercial.vw_customer_receivables TO authenticated;
GRANT SELECT ON comercial.vw_customer_receivables TO service_role;
GRANT SELECT ON comercial.vw_customer_payment_monthly_behavior TO authenticated;
GRANT SELECT ON comercial.vw_customer_payment_monthly_behavior TO service_role;
GRANT SELECT ON comercial.vw_receivables_monthly_summary TO authenticated;
GRANT SELECT ON comercial.vw_receivables_monthly_summary TO service_role;

REVOKE ALL ON comercial.vw_customer_invoice_receivables FROM anon;
REVOKE ALL ON comercial.vw_customer_receivables FROM anon;
REVOKE ALL ON comercial.vw_customer_payment_monthly_behavior FROM anon;
REVOKE ALL ON comercial.vw_receivables_monthly_summary FROM anon;
