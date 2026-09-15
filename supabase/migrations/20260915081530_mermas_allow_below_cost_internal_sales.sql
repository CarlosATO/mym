-- Allow Mermas worker sales below cost while preserving effective markup snapshots.
ALTER TABLE mermas.internal_sale_lines
  DROP CONSTRAINT IF EXISTS internal_sale_lines_markup_percent_snapshot_check;

DO $$
DECLARE
  function_definition text;
  declaration_old constant text := E'  v_markup numeric;\n  v_effective_markup numeric;\n  v_requested_unit_price numeric;\n  v_requested_unit_prices jsonb := ''{}''::jsonb;\n  v_minimum_unit_price numeric;';
  declaration_new constant text := E'  v_markup numeric;\n  v_effective_markup numeric;\n  v_requested_unit_price numeric;\n  v_requested_unit_prices jsonb := ''{}''::jsonb;';
  price_old constant text := E'    v_requested_unit_price := (v_requested_unit_prices->>v_variant_id::text)::numeric;\n    v_minimum_unit_price := ceil(v_cost * 1.19);\n    v_unit_price := coalesce(v_requested_unit_price, round(v_cost * 1.19 * (1 + v_markup / 100)));\n    IF v_unit_price < v_minimum_unit_price THEN\n      RAISE EXCEPTION ''El precio unitario debe ser igual o superior a %'', v_minimum_unit_price;\n    END IF;\n    v_effective_markup := ((v_unit_price / (v_cost * 1.19)) - 1) * 100;';
  price_new constant text := E'    v_requested_unit_price := (v_requested_unit_prices->>v_variant_id::text)::numeric;\n    v_unit_price := coalesce(v_requested_unit_price, round(v_cost * 1.19 * (1 + v_markup / 100)));\n    IF v_unit_price <= 0 OR v_unit_price <> trunc(v_unit_price) THEN\n      RAISE EXCEPTION ''El precio unitario debe ser un peso entero positivo'';\n    END IF;\n    v_effective_markup := ((v_unit_price / (v_cost * 1.19)) - 1) * 100;';
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO function_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'mermas'
    AND p.proname = 'create_internal_sale'
    AND pg_get_function_identity_arguments(p.oid) = 'p_company_id uuid, p_user_id uuid, p_employee_id uuid, p_items jsonb';

  IF function_definition IS NULL
     OR position(declaration_old IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected create_internal_sale declaration state';
  END IF;
  IF (length(function_definition) - length(replace(function_definition, price_old, ''))) / length(price_old) <> 2 THEN
    RAISE EXCEPTION 'Unexpected create_internal_sale pricing expression count';
  END IF;

  function_definition := replace(function_definition, declaration_old, declaration_new);
  function_definition := replace(function_definition, price_old, price_new);
  EXECUTE function_definition;
END;
$$;
