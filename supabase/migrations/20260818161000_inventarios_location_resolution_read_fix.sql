-- Complete the resolution_status projection missed by the previous textual patch.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.get_my_counting_zone_locations(uuid)'::regprocedure
    ) INTO v_definition;

    IF pg_catalog.strpos(v_definition, 'tl2.resolution_status') = 0 THEN
        RAISE EXCEPTION 'get_my_counting_zone_locations lateral resolution column is missing';
    END IF;

    IF pg_catalog.strpos(v_definition, 'tl.resolution_status') = 0 THEN
        v_definition := pg_catalog.replace(
            v_definition,
            E'tl.status AS raw_status,\n            tl.opened_at,',
            E'tl.status AS raw_status,\n            tl.resolution_status,\n            tl.opened_at,'
        );
    END IF;

    IF pg_catalog.strpos(v_definition, '''resolution_status'', resolution_status') = 0 THEN
        v_definition := pg_catalog.replace(
            v_definition,
            E'''location_status'', location_status,\n                ''is_active'', is_active,',
            E'''location_status'', location_status,\n                ''resolution_status'', resolution_status,\n                ''is_active'', is_active,'
        );
    END IF;

    IF pg_catalog.strpos(v_definition, 'tl.resolution_status') = 0
       OR pg_catalog.strpos(v_definition, '''resolution_status'', resolution_status') = 0 THEN
        RAISE EXCEPTION 'get_my_counting_zone_locations resolution projection could not be completed';
    END IF;

    EXECUTE v_definition;
END;
$migration$;

COMMIT;
