-- COMV2-22A.1: an identical payload on a used plan must not replace its tiers.

DO $$
DECLARE
    v_signature text := 'comisiones.save_supplier_sales_target_plan(uuid,uuid,text,uuid,date,date,jsonb)';
    v_definition text;
    v_old text := E'    DELETE FROM comisiones.commission_plan_tiers t\n    WHERE t.company_id = p_company_id AND t.plan_id = v_target_plan_id;';
    v_new text := E'    IF NOT (v_used AND NOT v_plan_changed) THEN\n        DELETE FROM comisiones.commission_plan_tiers t\n        WHERE t.company_id = p_company_id AND t.plan_id = v_target_plan_id;\n    END IF;';
BEGIN
    SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_definition;
    IF position(v_old IN v_definition) = 0 THEN
        RAISE EXCEPTION 'TARGET_TIER_DELETE_STATEMENT_NOT_FOUND';
    END IF;
    EXECUTE replace(v_definition, v_old, v_new);
END;
$$;
