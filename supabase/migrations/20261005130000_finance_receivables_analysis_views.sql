-- Read-only projections used by the receivables drill-down.
CREATE OR REPLACE VIEW integraciones.vw_bsale_receivables_documents AS
SELECT
    d.company_id, d.bsale_id, d.emission_date, d.document_type_id,
    d.client_id, d.total_amount, d.raw_json, d.state, n.sign_for_sales,
    n.business_category, n.include_in_replenishment, n.document_type_name, n.folio,
    d.net_amount, d.tax_amount, d.url_pdf
FROM integraciones.bsale_documents d
JOIN integraciones.vw_bsale_documents_normalized n
  ON n.company_id = d.company_id AND n.bsale_id = d.bsale_id;

CREATE OR REPLACE VIEW integraciones.vw_bsale_receivables_payments AS
SELECT
    dp.company_id, dp.bsale_document_id, dp.payment_record_date::date AS payment_date,
    dp.amount_applied, p.state, p.is_credit_payment,
    pt.raw_json AS payment_type_raw_json, dp.bsale_payment_id,
    p.operation_number, p.payment_type_name
FROM integraciones.bsale_document_payments dp
JOIN integraciones.bsale_payments p
  ON p.company_id = dp.company_id AND p.bsale_payment_id = dp.bsale_payment_id
LEFT JOIN integraciones.bsale_payment_types pt
  ON pt.company_id = p.company_id
 AND pt.bsale_payment_type_id = COALESCE(p.payment_type_bsale_id, p.payment_type_id);

CREATE OR REPLACE VIEW integraciones.vw_bsale_receivables_clients AS
SELECT company_id, bsale_client_id AS bsale_id, code, business_name AS name, first_name, last_name, company
FROM integraciones.bsale_clients;

GRANT SELECT ON integraciones.vw_bsale_receivables_documents,
                 integraciones.vw_bsale_receivables_payments,
                 integraciones.vw_bsale_receivables_clients
  TO petgroup_backend_runtime;
