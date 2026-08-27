-- Individual check membership for fund-closure deposits.
-- Existing deposits remain aggregate/legacy and are intentionally not backfilled.

CREATE TABLE IF NOT EXISTS adquisiciones.route_fund_closure_deposit_checks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    deposit_id uuid NOT NULL REFERENCES adquisiciones.route_fund_closure_deposits(id) ON DELETE CASCADE,
    payment_id uuid NOT NULL REFERENCES adquisiciones.route_settlement_payments(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id),
    CONSTRAINT uq_route_fund_closure_deposit_check UNIQUE (deposit_id, payment_id)
);

CREATE INDEX IF NOT EXISTS idx_route_fund_closure_deposit_checks_payment
    ON adquisiciones.route_fund_closure_deposit_checks(payment_id);
CREATE INDEX IF NOT EXISTS idx_route_fund_closure_deposit_checks_deposit
    ON adquisiciones.route_fund_closure_deposit_checks(deposit_id);

ALTER TABLE adquisiciones.route_fund_closure_deposit_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON adquisiciones.route_fund_closure_deposit_checks FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION adquisiciones.validate_route_fund_closure_deposit_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_deposit adquisiciones.route_fund_closure_deposits;
    v_payment adquisiciones.route_settlement_payments;
BEGIN
    SELECT * INTO v_deposit
    FROM adquisiciones.route_fund_closure_deposits
    WHERE id = NEW.deposit_id
    FOR SHARE;
    IF NOT FOUND OR v_deposit.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'El depósito no está activo.';
    END IF;

    SELECT * INTO v_payment
    FROM adquisiciones.route_settlement_payments
    WHERE id = NEW.payment_id
    FOR SHARE;
    IF NOT FOUND OR v_payment.payment_method_received <> 'CHECK' THEN
        RAISE EXCEPTION 'Sólo se pueden asociar Payments CHECK.';
    END IF;
    IF v_payment.company_id IS DISTINCT FROM NEW.company_id
       OR v_payment.company_id IS DISTINCT FROM v_deposit.company_id THEN
        RAISE EXCEPTION 'El cheque y el depósito deben pertenecer a la misma empresa.';
    END IF;
    IF v_payment.voided_at IS NOT NULL OR v_payment.verification_status = 'VOIDED' THEN
        RAISE EXCEPTION 'Un cheque anulado no puede asociarse a un depósito.';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM adquisiciones.route_fund_closure_items i
        WHERE i.fund_closure_id = v_deposit.fund_closure_id
          AND i.payment_id = v_payment.id
          AND i.released_at IS NULL
    ) THEN
        RAISE EXCEPTION 'El cheque no pertenece al Cierre de Fondos del depósito.';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM adquisiciones.route_fund_closure_deposit_checks x
        JOIN adquisiciones.route_fund_closure_deposits dx ON dx.id = x.deposit_id
        WHERE x.payment_id = NEW.payment_id
          AND dx.status = 'ACTIVE'
          AND x.deposit_id <> NEW.deposit_id
    ) THEN
        RAISE EXCEPTION 'El cheque ya pertenece a otro depósito activo.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_route_fund_closure_deposit_check
    ON adquisiciones.route_fund_closure_deposit_checks;
CREATE TRIGGER trg_validate_route_fund_closure_deposit_check
BEFORE INSERT OR UPDATE ON adquisiciones.route_fund_closure_deposit_checks
FOR EACH ROW EXECUTE FUNCTION adquisiciones.validate_route_fund_closure_deposit_check();

