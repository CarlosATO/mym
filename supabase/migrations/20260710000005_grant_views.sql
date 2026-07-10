-- ============================================================================
-- Grant permissions on views
-- ============================================================================
GRANT SELECT ON integraciones.vw_bsale_documents_normalized TO authenticated, service_role;
GRANT SELECT ON integraciones.vw_bsale_document_details_normalized TO authenticated, service_role;
GRANT SELECT ON integraciones.vw_bsale_sales_valid TO authenticated, service_role;
GRANT SELECT ON integraciones.vw_bsale_sales_daily_sku TO authenticated, service_role;
GRANT SELECT ON integraciones.vw_bsale_mirror_sync_health TO authenticated, service_role;
GRANT SELECT ON integraciones.vw_bsale_orphan_details TO authenticated, service_role;
GRANT SELECT ON integraciones.vw_bsale_headers_without_details TO authenticated, service_role;
GRANT SELECT ON integraciones.vw_bsale_sales_by_doc_type_daily TO authenticated, service_role;
