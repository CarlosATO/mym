-- COMV2-11 correction: the draft listing must remain draft-only.

DO $$
DECLARE
    function_definition text;
BEGIN
    SELECT pg_get_functiondef('comisiones.list_settlement_drafts(uuid)'::regprocedure)
    INTO function_definition;
    function_definition := replace(
        function_definition,
        E'AND s.settlement_kind = ''NORMAL''\n    GROUP BY s.id',
        E'AND s.settlement_kind = ''NORMAL''\n      AND s.status = ''DRAFT''\n    GROUP BY s.id'
    );
    EXECUTE function_definition;
END;
$$;
