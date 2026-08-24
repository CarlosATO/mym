-- COMV2-14A: idempotent V2 issuance lifecycle and official PDF storage contract.

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'comisiones.v2.issue', 'Emitir liquidaciones de Comisiones V2', 'Emitir borradores V2 como liquidaciones oficiales', id
FROM portal.modules WHERE code = 'comercial'
ON CONFLICT (code) DO NOTHING;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r JOIN portal.permissions p ON p.code = 'comisiones.v2.issue'
WHERE r.name IN ('SUPER_USUARIO', 'GERENCIA', 'FINANZAS')
ON CONFLICT DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('comisiones-documentos', 'comisiones-documentos', false, 10485760, ARRAY['application/pdf']::text[])
ON CONFLICT (id) DO NOTHING;

ALTER TABLE comisiones.settlements
    ADD COLUMN IF NOT EXISTS official_pdf_storage_bucket text,
    ADD COLUMN IF NOT EXISTS official_pdf_storage_path text,
    ADD COLUMN IF NOT EXISTS official_pdf_sha256 text,
    ADD COLUMN IF NOT EXISTS official_pdf_stored_at timestamptz;

ALTER TABLE comisiones.settlement_sequences
    ADD COLUMN IF NOT EXISTS sequence_year integer;

UPDATE comisiones.settlement_sequences
SET sequence_year = COALESCE(sequence_year, EXTRACT(YEAR FROM CURRENT_DATE)::integer)
WHERE sequence_year IS NULL;

ALTER TABLE comisiones.settlement_sequences
    ALTER COLUMN sequence_year SET DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::integer,
    ALTER COLUMN sequence_year SET NOT NULL;

