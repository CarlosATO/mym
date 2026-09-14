-- Replace per-line markup overrides with validated CLP unit prices.
DO $$
DECLARE
  function_definition text;
  declaration_old constant text := E'  v_markup numeric;\n  v_effective_markup numeric;\n  v_requested_markup jsonb := ''{}''::jsonb;';
  declaration_new constant text := E'  v_markup numeric;\n  v_effective_markup numeric;\n  v_requested_unit_price numeric;\n  v_requested_unit_prices jsonb := ''{}''::jsonb;\n  v_minimum_unit_price numeric;';
  parser_old constant text := E'    IF v_item ? ''markup_percent'' AND NULLIF(btrim(v_item->>''markup_percent''), '''') IS NOT NULL THEN\n      v_effective_markup := (v_item->>''markup_percent'')::numeric;\n      IF v_effective_markup < 0 THEN\n        RAISE EXCEPTION ''El porcentaje de venta no puede ser negativo'';\n      END IF;\n      IF v_requested_markup ? v_variant_id::text\n         AND (v_requested_markup->>v_variant_id::text)::numeric <> v_effective_markup THEN\n        RAISE EXCEPTION ''El producto % tiene porcentajes de venta inconsistentes'', v_variant_id;\n      END IF;\n      v_requested_markup := jsonb_set(v_requested_markup, ARRAY[v_variant_id::text], to_jsonb(v_effective_markup), true);\n    END IF;';
  parser_new constant text := E'    IF v_item ? ''unit_price'' AND v_item->>''unit_price'' IS NOT NULL THEN\n      IF NULLIF(btrim(v_item->>''unit_price''), '''') IS NULL THEN\n        RAISE EXCEPTION ''El precio unitario es obligatorio'';\n      END IF;\n      v_requested_unit_price := (v_item->>''unit_price'')::numeric;\n      IF v_requested_unit_price <= 0 OR v_requested_unit_price <> trunc(v_requested_unit_price) THEN\n        RAISE EXCEPTION ''El precio unitario debe ser un peso entero positivo'';\n      END IF;\n      IF v_requested_unit_prices ? v_variant_id::text\n         AND (v_requested_unit_prices->>v_variant_id::text)::numeric <> v_requested_unit_price THEN\n        RAISE EXCEPTION ''El producto % tiene precios unitarios inconsistentes'', v_variant_id;\n      END IF;\n      v_requested_unit_prices := jsonb_set(v_requested_unit_prices, ARRAY[v_variant_id::text], to_jsonb(v_requested_unit_price), true);\n    END IF;';
  price_old constant text := E'    v_effective_markup := coalesce((v_requested_markup->>v_variant_id::text)::numeric, v_markup);\n    IF v_effective_markup < 0 THEN\n      RAISE EXCEPTION ''El porcentaje de venta no puede ser negativo'';\n    END IF;\n    v_unit_price := round(v_cost * 1.19 * (1 + v_effective_markup / 100));';
  price_new constant text := E'    v_requested_unit_price := (v_requested_unit_prices->>v_variant_id::text)::numeric;\n    v_minimum_unit_price := ceil(v_cost * 1.19);\n    v_unit_price := coalesce(v_requested_unit_price, round(v_cost * 1.19 * (1 + v_markup / 100)));\n    IF v_unit_price < v_minimum_unit_price THEN\n      RAISE EXCEPTION ''El precio unitario debe ser igual o superior a %'', v_minimum_unit_price;\n    END IF;\n    v_effective_markup := ((v_unit_price / (v_cost * 1.19)) - 1) * 100;';
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO function_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'mermas'
    AND p.proname = 'create_internal_sale'
    AND pg_get_function_identity_arguments(p.oid) = 'p_company_id uuid, p_user_id uuid, p_employee_id uuid, p_items jsonb';

  IF function_definition IS NULL
     OR position(declaration_old IN function_definition) = 0
     OR position(parser_old IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected create_internal_sale unit-price migration state';
  END IF;
  IF (length(function_definition) - length(replace(function_definition, price_old, ''))) / length(price_old) <> 2 THEN
    RAISE EXCEPTION 'Unexpected create_internal_sale pricing expression count';
  END IF;

  function_definition := replace(function_definition, declaration_old, declaration_new);
  function_definition := replace(function_definition, parser_old, parser_new);
  function_definition := replace(function_definition, price_old, price_new);
  function_definition := replace(
    function_definition,
    '''worker_unit_price'', v_unit_price, ''markup_percent'', v_effective_markup, ''override'', v_effective_markup <> v_markup, ''line_total'', v_line_total',
    '''worker_unit_price'', v_unit_price, ''suggested_unit_price'', round(v_cost * 1.19 * (1 + v_markup / 100)), ''effective_unit_price'', v_unit_price, ''manual_override'', v_requested_unit_price IS NOT NULL, ''markup_percent'', v_effective_markup, ''line_total'', v_line_total'
  );
  EXECUTE function_definition;
END;
$$;
