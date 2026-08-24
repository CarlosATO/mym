-- COMV2-07 correction: Bsale payment_record_date is a civil Bsale date
-- serialized as timestamptz at 00:00 UTC. Do not shift it to Santiago.

DO $$
DECLARE
    function_definition text;
BEGIN
    SELECT pg_get_functiondef('comisiones.get_sales_line_payment_eligibility(uuid,bigint,date,date)'::regprocedure)
    INTO function_definition;
    function_definition := replace(
        function_definition,
        '(r.last_payment_date AT TIME ZONE ''America/Santiago'')::date',
        'r.last_payment_date::date'
    );
    EXECUTE function_definition;

    SELECT pg_get_functiondef('comisiones.get_sales_line_simulation(uuid,bigint,date,date)'::regprocedure)
    INTO function_definition;
    function_definition := replace(
        function_definition,
        '(e.full_payment_date AT TIME ZONE ''America/Santiago'')::date',
        'e.full_payment_date::date'
    );
    EXECUTE function_definition;
END;
$$;
