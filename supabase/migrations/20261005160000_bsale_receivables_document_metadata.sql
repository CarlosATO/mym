ALTER TABLE integraciones.bsale_documents
  ADD COLUMN IF NOT EXISTS document_level_payments_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS sale_condition_id int;

CREATE OR REPLACE VIEW integraciones.vw_bsale_receivables_documents AS
SELECT
    d.company_id, d.bsale_id, d.emission_date, d.document_type_id,
    d.client_id, d.total_amount, d.raw_json, d.state, n.sign_for_sales,
    n.business_category, n.include_in_replenishment, n.document_type_name, n.folio,
    d.net_amount, d.tax_amount, d.url_pdf,
    d.document_level_payments_amount, d.sale_condition_id
FROM integraciones.bsale_documents d
JOIN integraciones.vw_bsale_documents_normalized n
  ON n.company_id = d.company_id AND n.bsale_id = d.bsale_id;

GRANT SELECT ON integraciones.vw_bsale_receivables_documents TO petgroup_backend_runtime;
