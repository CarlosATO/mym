DO $$
DECLARE
  function_oid oid;
  function_definition text;
  active_predicate text := 'r.is_active';
  archived_predicate text := 'r.is_active AND COALESCE(r.is_archived, false) = false';
BEGIN
  FOR function_oid IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'comercial'
      AND p.proname IN ('preview_commission_settlement', 'resolve_commission_rule')
  LOOP
    function_definition := pg_get_functiondef(function_oid);
    IF position(archived_predicate IN function_definition) = 0 THEN
      IF position(active_predicate IN function_definition) = 0 THEN
        RAISE EXCEPTION 'No se encontró el filtro de reglas activas en función %', function_oid::regprocedure;
      END IF;
      EXECUTE replace(function_definition, active_predicate, archived_predicate);
    END IF;
  END LOOP;
END $$;
