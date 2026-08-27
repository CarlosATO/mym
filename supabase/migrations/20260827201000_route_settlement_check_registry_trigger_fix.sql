-- The registry trigger must observe Payment annulments, not initial inserts.
-- Existing VOIDED Payments are still represented as ANULADO by the read-model.

CREATE OR REPLACE FUNCTION adquisiciones.record_route_settlement_check_void_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_actor uuid := COALESCE(NEW.voided_by, NEW.updated_by, auth.uid());
BEGIN
    IF NEW.payment_method_received = 'CHECK'
       AND (NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL
            OR NEW.verification_status = 'VOIDED' AND OLD.verification_status IS DISTINCT FROM 'VOIDED') THEN
        IF v_actor IS NULL THEN
            RAISE EXCEPTION 'La anulacion del cheque requiere usuario.';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM adquisiciones.route_settlement_check_status_history h
            WHERE h.payment_id = NEW.id AND h.status = 'DEPOSITADO'
        ) THEN
            RAISE EXCEPTION 'Un cheque depositado no puede anularse.';
        END IF;

        INSERT INTO adquisiciones.route_settlement_check_status_history(
            company_id, payment_id, status, changed_by, reason
        ) VALUES (
            NEW.company_id, NEW.id, 'ANULADO', v_actor, NEW.void_reason
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_route_settlement_check_void_status
    ON adquisiciones.route_settlement_payments;
CREATE TRIGGER trg_route_settlement_check_void_status
AFTER UPDATE OF verification_status, voided_at, voided_by, void_reason
ON adquisiciones.route_settlement_payments
FOR EACH ROW
EXECUTE FUNCTION adquisiciones.record_route_settlement_check_void_status();
