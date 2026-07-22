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
    SELECT e.*
    FROM effective_period period
    CROSS JOIN LATERAL comercial.get_commission_eligible_invoice_lines(p_company_id, p_seller_bsale_id, p_period_to, period.period_from) e
  ), accumulated AS (
    SELECT e.*, SUM(e.net_amount) OVER () AS total_amount, SUM(e.quantity) OVER () AS total_quantity
    FROM eligible e
  )
  SELECT
    a.seller_bsale_id, a.seller_name, period.period_from, p_period_to,
    a.invoice_bsale_id, a.invoice_number, a.customer_name, a.payment_completed_at,
    a.invoice_line_id, a.sku, a.product_name, a.supplier_id,
    COALESCE(NULLIF(supplier.business_name, ''), NULLIF(supplier.fantasy_name, ''), 'Proveedor sin nombre'),
    a.commission_group_id, commission_group.name, a.quantity, a.net_amount, a.net_amount,
    a.total_amount, a.total_quantity,
    NULL::uuid, 'GENERAL', 'FIXED_PERCENT', 'NONE', settings.default_commission_percent,
    ROUND(a.net_amount * settings.default_commission_percent / 100, 0),
    'DEFAULT_RULE_USED', 'Usando comisión general para línea sin regla específica.'
  FROM accumulated a
  CROSS JOIN settings
  CROSS JOIN effective_period period
  LEFT JOIN adquisiciones.suppliers supplier ON supplier.id = a.supplier_id
  LEFT JOIN comercial.commission_groups commission_group ON commission_group.id = a.commission_group_id;
$$;

GRANT EXECUTE ON FUNCTION comercial.preview_default_commission_settlement(uuid, bigint, date, date) TO authenticated, service_role;
