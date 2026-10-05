-- The normalized BSale document view resolves finance eligibility from these
-- existing rules. Read-only access is required by the finance runtime role.
GRANT SELECT ON integraciones.bsale_document_type_rules
  TO petgroup_backend_runtime;
