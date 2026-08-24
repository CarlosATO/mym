-- COMV2-10.1 correction: populate the typed plan snapshot with the full row.

DO $$
DECLARE
    function_definition text;
BEGIN
    SELECT pg_get_functiondef('comisiones.create_settlement_draft(uuid,bigint,date,date)'::regprocedure)
    INTO function_definition;
    function_definition := replace(
        function_definition,
        E'SELECT cp.id, cp.plan_code, cp.version_no, cp.plan_type\n            INTO v_plan',
        E'SELECT cp.*\n            INTO v_plan'
    );
    EXECUTE function_definition;
END;
$$;
