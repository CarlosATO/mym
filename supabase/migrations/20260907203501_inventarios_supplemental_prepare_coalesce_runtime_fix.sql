DO $fix$
DECLARE
    v_def text;
    v_occurrences integer;
BEGIN
    SELECT pg_get_functiondef(
        'inventarios.prepare_supplemental_findings_session(uuid,uuid,jsonb,uuid)'::regprocedure
    )
    INTO v_def;

    v_occurrences :=
        (length(v_def) - length(replace(v_def, 'pg_catalog.coalesce', '')))
        / length('pg_catalog.coalesce');

    IF v_occurrences <> 4 THEN
        RAISE EXCEPTION
            'Unexpected pg_catalog.coalesce occurrence count: %',
            v_occurrences;
    END IF;

    v_def := replace(v_def, 'pg_catalog.coalesce', 'coalesce');
    EXECUTE v_def;
END
$fix$;
