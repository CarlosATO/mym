-- The finance runtime needs a normalized, owner-backed read model to classify
-- eligible document lines by their synchronized BSale product type. Direct
-- catalog tables remain protected by their existing RLS policies.
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_family_lines AS
SELECT
    details.company_id,
    details.bsale_document_id,
    details.bsale_id AS detail_bsale_id,
    details.net_amount AS line_net_amount,
    doc.emission_date,
    doc.sign_for_sales,
    doc.include_in_replenishment,
    doc.business_category,
    product_types.bsale_id AS product_type_id,
    product_types.name AS family_name
FROM integraciones.bsale_document_details AS details
JOIN integraciones.vw_bsale_documents_normalized AS doc
  ON doc.company_id = details.company_id
 AND doc.bsale_id = details.bsale_document_id
LEFT JOIN integraciones.bsale_variants AS variants
  ON variants.company_id = details.company_id
 AND variants.bsale_id = details.variant_id
LEFT JOIN integraciones.bsale_products AS products
  ON products.company_id = variants.company_id
 AND products.bsale_id = variants.bsale_product_id
LEFT JOIN integraciones.bsale_product_types AS product_types
  ON product_types.company_id = products.company_id
 AND product_types.bsale_id = products.product_type_id;

GRANT SELECT ON integraciones.vw_bsale_sales_family_lines
  TO petgroup_backend_runtime;
