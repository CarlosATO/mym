-- COMV2-14A correction: persist deterministic storage reference at PREPARED time.

CREATE OR REPLACE FUNCTION comisiones.prepare_settlement_issuance(
    p_company_id uuid, p_settlement_id uuid
)
RETURNS TABLE (
    issuance_id uuid, settlement_id uuid, status text, issuance_year integer,
    settlement_number bigint, settlement_code text, storage_bucket text,
    storage_path text, pdf_sha256 text, stored_at timestamptz, finalized_at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones
AS $$
DECLARE
    v_actor uuid := auth.uid(); v_settlement comisiones.settlements%ROWTYPE; v_existing comisiones.settlement_issuances%ROWTYPE;
    v_year integer := EXTRACT(YEAR FROM CURRENT_DATE)::integer; v_number bigint; v_code text; v_path text; v_issuance_id uuid;
    v_lines bigint; v_active_locks bigint;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.issue')) THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED'; END IF;
    SELECT s.* INTO v_settlement FROM comisiones.settlements s WHERE s.company_id = p_company_id AND s.id = p_settlement_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND'; END IF;
    SELECT i.* INTO v_existing FROM comisiones.settlement_issuances i WHERE i.company_id = p_company_id AND i.settlement_id = p_settlement_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.status = 'FINALIZED' AND v_settlement.status <> 'ISSUED' THEN RAISE EXCEPTION 'ISSUANCE_STATE_INCONSISTENT'; END IF;
        RETURN QUERY SELECT v_existing.id, v_existing.settlement_id, v_existing.status, v_existing.issuance_year, v_existing.settlement_number, v_existing.settlement_code, v_existing.storage_bucket, v_existing.storage_path, v_existing.pdf_sha256, v_existing.stored_at, v_existing.finalized_at;
        RETURN;
    END IF;
    IF v_settlement.status <> 'DRAFT' THEN RAISE EXCEPTION 'ONLY_DRAFT_SETTLEMENT_CAN_BE_ISSUED'; END IF;
    SELECT count(*) INTO v_lines FROM comisiones.settlement_lines sl WHERE sl.company_id = p_company_id AND sl.settlement_id = p_settlement_id;
    SELECT count(*) INTO v_active_locks FROM comisiones.line_locks l WHERE l.company_id = p_company_id AND l.settlement_id = p_settlement_id AND l.status = 'ACTIVE';
    IF v_lines = 0 THEN RAISE EXCEPTION 'SETTLEMENT_SNAPSHOT_EMPTY'; END IF;
    IF v_active_locks <> v_lines THEN RAISE EXCEPTION 'SETTLEMENT_RESERVATIONS_INCOMPLETE'; END IF;
    INSERT INTO comisiones.settlement_sequences(company_id, sequence_year, last_settlement_number) VALUES (p_company_id, v_year, 1)
    ON CONFLICT (company_id) DO UPDATE SET sequence_year = v_year, last_settlement_number = CASE WHEN comisiones.settlement_sequences.sequence_year = v_year THEN comisiones.settlement_sequences.last_settlement_number + 1 ELSE 1 END, updated_at = now()
    RETURNING settlement_sequences.last_settlement_number INTO v_number;
    v_code := 'LIQ-' || v_year::text || '-' || lpad(v_number::text, 6, '0');
    v_path := p_company_id::text || '/liquidaciones/' || p_settlement_id::text || '/' || v_code || '.pdf';
    INSERT INTO comisiones.settlement_issuances(company_id, settlement_id, issuance_year, settlement_number, settlement_code, storage_bucket, storage_path, prepared_by)
    VALUES (p_company_id, p_settlement_id, v_year, v_number, v_code, 'comisiones-documentos', v_path, v_actor)
    RETURNING id INTO v_issuance_id;
    RETURN QUERY SELECT v_issuance_id, p_settlement_id, 'PREPARED'::text, v_year, v_number, v_code, 'comisiones-documentos'::text, v_path, NULL::text, NULL::timestamptz, NULL::timestamptz;
END;
$$;
