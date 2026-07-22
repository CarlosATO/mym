CREATE OR REPLACE FUNCTION comercial.resolve_commission_rule(
  p_company_id uuid,
  p_seller_profile_id uuid,
  p_product_id uuid,
  p_supplier_id uuid,
  p_commission_group_id uuid,
  p_effective_date date,
  p_accumulated_amount numeric,
  p_accumulated_quantity numeric
)
RETURNS TABLE (
  rule_id uuid,
  rule_scope text,
  rule_type text,
  range_basis text,
  commission_percent numeric,
  priority integer,
  source_label text,
  warning_code text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH candidate AS (
    SELECT r.*
    FROM comercial.commission_rules r
    WHERE r.company_id = p_company_id
      AND r.is_active
      AND p_effective_date >= r.valid_from
      AND (r.valid_to IS NULL OR p_effective_date <= r.valid_to)
      AND (r.seller_profile_id IS NULL OR r.seller_profile_id = p_seller_profile_id)
      AND (
        (r.rule_scope = 'PRODUCT' AND r.product_id = p_product_id)
        OR (r.rule_scope = 'GROUP' AND r.commission_group_id = p_commission_group_id)
        OR (r.rule_scope = 'SUPPLIER' AND r.supplier_id = p_supplier_id)
        OR r.rule_scope = 'GENERAL'
      )
      AND (
        r.rule_type = 'FIXED_PERCENT'
        OR (r.rule_type = 'RANGE_BY_AMOUNT' AND p_accumulated_amount >= r.min_amount AND (r.max_amount IS NULL OR p_accumulated_amount <= r.max_amount))
        OR (r.rule_type = 'RANGE_BY_QUANTITY' AND p_accumulated_quantity >= r.min_quantity AND (r.max_quantity IS NULL OR p_accumulated_quantity <= r.max_quantity))
      )
    ORDER BY
      CASE r.rule_scope WHEN 'PRODUCT' THEN 4 WHEN 'GROUP' THEN 3 WHEN 'SUPPLIER' THEN 2 ELSE 1 END DESC,
      (r.seller_profile_id IS NOT NULL) DESC,
      r.priority DESC,
      r.valid_from DESC,
      r.id
    LIMIT 1
  )
  SELECT
    candidate.id,
    candidate.rule_scope,
    candidate.rule_type,
    candidate.range_basis,
    candidate.commission_percent,
    candidate.priority,
    'Regla ' || lower(candidate.rule_scope),
    CASE WHEN candidate.rule_scope = 'GENERAL' THEN 'DEFAULT_RULE_USED' END
  FROM candidate
  UNION ALL
  SELECT
    NULL,
    'GENERAL',
    'FIXED_PERCENT',
    'NONE',
    settings.default_commission_percent,
    0,
    'Comisión general',
    'DEFAULT_RULE_USED'
  FROM comercial.commission_settings settings
  WHERE settings.company_id = p_company_id
    AND settings.active
    AND NOT EXISTS (SELECT 1 FROM candidate);
$$;

CREATE OR REPLACE FUNCTION comercial.preview_commission_settlement(
  p_company_id uuid,
  p_seller_bsale_id bigint,
  p_period_to date,
  p_period_from date DEFAULT NULL
)
RETURNS TABLE (
  seller_bsale_id bigint,
  seller_name text,
  period_from date,
  period_to date,
  invoice_bsale_id bigint,
  invoice_number bigint,
  customer_name text,
  payment_completed_at timestamptz,
  invoice_line_id uuid,
  sku text,
  product_name text,
  supplier_id uuid,
  supplier_name text,
  commission_group_id uuid,
  commission_group_name text,
  quantity numeric,
  net_amount numeric,
  commission_base_amount numeric,
  accumulated_amount numeric,
  accumulated_quantity numeric,
  rule_id uuid,
  rule_scope text,
  rule_type text,
  range_basis text,
  commission_percent numeric,
  commission_amount numeric,
  warning_code text,
  warning_message text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH settings AS (
    SELECT *
    FROM comercial.commission_settings
    WHERE company_id = p_company_id AND active
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
    SELECT
      e.*,
      SUM(e.net_amount) OVER (PARTITION BY e.product_id) AS product_accumulated_amount,
      SUM(e.quantity) OVER (PARTITION BY e.product_id) AS product_accumulated_quantity,
      SUM(e.net_amount) OVER (PARTITION BY e.commission_group_id) AS group_accumulated_amount,
      SUM(e.quantity) OVER (PARTITION BY e.commission_group_id) AS group_accumulated_quantity,
      SUM(e.net_amount) OVER (PARTITION BY e.supplier_id) AS supplier_accumulated_amount,
      SUM(e.quantity) OVER (PARTITION BY e.supplier_id) AS supplier_accumulated_quantity,
      SUM(e.net_amount) OVER () AS general_accumulated_amount,
      SUM(e.quantity) OVER () AS general_accumulated_quantity
    FROM eligible e
  )
  SELECT
    a.seller_bsale_id,
    a.seller_name,
    period.period_from,
    p_period_to,
    a.invoice_bsale_id,
    a.invoice_number,
    a.customer_name,
    a.payment_completed_at,
    a.invoice_line_id,
    a.sku,
    a.product_name,
    a.supplier_id,
    COALESCE(NULLIF(supplier.business_name, ''), NULLIF(supplier.fantasy_name, ''), 'Proveedor sin nombre') AS supplier_name,
    a.commission_group_id,
    commission_group.name AS commission_group_name,
    a.quantity,
    a.net_amount,
    a.net_amount AS commission_base_amount,
    COALESCE(rule_candidate.accumulated_amount, a.general_accumulated_amount),
    COALESCE(rule_candidate.accumulated_quantity, a.general_accumulated_quantity),
    rule_candidate.id,
    COALESCE(rule_candidate.rule_scope, 'GENERAL'),
    COALESCE(rule_candidate.rule_type, 'FIXED_PERCENT'),
    COALESCE(rule_candidate.range_basis, 'NONE'),
    COALESCE(rule_candidate.commission_percent, settings.default_commission_percent),
    ROUND(a.net_amount * COALESCE(rule_candidate.commission_percent, settings.default_commission_percent) / 100, 0),
    CASE WHEN rule_candidate.id IS NULL OR rule_candidate.rule_scope = 'GENERAL' THEN 'DEFAULT_RULE_USED' END,
    CASE WHEN rule_candidate.id IS NULL OR rule_candidate.rule_scope = 'GENERAL' THEN 'Usando comisión general para línea sin regla específica.' END
  FROM accumulated a
  CROSS JOIN settings
  CROSS JOIN effective_period period
  LEFT JOIN adquisiciones.suppliers supplier ON supplier.id = a.supplier_id
  LEFT JOIN comercial.commission_groups commission_group ON commission_group.id = a.commission_group_id
  LEFT JOIN LATERAL (
    SELECT
      r.*,
      CASE r.rule_scope
        WHEN 'PRODUCT' THEN a.product_accumulated_amount
        WHEN 'GROUP' THEN a.group_accumulated_amount
        WHEN 'SUPPLIER' THEN a.supplier_accumulated_amount
        ELSE a.general_accumulated_amount
      END AS accumulated_amount,
      CASE r.rule_scope
        WHEN 'PRODUCT' THEN a.product_accumulated_quantity
        WHEN 'GROUP' THEN a.group_accumulated_quantity
        WHEN 'SUPPLIER' THEN a.supplier_accumulated_quantity
        ELSE a.general_accumulated_quantity
      END AS accumulated_quantity
    FROM comercial.commission_rules r
    WHERE r.company_id = p_company_id
      AND r.is_active
      AND a.payment_completed_at::date >= r.valid_from
      AND (r.valid_to IS NULL OR a.payment_completed_at::date <= r.valid_to)
      AND (r.seller_profile_id IS NULL OR r.seller_profile_id = a.seller_profile_id)
      AND (
        (r.rule_scope = 'PRODUCT' AND r.product_id = a.product_id)
        OR (r.rule_scope = 'GROUP' AND r.commission_group_id = a.commission_group_id)
        OR (r.rule_scope = 'SUPPLIER' AND r.supplier_id = a.supplier_id)
        OR r.rule_scope = 'GENERAL'
      )
      AND (
        r.rule_type = 'FIXED_PERCENT'
        OR (r.rule_type = 'RANGE_BY_AMOUNT' AND (CASE r.rule_scope WHEN 'PRODUCT' THEN a.product_accumulated_amount WHEN 'GROUP' THEN a.group_accumulated_amount WHEN 'SUPPLIER' THEN a.supplier_accumulated_amount ELSE a.general_accumulated_amount END) >= r.min_amount AND (r.max_amount IS NULL OR (CASE r.rule_scope WHEN 'PRODUCT' THEN a.product_accumulated_amount WHEN 'GROUP' THEN a.group_accumulated_amount WHEN 'SUPPLIER' THEN a.supplier_accumulated_amount ELSE a.general_accumulated_amount END) <= r.max_amount))
        OR (r.rule_type = 'RANGE_BY_QUANTITY' AND (CASE r.rule_scope WHEN 'PRODUCT' THEN a.product_accumulated_quantity WHEN 'GROUP' THEN a.group_accumulated_quantity WHEN 'SUPPLIER' THEN a.supplier_accumulated_quantity ELSE a.general_accumulated_quantity END) >= r.min_quantity AND (r.max_quantity IS NULL OR (CASE r.rule_scope WHEN 'PRODUCT' THEN a.product_accumulated_quantity WHEN 'GROUP' THEN a.group_accumulated_quantity WHEN 'SUPPLIER' THEN a.supplier_accumulated_quantity ELSE a.general_accumulated_quantity END) <= r.max_quantity))
      )
    ORDER BY
      CASE r.rule_scope WHEN 'PRODUCT' THEN 4 WHEN 'GROUP' THEN 3 WHEN 'SUPPLIER' THEN 2 ELSE 1 END DESC,
      (r.seller_profile_id IS NOT NULL) DESC,
      r.priority DESC,
      r.valid_from DESC,
      r.id
    LIMIT 1
  ) rule_candidate ON true;
$$;

GRANT EXECUTE ON FUNCTION comercial.resolve_commission_rule(uuid, uuid, uuid, uuid, uuid, date, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION comercial.preview_commission_settlement(uuid, bigint, date, date) TO authenticated, service_role;