-- A legacy six-argument call remains valid and creates an aggregate, unassigned
-- deposit. New callers must use the seven-argument form for check traceability.
CREATE OR REPLACE FUNCTION adquisiciones.register_route_fund_closure_deposit(
    p_fund_closure_id uuid,
    p_amount numeric,
    p_deposit_date date,
    p_deposit_method text,
    p_reference_number text DEFAULT NULL,
    p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
BEGIN
    RETURN adquisiciones.register_route_fund_closure_deposit(
        p_fund_closure_id, p_amount, p_deposit_date, p_deposit_method,
        ARRAY[]::uuid[], p_reference_number, p_notes
    );
END;
$$;

CREATE OR REPLACE FUNCTION adquisiciones.register_route_fund_closure_deposit(
    p_fund_closure_id uuid,
    p_amount numeric,
    p_deposit_date date,
    p_deposit_method text,
    p_check_payment_ids uuid[],
    p_reference_number text DEFAULT NULL,
    p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_closure adquisiciones.route_fund_closures;
    v_deposited numeric;
    v_balance numeric;
    v_deposit uuid;
    v_ref text;
    v_notes text;
    v_check_total numeric;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'No autorizado.'; END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'El monto del depósito debe ser mayor que cero.'; END IF;
    IF p_deposit_date IS NULL THEN RAISE EXCEPTION 'Debe indicar la fecha del depósito.'; END IF;
    IF p_deposit_method IS NULL OR p_deposit_method NOT IN ('DEPOSIT', 'CASH_DELIVERY', 'TRANSFER', 'OTHER') THEN RAISE EXCEPTION 'Método de depósito inválido.'; END IF;
    IF cardinality(COALESCE(p_check_payment_ids, ARRAY[]::uuid[])) <> cardinality(ARRAY(SELECT DISTINCT unnest(COALESCE(p_check_payment_ids, ARRAY[]::uuid[])))) THEN
        RAISE EXCEPTION 'La selección de cheques contiene duplicados.';
    END IF;

    SELECT * INTO v_closure FROM adquisiciones.route_fund_closures WHERE id = p_fund_closure_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cierre de Fondos no encontrado.'; END IF;
    IF NOT core.has_company_access(v_actor, v_closure.company_id) THEN RAISE EXCEPTION 'Usuario o empresa inválidos.'; END IF;
    IF NOT portal.user_has_permission(v_actor, 'adquisiciones.route_fund_closures.update') THEN RAISE EXCEPTION 'No tiene permisos para registrar depósitos.'; END IF;
    IF v_closure.status = 'CANCELLED' THEN RAISE EXCEPTION 'El Cierre está anulado.'; END IF;
    IF v_closure.status NOT IN ('CLOSED', 'WITH_DIFFERENCE') OR v_closure.closed_at IS NULL THEN RAISE EXCEPTION 'El depósito sólo se permite sobre un Cierre finalizado.'; END IF;

    IF EXISTS (
        SELECT 1 FROM unnest(COALESCE(p_check_payment_ids, ARRAY[]::uuid[])) ids(payment_id)
        WHERE NOT EXISTS (
            SELECT 1 FROM adquisiciones.route_fund_closure_items i
            JOIN adquisiciones.route_settlement_payments p ON p.id = i.payment_id
            WHERE i.fund_closure_id = v_closure.id AND i.payment_id = ids.payment_id
              AND i.released_at IS NULL AND p.company_id = v_closure.company_id
              AND p.payment_method_received = 'CHECK'
              AND p.verification_status <> 'VOIDED' AND p.voided_at IS NULL
        )
    ) THEN RAISE EXCEPTION 'Uno o más cheques no pertenecen al Cierre activo.'; END IF;
    IF EXISTS (
        SELECT 1 FROM unnest(COALESCE(p_check_payment_ids, ARRAY[]::uuid[])) ids(payment_id)
        JOIN adquisiciones.route_fund_closure_deposit_checks x ON x.payment_id = ids.payment_id
        JOIN adquisiciones.route_fund_closure_deposits d ON d.id = x.deposit_id
        WHERE d.status = 'ACTIVE'
    ) THEN RAISE EXCEPTION 'Uno o más cheques ya están asociados a un depósito activo.'; END IF;

    SELECT COALESCE(sum(d.amount), 0) INTO v_deposited
    FROM adquisiciones.route_fund_closure_deposits d
    WHERE d.fund_closure_id = v_closure.id AND d.status = 'ACTIVE';
    v_balance := v_closure.cash_delivered + v_closure.total_check_received - v_deposited;
    IF p_amount > v_balance THEN RAISE EXCEPTION 'El monto supera el saldo por depositar.'; END IF;

    SELECT COALESCE(sum(p.amount_received), 0) INTO v_check_total
    FROM adquisiciones.route_settlement_payments p
    WHERE p.id = ANY(COALESCE(p_check_payment_ids, ARRAY[]::uuid[]));
    IF v_check_total > p_amount THEN RAISE EXCEPTION 'El monto de los cheques seleccionados supera el monto del depósito.'; END IF;

    v_ref := NULLIF(btrim(COALESCE(p_reference_number, '')), '');
    v_notes := NULLIF(btrim(COALESCE(p_notes, '')), '');
    INSERT INTO adquisiciones.route_fund_closure_deposits(company_id, fund_closure_id, deposit_method, amount, deposit_date, reference_number, notes, created_by, status)
    VALUES (v_closure.company_id, v_closure.id, p_deposit_method, p_amount, p_deposit_date, v_ref, v_notes, v_actor, 'ACTIVE')
    RETURNING id INTO v_deposit;

    INSERT INTO adquisiciones.route_fund_closure_deposit_checks(company_id, deposit_id, payment_id, created_by)
    SELECT v_closure.company_id, v_deposit, ids.payment_id, v_actor
    FROM unnest(COALESCE(p_check_payment_ids, ARRAY[]::uuid[])) ids(payment_id);

    UPDATE adquisiciones.route_fund_closures SET total_deposits = v_deposited + p_amount WHERE id = v_closure.id;
    INSERT INTO portal.audit_logs(schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES ('adquisiciones', 'ADQUISICIONES', 'route_fund_closure_deposits', v_deposit, 'INSERT',
        jsonb_build_object('fund_closure_id', v_closure.id, 'amount', p_amount, 'deposit_date', p_deposit_date, 'check_payment_ids', COALESCE(p_check_payment_ids, ARRAY[]::uuid[])),
        v_actor, 'ROUTE_FUND_DEPOSIT_REGISTERED', 'INFO');
    RETURN jsonb_build_object('deposit_id', v_deposit, 'fund_closure_id', v_closure.id, 'amount', p_amount, 'deposit_date', p_deposit_date, 'deposit_method', p_deposit_method, 'reference_number', v_ref, 'status', 'ACTIVE', 'check_payment_ids', COALESCE(p_check_payment_ids, ARRAY[]::uuid[]), 'total_fisico_recibido', v_closure.cash_delivered + v_closure.total_check_received, 'total_depositado', v_deposited + p_amount, 'saldo_por_depositar', v_balance - p_amount);
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.register_route_fund_closure_deposit(uuid, numeric, date, text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.register_route_fund_closure_deposit(uuid, numeric, date, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION adquisiciones.register_route_fund_closure_deposit(uuid, numeric, date, text, uuid[], text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.register_route_fund_closure_deposit(uuid, numeric, date, text, uuid[], text, text) TO authenticated;

REVOKE ALL ON FUNCTION adquisiciones.validate_route_fund_closure_deposit_check() FROM PUBLIC, anon, authenticated;
