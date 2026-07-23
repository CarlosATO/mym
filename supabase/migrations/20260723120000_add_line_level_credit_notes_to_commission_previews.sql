-- Agrega líneas negativas de Notas de Crédito (NC) al preview de comisiones.
-- Cada línea NC se matchea por SKU contra su factura original y se descuenta
-- línea por línea, manteniendo el vendedor y reglas de comisión de la factura.

DROP FUNCTION IF EXISTS comercial.preview_default_commission_settlement(uuid, bigint, date, date);
DROP FUNCTION IF EXISTS comercial.preview_commission_settlement(uuid, bigint, date, date);

-- 1. Crear preview_default_commission_settlement

CREATE FUNCTION comercial.preview_default_commission_settlement(
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
  commission_amount numeric, warning_code text, warning_message text,
  commission_line_type text, source_document_type text, source_document_id bigint,
  source_document_number bigint, source_detail_id uuid, original_invoice_id bigint,
  original_invoice_number bigint, adjustment_reason text
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH settings AS (
    SELECT * FROM comercial.commission_settings WHERE company_id = p_company_id AND active
  ), effective_period AS (
    SELECT COALESCE(p_period_from,
      (SELECT max(s.period_to) + 1 FROM comercial.commission_settlements s WHERE s.company_id = p_company_id AND s.seller_bsale_id = p_seller_bsale_id AND s.status = 'ISSUED' AND s.source IN ('NORMAL', 'ADJUSTMENT')),
      settings.first_eligible_date) AS period_from
    FROM settings
  ), invoice_lines AS (
    SELECT
      ds.seller_bsale_id, ds.seller_name, r.bsale_document_id::bigint AS invoice_bsale_id,
      r.document_number::bigint AS invoice_number, r.client_name AS customer_name,
      r.last_payment_date AS payment_completed_at, dd.id AS invoice_line_id, dd.variant_code AS sku,
      COALESCE(p.description, dd.variant_description) AS product_name, psm.supplier_id,
      supplier.business_name AS supplier_name, cgp.commission_group_id,
      commission_group.name AS commission_group_name, COALESCE(dd.quantity, 0) AS quantity,
      COALESCE(dd.net_amount, 0) AS net_amount, period.period_from,
      'INVOICE_LINE'::text AS commission_line_type, 'INVOICE'::text AS source_document_type,
      r.bsale_document_id::bigint AS source_document_id, r.document_number::bigint AS source_document_number,
      dd.id AS source_detail_id, r.bsale_document_id::bigint AS original_invoice_id,
      r.document_number::bigint AS original_invoice_number, NULL::text AS adjustment_reason
    FROM comercial.vw_customer_invoice_receivables r
    CROSS JOIN effective_period period
    JOIN integraciones.bsale_documents d ON d.company_id = r.company_id AND d.bsale_id = r.bsale_document_id AND d.document_type_id = 5
    JOIN integraciones.bsale_document_details dd ON dd.company_id = d.company_id AND dd.bsale_document_id = d.bsale_id
    JOIN integraciones.bsale_document_sellers ds ON ds.company_id = d.company_id AND ds.bsale_document_id = d.bsale_id AND ds.is_primary AND ds.seller_bsale_id = p_seller_bsale_id
    JOIN comercial.commission_seller_profiles sp ON sp.company_id = ds.company_id AND sp.seller_bsale_id = ds.seller_bsale_id AND sp.is_commissionable AND sp.active
    LEFT JOIN comercial.customer_reporting_profiles crp ON crp.company_id = r.company_id AND crp.bsale_client_id = r.bsale_client_id
    JOIN adquisiciones.products p ON p.company_id = r.company_id AND upper(p.sku) = upper(dd.variant_code)
    JOIN adquisiciones.product_supplier_mappings psm ON psm.company_id = r.company_id AND psm.product_id = p.id AND psm.is_active AND psm.is_preferred
    JOIN adquisiciones.suppliers supplier ON supplier.id = psm.supplier_id
    LEFT JOIN comercial.commission_group_products cgp ON cgp.company_id = r.company_id AND cgp.product_id = p.id AND cgp.is_active AND r.last_payment_date::date >= cgp.valid_from AND (cgp.valid_to IS NULL OR r.last_payment_date::date <= cgp.valid_to)
    LEFT JOIN comercial.commission_groups commission_group ON commission_group.id = cgp.commission_group_id
    WHERE r.company_id = p_company_id AND r.receivable_status = 'PAGADA' AND r.pending_amount = 0
      AND r.last_payment_date::date BETWEEN period.period_from AND p_period_to
      AND COALESCE(crp.is_internal_account, false) = false AND COALESCE(crp.is_commissionable, true) = true
      AND NOT EXISTS (SELECT 1 FROM comercial.commission_settlement_lines locked WHERE locked.company_id = r.company_id AND locked.invoice_line_id = dd.id AND locked.line_type IN ('INVOICE', 'HISTORICAL_MARK') AND locked.eligibility_locked_at IS NOT NULL)
  ), credit_notes AS (
    SELECT
      ds.seller_bsale_id, ds.seller_name, r.bsale_document_id::bigint AS invoice_bsale_id,
      r.document_number::bigint AS invoice_number, r.client_name AS customer_name,
      r.last_payment_date AS payment_completed_at, nc_detail.id AS invoice_line_id,
      nc_detail.variant_code AS sku, COALESCE(p.description, nc_detail.variant_description) AS product_name,
      psm.supplier_id, supplier.business_name AS supplier_name, cgp.commission_group_id,
      commission_group.name AS commission_group_name, -ABS(COALESCE(nc_detail.quantity, 0)) AS quantity,
      -ABS(COALESCE(nc_detail.net_amount, 0)) AS net_amount, period.period_from,
      'CREDIT_NOTE_LINE'::text AS commission_line_type, 'CREDIT_NOTE'::text AS source_document_type,
      nc_doc.bsale_id::bigint AS source_document_id, nc_doc.number::bigint AS source_document_number,
      nc_detail.id AS source_detail_id, r.bsale_document_id::bigint AS original_invoice_id,
      r.document_number::bigint AS original_invoice_number, ref.reference_reason AS adjustment_reason
    FROM comercial.vw_customer_invoice_receivables r
    CROSS JOIN effective_period period
    JOIN integraciones.bsale_document_sellers ds ON ds.company_id = r.company_id AND ds.bsale_document_id = r.bsale_document_id AND ds.is_primary AND ds.seller_bsale_id = p_seller_bsale_id
    JOIN comercial.commission_seller_profiles sp ON sp.company_id = ds.company_id AND sp.seller_bsale_id = ds.seller_bsale_id AND sp.is_commissionable AND sp.active
    LEFT JOIN comercial.customer_reporting_profiles crp ON crp.company_id = r.company_id AND crp.bsale_client_id = r.bsale_client_id
    JOIN integraciones.bsale_document_references ref ON ref.company_id = r.company_id AND ref.referenced_document_number = r.document_number::text
    JOIN integraciones.bsale_documents nc_doc ON nc_doc.company_id = ref.company_id AND nc_doc.bsale_id = ref.bsale_document_id AND nc_doc.document_type_id = 2
    JOIN integraciones.bsale_document_details nc_detail ON nc_detail.company_id = nc_doc.company_id AND nc_detail.bsale_document_id = nc_doc.bsale_id AND COALESCE(nc_detail.net_amount, 0) <> 0
    JOIN integraciones.bsale_document_details inv_detail ON inv_detail.company_id = r.company_id AND inv_detail.bsale_document_id = r.bsale_document_id AND upper(inv_detail.variant_code) = upper(nc_detail.variant_code)
    LEFT JOIN adquisiciones.products p ON p.company_id = r.company_id AND upper(p.sku) = upper(nc_detail.variant_code)
    LEFT JOIN adquisiciones.product_supplier_mappings psm ON psm.company_id = r.company_id AND psm.product_id = p.id AND psm.is_active AND psm.is_preferred
    LEFT JOIN adquisiciones.suppliers supplier ON supplier.id = psm.supplier_id
    LEFT JOIN comercial.commission_group_products cgp ON cgp.company_id = r.company_id AND cgp.product_id = p.id AND cgp.is_active AND r.last_payment_date::date >= cgp.valid_from AND (cgp.valid_to IS NULL OR r.last_payment_date::date <= cgp.valid_to)
    LEFT JOIN comercial.commission_groups commission_group ON commission_group.id = cgp.commission_group_id
    WHERE r.company_id = p_company_id AND r.receivable_status = 'PAGADA' AND r.pending_amount = 0
      AND r.last_payment_date::date BETWEEN period.period_from AND p_period_to
      AND COALESCE(crp.is_internal_account, false) = false AND COALESCE(crp.is_commissionable, true) = true
      AND NOT EXISTS (SELECT 1 FROM comercial.commission_settlement_lines locked WHERE locked.company_id = r.company_id AND locked.invoice_line_id = inv_detail.id AND locked.line_type IN ('INVOICE', 'HISTORICAL_MARK') AND locked.eligibility_locked_at IS NOT NULL)
      AND nc_doc.emission_date <= p_period_to
  ), combined AS (
    SELECT * FROM invoice_lines
    UNION ALL
    SELECT * FROM credit_notes
  ), accumulated AS (
    SELECT c.*, SUM(c.net_amount) OVER () AS total_amount, SUM(c.quantity) OVER () AS total_quantity FROM combined c
  )
  SELECT
    a.seller_bsale_id, a.seller_name, a.period_from, p_period_to, a.invoice_bsale_id, a.invoice_number,
    a.customer_name, a.payment_completed_at, a.invoice_line_id, a.sku, a.product_name, a.supplier_id,
    COALESCE(NULLIF(a.supplier_name, ''), 'Proveedor sin nombre'), a.commission_group_id,
    a.commission_group_name, a.quantity, a.net_amount, a.net_amount, a.total_amount, a.total_quantity,
    NULL::uuid, 'GENERAL', 'FIXED_PERCENT', 'NONE', settings.default_commission_percent,
    ROUND(a.net_amount * settings.default_commission_percent / 100, 0),
    CASE WHEN a.commission_line_type = 'CREDIT_NOTE_LINE' THEN 'CREDIT_NOTE_LINE'
         ELSE 'DEFAULT_RULE_USED' END,
    CASE WHEN a.commission_line_type = 'CREDIT_NOTE_LINE' THEN 'Ajuste por nota de crédito asociada a la factura.'
         ELSE 'Usando comisión general para línea sin regla específica.' END,
    a.commission_line_type, a.source_document_type, a.source_document_id,
    a.source_document_number, a.source_detail_id, a.original_invoice_id,
    a.original_invoice_number, a.adjustment_reason
  FROM accumulated a CROSS JOIN settings;
$$;

-- 2. Crear preview_commission_settlement (con reglas de rango/scope)

CREATE FUNCTION comercial.preview_commission_settlement(
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
  commission_amount numeric, warning_code text, warning_message text,
  commission_line_type text, source_document_type text, source_document_id bigint,
  source_document_number bigint, source_detail_id uuid, original_invoice_id bigint,
  original_invoice_number bigint, adjustment_reason text
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH settings AS (
    SELECT * FROM comercial.commission_settings WHERE company_id = p_company_id AND active
  ), effective_period AS (
    SELECT COALESCE(p_period_from,
      (SELECT max(s.period_to) + 1 FROM comercial.commission_settlements s WHERE s.company_id = p_company_id AND s.seller_bsale_id = p_seller_bsale_id AND s.status = 'ISSUED' AND s.source IN ('NORMAL', 'ADJUSTMENT')),
      settings.first_eligible_date) AS period_from
    FROM settings
  ), invoice_lines AS (
    SELECT
      ds.seller_bsale_id, ds.seller_name, sp.id AS seller_profile_id, p.id AS product_id,
      r.bsale_document_id::bigint AS invoice_bsale_id, r.document_number::bigint AS invoice_number,
      r.client_name AS customer_name, r.last_payment_date AS payment_completed_at,
      dd.id AS invoice_line_id, dd.variant_code AS sku,
      COALESCE(p.description, dd.variant_description) AS product_name, psm.supplier_id,
      supplier.business_name AS supplier_name, cgp.commission_group_id,
      commission_group.name AS commission_group_name, COALESCE(dd.quantity, 0) AS quantity,
      COALESCE(dd.net_amount, 0) AS net_amount, period.period_from,
      'INVOICE_LINE'::text AS commission_line_type, 'INVOICE'::text AS source_document_type,
      r.bsale_document_id::bigint AS source_document_id, r.document_number::bigint AS source_document_number,
      dd.id AS source_detail_id, r.bsale_document_id::bigint AS original_invoice_id,
      r.document_number::bigint AS original_invoice_number, NULL::text AS adjustment_reason
    FROM comercial.vw_customer_invoice_receivables r
    CROSS JOIN effective_period period
    JOIN integraciones.bsale_documents d ON d.company_id = r.company_id AND d.bsale_id = r.bsale_document_id AND d.document_type_id = 5
    JOIN integraciones.bsale_document_details dd ON dd.company_id = d.company_id AND dd.bsale_document_id = d.bsale_id
    JOIN integraciones.bsale_document_sellers ds ON ds.company_id = d.company_id AND ds.bsale_document_id = d.bsale_id AND ds.is_primary AND ds.seller_bsale_id = p_seller_bsale_id
    JOIN comercial.commission_seller_profiles sp ON sp.company_id = ds.company_id AND sp.seller_bsale_id = ds.seller_bsale_id AND sp.is_commissionable AND sp.active
    LEFT JOIN comercial.customer_reporting_profiles crp ON crp.company_id = r.company_id AND crp.bsale_client_id = r.bsale_client_id
    JOIN adquisiciones.products p ON p.company_id = r.company_id AND upper(p.sku) = upper(dd.variant_code)
    JOIN adquisiciones.product_supplier_mappings psm ON psm.company_id = r.company_id AND psm.product_id = p.id AND psm.is_active AND psm.is_preferred
    JOIN adquisiciones.suppliers supplier ON supplier.id = psm.supplier_id
    LEFT JOIN comercial.commission_group_products cgp ON cgp.company_id = r.company_id AND cgp.product_id = p.id AND cgp.is_active AND r.last_payment_date::date >= cgp.valid_from AND (cgp.valid_to IS NULL OR r.last_payment_date::date <= cgp.valid_to)
    LEFT JOIN comercial.commission_groups commission_group ON commission_group.id = cgp.commission_group_id
    WHERE r.company_id = p_company_id AND r.receivable_status = 'PAGADA' AND r.pending_amount = 0
      AND r.last_payment_date::date BETWEEN period.period_from AND p_period_to
      AND COALESCE(crp.is_internal_account, false) = false AND COALESCE(crp.is_commissionable, true) = true
      AND NOT EXISTS (SELECT 1 FROM comercial.commission_settlement_lines locked WHERE locked.company_id = r.company_id AND locked.invoice_line_id = dd.id AND locked.line_type IN ('INVOICE', 'HISTORICAL_MARK') AND locked.eligibility_locked_at IS NOT NULL)
  ), credit_notes AS (
    SELECT
      ds.seller_bsale_id, ds.seller_name, sp.id AS seller_profile_id, p.id AS product_id,
      r.bsale_document_id::bigint AS invoice_bsale_id, r.document_number::bigint AS invoice_number,
      r.client_name AS customer_name, r.last_payment_date AS payment_completed_at,
      nc_detail.id AS invoice_line_id, nc_detail.variant_code AS sku,
      COALESCE(p.description, nc_detail.variant_description) AS product_name, psm.supplier_id,
      supplier.business_name AS supplier_name, cgp.commission_group_id,
      commission_group.name AS commission_group_name, -ABS(COALESCE(nc_detail.quantity, 0)) AS quantity,
      -ABS(COALESCE(nc_detail.net_amount, 0)) AS net_amount, period.period_from,
      'CREDIT_NOTE_LINE'::text AS commission_line_type, 'CREDIT_NOTE'::text AS source_document_type,
      nc_doc.bsale_id::bigint AS source_document_id, nc_doc.number::bigint AS source_document_number,
      nc_detail.id AS source_detail_id, r.bsale_document_id::bigint AS original_invoice_id,
      r.document_number::bigint AS original_invoice_number, ref.reference_reason AS adjustment_reason
    FROM comercial.vw_customer_invoice_receivables r
    CROSS JOIN effective_period period
    JOIN integraciones.bsale_document_sellers ds ON ds.company_id = r.company_id AND ds.bsale_document_id = r.bsale_document_id AND ds.is_primary AND ds.seller_bsale_id = p_seller_bsale_id
    JOIN comercial.commission_seller_profiles sp ON sp.company_id = ds.company_id AND sp.seller_bsale_id = ds.seller_bsale_id AND sp.is_commissionable AND sp.active
    LEFT JOIN comercial.customer_reporting_profiles crp ON crp.company_id = r.company_id AND crp.bsale_client_id = r.bsale_client_id
    JOIN integraciones.bsale_document_references ref ON ref.company_id = r.company_id AND ref.referenced_document_number = r.document_number::text
    JOIN integraciones.bsale_documents nc_doc ON nc_doc.company_id = ref.company_id AND nc_doc.bsale_id = ref.bsale_document_id AND nc_doc.document_type_id = 2
    JOIN integraciones.bsale_document_details nc_detail ON nc_detail.company_id = nc_doc.company_id AND nc_detail.bsale_document_id = nc_doc.bsale_id AND COALESCE(nc_detail.net_amount, 0) <> 0
    JOIN integraciones.bsale_document_details inv_detail ON inv_detail.company_id = r.company_id AND inv_detail.bsale_document_id = r.bsale_document_id AND upper(inv_detail.variant_code) = upper(nc_detail.variant_code)
    LEFT JOIN adquisiciones.products p ON p.company_id = r.company_id AND upper(p.sku) = upper(nc_detail.variant_code)
    LEFT JOIN adquisiciones.product_supplier_mappings psm ON psm.company_id = r.company_id AND psm.product_id = p.id AND psm.is_active AND psm.is_preferred
    LEFT JOIN adquisiciones.suppliers supplier ON supplier.id = psm.supplier_id
    LEFT JOIN comercial.commission_group_products cgp ON cgp.company_id = r.company_id AND cgp.product_id = p.id AND cgp.is_active AND r.last_payment_date::date >= cgp.valid_from AND (cgp.valid_to IS NULL OR r.last_payment_date::date <= cgp.valid_to)
    LEFT JOIN comercial.commission_groups commission_group ON commission_group.id = cgp.commission_group_id
    WHERE r.company_id = p_company_id AND r.receivable_status = 'PAGADA' AND r.pending_amount = 0
      AND r.last_payment_date::date BETWEEN period.period_from AND p_period_to
      AND COALESCE(crp.is_internal_account, false) = false AND COALESCE(crp.is_commissionable, true) = true
      AND NOT EXISTS (SELECT 1 FROM comercial.commission_settlement_lines locked WHERE locked.company_id = r.company_id AND locked.invoice_line_id = inv_detail.id AND locked.line_type IN ('INVOICE', 'HISTORICAL_MARK') AND locked.eligibility_locked_at IS NOT NULL)
      AND nc_doc.emission_date <= p_period_to
  ), combined AS (
    SELECT * FROM invoice_lines
    UNION ALL
    SELECT * FROM credit_notes
  ), accumulated AS (
    SELECT c.*,
      SUM(c.net_amount) OVER (PARTITION BY c.product_id) AS product_accumulated_amount,
      SUM(c.quantity) OVER (PARTITION BY c.product_id) AS product_accumulated_quantity,
      SUM(c.net_amount) OVER (PARTITION BY c.commission_group_id) AS group_accumulated_amount,
      SUM(c.quantity) OVER (PARTITION BY c.commission_group_id) AS group_accumulated_quantity,
      SUM(c.net_amount) OVER (PARTITION BY c.supplier_id) AS supplier_accumulated_amount,
      SUM(c.quantity) OVER (PARTITION BY c.supplier_id) AS supplier_accumulated_quantity,
      SUM(c.net_amount) OVER () AS general_accumulated_amount,
      SUM(c.quantity) OVER () AS general_accumulated_quantity
    FROM combined c
  )
  SELECT
    a.seller_bsale_id, a.seller_name, a.period_from, p_period_to, a.invoice_bsale_id, a.invoice_number,
    a.customer_name, a.payment_completed_at, a.invoice_line_id, a.sku, a.product_name, a.supplier_id,
    COALESCE(NULLIF(a.supplier_name, ''), 'Proveedor sin nombre'), a.commission_group_id, a.commission_group_name,
    a.quantity, a.net_amount, a.net_amount,
    COALESCE(rule_candidate.accumulated_amount, a.general_accumulated_amount),
    COALESCE(rule_candidate.accumulated_quantity, a.general_accumulated_quantity),
    rule_candidate.id, COALESCE(rule_candidate.rule_scope, 'GENERAL'), COALESCE(rule_candidate.rule_type, 'FIXED_PERCENT'),
    COALESCE(rule_candidate.range_basis, 'NONE'), COALESCE(rule_candidate.commission_percent, settings.default_commission_percent),
    ROUND(a.net_amount * COALESCE(rule_candidate.commission_percent, settings.default_commission_percent) / 100, 0),
    CASE WHEN a.commission_line_type = 'CREDIT_NOTE_LINE' THEN 'CREDIT_NOTE_LINE'
         WHEN rule_candidate.id IS NULL OR rule_candidate.rule_scope = 'GENERAL' THEN 'DEFAULT_RULE_USED'
         ELSE NULL END,
    CASE WHEN a.commission_line_type = 'CREDIT_NOTE_LINE' THEN 'Ajuste por nota de crédito asociada a la factura.'
         WHEN rule_candidate.id IS NULL OR rule_candidate.rule_scope = 'GENERAL' THEN 'Usando comisión general para línea sin regla específica.'
         ELSE NULL END,
    a.commission_line_type, a.source_document_type, a.source_document_id,
    a.source_document_number, a.source_detail_id, a.original_invoice_id,
    a.original_invoice_number, a.adjustment_reason
  FROM accumulated a
  CROSS JOIN settings
  LEFT JOIN LATERAL (
    SELECT r.*,
      CASE r.rule_scope WHEN 'PRODUCT' THEN a.product_accumulated_amount WHEN 'GROUP' THEN a.group_accumulated_amount WHEN 'SUPPLIER' THEN a.supplier_accumulated_amount ELSE a.general_accumulated_amount END AS accumulated_amount,
      CASE r.rule_scope WHEN 'PRODUCT' THEN a.product_accumulated_quantity WHEN 'GROUP' THEN a.group_accumulated_quantity WHEN 'SUPPLIER' THEN a.supplier_accumulated_quantity ELSE a.general_accumulated_quantity END AS accumulated_quantity
    FROM comercial.commission_rules r
    WHERE r.company_id = p_company_id AND r.is_active
      AND a.payment_completed_at::date >= r.valid_from AND (r.valid_to IS NULL OR a.payment_completed_at::date <= r.valid_to)
      AND (r.seller_profile_id IS NULL OR r.seller_profile_id = a.seller_profile_id)
      AND ((r.rule_scope = 'PRODUCT' AND r.product_id = a.product_id) OR (r.rule_scope = 'GROUP' AND r.commission_group_id = a.commission_group_id) OR (r.rule_scope = 'SUPPLIER' AND r.supplier_id = a.supplier_id) OR r.rule_scope = 'GENERAL')
      AND (r.rule_type = 'FIXED_PERCENT'
        OR (r.rule_type = 'RANGE_BY_AMOUNT' AND (CASE r.rule_scope WHEN 'PRODUCT' THEN a.product_accumulated_amount WHEN 'GROUP' THEN a.group_accumulated_amount WHEN 'SUPPLIER' THEN a.supplier_accumulated_amount ELSE a.general_accumulated_amount END) >= r.min_amount AND (r.max_amount IS NULL OR (CASE r.rule_scope WHEN 'PRODUCT' THEN a.product_accumulated_amount WHEN 'GROUP' THEN a.group_accumulated_amount WHEN 'SUPPLIER' THEN a.supplier_accumulated_amount ELSE a.general_accumulated_amount END) <= r.max_amount))
        OR (r.rule_type = 'RANGE_BY_QUANTITY' AND (CASE r.rule_scope WHEN 'PRODUCT' THEN a.product_accumulated_quantity WHEN 'GROUP' THEN a.group_accumulated_quantity WHEN 'SUPPLIER' THEN a.supplier_accumulated_quantity ELSE a.general_accumulated_quantity END) >= r.min_quantity AND (r.max_quantity IS NULL OR (CASE r.rule_scope WHEN 'PRODUCT' THEN a.product_accumulated_quantity WHEN 'GROUP' THEN a.group_accumulated_quantity WHEN 'SUPPLIER' THEN a.supplier_accumulated_quantity ELSE a.general_accumulated_quantity END) <= r.max_quantity)))
    ORDER BY CASE r.rule_scope WHEN 'PRODUCT' THEN 4 WHEN 'GROUP' THEN 3 WHEN 'SUPPLIER' THEN 2 ELSE 1 END DESC, (r.seller_profile_id IS NOT NULL) DESC, r.priority DESC, r.valid_from DESC, r.id
    LIMIT 1
  ) rule_candidate ON true;
$$;

GRANT EXECUTE ON FUNCTION comercial.preview_default_commission_settlement(uuid, bigint, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION comercial.preview_commission_settlement(uuid, bigint, date, date) TO authenticated, service_role;
