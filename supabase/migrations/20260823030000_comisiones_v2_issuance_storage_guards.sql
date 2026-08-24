-- COMV2-14A hardening: DB-side guards prevent ISSUED without an official object.

CREATE OR REPLACE FUNCTION comisiones.guard_settlement_issuance_storage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, storage, comisiones
AS $$
BEGIN
    IF NEW.status IN ('STORED', 'FINALIZED') THEN
        IF NEW.storage_bucket <> 'comisiones-documentos' OR NEW.storage_path IS NULL OR NEW.pdf_sha256 IS NULL THEN
            RAISE EXCEPTION 'ISSUANCE_STORAGE_REFERENCE_INCOMPLETE';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM storage.objects o
            WHERE o.bucket_id = NEW.storage_bucket AND o.name = NEW.storage_path
        ) THEN
            RAISE EXCEPTION 'OFFICIAL_PDF_NOT_FOUND';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_settlement_issuance_storage ON comisiones.settlement_issuances;
CREATE TRIGGER guard_settlement_issuance_storage
BEFORE INSERT OR UPDATE ON comisiones.settlement_issuances
FOR EACH ROW EXECUTE FUNCTION comisiones.guard_settlement_issuance_storage();

CREATE OR REPLACE FUNCTION comisiones.guard_issued_pdf_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = 'ISSUED' AND (
        NEW.official_pdf_storage_bucket IS NULL OR
        NEW.official_pdf_storage_path IS NULL OR
        NEW.official_pdf_sha256 IS NULL OR
        NEW.official_pdf_stored_at IS NULL
    ) THEN
        RAISE EXCEPTION 'ISSUED_SETTLEMENT_REQUIRES_OFFICIAL_PDF';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_issued_pdf_reference ON comisiones.settlements;
CREATE TRIGGER guard_issued_pdf_reference
BEFORE INSERT OR UPDATE ON comisiones.settlements
FOR EACH ROW EXECUTE FUNCTION comisiones.guard_issued_pdf_reference();
