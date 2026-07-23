DO $$
DECLARE
  function_oid oid;
  function_definition text;
  source_columns text := 'COALESCE(p.description, dd.variant_description) AS product_name, psm.supplier_id,';
  effective_columns text := 'COALESCE(p.description, dd.variant_description) AS product_name, COALESCE(parent_supplier.id, psm.supplier_id) AS supplier_id,';
  source_name text := 'supplier.business_name AS supplier_name, cgp.commission_group_id,';
  effective_name text := 'COALESCE(parent_supplier.business_name, supplier.business_name) AS supplier_name, cgp.commission_group_id,';
  source_join text := 'JOIN adquisiciones.suppliers supplier ON supplier.id = psm.supplier_id';
  effective_join text := 'JOIN adquisiciones.suppliers supplier ON supplier.id = psm.supplier_id LEFT JOIN adquisiciones.suppliers parent_supplier ON parent_supplier.id = supplier.parent_supplier_id';
BEGIN
  SELECT p.oid INTO function_oid
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'comercial' AND p.proname = 'preview_commission_settlement'
  LIMIT 1;
  function_definition := pg_get_functiondef(function_oid);
  IF position(effective_columns IN function_definition) = 0 THEN
    IF position(source_columns IN function_definition) = 0 OR position(source_join IN function_definition) = 0 THEN
      RAISE EXCEPTION 'La definición de preview_commission_settlement no coincide con el contrato esperado';
    END IF;
    function_definition := replace(function_definition, source_columns, effective_columns);
    function_definition := replace(function_definition, source_name, effective_name);
    function_definition := replace(function_definition, source_join, effective_join);
    EXECUTE function_definition;
  END IF;
END $$;
