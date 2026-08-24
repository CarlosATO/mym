-- COMV2-14A.2: consumed locks are permanently ineligible in every simulation.

DO $$
DECLARE
    v_signature text;
    v_definition text;
    v_original text;
BEGIN
    FOREACH v_signature IN ARRAY ARRAY[
        'comisiones.get_sales_line_payment_eligibility(uuid,bigint,date,date)',
        'comisiones.get_sales_period_simulation(uuid,date,date)'
    ] LOOP
        SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_definition;
        v_original := v_definition;
        v_definition := replace(
            v_definition,
            'lock.status = ''ACTIVE''',
            'lock.status IN (''ACTIVE'', ''CONSUMED'')'
        );
        IF v_definition = v_original THEN
            RAISE EXCEPTION 'ACTIVE_LOCK_PREDICATE_NOT_FOUND: %', v_signature;
        END IF;
        EXECUTE v_definition;
    END LOOP;
END;
$$;
