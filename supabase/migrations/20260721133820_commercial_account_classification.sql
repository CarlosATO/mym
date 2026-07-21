-- Fase 3E.2.1: clasificacion comercial de cuentas internas/relacionadas.
-- No modifica datos fuente Bsale ni comercial.customers; agrega perfil de reporte 1:1.

CREATE TABLE IF NOT EXISTS comercial.customer_reporting_profiles (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  bsale_client_id bigint NOT NULL,
  customer_id uuid REFERENCES comercial.customers(id) ON DELETE SET NULL,
  account_type text NOT NULL DEFAULT 'EXTERNAL_CUSTOMER',
  relationship_type text,
  reporting_channel text,
  reporting_seller_name text,
  is_internal_account boolean NOT NULL DEFAULT false,
  is_commissionable boolean NOT NULL DEFAULT true,
  exclude_from_external_reports boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,

  CONSTRAINT uq_customer_reporting_profiles_company_client UNIQUE (company_id, bsale_client_id),
  CONSTRAINT chk_customer_reporting_profiles_account_type CHECK (
    account_type IN ('EXTERNAL_CUSTOMER', 'INTERNAL_ACCOUNT', 'OWN_STORE', 'RELATED_COMPANY')
  ),
  CONSTRAINT chk_customer_reporting_profiles_relationship_type CHECK (
    relationship_type IS NULL OR relationship_type IN ('NONE', 'OWN_STORE', 'RELATED_COMPANY', 'INTERNAL_TRANSFER', 'ADMINISTRATION', 'OTHER')
  )
);

CREATE INDEX IF NOT EXISTS idx_customer_reporting_profiles_company_client
ON comercial.customer_reporting_profiles(company_id, bsale_client_id);

CREATE INDEX IF NOT EXISTS idx_customer_reporting_profiles_company_account_type
ON comercial.customer_reporting_profiles(company_id, account_type);

CREATE INDEX IF NOT EXISTS idx_customer_reporting_profiles_company_internal
ON comercial.customer_reporting_profiles(company_id, is_internal_account);

CREATE INDEX IF NOT EXISTS idx_customer_reporting_profiles_company_external_exclusion
ON comercial.customer_reporting_profiles(company_id, exclude_from_external_reports);

CREATE INDEX IF NOT EXISTS idx_customer_reporting_profiles_company_seller
ON comercial.customer_reporting_profiles(company_id, reporting_seller_name);

ALTER TABLE comercial.customer_reporting_profiles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE comercial.customer_reporting_profiles FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE comercial.customer_reporting_profiles FROM authenticated;

GRANT SELECT ON TABLE comercial.customer_reporting_profiles TO authenticated;
GRANT ALL ON TABLE comercial.customer_reporting_profiles TO service_role;

DROP POLICY IF EXISTS "customer_reporting_profiles company select"
ON comercial.customer_reporting_profiles;

CREATE POLICY "customer_reporting_profiles company select"
ON comercial.customer_reporting_profiles
FOR SELECT
TO authenticated
USING (core.has_company_access(auth.uid(), company_id));

DROP TRIGGER IF EXISTS set_customer_reporting_profiles_updated_at
ON comercial.customer_reporting_profiles;

CREATE TRIGGER set_customer_reporting_profiles_updated_at
BEFORE UPDATE ON comercial.customer_reporting_profiles
FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();

INSERT INTO comercial.customer_reporting_profiles (
  company_id,
  bsale_client_id,
  customer_id,
  account_type,
  relationship_type,
  reporting_channel,
  reporting_seller_name,
  is_internal_account,
  is_commissionable,
  exclude_from_external_reports,
  notes,
  updated_at
)
SELECT
  'd1000000-0000-0000-0000-000000000001'::uuid,
  643,
  c.id,
  'OWN_STORE',
  'OWN_STORE',
  'TIENDAS PROPIAS / VENTA DIRECTA',
  'ADMINISTRACION',
  true,
  false,
  true,
  'Cuenta interna/tienda propia para venta directa a publico; mantener en detalle, excluir de resumenes externos y comisiones comerciales.',
  now()
