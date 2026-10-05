CREATE OR REPLACE VIEW integraciones.vw_bsale_receivables_payments AS
SELECT
    dp.company_id, dp.bsale_document_id, dp.payment_record_date::date AS payment_date,
    dp.amount_applied, p.state, p.is_credit_payment,
    pt.raw_json AS payment_type_raw_json, dp.bsale_payment_id,
    p.operation_number, p.payment_type_name,
    NULLIF(p.raw_json #>> '{return,id}', '')::bigint AS payment_return_id
FROM integraciones.bsale_document_payments dp
JOIN integraciones.bsale_payments p
  ON p.company_id = dp.company_id AND p.bsale_payment_id = dp.bsale_payment_id
LEFT JOIN integraciones.bsale_payment_types pt
  ON pt.company_id = p.company_id
 AND pt.bsale_payment_type_id = COALESCE(p.payment_type_bsale_id, p.payment_type_id);
