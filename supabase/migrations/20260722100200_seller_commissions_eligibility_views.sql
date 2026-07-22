CREATE OR REPLACE VIEW comercial.vw_commission_sellers
WITH (security_invoker = true)
AS
WITH seller_documents AS (
  SELECT
    ds.company_id,
    ds.seller_bsale_id,
    max(ds.seller_name) FILTER (WHERE ds.seller_name IS NOT NULL) AS seller_name,
    count(*) AS docs_count,
    count(*) FILTER (WHERE ds.document_type_id = 5) AS invoices_count,
    count(*) FILTER (WHERE ds.document_type_id = 5 AND r.receivable_status = 'PAGADA' AND r.pending_amount = 0) AS paid_invoices_count,
    max(ds.last_sync_at) AS last_seen_at
  FROM integraciones.bsale_document_sellers ds
  LEFT JOIN comercial.vw_customer_invoice_receivables r
    ON r.company_id = ds.company_id
   AND r.bsale_document_id = ds.bsale_document_id
  WHERE ds.is_primary = true
  GROUP BY ds.company_id, ds.seller_bsale_id
)
SELECT
  sd.company_id,
  sd.seller_bsale_id,
  sd.seller_name,
  sd.docs_count,
  sd.invoices_count,
  sd.paid_invoices_count,
  sp.id AS seller_profile_id,
  COALESCE(sp.is_commissionable, false) AS is_commissionable,
  COALESCE(sp.seller_type, 'OTHER') AS seller_type,
  sp.active AS profile_active,
  sd.last_seen_at
FROM seller_documents sd
LEFT JOIN comercial.commission_seller_profiles sp
  ON sp.company_id = sd.company_id
 AND sp.seller_bsale_id = sd.seller_bsale_id;

CREATE OR REPLACE VIEW comercial.vw_commission_invoice_line_base
WITH (security_invoker = true)
AS
SELECT
  r.company_id,
  d.id AS invoice_document_id,
  r.bsale_document_id::bigint AS invoice_bsale_id,
  r.document_number::bigint AS invoice_number,
  r.emission_date,
  dd.id AS invoice_line_id,
  dd.line_number,
  dd.quantity,
  COALESCE(dd.net_amount, 0) AS net_amount,
  dd.variant_code AS sku,
  dd.variant_description AS source_product_name,
  seller.seller_bsale_id,
  seller.seller_name,
  seller.profile_id AS seller_profile_id,
  COALESCE(seller.is_commissionable, false) AS is_seller_commissionable,
  r.bsale_client_id::bigint AS client_bsale_id,
  r.customer_id,
  r.client_name AS customer_name,
  r.last_payment_date AS payment_completed_at,
  r.receivable_status = 'PAGADA' AND r.pending_amount = 0 AS is_paid_full,
  product.id AS product_id,
  COALESCE(product.description, dd.variant_description) AS product_name,
  supplier.supplier_id,
  group_match.commission_group_id,
  COALESCE(customer_profile.is_internal_account, false) AS is_internal_customer,
  COALESCE(customer_profile.is_commissionable, true) AS is_customer_commissionable,
  product.id IS NOT NULL AS is_product_matched,
  supplier.supplier_id IS NOT NULL AS is_supplier_matched,
  EXISTS (
    SELECT 1
    FROM comercial.commission_settlement_lines locked
    WHERE locked.company_id = r.company_id
      AND locked.invoice_line_id = dd.id
      AND locked.line_type IN ('INVOICE', 'HISTORICAL_MARK')
      AND locked.eligibility_locked_at IS NOT NULL
  ) AS is_already_locked,
  EXISTS (
    SELECT 1
    FROM comercial.commission_settings settings
    WHERE settings.company_id = r.company_id
      AND r.last_payment_date::date >= settings.first_eligible_date
  ) AS is_after_first_eligible_date,
  EXISTS (
    SELECT 1
    FROM comercial.commission_settings settings
    WHERE settings.company_id = r.company_id
      AND r.last_payment_date::date <= settings.historical_cutoff_date
  ) AS is_historical_period
FROM comercial.vw_customer_invoice_receivables r
JOIN integraciones.bsale_documents d
  ON d.company_id = r.company_id
 AND d.bsale_id = r.bsale_document_id
 AND d.document_type_id = 5
JOIN integraciones.bsale_document_details dd
  ON dd.company_id = d.company_id
 AND dd.bsale_document_id = d.bsale_id
LEFT JOIN LATERAL (
  SELECT
    ds.seller_bsale_id,
    ds.seller_name,
    sp.id AS profile_id,
    sp.is_commissionable
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
LEFT JOIN comercial.customer_reporting_profiles customer_profile
  ON customer_profile.company_id = r.company_id
 AND customer_profile.bsale_client_id = r.bsale_client_id
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
  WHERE psm.company_id = r.company_id
    AND psm.product_id = product.id
    AND psm.is_active = true
  ORDER BY psm.is_preferred DESC, psm.updated_at DESC NULLS LAST, psm.id
  LIMIT 1
) supplier ON true
LEFT JOIN LATERAL (
  SELECT cgp.commission_group_id
  FROM comercial.commission_group_products cgp
  WHERE cgp.company_id = r.company_id
    AND cgp.product_id = product.id
    AND cgp.is_active = true
    AND r.last_payment_date::date >= cgp.valid_from
    AND (cgp.valid_to IS NULL OR r.last_payment_date::date <= cgp.valid_to)
  ORDER BY cgp.valid_from DESC, cgp.id
  LIMIT 1
) group_match ON true;

CREATE OR REPLACE FUNCTION comercial.get_commission_eligible_invoice_lines(
  p_company_id uuid,
  p_seller_bsale_id bigint,
  p_period_to date,
  p_period_from date DEFAULT NULL
)
RETURNS SETOF comercial.vw_commission_invoice_line_base
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH effective_period AS (
    SELECT
      COALESCE(
        p_period_from,
        (
          SELECT max(s.period_to) + 1
          FROM comercial.commission_settlements s
          WHERE s.company_id = p_company_id
            AND s.seller_bsale_id = p_seller_bsale_id
            AND s.status = 'ISSUED'
            AND s.source IN ('NORMAL', 'ADJUSTMENT')
        ),
        settings.first_eligible_date
      ) AS period_from
    FROM comercial.commission_settings settings
    WHERE settings.company_id = p_company_id
      AND settings.active = true
  )
  SELECT base.*
  FROM comercial.vw_commission_invoice_line_base base
  CROSS JOIN effective_period period
  WHERE base.company_id = p_company_id
    AND base.seller_bsale_id = p_seller_bsale_id
    AND base.is_seller_commissionable
    AND base.is_paid_full
    AND base.is_after_first_eligible_date
    AND NOT base.is_historical_period
    AND NOT base.is_already_locked
    AND NOT base.is_internal_customer
    AND base.is_customer_commissionable
    AND base.is_product_matched
    AND base.is_supplier_matched
    AND base.payment_completed_at::date BETWEEN period.period_from AND p_period_to;
$$;

COMMENT ON FUNCTION comercial.get_commission_eligible_invoice_lines(uuid, bigint, date, date) IS 'Fase 1A: retorna lineas elegibles sin resolver reglas ni calcular comision. El contrato de preview_commission_settlement se implementara en la siguiente fase.';

GRANT SELECT ON comercial.vw_commission_sellers TO authenticated, service_role;
GRANT SELECT ON comercial.vw_commission_invoice_line_base TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION comercial.get_commission_eligible_invoice_lines(uuid, bigint, date, date) TO authenticated, service_role;
