-- COMV2-14A.1: consumed lines remain permanently ineligible.

DO $$
DECLARE
    v_signature text;
    v_definition text;
BEGIN
    FOREACH v_signature IN ARRAY ARRAY[
        'comisiones.get_sales_line_payment_eligibility(uuid,bigint,date,date)',
        'comisiones.get_sales_period_simulation(uuid,date,date)'
    ] LOOP
        SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_definition;
        v_definition := replace(
            v_definition,
            'lock.status IN (''ACTIVE'', ''CONSUMED'')',
            'lock.status = ''ACTIVE'''
        );
        IF v_definition = pg_get_functiondef(v_signature::regprocedure) THEN
            RAISE EXCEPTION 'ACTIVE_ONLY_LOCK_GUARD_NOT_FOUND: %', v_signature;
        END IF;
        EXECUTE v_definition;
    END LOOP;
END;
$$;