CREATE TABLE IF NOT EXISTS comisiones.settlement_issuances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    settlement_id uuid NOT NULL,
    issuance_year integer NOT NULL,
    settlement_number bigint NOT NULL,
    settlement_code text NOT NULL,
    status text NOT NULL DEFAULT 'PREPARED',
    storage_bucket text,
    storage_path text,
    pdf_sha256 text,
    prepared_at timestamptz NOT NULL DEFAULT now(),
    prepared_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    stored_at timestamptz,
    finalized_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_comisiones_issuances_company_settlement UNIQUE (company_id, settlement_id),
    CONSTRAINT uq_comisiones_issuances_company_year_number UNIQUE (company_id, issuance_year, settlement_number),
    CONSTRAINT uq_comisiones_issuances_company_code UNIQUE (company_id, settlement_code),
    CONSTRAINT chk_comisiones_issuances_status CHECK (status IN ('PREPARED', 'STORED', 'FINALIZED')),
    CONSTRAINT chk_comisiones_issuances_number CHECK (settlement_number > 0),
    CONSTRAINT chk_comisiones_issuances_year CHECK (issuance_year BETWEEN 2000 AND 9999),
    CONSTRAINT chk_comisiones_issuances_stored_shape CHECK (
        (status = 'PREPARED' AND stored_at IS NULL AND finalized_at IS NULL)
        OR (status IN ('STORED', 'FINALIZED') AND stored_at IS NOT NULL)
    ),
    CONSTRAINT chk_comisiones_issuances_finalized_shape CHECK (status <> 'FINALIZED' OR finalized_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_comisiones_issuances_settlement_status
    ON comisiones.settlement_issuances(company_id, settlement_id, status);

ALTER TABLE comisiones.settlement_issuances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON comisiones.settlement_issuances FROM PUBLIC, anon;
GRANT SELECT ON comisiones.settlement_issuances TO authenticated;
GRANT ALL ON comisiones.settlement_issuances TO service_role;
CREATE POLICY comisiones_issuances_read ON comisiones.settlement_issuances
    FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.read') AND core.has_company_access(auth.uid(), company_id)));

CREATE OR REPLACE FUNCTION comisiones.prepare_settlement_issuance(
    p_company_id uuid,
    p_settlement_id uuid
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
    v_actor uuid := auth.uid();
    v_settlement comisiones.settlements%ROWTYPE;
    v_existing comisiones.settlement_issuances%ROWTYPE;
    v_year integer := EXTRACT(YEAR FROM CURRENT_DATE)::integer;
    v_number bigint;
    v_code text;
    v_issuance_id uuid;
    v_lines bigint;
    v_active_locks bigint;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.issue')) THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED'; END IF;

    SELECT s.* INTO v_settlement FROM comisiones.settlements s
    WHERE s.company_id = p_company_id AND s.id = p_settlement_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND'; END IF;

    SELECT i.* INTO v_existing FROM comisiones.settlement_issuances i
    WHERE i.company_id = p_company_id AND i.settlement_id = p_settlement_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.status = 'FINALIZED' AND v_settlement.status <> 'ISSUED' THEN RAISE EXCEPTION 'ISSUANCE_STATE_INCONSISTENT'; END IF;
        RETURN QUERY SELECT v_existing.id, v_existing.settlement_id, v_existing.status, v_existing.issuance_year,
            v_existing.settlement_number, v_existing.settlement_code, v_existing.storage_bucket,
            v_existing.storage_path, v_existing.pdf_sha256, v_existing.stored_at, v_existing.finalized_at;
        RETURN;
    END IF;
    IF v_settlement.status <> 'DRAFT' THEN RAISE EXCEPTION 'ONLY_DRAFT_SETTLEMENT_CAN_BE_ISSUED'; END IF;

    SELECT count(*) INTO v_lines FROM comisiones.settlement_lines sl
    WHERE sl.company_id = p_company_id AND sl.settlement_id = p_settlement_id;
    SELECT count(*) INTO v_active_locks FROM comisiones.line_locks l
    WHERE l.company_id = p_company_id AND l.settlement_id = p_settlement_id AND l.status = 'ACTIVE';
    IF v_lines = 0 THEN RAISE EXCEPTION 'SETTLEMENT_SNAPSHOT_EMPTY'; END IF;
    IF v_active_locks <> v_lines THEN RAISE EXCEPTION 'SETTLEMENT_RESERVATIONS_INCOMPLETE'; END IF;

    INSERT INTO comisiones.settlement_sequences(company_id, sequence_year, last_settlement_number)
    VALUES (p_company_id, v_year, 1)
    ON CONFLICT (company_id) DO UPDATE
    SET sequence_year = v_year,
        last_settlement_number = CASE WHEN comisiones.settlement_sequences.sequence_year = v_year
            THEN comisiones.settlement_sequences.last_settlement_number + 1 ELSE 1 END,
        updated_at = now()
    RETURNING settlement_sequences.last_settlement_number INTO v_number;
    v_code := 'LIQ-' || v_year::text || '-' || lpad(v_number::text, 6, '0');

    INSERT INTO comisiones.settlement_issuances(company_id, settlement_id, issuance_year, settlement_number, settlement_code, prepared_by)
    VALUES (p_company_id, p_settlement_id, v_year, v_number, v_code, v_actor)
    RETURNING id INTO v_issuance_id;

    RETURN QUERY SELECT v_issuance_id, p_settlement_id, 'PREPARED'::text, v_year, v_number, v_code,
        'comisiones-documentos'::text,
        (p_company_id::text || '/liquidaciones/' || p_settlement_id::text || '/' || v_code || '.pdf')::text,
        NULL::text, NULL::timestamptz, NULL::timestamptz;
END;
$$;

CREATE OR REPLACE FUNCTION comisiones.store_settlement_issuance(
    p_company_id uuid, p_issuance_id uuid, p_storage_bucket text, p_storage_path text, p_pdf_sha256 text
)
RETURNS TABLE (issuance_id uuid, settlement_id uuid, status text, storage_bucket text, storage_path text, pdf_sha256 text, stored_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones
AS $$
DECLARE v_actor uuid := auth.uid(); v_issue comisiones.settlement_issuances%ROWTYPE; v_now timestamptz := clock_timestamp();
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.issue')) THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED'; END IF;
    IF p_pdf_sha256 IS NULL OR p_pdf_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_PDF_HASH'; END IF;
    SELECT i.* INTO v_issue FROM comisiones.settlement_issuances i WHERE i.company_id = p_company_id AND i.id = p_issuance_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ISSUANCE_NOT_FOUND'; END IF;
    IF v_issue.status = 'FINALIZED' THEN
        IF v_issue.pdf_sha256 <> p_pdf_sha256 OR v_issue.storage_path <> p_storage_path THEN RAISE EXCEPTION 'ISSUANCE_STORAGE_INTEGRITY_MISMATCH'; END IF;
    ELSIF v_issue.status = 'STORED' THEN
        IF v_issue.pdf_sha256 <> p_pdf_sha256 OR v_issue.storage_path <> p_storage_path THEN RAISE EXCEPTION 'ISSUANCE_STORAGE_INTEGRITY_MISMATCH'; END IF;
    ELSIF v_issue.status = 'PREPARED' THEN
        UPDATE comisiones.settlement_issuances i SET status = 'STORED', storage_bucket = p_storage_bucket,
            storage_path = p_storage_path, pdf_sha256 = p_pdf_sha256, stored_at = v_now, updated_at = v_now
        WHERE i.company_id = p_company_id AND i.id = p_issuance_id;
    ELSE RAISE EXCEPTION 'INVALID_ISSUANCE_STATE'; END IF;
    SELECT * INTO v_issue FROM comisiones.settlement_issuances i WHERE i.company_id = p_company_id AND i.id = p_issuance_id;
    RETURN QUERY SELECT v_issue.id, v_issue.settlement_id, v_issue.status, v_issue.storage_bucket, v_issue.storage_path, v_issue.pdf_sha256, v_issue.stored_at;
END;
$$;

CREATE OR REPLACE FUNCTION comisiones.finalize_settlement_issuance(p_company_id uuid, p_issuance_id uuid)
RETURNS TABLE (settlement_id uuid, status text, settlement_number bigint, settlement_code text, issued_at timestamptz, consumed_locks bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones
AS $$
DECLARE
    v_actor uuid := auth.uid(); v_issue comisiones.settlement_issuances%ROWTYPE; v_settlement comisiones.settlements%ROWTYPE;
    v_before jsonb; v_after jsonb; v_now timestamptz := clock_timestamp(); v_lines bigint; v_locks bigint; v_consumed bigint;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.issue')) THEN RAISE EXCEPTION 'PERMISSION_DENIED'; END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED'; END IF;
    SELECT i.* INTO v_issue FROM comisiones.settlement_issuances i WHERE i.company_id = p_company_id AND i.id = p_issuance_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ISSUANCE_NOT_FOUND'; END IF;
    SELECT s.* INTO v_settlement FROM comisiones.settlements s WHERE s.company_id = p_company_id AND s.id = v_issue.settlement_id FOR UPDATE;
    IF v_settlement.status = 'ISSUED' AND v_issue.status = 'FINALIZED' THEN
        RETURN QUERY SELECT v_settlement.id, v_settlement.status, v_settlement.settlement_number, v_settlement.settlement_code, v_settlement.issued_at, 0::bigint; RETURN;
    END IF;
    IF v_settlement.status <> 'DRAFT' THEN RAISE EXCEPTION 'ONLY_DRAFT_SETTLEMENT_CAN_BE_ISSUED'; END IF;
    IF v_issue.status <> 'STORED' THEN RAISE EXCEPTION 'ISSUANCE_PDF_NOT_STORED'; END IF;
    SELECT count(*) INTO v_lines FROM comisiones.settlement_lines sl WHERE sl.company_id = p_company_id AND sl.settlement_id = v_settlement.id;
    SELECT count(*) INTO v_locks FROM comisiones.line_locks l WHERE l.company_id = p_company_id AND l.settlement_id = v_settlement.id AND l.status = 'ACTIVE';
    IF v_lines = 0 OR v_locks <> v_lines THEN RAISE EXCEPTION 'SETTLEMENT_RESERVATIONS_INCOMPLETE'; END IF;
    v_before := to_jsonb(v_settlement);
    UPDATE comisiones.settlements s SET settlement_number = v_issue.settlement_number, settlement_code = v_issue.settlement_code,
        status = 'ISSUED', issued_at = v_now, issued_by = v_actor, official_pdf_storage_bucket = v_issue.storage_bucket,
        official_pdf_storage_path = v_issue.storage_path, official_pdf_sha256 = v_issue.pdf_sha256,
        official_pdf_stored_at = v_issue.stored_at, updated_at = v_now, updated_by = v_actor
    WHERE s.company_id = p_company_id AND s.id = v_settlement.id;
    UPDATE comisiones.line_locks l SET status = 'CONSUMED', consumed_at = v_now
    WHERE l.company_id = p_company_id AND l.settlement_id = v_settlement.id AND l.status = 'ACTIVE';
    GET DIAGNOSTICS v_consumed = ROW_COUNT;
    UPDATE comisiones.settlement_issuances i SET status = 'FINALIZED', finalized_at = v_now, updated_at = v_now
    WHERE i.company_id = p_company_id AND i.id = v_issue.id;
    SELECT to_jsonb(s) INTO v_after FROM comisiones.settlements s WHERE s.company_id = p_company_id AND s.id = v_settlement.id;
    INSERT INTO comisiones.audit_events(company_id, actor_user_id, event_type, entity_type, entity_id, before_data, after_data, reason)
    VALUES (p_company_id, v_actor, 'SETTLEMENT_ISSUED', 'SETTLEMENT', v_settlement.id, v_before,
        v_after || jsonb_build_object('settlement_number', v_issue.settlement_number, 'settlement_code', v_issue.settlement_code, 'total_net_amount', v_settlement.total_net_amount, 'total_commission_amount', v_settlement.total_commission_amount), 'COMV2-14A definitive issuance');
    RETURN QUERY SELECT v_settlement.id, 'ISSUED'::text, v_issue.settlement_number, v_issue.settlement_code, v_now, v_consumed;
END;
$$;

REVOKE ALL ON FUNCTION comisiones.prepare_settlement_issuance(uuid, uuid), comisiones.store_settlement_issuance(uuid, uuid, text, text, text), comisiones.finalize_settlement_issuance(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.prepare_settlement_issuance(uuid, uuid), comisiones.store_settlement_issuance(uuid, uuid, text, text, text), comisiones.finalize_settlement_issuance(uuid, uuid) TO authenticated, service_role;
