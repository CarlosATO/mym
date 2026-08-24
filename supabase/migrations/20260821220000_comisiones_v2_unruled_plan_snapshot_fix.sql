-- COMV2-10.1 correction: an absent plan needs a typed nullable snapshot row.

DO $$
DECLARE
    function_definition text;
BEGIN
    SELECT pg_get_functiondef('comisiones.create_settlement_draft(uuid,bigint,date,date)'::regprocedure)
    INTO function_definition;
    function_definition := replace(
        function_definition,
        'v_plan record;',
        'v_plan comisiones.commission_plans%ROWTYPE;'
    );
    EXECUTE function_definition;
END;
$$;
