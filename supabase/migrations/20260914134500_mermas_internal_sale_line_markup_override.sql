-- Allow a validated markup override per internal-sale line.
DO $$
DECLARE
  function_definition text;
  declaration_old constant text := '  v_markup numeric;';
  declaration_new constant text := E'  v_markup numeric;\n  v_effective_markup numeric;\n  v_requested_markup jsonb := ''{}''::jsonb;';
  parse_old constant text := E'    v_quantity := NULLIF(v_item->>''quantity'', '''')::numeric;\n    IF v_variant_id IS NULL OR v_variant_id <= 0 OR v_quantity IS NULL OR v_quantity <= 0 THEN\n      RAISE EXCEPTION ''Producto o cantidad inválida'';\n    END IF;';
  parse_new constant text := E'    v_quantity := NULLIF(v_item->>''quantity'', '''')::numeric;\n    IF v_variant_id IS NULL OR v_variant_id <= 0 OR v_quantity IS NULL OR v_quantity <= 0 THEN\n      RAISE EXCEPTION ''Producto o cantidad inválida'';\n    END IF;\n    IF v_item ? ''markup_percent'' AND NULLIF(btrim(v_item->>''markup_percent''), '''') IS NOT NULL THEN\n      v_effective_markup := (v_item->>''markup_percent'')::numeric;\n      IF v_effective_markup < 0 THEN\n        RAISE EXCEPTION ''El porcentaje de venta no puede ser negativo'';\n      END IF;\n      IF v_requested_markup ? v_variant_id::text\n         AND (v_requested_markup->>v_variant_id::text)::numeric <> v_effective_markup THEN\n        RAISE EXCEPTION ''El producto % tiene porcentajes de venta inconsistentes'', v_variant_id;\n      END IF;\n      v_requested_markup := jsonb_set(v_requested_markup, ARRAY[v_variant_id::text], to_jsonb(v_effective_markup), true);\n    END IF;';
  price_old constant text := 'v_unit_price := round(v_cost * 1.19 * (1 + v_markup / 100));';
  price_new constant text := E'v_effective_markup := coalesce((v_requested_markup->>v_variant_id::text)::numeric, v_markup);\n    IF v_effective_markup < 0 THEN\n      RAISE EXCEPTION ''El porcentaje de venta no puede ser negativo'';\n    END IF;\n    v_unit_price := round(v_cost * 1.19 * (1 + v_effective_markup / 100));';
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO function_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'mermas'
    AND p.proname = 'create_internal_sale'
    AND pg_get_function_identity_arguments(p.oid) = 'p_company_id uuid, p_user_id uuid, p_employee_id uuid, p_items jsonb';

  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'mermas.create_internal_sale not found';
  END IF;
  IF position(declaration_old IN function_definition) = 0
     OR position(parse_old IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected create_internal_sale declaration or item parser';
  END IF;
  IF (length(function_definition) - length(replace(function_definition, price_old, ''))) / length(price_old) <> 2 THEN
    RAISE EXCEPTION 'Unexpected create_internal_sale pricing expression count';
  END IF;

  function_definition := replace(function_definition, declaration_old, declaration_new);
  function_definition := replace(function_definition, parse_old, parse_new);
  function_definition := replace(function_definition, price_old, price_new);
  function_definition := replace(
    function_definition,
    '''worker_unit_price'', v_unit_price, ''line_total'', v_line_total',
    '''worker_unit_price'', v_unit_price, ''markup_percent'', v_effective_markup, ''override'', v_effective_markup <> v_markup, ''line_total'', v_line_total'
  );
  function_definition := replace(
    function_definition,
    '''total_amount'', v_total, ''status'', ''PENDING_RENDITION'', ''lines'', v_lines',
    '''total_amount'', v_total, ''status'', ''PENDING_RENDITION'', ''default_markup_percent'', v_markup, ''lines'', v_lines'
  );
  EXECUTE function_definition;
END;
$$;
