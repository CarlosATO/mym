-- MIGRATION: 20260630070001_sales_analysis_grants.sql

GRANT ALL ON TABLE adquisiciones.sales_analysis_reports TO authenticated;
GRANT ALL ON TABLE adquisiciones.sales_analysis_reports TO service_role;

GRANT ALL ON TABLE adquisiciones.sales_analysis_items TO authenticated;
GRANT ALL ON TABLE adquisiciones.sales_analysis_items TO service_role;
