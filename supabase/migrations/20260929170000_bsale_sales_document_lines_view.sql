-- Runtime Finance API reads through security-definer views. The underlying BSale
-- tables are intentionally protected by RLS and are not directly readable by
-- petgroup_backend_runtime.
CREATE OR REPLACE VIEW integraciones.vw_bsale_sales_document_lines AS
SELECT
    normalized.company_id,
    normalized.bsale_id AS document_id,
    normalized.folio,
    normalized.emission_date,
    documents.total_amount AS document_total_amount,
    documents.net_amount AS document_net_amount,
    documents.tax_amount AS document_tax_amount,
    documents.exempt_amount AS document_exempt_amount,
    normalized.document_type_id,
    normalized.document_type_name,
    documents.client_id,
    NULLIF(
        COALESCE(
            clients.business_name,
            NULLIF(concat_ws(' ', clients.first_name, clients.last_name), ''),
            clients.company
        ),
        ''
    ) AS client_name,
    clients.code AS client_code,
    normalized.office_id,
    normalized.office_name,
    normalized.sign_for_sales,
    details.id AS detail_id,
    details.bsale_id AS detail_bsale_id,
    details.line_number,
    details.variant_id,
    COALESCE(variants.code, details.variant_code) AS sku,
    variants.bar_code AS barcode,
    COALESCE(variants.description, details.variant_description) AS variant_name,
    products.bsale_id AS product_id,
    products.name AS product_name,
    details.quantity,
    details.net_unit_value AS unit_price,
    details.net_amount,
    details.net_discount AS discount,
    details.tax_amount,
    details.total_amount,
    COALESCE(provider_lines.provider_key, 'unassigned') AS provider_key,
    provider_lines.provider_name,
    provider_lines.product_type_id,
    provider_lines.family_name,
    CASE
        WHEN provider_lines.detail_bsale_id IS NULL
            OR NULLIF(regexp_replace(btrim(provider_lines.family_name), '\s+', ' ', 'g'), '') IS NULL
            THEN 'unclassified'
        WHEN provider_lines.product_type_id IS NOT NULL
            THEN 'product_type:' || provider_lines.product_type_id::text
        ELSE 'product_type:' || lower(regexp_replace(btrim(provider_lines.family_name), '\s+', ' ', 'g'))
    END AS family_key_suffix
FROM integraciones.vw_bsale_documents_normalized AS normalized
JOIN integraciones.bsale_documents AS documents
  ON documents.company_id = normalized.company_id
 AND documents.bsale_id = normalized.bsale_id
JOIN integraciones.bsale_document_details AS details
  ON details.company_id = normalized.company_id
 AND details.bsale_document_id = normalized.bsale_id
LEFT JOIN integraciones.bsale_variants AS variants
  ON variants.company_id = details.company_id
 AND variants.bsale_id = details.variant_id
LEFT JOIN integraciones.bsale_products AS products
  ON products.company_id = variants.company_id
 AND products.bsale_id = variants.bsale_product_id
LEFT JOIN integraciones.bsale_clients AS clients
  ON clients.company_id = documents.company_id
 AND clients.bsale_client_id = documents.client_id
LEFT JOIN integraciones.vw_bsale_sales_provider_family_lines AS provider_lines
  ON provider_lines.company_id = details.company_id
 AND provider_lines.detail_bsale_id = details.bsale_id
WHERE normalized.include_in_replenishment = TRUE
  AND normalized.sign_for_sales IN (1, -1)
  AND normalized.business_category IN ('sale', 'reversal');

COMMENT ON VIEW integraciones.vw_bsale_sales_document_lines IS
    'Security-definer read model for Finance API document line traceability.';

GRANT SELECT ON integraciones.vw_bsale_sales_document_lines
  TO petgroup_backend_runtime, service_role;
