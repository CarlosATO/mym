GRANT ALL ON adquisiciones.products TO authenticated, service_role;
GRANT ALL ON adquisiciones.suppliers TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA adquisiciones TO authenticated, service_role;
