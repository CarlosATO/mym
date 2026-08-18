-- Remove the legacy first-count guard from both task completion contracts.
-- Physical location coverage is now enforced by task_selected_coverage_ok.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
    v_start integer;
    v_end integer;
BEGIN
    SELECT pg_catalog.pg_get_functiondef('inventarios.complete_my_counting_zone(uuid,uuid)'::regprocedure) INTO v_definition;
    v_start := pg_catalog.strpos(v_definition, 'SELECT pg_catalog.count(*) INTO v_effective_counts');
    IF v_start = 0 THEN RAISE EXCEPTION 'complete_my_counting_zone effective count guard not found'; END IF;
    v_end := v_start + pg_catalog.strpos(pg_catalog.substr(v_definition, v_start), 'END IF;') + 6;
    v_definition := pg_catalog.substr(v_definition, 1, v_start - 1) || pg_catalog.substr(v_definition, v_end + 1);
    EXECUTE v_definition;
END;
$migration$;

DO $migration$
DECLARE
    v_definition text;
    v_start integer;
    v_end integer;
BEGIN
    SELECT pg_catalog.pg_get_functiondef('inventarios.complete_inventory_task(uuid,uuid,integer,uuid)'::regprocedure) INTO v_definition;
    v_start := pg_catalog.strpos(v_definition, 'SELECT pg_catalog.count(*) INTO v_effective_counts');
    IF v_start = 0 THEN RAISE EXCEPTION 'complete_inventory_task effective count guard not found'; END IF;
    v_end := v_start + pg_catalog.strpos(pg_catalog.substr(v_definition, v_start), 'END IF;') + 6;
    v_definition := pg_catalog.substr(v_definition, 1, v_start - 1) || pg_catalog.substr(v_definition, v_end + 1);
    EXECUTE v_definition;
END;
$migration$;

COMMIT;
