-- COMV2-14A.2: forward-only hardening for already deployed issuance functions.

DO $$
DECLARE
    v_signature text;
    v_definition text;
    v_original text;
BEGIN
    v_signature := 'comisiones.finalize_settlement_issuance(uuid,uuid)';
    SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_definition;
    v_original := v_definition;
    v_definition := replace(
        v_definition,
        'UPDATE comisiones.line_locks l SET status = ''CONSUMED'', consumed_at = v_now',
        'UPDATE comisiones.line_locks l SET status = ''CONSUMED'', lock_kind = ''DEFINITIVE'', consumed_at = v_now'
    );
    IF v_definition = v_original THEN
        RAISE EXCEPTION 'FINALIZE_LOCK_KIND_CONTRACT_NOT_FOUND';
    END IF;
    EXECUTE v_definition;

    v_signature := 'comisiones.store_settlement_issuance(uuid,uuid,text,text,text)';
    SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_definition;
    v_original := v_definition;
    v_definition := replace(
        v_definition,
        'IF NOT FOUND THEN RAISE EXCEPTION ''ISSUANCE_NOT_FOUND''; END IF;',
        'IF NOT FOUND THEN RAISE EXCEPTION ''ISSUANCE_NOT_FOUND''; END IF;
    IF p_storage_bucket <> ''comisiones-documentos''
       OR p_storage_path <> (p_company_id::text || ''/liquidaciones/'' || v_issue.settlement_id::text || ''/'' || v_issue.settlement_code || ''.pdf'') THEN
        RAISE EXCEPTION ''ISSUANCE_STORAGE_REFERENCE_MISMATCH'';
    END IF;'
    );
    IF v_definition = v_original THEN
        RAISE EXCEPTION 'STORE_STORAGE_REFERENCE_CONTRACT_NOT_FOUND';
    END IF;
    EXECUTE v_definition;
END;
$$;
