-- COMV2-24A.1: qualify plan_id in the replacement statements. The RETURNS
-- TABLE output column otherwise shadows the table column in PL/pgSQL.
DO $$
DECLARE
    v_signature text;
    v_definition text;
BEGIN
    v_signature := 'comisiones.save_family_fixed_plan(uuid,uuid,text,uuid,date,date,jsonb)';
    SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_definition;
    v_definition := replace(v_definition,
        'DELETE FROM comisiones.commission_plan_family_rates WHERE company_id = p_company_id AND plan_id = v_target;',
        'DELETE FROM comisiones.commission_plan_family_rates fr WHERE fr.company_id = p_company_id AND fr.plan_id = v_target;');
    EXECUTE v_definition;

    v_signature := 'comisiones.save_supplier_sales_target_plan(uuid,uuid,text,uuid,date,date,jsonb)';
    SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_definition;
    v_definition := replace(v_definition,
        'DELETE FROM comisiones.commission_plan_tiers WHERE company_id = p_company_id AND plan_id = v_target;',
        'DELETE FROM comisiones.commission_plan_tiers t WHERE t.company_id = p_company_id AND t.plan_id = v_target;');
    EXECUTE v_definition;
END;
$$;
