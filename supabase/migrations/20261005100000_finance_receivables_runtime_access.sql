-- Finance API receivables read model needs the existing BSale payment facts.
-- This grants read access only; no source data or accounting calculations change.
GRANT USAGE ON SCHEMA integraciones TO petgroup_backend_runtime;

GRANT SELECT ON integraciones.bsale_payments,
                 integraciones.bsale_document_payments,
                 integraciones.bsale_payment_types,
                 integraciones.bsale_document_references
  TO petgroup_backend_runtime;
