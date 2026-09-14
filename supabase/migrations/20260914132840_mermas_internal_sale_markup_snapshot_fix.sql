-- Persist the effective per-line markup in the sale snapshot.
DO $$
DECLARE
  function_definition text;
  old_expression constant text := 'v_cost, v_markup, v_unit_price, v_line_total';
  new_expression constant text := 'v_cost, v_effective_markup, v_unit_price, v_line_total';
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO function_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'mermas'
    AND p.proname = 'create_internal_sale'
    AND pg_get_function_identity_arguments(p.oid) = 'p_company_id uuid, p_user_id uuid, p_employee_id uuid, p_items jsonb';

  IF function_definition IS NULL OR position(old_expression IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected create_internal_sale snapshot expression';
  END IF;
  EXECUTE replace(function_definition, old_expression, new_expression);
END;
$$;
