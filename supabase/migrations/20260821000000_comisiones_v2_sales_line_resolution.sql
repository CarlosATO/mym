-- COMV2-03: single read-only commercial resolution for V2 sales lines.
-- The product identity is strictly (company_id, bsale_document_details.variant_id).
-- SKU, barcode, and description are diagnostic snapshots only and never fallbacks.

CREATE OR REPLACE VIEW comisiones.vw_sales_line_resolution
WITH (security_invoker = true) AS
SELECT
    d.company_id,
    doc.id AS document_id,
    doc.bsale_id AS document_bsale_id,
    doc.number AS document_number,
    doc.document_type_id,
    doc.emission_date,
    d.id AS detail_id,
    d.bsale_id AS detail_bsale_id,
    d.line_number,
    d.quantity,
    d.net_amount,
    d.variant_id,
    d.variant_code AS variant_code_snapshot,
    d.variant_description AS variant_description_snapshot,
    p.id AS product_id,
    p.sku AS current_sku,
    p.description AS current_product_description,
    p.is_active AS product_is_active,
    p.bsale_brand_id,
    l.supplier_id AS real_supplier_id,
    s.business_name AS real_supplier_business_name,
    p.bsale_product_type_id AS family_bsale_product_type_id,
    p.bsale_product_type_name AS family_name,
    CASE
        WHEN d.variant_id IS NULL THEN 'VARIANT_MISSING'
        WHEN p.id IS NULL THEN 'PRODUCT_UNRESOLVED'
        WHEN b.id IS NULL THEN 'BRAND_UNRESOLVED'
        WHEN l.id IS NULL THEN 'BRAND_LINK_UNRESOLVED'
        WHEN s.id IS NULL
          OR s.company_id IS DISTINCT FROM d.company_id
          OR s.supplier_kind <> 'REAL'
          OR s.status <> 'ACTIVE'
          OR s.is_active IS NOT TRUE THEN 'SUPPLIER_INVALID'
        WHEN p.bsale_product_type_id IS NULL
          OR NULLIF(btrim(p.bsale_product_type_name), '') IS NULL THEN 'FAMILY_UNRESOLVED'
        ELSE 'RESOLVED'
    END AS resolution_status,
    CASE
        WHEN d.variant_id IS NULL THEN 'VARIANT_MISSING'
        WHEN p.id IS NULL THEN 'PRODUCT_UNRESOLVED'
        WHEN b.id IS NULL THEN 'BRAND_UNRESOLVED'
        WHEN l.id IS NULL THEN 'BRAND_LINK_UNRESOLVED'
        WHEN s.id IS NULL
          OR s.company_id IS DISTINCT FROM d.company_id
          OR s.supplier_kind <> 'REAL'
          OR s.status <> 'ACTIVE'
          OR s.is_active IS NOT TRUE THEN 'SUPPLIER_INVALID'
        WHEN p.bsale_product_type_id IS NULL
          OR NULLIF(btrim(p.bsale_product_type_name), '') IS NULL THEN 'FAMILY_UNRESOLVED'
        ELSE NULL
    END AS resolution_code,
    CASE
        WHEN d.variant_id IS NULL THEN 'Detail has no Bsale variant_id.'
        WHEN p.id IS NULL THEN 'No current product matches company_id and variant_id.'
        WHEN b.id IS NULL THEN 'Product has no detected Bsale Brand in the same company.'
        WHEN l.id IS NULL THEN 'No approved Brand Supplier Link exists for the company and Brand.'
        WHEN s.id IS NULL
          OR s.company_id IS DISTINCT FROM d.company_id
          OR s.supplier_kind <> 'REAL'
          OR s.status <> 'ACTIVE'
          OR s.is_active IS NOT TRUE THEN 'Brand link does not resolve to an active REAL supplier in the same company.'
        WHEN p.bsale_product_type_id IS NULL
          OR NULLIF(btrim(p.bsale_product_type_name), '') IS NULL THEN 'Product has no current Bsale family id and name.'
        ELSE 'Commercial V2 classification resolved.'
    END AS resolution_message
FROM integraciones.bsale_document_details AS d
LEFT JOIN integraciones.bsale_documents AS doc
  ON doc.company_id = d.company_id
 AND doc.bsale_id = d.bsale_document_id
LEFT JOIN adquisiciones.products AS p
  ON p.company_id = d.company_id
 AND p.bsale_variant_id = d.variant_id
LEFT JOIN integraciones.bsale_brands AS b
  ON b.company_id = p.company_id
 AND b.bsale_brand_id = p.bsale_brand_id
LEFT JOIN integraciones.bsale_brand_supplier_links AS l
  ON l.company_id = p.company_id
 AND l.bsale_brand_id = p.bsale_brand_id
LEFT JOIN adquisiciones.suppliers AS s
  ON s.id = l.supplier_id;

COMMENT ON VIEW comisiones.vw_sales_line_resolution IS
    'Single read-only COMV2 resolution: detail variant -> current product -> Bsale Brand -> approved Brand Supplier Link -> active REAL supplier -> current Bsale family. No SKU or mapping fallback.';
