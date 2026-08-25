-- COMV2-22A.2: skip tier replacement entirely for an identical used payload.

DO $$
DECLARE
    v_signature text := 'comisiones.save_supplier_sales_target_plan(uuid,uuid,text,uuid,date,date,jsonb)';
    v_definition text;
    v_old text := E'    FOR v_tier IN SELECT value FROM jsonb_array_elements(p_tiers) ORDER BY (value ->> ''tier_order'')::integer LOOP\n        INSERT INTO comisiones.commission_plan_tiers (company_id, plan_id, tier_order, lower_bound, upper_bound, percentage, created_by, updated_by)\n        VALUES (p_company_id, v_target_plan_id, (v_tier ->> ''tier_order'')::smallint, (v_tier ->> ''lower_bound'')::numeric, NULLIF(v_tier ->> ''upper_bound'', '''')::numeric, (v_tier ->> ''percentage'')::numeric, v_actor, v_actor);\n    END LOOP;';
    v_new text := E'    IF NOT (v_used AND NOT v_plan_changed) THEN\n        FOR v_tier IN SELECT value FROM jsonb_array_elements(p_tiers) ORDER BY (value ->> ''tier_order'')::integer LOOP\n            INSERT INTO comisiones.commission_plan_tiers (company_id, plan_id, tier_order, lower_bound, upper_bound, percentage, created_by, updated_by)\n            VALUES (p_company_id, v_target_plan_id, (v_tier ->> ''tier_order'')::smallint, (v_tier ->> ''lower_bound'')::numeric, NULLIF(v_tier ->> ''upper_bound'', '''')::numeric, (v_tier ->> ''percentage'')::numeric, v_actor, v_actor);\n        END LOOP;\n    END IF;';
BEGIN
    SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_definition;
    IF position(v_old IN v_definition) = 0 THEN
        RAISE EXCEPTION 'TARGET_TIER_INSERT_LOOP_NOT_FOUND';
    END IF;
    EXECUTE replace(v_definition, v_old, v_new);
END;
$$;
