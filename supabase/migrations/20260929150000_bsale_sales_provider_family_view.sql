-- Financial sales classification by the source BSale brand on each product.
-- The brand id is the stable provider identity; the supplier link is only used
-- to obtain the current operational display name when it exists.
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_provider_family_lines AS
SELECT
    details.company_id,
    details.bsale_document_id,
    details.bsale_id AS detail_bsale_id,
    details.net_amount AS line_net_amount,
    details.variant_id,
    doc.emission_date,
    doc.sign_for_sales,
    doc.include_in_replenishment,
    doc.business_category,
    product_types.bsale_id AS product_type_id,
    product_types.name AS family_name,
    brand.brand_id,
    CASE
        WHEN brand.brand_id IS NULL THEN NULL
        ELSE 'brand:' || brand.brand_id::text
    END AS provider_key,
    CASE
        WHEN brand.brand_id IS NULL THEN NULL
        ELSE COALESCE(supplier.business_name, 'Marca BSale #' || brand.brand_id::text)
    END AS provider_name
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
 AND product_types.bsale_id = products.product_type_id
LEFT JOIN LATERAL (
    SELECT COALESCE(
        NULLIF(products.raw_json->'brand'->>'id', '')::integer,
        (
            SELECT p.bsale_brand_id
            FROM adquisiciones.products AS p
            WHERE p.company_id = details.company_id
              AND p.bsale_variant_id = details.variant_id
              AND p.bsale_brand_id IS NOT NULL
            ORDER BY p.updated_at DESC, p.id
            LIMIT 1
        )
    ) AS brand_id
) AS brand ON TRUE
LEFT JOIN integraciones.bsale_brand_supplier_links AS brand_links
  ON brand_links.company_id = details.company_id
 AND brand_links.bsale_brand_id = brand.brand_id
LEFT JOIN adquisiciones.suppliers AS supplier
  ON supplier.id = brand_links.supplier_id
 AND supplier.company_id = details.company_id;

COMMENT ON VIEW integraciones.vw_bsale_sales_provider_family_lines IS
    'Current BSale brand/provider and product type per eligible sales line. Historical attribution follows the current synchronized product catalog because document details do not snapshot brand_id.';

GRANT SELECT ON integraciones.vw_bsale_sales_provider_family_lines
  TO petgroup_backend_runtime, service_role;