FROM comercial.customers c
WHERE c.company_id = 'd1000000-0000-0000-0000-000000000001'
  AND c.bsale_client_id = 643
ORDER BY c.is_active DESC NULLS LAST, c.last_bsale_sync_at DESC NULLS LAST, c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST, c.id DESC
LIMIT 1
ON CONFLICT (company_id, bsale_client_id) DO UPDATE
SET customer_id = EXCLUDED.customer_id,
    account_type = EXCLUDED.account_type,
    relationship_type = EXCLUDED.relationship_type,
    reporting_channel = EXCLUDED.reporting_channel,
    reporting_seller_name = EXCLUDED.reporting_seller_name,
    is_internal_account = EXCLUDED.is_internal_account,
    is_commissionable = EXCLUDED.is_commissionable,
    exclude_from_external_reports = EXCLUDED.exclude_from_external_reports,
    notes = EXCLUDED.notes,
    updated_at = now();

CREATE OR REPLACE VIEW comercial.vw_customer_invoice_receivables
WITH (security_invoker = true)
AS
WITH payment_agg AS (
  SELECT dp.company_id, dp.bsale_document_id, SUM(dp.amount_applied) AS paid_amount, MAX(dp.payment_record_date) AS last_payment_date, COUNT(DISTINCT dp.bsale_payment_id) AS payments_count
  FROM integraciones.bsale_document_payments dp
  GROUP BY dp.company_id, dp.bsale_document_id
), ranked_customers AS (
  SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.company_id, c.bsale_client_id ORDER BY c.is_active DESC NULLS LAST, c.last_bsale_sync_at DESC NULLS LAST, c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST, c.id DESC) AS rn
  FROM comercial.customers c
  WHERE c.source = 'BSALE' AND c.bsale_client_id IS NOT NULL
), ranked_group_members AS (
  SELECT cgm.company_id, cgm.bsale_client_id, cgm.group_id, cgm.relationship_type, cg.group_name, cg.group_code,
         ROW_NUMBER() OVER (PARTITION BY cgm.company_id, cgm.bsale_client_id ORDER BY cgm.is_primary DESC NULLS LAST, cgm.valid_to DESC NULLS LAST, cgm.approved_at DESC NULLS LAST, cgm.created_at DESC, cgm.id DESC) AS rn
  FROM comercial.commercial_group_members cgm
  JOIN comercial.commercial_groups cg ON cg.company_id = cgm.company_id AND cg.id = cgm.group_id
  WHERE cgm.valid_to IS NULL OR cgm.valid_to >= current_date
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
    d.raw_json ->> 'commercialState' AS raw_commercial_state,
    rc.customer_type AS customer_classification,
    rgm.group_id AS commercial_group_id,
    rgm.group_name AS commercial_group_name,
    rgm.group_code AS commercial_group_code,
    rgm.relationship_type AS commercial_relationship_type,
    COALESCE(crp.account_type, 'EXTERNAL_CUSTOMER') AS account_type,
    COALESCE(crp.relationship_type, 'NONE') AS relationship_type,
    crp.reporting_channel,
    crp.reporting_seller_name,
    COALESCE(crp.is_internal_account, false) AS is_internal_account,
    COALESCE(crp.is_commissionable, true) AS is_commissionable,
    COALESCE(crp.exclude_from_external_reports, false) AS exclude_from_external_reports
  FROM integraciones.bsale_documents d
  LEFT JOIN payment_agg pa ON pa.company_id = d.company_id AND pa.bsale_document_id = d.bsale_id
  LEFT JOIN ranked_customers rc ON rc.company_id = d.company_id AND rc.bsale_client_id = d.client_id AND rc.rn = 1
  LEFT JOIN ranked_group_members rgm ON rgm.company_id = d.company_id AND rgm.bsale_client_id = d.client_id AND rgm.rn = 1
  LEFT JOIN comercial.customer_reporting_profiles crp ON crp.company_id = d.company_id AND crp.bsale_client_id = d.client_id
  WHERE d.document_type_id = 5 AND d.client_id IS NOT NULL
)
SELECT
  ib.company_id, ib.bsale_client_id, ib.customer_id, ib.client_name, ib.bsale_document_id, ib.document_number, ib.document_type_id, ib.emission_date, ib.expiration_date, ib.total_amount, ib.paid_amount, ib.pending_amount,
  ib.pending_amount <= 0 AS is_paid,
  ib.paid_amount > 0 AND ib.pending_amount > 0 AS is_partially_paid,
  ib.pending_amount > 0 AS is_pending,
  ib.pending_amount > 0 AND ib.expiration_date < current_date AS is_overdue,
  CASE WHEN ib.pending_amount > 0 AND ib.expiration_date < current_date THEN current_date - ib.expiration_date ELSE 0 END AS days_overdue,
  CASE
    WHEN ib.pending_amount <= 0 THEN 'PAGADA'
    WHEN ib.expiration_date IS NULL THEN 'SIN_VENCIMIENTO'
    WHEN ib.pending_amount > 0 AND ib.expiration_date < current_date THEN 'VENCIDA'
    WHEN ib.paid_amount > 0 AND ib.pending_amount > 0 THEN 'PAGO_PARCIAL'
    WHEN ib.pending_amount > 0 THEN 'PENDIENTE'
    ELSE 'SIN_PAGO'
  END AS receivable_status,
  ib.last_payment_date, ib.payments_count, ib.sale_condition_id, sc.name AS sale_condition_name, ib.raw_commercial_state,
  ib.customer_classification, ib.commercial_group_id, ib.commercial_group_name, ib.commercial_group_code, ib.commercial_relationship_type,
  ib.account_type, ib.relationship_type, ib.reporting_channel, ib.reporting_seller_name, ib.is_internal_account, ib.is_commissionable, ib.exclude_from_external_reports
