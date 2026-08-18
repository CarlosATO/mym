-- Expose persisted location resolutions to Mobile and clear them on switch reopen.
-- This migration preserves the existing function signatures, guards, events and
-- idempotency envelopes. Normal closes already persist COUNTED.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.get_my_counting_zone_locations(uuid)'::regprocedure
    ) INTO v_definition;

    IF pg_catalog.strpos(v_definition, 'tl2.id, tl2.status, tl2.opened_at') = 0
       OR pg_catalog.strpos(v_definition, '''location_status'', location_status') = 0 THEN
        RAISE EXCEPTION 'get_my_counting_zone_locations definition does not match the expected contract';
    END IF;

    v_definition := pg_catalog.replace(
        v_definition,
        'tl2.id, tl2.status, tl2.opened_at',
        'tl2.id, tl2.status, tl2.opened_at, tl2.resolution_status'
    );
    v_definition := pg_catalog.replace(
        v_definition,
        E'tl.status AS raw_status,\n             tl.opened_at,',
        E'tl.status AS raw_status,\n             tl.resolution_status,\n             tl.opened_at,'
    );
    v_definition := pg_catalog.replace(
        v_definition,
        E'''location_status'', location_status,\n                 ''is_active'', is_active,',
        E'''location_status'', location_status,\n                 ''resolution_status'', resolution_status,\n                 ''is_active'', is_active,'
    );

    EXECUTE v_definition;
END;
$migration$;

DO $migration$
DECLARE
    v_definition text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.switch_my_counting_location(uuid,uuid,uuid)'::regprocedure
    ) INTO v_definition;

    IF pg_catalog.strpos(
        v_definition,
        'SET status = ''OPEN'', opened_at = v_occurred_at, opened_by = v_actor_id, closed_at = NULL, closed_by = NULL'
    ) = 0 THEN
        RAISE EXCEPTION 'switch_my_counting_location definition does not match the expected reopen contract';
    END IF;

    v_definition := pg_catalog.replace(
        v_definition,
        'SET status = ''OPEN'', opened_at = v_occurred_at, opened_by = v_actor_id, closed_at = NULL, closed_by = NULL',
        'SET status = ''OPEN'', opened_at = v_occurred_at, opened_by = v_actor_id, closed_at = NULL, closed_by = NULL, resolution_status = NULL'
    );

    EXECUTE v_definition;
END;
$migration$;

COMMIT;
