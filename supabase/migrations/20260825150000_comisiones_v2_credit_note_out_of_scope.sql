-- COMV2-28C: classify deterministic credit notes for non-commissionable
-- Bsale documents separately from unresolved or ambiguous references.
-- The previous migration remains immutable; this forward migration only
-- replaces the deployed read-only function definition.

DO $$
DECLARE
    v_definition text;
BEGIN
    SELECT pg_get_functiondef(
        'comisiones.get_credit_note_adjustment_candidates(uuid,date,date)'::regprocedure
    ) INTO v_definition;

    v_definition := replace(v_definition,
        'AND by_id.document_type_id = 5',
        ''
    );
    v_definition := replace(v_definition,
        'AND d.document_type_id = 5',
        ''
    );
    v_definition := replace(v_definition,
        'SELECT d.id AS document_id, d.bsale_id, d.number, count(*) OVER () AS match_count',
        'SELECT d.id AS document_id, d.bsale_id, d.number, d.document_type_id, count(*) OVER () AS match_count'
    );
    v_definition := replace(v_definition,
        'AND original_doc.document_type_id = 5',
        'AND original_doc.document_type_id IS NOT NULL'
    );
    v_definition := replace(v_definition,
        'WHEN cn.referenced_type IS NOT NULL AND cn.referenced_type NOT IN (''5'', ''33'') THEN ''AMBIGUOUS''',
        'WHEN cn.referenced_type IS NOT NULL AND cn.referenced_type NOT IN (''1'', ''5'', ''33'', ''39'') THEN ''AMBIGUOUS'''
    );
    v_definition := replace(v_definition,
        'WHEN cn.referenced_document_id IS NOT NULL AND by_id.bsale_id IS NOT NULL THEN ''RESOLVED''',
        'WHEN cn.referenced_document_id IS NOT NULL AND by_id.bsale_id IS NOT NULL AND by_id.document_type_id <> 5 THEN ''OUT_OF_SCOPE''
            WHEN cn.referenced_document_id IS NOT NULL AND by_id.bsale_id IS NOT NULL THEN ''RESOLVED'''
    );
    v_definition := replace(v_definition,
        'WHEN cn.referenced_document_id IS NULL AND by_number.match_count = 1 THEN ''RESOLVED''',
        'WHEN cn.referenced_document_id IS NULL AND by_number.match_count = 1 AND by_number.document_type_id <> 5 THEN ''OUT_OF_SCOPE''
            WHEN cn.referenced_document_id IS NULL AND by_number.match_count = 1 THEN ''RESOLVED'''
    );
    v_definition := replace(v_definition,
        'WHEN cn.referenced_type IS NOT NULL AND cn.referenced_type NOT IN (''5'', ''33'') THEN ''REFERENCE_TYPE_CONFLICT''',
        'WHEN cn.referenced_type IS NOT NULL AND cn.referenced_type NOT IN (''1'', ''5'', ''33'', ''39'') THEN ''REFERENCE_TYPE_CONFLICT'''
    );
    v_definition := replace(v_definition,
        'WHEN cn.referenced_document_id IS NOT NULL AND by_id.bsale_id IS NOT NULL THEN ''REFERENCE_ID_RESOLVED''',
        'WHEN cn.referenced_document_id IS NOT NULL AND by_id.bsale_id IS NOT NULL AND by_id.document_type_id <> 5 THEN ''OUT_OF_SCOPE_DOCUMENT''
            WHEN cn.referenced_document_id IS NOT NULL AND by_id.bsale_id IS NOT NULL THEN ''REFERENCE_ID_RESOLVED'''
    );
    v_definition := replace(v_definition,
        'WHEN cn.referenced_document_id IS NULL AND by_number.match_count = 1 THEN ''REFERENCE_NUMBER_RESOLVED''',
        'WHEN cn.referenced_document_id IS NULL AND by_number.match_count = 1 AND by_number.document_type_id <> 5 THEN ''OUT_OF_SCOPE_DOCUMENT''
            WHEN cn.referenced_document_id IS NULL AND by_number.match_count = 1 THEN ''REFERENCE_NUMBER_RESOLVED'''
    );
    v_definition := replace(v_definition,
        'WHEN dr.document_resolution_status = ''RESOLVED''',
        'WHEN dr.document_resolution_status IN (''RESOLVED'', ''OUT_OF_SCOPE'')'
    );
    v_definition := replace(v_definition,
        'WHEN o.document_resolution_status = ''UNRESOLVED'' THEN ''No deterministic Bsale invoice reference was found.''',
        'WHEN o.document_resolution_status = ''OUT_OF_SCOPE'' THEN ''La nota de crédito corresponde a un documento no comisionable.''
        WHEN o.document_resolution_status = ''UNRESOLVED'' THEN ''No deterministic Bsale invoice reference was found.'''
    );

    IF v_definition = pg_get_functiondef(
        'comisiones.get_credit_note_adjustment_candidates(uuid,date,date)'::regprocedure
    ) THEN
        RAISE EXCEPTION 'CREDIT_NOTE_OUT_OF_SCOPE_REPLACEMENT_NOT_APPLIED';
    END IF;

    EXECUTE v_definition;
END;
$$;

COMMENT ON FUNCTION comisiones.get_credit_note_adjustment_candidates(uuid, date, date) IS
    'COMV2-28C deterministic credit-note resolver. Non-type-5 original Bsale documents are OUT_OF_SCOPE; only type-5 invoices can affect commissions.';
