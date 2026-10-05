-- Read-only, owner-secured projections for the Finance API runtime role.
-- Source tables remain unchanged and continue to enforce their own RLS.
CREATE OR REPLACE VIEW integraciones.vw_bsale_receivables_documents AS
SELECT
    d.company_id, d.bsale_id, d.emission_date, d.document_type_id,
    d.client_id, d.total_amount, d.raw_json, d.state,
    n.sign_for_sales, n.business_category, n.include_in_replenishment,
    n.document_type_name, n.folio
FROM integraciones.bsale_documents d
JOIN integraciones.vw_bsale_documents_normalized n
  ON n.company_id = d.company_id AND n.bsale_id = d.bsale_id;

CREATE OR REPLACE VIEW integraciones.vw_bsale_receivables_payments AS
SELECT
    dp.company_id, dp.bsale_document_id, dp.payment_record_date::date AS payment_date,
    dp.amount_applied, p.state, p.is_credit_payment,
    pt.raw_json AS payment_type_raw_json
FROM integraciones.bsale_document_payments dp
JOIN integraciones.bsale_payments p
  ON p.company_id = dp.company_id AND p.bsale_payment_id = dp.bsale_payment_id
LEFT JOIN integraciones.bsale_payment_types pt
  ON pt.company_id = p.company_id
 AND pt.bsale_payment_type_id = COALESCE(p.payment_type_bsale_id, p.payment_type_id);

CREATE OR REPLACE VIEW integraciones.vw_bsale_receivables_references AS
SELECT company_id, bsale_document_id, referenced_document_id,
       referenced_document_number, referenced_document_type_id
FROM integraciones.bsale_document_references;

GRANT SELECT ON integraciones.vw_bsale_receivables_documents,
                 integraciones.vw_bsale_receivables_payments,
                 integraciones.vw_bsale_receivables_references
  TO petgroup_backend_runtime;
