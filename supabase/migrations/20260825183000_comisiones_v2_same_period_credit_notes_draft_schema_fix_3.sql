-- COMV2-29D forward fix 3: remove the unavailable original invoice number
-- column from the generated INSERT; retain it in the traceability metadata.

DO $$
DECLARE
    function_definition text;
BEGIN
    SELECT pg_get_functiondef(
        'comisiones.create_settlement_draft(uuid, bigint, date, date)'::regprocedure
    ) INTO function_definition;

    function_definition := regexp_replace(
        function_definition,
        'original_invoice_number,[[:space:]]*',
        '',
        'g'
    );
    function_definition := regexp_replace(
        function_definition,
        'v_row[.]original_invoice_number::bigint,[[:space:]]*',
        '',
        'g'
    );

    EXECUTE function_definition;
END;
$$;
