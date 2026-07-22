INSERT INTO comercial.commission_settings (
  company_id,
  default_commission_percent,
  base_amount,
  require_full_payment,
  historical_cutoff_date,
  first_eligible_date,
  active
) VALUES (
  'd1000000-0000-0000-0000-000000000001',
  1.0000,
  'NET',
  true,
  DATE '2026-06-25',
  DATE '2026-06-26',
  true
)
ON CONFLICT (company_id) DO NOTHING;

INSERT INTO comercial.commission_settlement_sequences (company_id, last_settlement_number)
VALUES ('d1000000-0000-0000-0000-000000000001', 0)
ON CONFLICT (company_id) DO NOTHING;

INSERT INTO comercial.commission_settlements (
  company_id,
  settlement_code,
  period_from,
  period_to,
  period_label,
  status,
  source,
  issued_at,
  total_net_amount,
  total_commission_amount,
  notes
) VALUES (
  'd1000000-0000-0000-0000-000000000001',
  'HISTORICO',
  DATE '2026-01-01',
  DATE '2026-06-25',
  'Historico hasta 25-06-2026',
  'ISSUED',
  'HISTORICAL',
  now(),
  0,
  0,
  'Cierre historico inicial. Facturas pagadas hasta 25-06-2026 inclusive marcadas como ya comisionadas.'
)
ON CONFLICT (company_id, settlement_code) DO NOTHING;

WITH historical_settlement AS (
  SELECT id
  FROM comercial.commission_settlements
  WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
    AND settlement_code = 'HISTORICO'
), historical_lines AS (
  SELECT
    r.company_id,
    hs.id AS settlement_id,
    seller.profile_id AS seller_profile_id,
    seller.seller_bsale_id,
    seller.seller_name,
    r.bsale_document_id::bigint AS invoice_bsale_id,
    r.document_number::bigint AS invoice_number,
    d.id AS invoice_document_id,
    dd.id AS invoice_line_id,
    r.bsale_client_id::bigint AS client_bsale_id,
    r.customer_id,
    r.client_name AS customer_name,
    product.id AS product_id,
    dd.variant_code AS sku,
    COALESCE(product.description, dd.variant_description) AS product_name,
    supplier.supplier_id,
    dd.quantity,
    dd.net_amount,
    r.last_payment_date AS payment_completed_at
  FROM comercial.vw_customer_invoice_receivables r
  JOIN integraciones.bsale_documents d
    ON d.company_id = r.company_id
   AND d.bsale_id = r.bsale_document_id
   AND d.document_type_id = 5
  JOIN integraciones.bsale_document_details dd
    ON dd.company_id = d.company_id
   AND dd.bsale_document_id = d.bsale_id
  CROSS JOIN historical_settlement hs
  LEFT JOIN LATERAL (
    SELECT
      sp.id AS profile_id,
      ds.seller_bsale_id,
      ds.seller_name
    FROM integraciones.bsale_document_sellers ds
    LEFT JOIN comercial.commission_seller_profiles sp
      ON sp.company_id = ds.company_id
     AND sp.seller_bsale_id = ds.seller_bsale_id
    WHERE ds.company_id = d.company_id
      AND ds.bsale_document_id = d.bsale_id
      AND ds.is_primary = true
    ORDER BY ds.created_at DESC, ds.id DESC
    LIMIT 1
  ) seller ON true
  LEFT JOIN LATERAL (
    SELECT p.id, p.description
    FROM adquisiciones.products p
    WHERE upper(p.sku) = upper(dd.variant_code)
    ORDER BY p.is_active DESC NULLS LAST, p.updated_at DESC NULLS LAST, p.id
    LIMIT 1
  ) product ON true
  LEFT JOIN LATERAL (
    SELECT psm.supplier_id
    FROM adquisiciones.product_supplier_mappings psm
    WHERE psm.company_id = d.company_id
      AND psm.product_id = product.id
      AND psm.is_active = true
    ORDER BY psm.is_preferred DESC, psm.updated_at DESC NULLS LAST, psm.id
    LIMIT 1
  ) supplier ON true
  WHERE r.company_id = 'd1000000-0000-0000-0000-000000000001'
    AND r.receivable_status = 'PAGADA'
    AND r.pending_amount = 0
    AND r.last_payment_date::date <= DATE '2026-06-25'
)
INSERT INTO comercial.commission_settlement_lines (
  company_id, settlement_id, line_type,
  seller_profile_id, seller_bsale_id, seller_name,
  invoice_bsale_id, invoice_number, invoice_document_id, invoice_line_id,
  client_bsale_id, customer_id, customer_name,
  product_id, sku, product_name, supplier_id,
  quantity, net_amount, commission_base_amount,
  payment_completed_at, eligibility_locked_at, metadata
)
SELECT
  hl.company_id, hl.settlement_id, 'HISTORICAL_MARK',
  hl.seller_profile_id, hl.seller_bsale_id, hl.seller_name,
  hl.invoice_bsale_id, hl.invoice_number, hl.invoice_document_id, hl.invoice_line_id,
  hl.client_bsale_id, hl.customer_id, hl.customer_name,
  hl.product_id, hl.sku, hl.product_name, hl.supplier_id,
  COALESCE(hl.quantity, 0), COALESCE(hl.net_amount, 0), COALESCE(hl.net_amount, 0),
  hl.payment_completed_at, now(), jsonb_build_object('reason', 'HISTORICAL_CUTOFF_2026_06_25')
FROM historical_lines hl
WHERE NOT EXISTS (
  SELECT 1
  FROM comercial.commission_settlement_lines existing
  WHERE existing.company_id = hl.company_id
    AND existing.invoice_line_id = hl.invoice_line_id
    AND existing.line_type IN ('INVOICE', 'HISTORICAL_MARK')
    AND existing.eligibility_locked_at IS NOT NULL
);

UPDATE comercial.commission_settlements settlement
SET
  total_net_amount = COALESCE(totals.total_net_amount, 0),
  total_commission_amount = 0
FROM (
  SELECT settlement_id, SUM(net_amount) AS total_net_amount
  FROM comercial.commission_settlement_lines
  WHERE line_type = 'HISTORICAL_MARK'
  GROUP BY settlement_id
) totals
WHERE settlement.company_id = 'd1000000-0000-0000-0000-000000000001'
  AND settlement.settlement_code = 'HISTORICO'
  AND totals.settlement_id = settlement.id;