FROM invoice_base ib
LEFT JOIN integraciones.bsale_sale_conditions sc ON sc.company_id = ib.company_id AND sc.bsale_id = ib.sale_condition_id;

CREATE OR REPLACE VIEW comercial.vw_customer_receivables
WITH (security_invoker = true)
AS
WITH customer_totals AS (
  SELECT
    r.company_id, r.bsale_client_id, r.customer_id, r.client_name,
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
    AVG((r.last_payment_date::date - r.emission_date)::numeric) FILTER (WHERE r.is_paid AND r.last_payment_date IS NOT NULL AND r.emission_date IS NOT NULL) AS avg_days_to_pay,
    MAX(r.days_overdue) AS max_days_overdue,
    MAX(r.customer_classification) AS customer_classification,
    MIN(r.commercial_group_id::text)::uuid AS commercial_group_id,
    MAX(r.commercial_group_name) AS commercial_group_name,
    MAX(r.commercial_group_code) AS commercial_group_code,
    MAX(r.commercial_relationship_type) AS commercial_relationship_type,
    MAX(r.account_type) AS account_type,
    MAX(r.relationship_type) AS relationship_type,
    MAX(r.reporting_channel) AS reporting_channel,
    MAX(r.reporting_seller_name) AS reporting_seller_name,
    BOOL_OR(r.is_internal_account) AS is_internal_account,
    BOOL_AND(r.is_commissionable) AS is_commissionable,
    BOOL_OR(r.exclude_from_external_reports) AS exclude_from_external_reports
  FROM comercial.vw_customer_invoice_receivables r
  GROUP BY r.company_id, r.bsale_client_id, r.customer_id, r.client_name
)
SELECT
  ct.company_id, ct.bsale_client_id, ct.customer_id, ct.client_name,
  COALESCE(ct.total_invoiced, 0) AS total_invoiced,
  COALESCE(ct.total_paid, 0) AS total_paid,
  COALESCE(ct.total_pending, 0) AS total_pending,
  COALESCE(ct.overdue_amount, 0) AS overdue_amount,
  ct.pending_invoices_count, ct.overdue_invoices_count, ct.paid_invoices_count, ct.partial_payment_invoices_count,
  ct.last_invoice_date, ct.last_payment_date, ct.avg_days_to_pay, COALESCE(ct.max_days_overdue, 0) AS max_days_overdue,
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
  END AS payment_behavior_label,
  ct.customer_classification, ct.commercial_group_id, ct.commercial_group_name, ct.commercial_group_code, ct.commercial_relationship_type,
  ct.account_type, ct.relationship_type, ct.reporting_channel, ct.reporting_seller_name, ct.is_internal_account, ct.is_commissionable, ct.exclude_from_external_reports
