-- =========================================================================================
-- MIGRATION: M1.5H fix - relaxa chk_inventarios_audits_submitted_by
-- =========================================================================================
-- El CHECK exigia status='SUBMITTED' cuando submitted_at estaba presente, incompatible con
-- el estado agregado por producto (PARTIALLY_RESOLVED/RESOLVED/APPROVED/REJECTED conservan
-- submitted_at tras el envio). Se conserva la trazabilidad (submitted_at -> submitted_by).
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

DO $$
DECLARE
    v_con text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
               WHERE c.conrelid = 'inventarios.inventory_audits'::regclass
                 AND c.conname = 'chk_inventarios_audits_submitted_by') THEN
        ALTER TABLE inventarios.inventory_audits DROP CONSTRAINT chk_inventarios_audits_submitted_by;
    ELSE
        SELECT c.conname INTO v_con
        FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = 'inventarios.inventory_audits'::regclass
          AND c.contype = 'c'
          AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%submitted_by%'
        ORDER BY c.conname
        LIMIT 1;
        IF v_con IS NOT NULL THEN
            EXECUTE pg_catalog.format('ALTER TABLE inventarios.inventory_audits DROP CONSTRAINT %I', v_con);
        END IF;
    END IF;
END;
$$;

ALTER TABLE inventarios.inventory_audits
    ADD CONSTRAINT chk_inventarios_audits_submitted_by
    CHECK (submitted_at IS NULL OR submitted_by IS NOT NULL);

COMMIT;
