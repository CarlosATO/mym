-- COMV2-29D forward fix: give the optional plan snapshot a stable row type
-- so NO_ACTIVE_PLAN rows can persist NULL plan fields safely.

DO $$
DECLARE
    function_definition text;
BEGIN
    SELECT pg_get_functiondef(
        'comisiones.create_settlement_draft(uuid, bigint, date, date)'::regprocedure
    ) INTO function_definition;

    function_definition := replace(
        function_definition,
        'v_plan record;',
        'v_plan comisiones.commission_plans%ROWTYPE;'
    );
    function_definition := replace(
        function_definition,
        'SELECT cp.id, cp.plan_code, cp.version_no, cp.plan_type',
        'SELECT cp.*'
    );

    EXECUTE function_definition;
END;
$$;
