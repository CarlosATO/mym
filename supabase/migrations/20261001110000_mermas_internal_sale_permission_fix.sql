-- Mermas: use the dedicated permission when creating internal worker sales.

DO $$
DECLARE
  v_definition text;
  v_old_permission constant text := 'logistica.mermas.create';
  v_new_permission constant text := 'logistica.mermas.internal_sale.create';
  v_occurrences integer;
BEGIN
  SELECT pg_get_functiondef('mermas.create_internal_sale(uuid, uuid, uuid, jsonb)'::regprocedure)
    INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'mermas.create_internal_sale not found';
  END IF;

  v_occurrences := (length(v_definition) - length(replace(v_definition, v_old_permission, ''))) / length(v_old_permission);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'Unexpected create_internal_sale permission guard count: %', v_occurrences;
  END IF;

  EXECUTE replace(v_definition, v_old_permission, v_new_permission);
END;
$$;
