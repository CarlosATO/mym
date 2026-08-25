-- COMV2-24A.3: apply the initialization independently of formatting emitted by
-- pg_get_functiondef across PostgreSQL versions.
DO $$
DECLARE
    v_signature text;
    v_definition text;
BEGIN
    FOREACH v_signature IN ARRAY ARRAY[
        'comisiones.save_family_fixed_plan(uuid,uuid,text,uuid,date,date,jsonb)',
        'comisiones.save_supplier_sales_target_plan(uuid,uuid,text,uuid,date,date,jsonb)'
    ] LOOP
        SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_definition;
        v_definition := replace(v_definition,
            '    IF p_plan_id IS NULL THEN',
            E'    v_used := false;\n    v_changed := true;\n    IF p_plan_id IS NULL THEN');
        EXECUTE v_definition;
    END LOOP;
END;
$$;
