-- Fase 3E.2 ajuste: no exponer saldo acumulado historico mientras pagos
-- solo cubren el backfill parcial reciente.

CREATE OR REPLACE VIEW comercial.vw_receivables_monthly_summary
WITH (security_invoker = true)
AS
WITH invoice_months AS (
  SELECT
    d.company_id,
    date_trunc('month', d.emission_date)::date AS month,
    ROUND(SUM(COALESCE(d.total_amount, 0)), 0) AS invoiced_amount,
    COUNT(*) AS invoices_count
  FROM integraciones.bsale_documents d
  WHERE d.document_type_id = 5
  GROUP BY d.company_id, date_trunc('month', d.emission_date)::date
), payment_months AS (
  SELECT
    dp.company_id,
    date_trunc('month', dp.payment_record_date)::date AS month,
    ROUND(SUM(dp.amount_applied), 0) AS paid_amount,
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
  NULL::numeric AS cumulative_pending,
  c.invoices_count,
  c.payments_count
FROM combined c;

GRANT SELECT ON comercial.vw_receivables_monthly_summary TO authenticated;
GRANT SELECT ON comercial.vw_receivables_monthly_summary TO service_role;
REVOKE ALL ON comercial.vw_receivables_monthly_summary FROM anon;
