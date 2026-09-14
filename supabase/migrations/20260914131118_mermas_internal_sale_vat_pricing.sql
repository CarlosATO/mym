-- Apply the approved VAT-inclusive worker pricing rule to the existing RPC.
DO $$
DECLARE
  function_definition text;
  old_expression constant text := 'greatest(v_cost, round(v_cost * (1 + v_markup / 100)))';
  new_expression constant text := 'round(v_cost * 1.19 * (1 + v_markup / 100))';
  occurrence_count integer;
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO function_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'mermas'
    AND p.proname = 'create_internal_sale'
    AND pg_get_function_identity_arguments(p.oid) = 'p_company_id uuid, p_user_id uuid, p_employee_id uuid, p_items jsonb';

  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'mermas.create_internal_sale(uuid, uuid, uuid, jsonb) not found';
  END IF;

  occurrence_count := (
    length(function_definition) - length(replace(function_definition, old_expression, ''))
  ) / length(old_expression);
  IF occurrence_count <> 2 THEN
    RAISE EXCEPTION 'Unexpected create_internal_sale pricing expression count: %', occurrence_count;
  END IF;

  EXECUTE replace(function_definition, old_expression, new_expression);
END;
$$;
