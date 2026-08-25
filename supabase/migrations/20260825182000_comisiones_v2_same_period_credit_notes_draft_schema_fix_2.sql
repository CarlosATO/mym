-- COMV2-29D forward fix 2: normalize the generated function text regardless
-- of pg_get_functiondef indentation.

DO $$
DECLARE
    function_definition text;
BEGIN
    SELECT pg_get_functiondef(
        'comisiones.create_settlement_draft(uuid, bigint, date, date)'::regprocedure
    ) INTO function_definition;

    function_definition := regexp_replace(
        function_definition,
        'original_invoice_number,\\s*',
        '',
        'g'
    );
    function_definition := regexp_replace(
        function_definition,
        'v_row\\.original_invoice_number::bigint,\\s*',
        '',
        'g'
    );
    function_definition := replace(
        function_definition,
        '''credit_note_placement'', ''SAME_PERIOD''',
        '''credit_note_placement'', ''SAME_PERIOD'', ''original_invoice_number'', v_row.original_invoice_number'
    );

    EXECUTE function_definition;
END;
$$;
