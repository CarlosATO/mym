-- Expose document net amounts through the owner-secured normalized view.
-- Direct table RLS remains unchanged; the finance runtime reads the view only.

CREATE OR REPLACE VIEW integraciones.vw_bsale_documents_normalized AS
SELECT
    d.company_id,
    d.bsale_id,
    d.number AS folio,
    d.document_type_id,
    COALESCE(r.document_type_name, 'UNKNOWN') AS document_type_name,
    d.office_id,
    o.name AS office_name,
    d.emission_date,
    d.generation_date,
    d.synced_at,
    COALESCE(r.sign_for_sales, 0) AS sign_for_sales,
    COALESCE(r.include_in_replenishment, false) AS include_in_replenishment,
    COALESCE(r.include_in_sales_reports, false) AS include_in_sales_reports,
    COALESCE(r.business_category, 'unknown') AS business_category,
    d.net_amount
FROM integraciones.bsale_documents AS d
LEFT JOIN integraciones.bsale_document_type_rules AS r
  ON d.company_id = r.company_id
 AND d.document_type_id = r.document_type_id
LEFT JOIN integraciones.bsale_offices AS o
  ON d.company_id = o.company_id
 AND d.office_id = o.bsale_id;

GRANT USAGE ON SCHEMA integraciones TO petgroup_backend_runtime;

GRANT SELECT ON integraciones.vw_bsale_documents_normalized
  TO authenticated, service_role, petgroup_backend_runtime;

-- These grants do not bypass row-level security. They preserve the manually
-- applied object privileges while direct reads remain filtered by existing RLS.
GRANT SELECT ON integraciones.bsale_documents,
                 integraciones.bsale_document_details,
                 integraciones.bsale_document_costs,
                 integraciones.bsale_credit_note_cogs_resolutions
  TO petgroup_backend_runtime;