FROM customer_totals ct;

CREATE OR REPLACE VIEW comercial.vw_customer_payment_monthly_behavior
WITH (security_invoker = true)
AS
WITH ranked_customers AS (
  SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.company_id, c.bsale_client_id ORDER BY c.is_active DESC NULLS LAST, c.last_bsale_sync_at DESC NULLS LAST, c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST, c.id DESC) AS rn
  FROM comercial.customers c
  WHERE c.source = 'BSALE' AND c.bsale_client_id IS NOT NULL
), ranked_group_members AS (
  SELECT cgm.company_id, cgm.bsale_client_id, cgm.group_id, cgm.relationship_type, cg.group_name, cg.group_code,
         ROW_NUMBER() OVER (PARTITION BY cgm.company_id, cgm.bsale_client_id ORDER BY cgm.is_primary DESC NULLS LAST, cgm.valid_to DESC NULLS LAST, cgm.approved_at DESC NULLS LAST, cgm.created_at DESC, cgm.id DESC) AS rn
  FROM comercial.commercial_group_members cgm
  JOIN comercial.commercial_groups cg ON cg.company_id = cgm.company_id AND cg.id = cgm.group_id
  WHERE cgm.valid_to IS NULL OR cgm.valid_to >= current_date
), invoice_months AS (
  SELECT d.company_id, d.client_id AS bsale_client_id, date_trunc('month', d.emission_date)::date AS month, SUM(COALESCE(d.total_amount, 0)) AS invoiced_amount
  FROM integraciones.bsale_documents d
  WHERE d.document_type_id = 5 AND d.client_id IS NOT NULL
  GROUP BY d.company_id, d.client_id, date_trunc('month', d.emission_date)::date
), payment_months AS (
  SELECT dp.company_id, dp.client_id AS bsale_client_id, date_trunc('month', dp.payment_record_date)::date AS month, SUM(dp.amount_applied) AS paid_amount
  FROM integraciones.bsale_document_payments dp
  WHERE dp.client_id IS NOT NULL AND dp.payment_record_date IS NOT NULL
  GROUP BY dp.company_id, dp.client_id, date_trunc('month', dp.payment_record_date)::date
), combined AS (
  SELECT COALESCE(i.company_id, p.company_id) AS company_id, COALESCE(i.bsale_client_id, p.bsale_client_id) AS bsale_client_id, COALESCE(i.month, p.month) AS month, COALESCE(i.invoiced_amount, 0) AS invoiced_amount, COALESCE(p.paid_amount, 0) AS paid_amount
  FROM invoice_months i
  FULL JOIN payment_months p ON p.company_id = i.company_id AND p.bsale_client_id = i.bsale_client_id AND p.month = i.month
)
SELECT
  c.company_id, c.bsale_client_id, rc.id AS customer_id,
  COALESCE(NULLIF(rc.business_name, ''), NULLIF(rc.fantasy_name, ''), 'Cliente Bsale ' || c.bsale_client_id::text) AS client_name,
  c.month, c.invoiced_amount, c.paid_amount, c.invoiced_amount - c.paid_amount AS net_cash_gap,
  rc.customer_type AS customer_classification, rgm.group_id AS commercial_group_id, rgm.group_name AS commercial_group_name, rgm.group_code AS commercial_group_code, rgm.relationship_type AS commercial_relationship_type,
  COALESCE(crp.account_type, 'EXTERNAL_CUSTOMER') AS account_type,
  COALESCE(crp.relationship_type, 'NONE') AS relationship_type,
  crp.reporting_channel,
  crp.reporting_seller_name,
  COALESCE(crp.is_internal_account, false) AS is_internal_account,
  COALESCE(crp.is_commissionable, true) AS is_commissionable,
  COALESCE(crp.exclude_from_external_reports, false) AS exclude_from_external_reports
