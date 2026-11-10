-- Preserve the historical migration and restore the currently deployed function
-- projection on databases still carrying its original definition.
BEGIN;
DO $migration$
DECLARE
  definition text;
  original_fragment text := E'      cm.document_state,\n      cm.sync_proven,';
  current_fragment text := E'      cm.document_state,\n      cm.bsale_sync_run_id,\n      cm.sync_status,\n      cm.sync_completed_at,\n      cm.sync_proven,';
BEGIN
  SELECT pg_get_functiondef('logistica.verify_open_preparation_incidents_v1(uuid,bigint[])'::regprocedure) INTO definition;
  IF strpos(definition, current_fragment) > 0 THEN
    RETURN;
  END IF;
  IF strpos(definition, original_fragment) = 0
     OR strpos(replace(definition, original_fragment, ''), original_fragment) > 0 THEN
    RAISE EXCEPTION 'La definición de verificación de incidencias no coincide con la versión histórica esperada';
  END IF;
  EXECUTE replace(definition, original_fragment, current_fragment);
END;
$migration$;
COMMIT;
