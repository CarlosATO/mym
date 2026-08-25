-- COMV2-29D forward fix: settlement_lines stores the original invoice number
-- in metadata; its structured original-document columns are IDs only.

DO $$
DECLARE
    function_definition text;
BEGIN
    SELECT pg_get_functiondef(
        'comisiones.create_settlement_draft(uuid, bigint, date, date)'::regprocedure
    ) INTO function_definition;

    function_definition := replace(
        function_definition,
        '            original_invoice_number, original_invoice_line_id, original_invoice_detail_bsale_id,\n',
        '            original_invoice_line_id, original_invoice_detail_bsale_id,\n'
    );
    function_definition := replace(
        function_definition,
        '            v_row.original_invoice_bsale_id::integer, v_row.original_invoice_number::bigint,\n            v_row.original_invoice_line_id, v_row.original_invoice_detail_bsale_id::integer,\n',
        '            v_row.original_invoice_bsale_id::integer,\n            v_row.original_invoice_line_id, v_row.original_invoice_detail_bsale_id::integer,\n'
    );

    function_definition := replace(
        function_definition,
        '                THEN jsonb_build_object(''credit_note_placement'', ''SAME_PERIOD'')\n',
        '                THEN jsonb_build_object(''credit_note_placement'', ''SAME_PERIOD'', ''original_invoice_number'', v_row.original_invoice_number)\n'
    );

    EXECUTE function_definition;
END;
$$;
