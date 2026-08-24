-- COMV2-10.1: unruled eligible lines are snapshot as zero-commission warnings.

DO $$
DECLARE
    function_definition text;
BEGIN
    SELECT pg_get_functiondef('comisiones.create_settlement_draft(uuid,bigint,date,date)'::regprocedure)
    INTO function_definition;

    function_definition := replace(
        function_definition,
        'count(*) FILTER (WHERE simulation_status <> ''RULE_APPLIED'')',
        'count(*) FILTER (WHERE simulation_status IN (''NO_SALES_TARGET_TIER'', ''COMMERCIAL_INCIDENT''))'
    );
    function_definition := replace(
        function_definition,
        E'IF v_invalid_count > 0 THEN\n        RAISE EXCEPTION ''BLOCKING_SIMULATION_INCIDENT'';\n    END IF;',
        E'IF v_invalid_count > 0 THEN\n        IF EXISTS (\n            SELECT 1\n            FROM comisiones.get_sales_line_simulation(p_company_id, p_seller_bsale_id, p_period_from, p_period_to)\n            WHERE simulation_status = ''NO_SALES_TARGET_TIER''\n        ) THEN\n            RAISE EXCEPTION ''BLOCKING_NO_SALES_TARGET_TIER'';\n        END IF;\n        RAISE EXCEPTION ''BLOCKING_COMMERCIAL_INCIDENT'';\n    END IF;'
    );
    function_definition := replace(
        function_definition,
        $old$IF v_row.plan_id IS NULL OR v_row.plan_type IS NULL
           OR v_row.commission_percent IS NULL OR v_row.commission_amount IS NULL THEN
            RAISE EXCEPTION 'INCOMPLETE_CALCULATION_SNAPSHOT';
        END IF;$old$,
        $new$IF v_row.simulation_status = 'RULE_APPLIED'
           AND (v_row.plan_id IS NULL OR v_row.plan_type IS NULL
                OR v_row.commission_percent IS NULL OR v_row.commission_amount IS NULL) THEN
            RAISE EXCEPTION 'INCOMPLETE_CALCULATION_SNAPSHOT';
        END IF;$new$
    );
    function_definition := replace(
        function_definition,
        $old$        SELECT cp.id, cp.plan_code, cp.version_no, cp.plan_type
        INTO v_plan
        FROM comisiones.commission_plans cp
        WHERE cp.company_id = p_company_id AND cp.id = v_row.plan_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'PLAN_SNAPSHOT_NOT_FOUND';
        END IF;$old$,
        $new$        v_plan := NULL;
        IF v_row.plan_id IS NOT NULL THEN
            SELECT cp.id, cp.plan_code, cp.version_no, cp.plan_type
            INTO v_plan
            FROM comisiones.commission_plans cp
            WHERE cp.company_id = p_company_id AND cp.id = v_row.plan_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'PLAN_SNAPSHOT_NOT_FOUND';
            END IF;
        END IF;$new$
    );
    function_definition := replace(
        function_definition,
        'IF v_row.plan_type = ''FAMILY_FIXED_PERCENT'' THEN',
        E'IF v_row.simulation_status = ''NO_ACTIVE_PLAN'' THEN\n            NULL;\n        ELSIF v_row.plan_type = ''FAMILY_FIXED_PERCENT'' THEN'
    );
    function_definition := replace(
        function_definition,
        'IF v_family_rate_id IS NULL THEN',
        'IF v_family_rate_id IS NULL AND v_row.simulation_status = ''RULE_APPLIED'' THEN'
    );
    function_definition := replace(
        function_definition,
        E'v_row.tier_upper_bound, v_row.supplier_total_net, v_row.commission_percent,\n            v_row.net_amount, v_row.commission_amount, ''CLP''',
        E'v_row.tier_upper_bound, v_row.supplier_total_net, COALESCE(v_row.commission_percent, 0),\n            v_row.net_amount, COALESCE(v_row.commission_amount, 0), ''CLP'''
    );
    function_definition := replace(
        function_definition,
        $old$                'payment_record_date', v_row.full_payment_date::date
            )$old$,
        $new$                'payment_record_date', v_row.full_payment_date::date,
                'simulation_status', v_row.simulation_status,
                'simulation_message', v_row.simulation_message,
                'warning', CASE WHEN v_row.simulation_status IN ('NO_ACTIVE_PLAN', 'NO_FAMILY_RATE') THEN true ELSE false END
            )$new$
    );
    EXECUTE function_definition;
END;
$$;

