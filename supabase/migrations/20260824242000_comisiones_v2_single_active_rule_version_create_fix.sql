-- COMV2-24A.2: new plans must always materialize their configuration rows.
DO $$
DECLARE
    v_signature text;
    v_definition text;
BEGIN
    v_signature := 'comisiones.save_family_fixed_plan(uuid,uuid,text,uuid,date,date,jsonb)';
    SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_definition;
    v_definition := replace(v_definition,
        'PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || '':'' || p_supplier_id::text || '':FAMILY_FIXED_PERCENT'', 0));\n    IF p_plan_id IS NULL THEN',
        'PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || '':'' || p_supplier_id::text || '':FAMILY_FIXED_PERCENT'', 0));\n    v_used := false;\n    v_changed := true;\n    IF p_plan_id IS NULL THEN');
    EXECUTE v_definition;

    v_signature := 'comisiones.save_supplier_sales_target_plan(uuid,uuid,text,uuid,date,date,jsonb)';
    SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_definition;
    v_definition := replace(v_definition,
        'PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || '':'' || p_supplier_id::text || '':SUPPLIER_SALES_TARGET'', 0));\n    IF p_plan_id IS NULL THEN',
        'PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || '':'' || p_supplier_id::text || '':SUPPLIER_SALES_TARGET'', 0));\n    v_used := false;\n    v_changed := true;\n    IF p_plan_id IS NULL THEN');
    EXECUTE v_definition;
END;
$$;