FROM combined c
LEFT JOIN ranked_customers rc ON rc.company_id = c.company_id AND rc.bsale_client_id = c.bsale_client_id AND rc.rn = 1
LEFT JOIN ranked_group_members rgm ON rgm.company_id = c.company_id AND rgm.bsale_client_id = c.bsale_client_id AND rgm.rn = 1
LEFT JOIN comercial.customer_reporting_profiles crp ON crp.company_id = c.company_id AND crp.bsale_client_id = c.bsale_client_id;

CREATE OR REPLACE VIEW comercial.vw_receivables_reporting_summary
WITH (security_invoker = true)
AS
SELECT
  r.company_id,
  SUM(r.total_invoiced) AS total_invoiced_all,
  SUM(r.total_paid) AS total_paid_all,
  SUM(r.total_pending) AS total_pending_all,
  SUM(r.overdue_amount) AS overdue_amount_all,
  COUNT(*) FILTER (WHERE r.total_pending > 0) AS customers_with_debt_all,
  COALESCE(SUM(r.total_invoiced) FILTER (WHERE r.exclude_from_external_reports = false), 0) AS total_invoiced_external,
  COALESCE(SUM(r.total_paid) FILTER (WHERE r.exclude_from_external_reports = false), 0) AS total_paid_external,
  COALESCE(SUM(r.total_pending) FILTER (WHERE r.exclude_from_external_reports = false), 0) AS total_pending_external,
  COALESCE(SUM(r.overdue_amount) FILTER (WHERE r.exclude_from_external_reports = false), 0) AS overdue_amount_external,
  COUNT(*) FILTER (WHERE r.total_pending > 0 AND r.exclude_from_external_reports = false) AS customers_with_debt_external,
  COALESCE(SUM(r.total_invoiced) FILTER (WHERE r.is_internal_account = true OR r.exclude_from_external_reports = true), 0) AS total_invoiced_internal,
  COALESCE(SUM(r.total_paid) FILTER (WHERE r.is_internal_account = true OR r.exclude_from_external_reports = true), 0) AS total_paid_internal,
  COALESCE(SUM(r.total_pending) FILTER (WHERE r.is_internal_account = true OR r.exclude_from_external_reports = true), 0) AS total_pending_internal,
  COALESCE(SUM(r.overdue_amount) FILTER (WHERE r.is_internal_account = true OR r.exclude_from_external_reports = true), 0) AS overdue_amount_internal,
  COUNT(*) FILTER (WHERE r.total_pending > 0 AND (r.is_internal_account = true OR r.exclude_from_external_reports = true)) AS customers_with_debt_internal
FROM comercial.vw_customer_receivables r
GROUP BY r.company_id;

GRANT SELECT ON comercial.vw_customer_invoice_receivables TO authenticated;
GRANT SELECT ON comercial.vw_customer_invoice_receivables TO service_role;
GRANT SELECT ON comercial.vw_customer_receivables TO authenticated;
GRANT SELECT ON comercial.vw_customer_receivables TO service_role;
GRANT SELECT ON comercial.vw_customer_payment_monthly_behavior TO authenticated;
GRANT SELECT ON comercial.vw_customer_payment_monthly_behavior TO service_role;
GRANT SELECT ON comercial.vw_receivables_reporting_summary TO authenticated;
GRANT SELECT ON comercial.vw_receivables_reporting_summary TO service_role;

REVOKE ALL ON comercial.vw_customer_invoice_receivables FROM anon;
REVOKE ALL ON comercial.vw_customer_receivables FROM anon;
REVOKE ALL ON comercial.vw_customer_payment_monthly_behavior FROM anon;
REVOKE ALL ON comercial.vw_receivables_reporting_summary FROM anon;
