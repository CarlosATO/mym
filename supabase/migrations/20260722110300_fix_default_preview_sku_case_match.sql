CREATE OR REPLACE FUNCTION comercial.preview_default_commission_settlement(
  p_company_id uuid,
  p_seller_bsale_id bigint,
  p_period_to date,
  p_period_from date DEFAULT NULL
)
RETURNS TABLE (
  seller_bsale_id bigint, seller_name text, period_from date, period_to date,
  invoice_bsale_id bigint, invoice_number bigint, customer_name text, payment_completed_at timestamptz,
  invoice_line_id uuid, sku text, product_name text, supplier_id uuid, supplier_name text,
  commission_group_id uuid, commission_group_name text, quantity numeric, net_amount numeric,
  commission_base_amount numeric, accumulated_amount numeric, accumulated_quantity numeric,
  rule_id uuid, rule_scope text, rule_type text, range_basis text, commission_percent numeric,
  commission_amount numeric, warning_code text, warning_message text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH settings AS (
    SELECT * FROM comercial.commission_settings WHERE company_id = p_company_id AND active
  ), effective_period AS (
    SELECT COALESCE(
      p_period_from,
      (SELECT max(s.period_to) + 1 FROM comercial.commission_settlements s WHERE s.company_id = p_company_id AND s.seller_bsale_id = p_seller_bsale_id AND s.status = 'ISSUED' AND s.source IN ('NORMAL', 'ADJUSTMENT')),
      settings.first_eligible_date
    ) AS period_from
    FROM settings
  ), eligible AS (
    SELECT
      ds.seller_bsale_id, ds.seller_name, r.bsale_document_id::bigint AS invoice_bsale_id,
      r.document_number::bigint AS invoice_number, r.client_name AS customer_name,
      r.last_payment_date AS payment_completed_at, dd.id AS invoice_line_id, dd.variant_code AS sku,
      COALESCE(p.description, dd.variant_description) AS product_name, psm.supplier_id,
      supplier.business_name AS supplier_name, cgp.commission_group_id,
      commission_group.name AS commission_group_name, COALESCE(dd.quantity, 0) AS quantity,
      COALESCE(dd.net_amount, 0) AS net_amount, period.period_from
    FROM comercial.vw_customer_invoice_receivables r
    CROSS JOIN effective_period period
    JOIN integraciones.bsale_documents d ON d.company_id = r.company_id AND d.bsale_id = r.bsale_document_id AND d.document_type_id = 5
    JOIN integraciones.bsale_document_details dd ON dd.company_id = d.company_id AND dd.bsale_document_id = d.bsale_id
    JOIN integraciones.bsale_document_sellers ds ON ds.company_id = d.company_id AND ds.bsale_document_id = d.bsale_id AND ds.is_primary AND ds.seller_bsale_id = p_seller_bsale_id
    JOIN comercial.commission_seller_profiles sp ON sp.company_id = ds.company_id AND sp.seller_bsale_id = ds.seller_bsale_id AND sp.is_commissionable AND sp.active
    LEFT JOIN comercial.customer_reporting_profiles crp ON crp.company_id = r.company_id AND crp.bsale_client_id = r.bsale_client_id
    JOIN adquisiciones.products p ON p.company_id = r.company_id AND upper(p.sku) = upper(dd.variant_code) AND p.is_active
    JOIN adquisiciones.product_supplier_mappings psm ON psm.company_id = r.company_id AND psm.product_id = p.id AND psm.is_active AND psm.is_preferred
    JOIN adquisiciones.suppliers supplier ON supplier.id = psm.supplier_id
    LEFT JOIN comercial.commission_group_products cgp ON cgp.company_id = r.company_id AND cgp.product_id = p.id AND cgp.is_active AND r.last_payment_date::date >= cgp.valid_from AND (cgp.valid_to IS NULL OR r.last_payment_date::date <= cgp.valid_to)
    LEFT JOIN comercial.commission_groups commission_group ON commission_group.id = cgp.commission_group_id
    WHERE r.company_id = p_company_id AND r.receivable_status = 'PAGADA' AND r.pending_amount = 0
      AND r.last_payment_date::date BETWEEN period.period_from AND p_period_to
      AND COALESCE(crp.is_internal_account, false) = false AND COALESCE(crp.is_commissionable, true) = true
      AND NOT EXISTS (SELECT 1 FROM comercial.commission_settlement_lines locked WHERE locked.company_id = r.company_id AND locked.invoice_line_id = dd.id AND locked.line_type IN ('INVOICE', 'HISTORICAL_MARK') AND locked.eligibility_locked_at IS NOT NULL)
  ), accumulated AS (
    SELECT e.*, SUM(e.net_amount) OVER () AS total_amount, SUM(e.quantity) OVER () AS total_quantity FROM eligible e
  )
  SELECT
    a.seller_bsale_id, a.seller_name, a.period_from, p_period_to, a.invoice_bsale_id, a.invoice_number,
    a.customer_name, a.payment_completed_at, a.invoice_line_id, a.sku, a.product_name, a.supplier_id,
    COALESCE(NULLIF(a.supplier_name, ''), 'Proveedor sin nombre'), a.commission_group_id,
    a.commission_group_name, a.quantity, a.net_amount, a.net_amount, a.total_amount, a.total_quantity,
    NULL::uuid, 'GENERAL', 'FIXED_PERCENT', 'NONE', settings.default_commission_percent,
    ROUND(a.net_amount * settings.default_commission_percent / 100, 0),
    'DEFAULT_RULE_USED', 'Usando comisión general para línea sin regla específica.'
  FROM accumulated a CROSS JOIN settings;
$$;