CREATE OR REPLACE FUNCTION comisiones.get_settlement_draft_readiness(
    p_company_id uuid,
    p_seller_bsale_id bigint,
    p_period_from date,
    p_period_to date
)
RETURNS TABLE (
    can_create boolean,
    total_lines bigint,
    total_net_amount numeric,
    total_commission_amount numeric,
    no_active_plan_lines bigint,
    no_active_plan_net numeric,
    no_family_rate_lines bigint,
    no_family_rate_net numeric,
    unruled_lines bigint,
    unruled_net numeric,
    blocking_lines bigint,
    no_sales_target_tier_lines bigint,
    commercial_incident_lines bigint,
    blocking_reasons text[]
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, comercial, integraciones, adquisiciones
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_seller_valid boolean;
    v_existing_draft boolean;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.draft.create')) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'COMPANY_ACCESS_DENIED';
    END IF;
    IF p_seller_bsale_id IS NULL OR p_seller_bsale_id <= 0
       OR p_period_from IS NULL OR p_period_to IS NULL OR p_period_to < p_period_from THEN
        RAISE EXCEPTION 'INVALID_SETTLEMENT_PERIOD';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM comisiones.seller_profiles sp
        WHERE sp.company_id = p_company_id
          AND sp.seller_bsale_id = p_seller_bsale_id
          AND sp.active AND sp.is_commissionable
    ) INTO v_seller_valid;
    SELECT EXISTS (
        SELECT 1 FROM comisiones.settlements s
        WHERE s.company_id = p_company_id AND s.seller_bsale_id = p_seller_bsale_id
          AND s.status = 'DRAFT' AND s.settlement_kind = 'NORMAL'
    ) INTO v_existing_draft;

    RETURN QUERY
    WITH simulation AS MATERIALIZED (
        SELECT *
        FROM comisiones.get_sales_line_simulation(
            p_company_id, p_seller_bsale_id, p_period_from, p_period_to
        )
    ), summary AS (
        SELECT
            count(*)::bigint AS total_lines,
            COALESCE(sum(net_amount), 0)::numeric(18,2) AS total_net_amount,
            COALESCE(sum(COALESCE(commission_amount, 0)), 0)::numeric(18,2) AS total_commission_amount,
            count(*) FILTER (WHERE simulation_status = 'NO_ACTIVE_PLAN')::bigint AS no_active_plan_lines,
            COALESCE(sum(net_amount) FILTER (WHERE simulation_status = 'NO_ACTIVE_PLAN'), 0)::numeric(18,2) AS no_active_plan_net,
            count(*) FILTER (WHERE simulation_status = 'NO_FAMILY_RATE')::bigint AS no_family_rate_lines,
            COALESCE(sum(net_amount) FILTER (WHERE simulation_status = 'NO_FAMILY_RATE'), 0)::numeric(18,2) AS no_family_rate_net,
            count(*) FILTER (WHERE simulation_status IN ('NO_ACTIVE_PLAN', 'NO_FAMILY_RATE'))::bigint AS unruled_lines,
            COALESCE(sum(net_amount) FILTER (WHERE simulation_status IN ('NO_ACTIVE_PLAN', 'NO_FAMILY_RATE')), 0)::numeric(18,2) AS unruled_net,
            count(*) FILTER (WHERE simulation_status IN ('NO_SALES_TARGET_TIER', 'COMMERCIAL_INCIDENT'))::bigint AS blocking_lines,
            count(*) FILTER (WHERE simulation_status = 'NO_SALES_TARGET_TIER')::bigint AS no_sales_target_tier_lines,
            count(*) FILTER (WHERE simulation_status = 'COMMERCIAL_INCIDENT')::bigint AS commercial_incident_lines,
            COALESCE(array_agg(DISTINCT simulation_status::text) FILTER (WHERE simulation_status IN ('NO_SALES_TARGET_TIER', 'COMMERCIAL_INCIDENT')), ARRAY[]::text[]) AS blocking_reasons
        FROM simulation
    )
    SELECT
        v_seller_valid AND NOT v_existing_draft
            AND summary.total_lines > 0 AND summary.blocking_lines = 0,
        summary.total_lines, summary.total_net_amount, summary.total_commission_amount,
        summary.no_active_plan_lines, summary.no_active_plan_net,
        summary.no_family_rate_lines, summary.no_family_rate_net,
        summary.unruled_lines, summary.unruled_net, summary.blocking_lines,
        summary.no_sales_target_tier_lines, summary.commercial_incident_lines,
        summary.blocking_reasons
    FROM summary;
END;
$$;

REVOKE ALL ON FUNCTION comisiones.get_settlement_draft_readiness(uuid, bigint, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_settlement_draft_readiness(uuid, bigint, date, date) TO authenticated, service_role;

COMMENT ON FUNCTION comisiones.get_settlement_draft_readiness(uuid, bigint, date, date) IS
    'COMV2-10.1 server-side preflight. Unruled lines are warnings; target-tier gaps and commercial incidents block creation.';
