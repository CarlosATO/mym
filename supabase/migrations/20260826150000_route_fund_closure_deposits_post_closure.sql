-- Contrato backend para depósitos posteriores a un Cierre de Fondos finalizado.
-- Permite registrar uno o varios depósitos hasta completar el total físico realmente
-- entregado (cash_delivered + total_check_received), sin reabrir la Rendición ni
-- alterar el resultado físico del Cierre.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Lifecycle de depósitos (anulación lógica, nunca DELETE físico)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE adquisiciones.route_fund_closure_deposits
    ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE adquisiciones.route_fund_closure_deposits
    ADD COLUMN IF NOT EXISTS voided_at timestamptz,
    ADD COLUMN IF NOT EXISTS voided_by uuid REFERENCES portal.users(id),
    ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE adquisiciones.route_fund_closure_deposits
    DROP CONSTRAINT IF EXISTS chk_rfcd_status;
ALTER TABLE adquisiciones.route_fund_closure_deposits
    ADD CONSTRAINT chk_rfcd_status CHECK (status IN ('ACTIVE', 'VOIDED'));

ALTER TABLE adquisiciones.route_fund_closure_deposits
    DROP CONSTRAINT IF EXISTS chk_rfcd_amount_positive;
ALTER TABLE adquisiciones.route_fund_closure_deposits
    ADD CONSTRAINT chk_rfcd_amount_positive CHECK (amount > 0) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_route_fund_closure_deposits_closure
    ON adquisiciones.route_fund_closure_deposits (fund_closure_id);

CREATE INDEX IF NOT EXISTS idx_route_fund_closure_deposits_active
    ON adquisiciones.route_fund_closure_deposits (fund_closure_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Validación de comprobantes DEPOSIT en route_fund_closure_attachments
--    (mantiene formatos y tamaño ya validados: PDF/PNG/JPEG/WEBP <= 10 MB)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION adquisiciones.validate_route_fund_closure_attachment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_expense adquisiciones.route_fund_closure_expenses;
    v_deposit adquisiciones.route_fund_closure_deposits;
BEGIN
    IF NEW.attachment_type = 'EXPENSE' THEN
        IF NEW.expense_id IS NULL THEN
            RAISE EXCEPTION 'Un comprobante de gasto requiere expense_id';
        END IF;

        SELECT * INTO v_expense
        FROM adquisiciones.route_fund_closure_expenses
        WHERE id = NEW.expense_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'El gasto no existe';
        END IF;
        IF NEW.company_id IS DISTINCT FROM v_expense.company_id THEN
            RAISE EXCEPTION 'El comprobante y el gasto deben pertenecer a la misma empresa';
        END IF;
        IF NEW.fund_closure_id IS DISTINCT FROM v_expense.fund_closure_id THEN
            RAISE EXCEPTION 'El comprobante no es coherente con el cierre del gasto';
        END IF;
    ELSIF NEW.attachment_type = 'DEPOSIT' THEN
        IF NEW.deposit_id IS NULL THEN
            RAISE EXCEPTION 'Un comprobante de depósito requiere deposit_id';
        END IF;

        SELECT * INTO v_deposit
        FROM adquisiciones.route_fund_closure_deposits
        WHERE id = NEW.deposit_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'El depósito no existe';
        END IF;
        IF NEW.company_id IS DISTINCT FROM v_deposit.company_id THEN
            RAISE EXCEPTION 'El comprobante y el depósito deben pertenecer a la misma empresa';
        END IF;
        IF NEW.fund_closure_id IS DISTINCT FROM v_deposit.fund_closure_id THEN
            RAISE EXCEPTION 'El comprobante no es coherente con el cierre del depósito';
        END IF;
    ELSIF NEW.fund_closure_id IS NULL THEN
        RAISE EXCEPTION 'Este tipo de comprobante requiere fund_closure_id';
    END IF;

    RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RPC: registrar depósito posterior
--    total_fisico_recibido = cash_delivered + total_check_received (sin volver
--    a descontar gastos, ya considerados al determinar cash_delivered).
-- ─────────────────────────────────────────────────────────────────────────────
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
DECLARE
    v_actor uuid := auth.uid();
    v_closure adquisiciones.route_fund_closures;
    v_deposited numeric;
    v_balance numeric;
    v_deposit uuid;
    v_ref text;
    v_notes text;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'No autorizado.'; END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'El monto del depósito debe ser mayor que cero.'; END IF;
    IF p_deposit_date IS NULL THEN RAISE EXCEPTION 'Debe indicar la fecha del depósito.'; END IF;
    IF p_deposit_method IS NULL OR p_deposit_method NOT IN ('DEPOSIT', 'CASH_DELIVERY', 'TRANSFER', 'OTHER') THEN RAISE EXCEPTION 'Método de depósito inválido.'; END IF;

    SELECT * INTO v_closure
    FROM adquisiciones.route_fund_closures
    WHERE id = p_fund_closure_id
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Cierre de Fondos no encontrado.'; END IF;
    IF NOT core.has_company_access(v_actor, v_closure.company_id) THEN RAISE EXCEPTION 'Usuario o empresa inválidos.'; END IF;
    IF NOT portal.user_has_permission(v_actor, 'adquisiciones.route_fund_closures.update') THEN RAISE EXCEPTION 'No tiene permisos para registrar depósitos.'; END IF;
    IF v_closure.status = 'CANCELLED' THEN RAISE EXCEPTION 'El Cierre está anulado.'; END IF;
    IF v_closure.status NOT IN ('CLOSED', 'WITH_DIFFERENCE') OR v_closure.closed_at IS NULL THEN
        RAISE EXCEPTION 'El depósito sólo se permite sobre un Cierre finalizado.';
    END IF;

    SELECT COALESCE(sum(d.amount), 0) INTO v_deposited
    FROM adquisiciones.route_fund_closure_deposits d
    WHERE d.fund_closure_id = v_closure.id AND d.status = 'ACTIVE';

    v_balance := v_closure.cash_delivered + v_closure.total_check_received - v_deposited;
    IF p_amount > v_balance THEN RAISE EXCEPTION 'El monto supera el saldo por depositar.'; END IF;

    v_ref := NULLIF(btrim(COALESCE(p_reference_number, '')), '');
    v_notes := NULLIF(btrim(COALESCE(p_notes, '')), '');

    INSERT INTO adquisiciones.route_fund_closure_deposits(
        company_id, fund_closure_id, deposit_method, amount, deposit_date,
        reference_number, notes, created_by, status
    ) VALUES (
        v_closure.company_id, v_closure.id, p_deposit_method, p_amount, p_deposit_date,
        v_ref, v_notes, v_actor, 'ACTIVE'
    ) RETURNING id INTO v_deposit;

    UPDATE adquisiciones.route_fund_closures
    SET total_deposits = v_deposited + p_amount
    WHERE id = v_closure.id;

    INSERT INTO portal.audit_logs(schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES('adquisiciones', 'ADQUISICIONES', 'route_fund_closure_deposits', v_deposit, 'INSERT',
        jsonb_build_object('fund_closure_id', v_closure.id, 'amount', p_amount, 'deposit_date', p_deposit_date,
            'deposit_method', p_deposit_method, 'reference_number', v_ref),
        v_actor, 'ROUTE_FUND_DEPOSIT_REGISTERED', 'INFO');

    RETURN jsonb_build_object(
        'deposit_id', v_deposit,
        'fund_closure_id', v_closure.id,
        'amount', p_amount,
        'deposit_date', p_deposit_date,
        'deposit_method', p_deposit_method,
        'reference_number', v_ref,
        'status', 'ACTIVE',
        'total_fisico_recibido', v_closure.cash_delivered + v_closure.total_check_received,
        'total_depositado', v_deposited + p_amount,
        'saldo_por_depositar', v_balance - p_amount
    );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RPC: anular depósito (restaura saldo, conserva historia)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION adquisiciones.void_route_fund_closure_deposit(
    p_deposit_id uuid,
    p_void_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_deposit adquisiciones.route_fund_closure_deposits;
    v_closure adquisiciones.route_fund_closures;
    v_deposited numeric;
    v_balance numeric;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'No autorizado.'; END IF;
    IF p_void_reason IS NULL OR length(btrim(p_void_reason)) = 0 THEN RAISE EXCEPTION 'Debe indicar el motivo de anulación.'; END IF;

    SELECT * INTO v_deposit
    FROM adquisiciones.route_fund_closure_deposits
    WHERE id = p_deposit_id
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Depósito no encontrado.'; END IF;
    IF v_deposit.status <> 'ACTIVE' THEN RAISE EXCEPTION 'El depósito ya fue anulado.'; END IF;

    SELECT * INTO v_closure
    FROM adquisiciones.route_fund_closures
    WHERE id = v_deposit.fund_closure_id
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Cierre de Fondos no encontrado.'; END IF;
    IF NOT core.has_company_access(v_actor, v_closure.company_id) THEN RAISE EXCEPTION 'Usuario o empresa inválidos.'; END IF;
    IF NOT portal.user_has_permission(v_actor, 'adquisiciones.route_fund_closures.update') THEN RAISE EXCEPTION 'No tiene permisos para anular depósitos.'; END IF;
    IF v_closure.status NOT IN ('CLOSED', 'WITH_DIFFERENCE') OR v_closure.closed_at IS NULL THEN
        RAISE EXCEPTION 'El depósito sólo se anula sobre un Cierre finalizado.';
    END IF;

    UPDATE adquisiciones.route_fund_closure_deposits
    SET status = 'VOIDED', voided_at = now(), voided_by = v_actor, void_reason = btrim(p_void_reason)
    WHERE id = v_deposit.id;

    SELECT COALESCE(sum(d.amount), 0) INTO v_deposited
    FROM adquisiciones.route_fund_closure_deposits d
    WHERE d.fund_closure_id = v_closure.id AND d.status = 'ACTIVE';

    UPDATE adquisiciones.route_fund_closures
    SET total_deposits = v_deposited
    WHERE id = v_closure.id;

    v_balance := v_closure.cash_delivered + v_closure.total_check_received - v_deposited;

    INSERT INTO portal.audit_logs(schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES('adquisiciones', 'ADQUISICIONES', 'route_fund_closure_deposits', v_deposit.id, 'VOID',
        jsonb_build_object('void_reason', btrim(p_void_reason)),
        v_actor, 'ROUTE_FUND_DEPOSIT_VOIDED', 'INFO');

    RETURN jsonb_build_object(
        'deposit_id', v_deposit.id,
        'status', 'VOIDED',
        'total_fisico_recibido', v_closure.cash_delivered + v_closure.total_check_received,
        'total_depositado', v_deposited,
        'saldo_por_depositar', v_balance
    );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RPC: lectura del detalle de depósitos de un Cierre
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION adquisiciones.get_route_fund_closure_deposit_summary(p_fund_closure_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_closure adquisiciones.route_fund_closures;
    v_deposited numeric;
    v_balance numeric;
    v_deposits jsonb;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'No autorizado.'; END IF;

    SELECT * INTO v_closure
    FROM adquisiciones.route_fund_closures
    WHERE id = p_fund_closure_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'Cierre de Fondos no encontrado.'; END IF;
    IF NOT core.has_company_access(v_actor, v_closure.company_id) THEN RAISE EXCEPTION 'Usuario o empresa inválidos.'; END IF;
    IF NOT portal.user_has_permission(v_actor, 'adquisiciones.route_fund_closures.view') THEN RAISE EXCEPTION 'No tiene permisos para consultar el Cierre.'; END IF;

    SELECT COALESCE(sum(d.amount), 0) INTO v_deposited
    FROM adquisiciones.route_fund_closure_deposits d
    WHERE d.fund_closure_id = v_closure.id AND d.status = 'ACTIVE';

    v_balance := v_closure.cash_delivered + v_closure.total_check_received - v_deposited;

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', d.id, 'deposit_method', d.deposit_method, 'amount', d.amount,
            'deposit_date', d.deposit_date, 'reference_number', d.reference_number,
            'notes', d.notes, 'status', d.status, 'created_by', d.created_by,
            'created_at', d.created_at, 'voided_at', d.voided_at,
            'voided_by', d.voided_by, 'void_reason', d.void_reason,
            'attachments', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', a.id, 'attachment_type', a.attachment_type,
                    'file_name', a.file_name, 'storage_path', a.storage_path,
                    'file_mime_type', a.file_mime_type, 'file_size', a.file_size,
                    'uploaded_by', a.uploaded_by, 'uploaded_at', a.uploaded_at
                ) ORDER BY a.uploaded_at, a.id)
                FROM adquisiciones.route_fund_closure_attachments a
                WHERE a.deposit_id = d.id AND a.company_id = v_closure.company_id
            ), '[]'::jsonb)
        ) ORDER BY d.deposit_date, d.created_at, d.id
    ), '[]'::jsonb)
    INTO v_deposits
    FROM adquisiciones.route_fund_closure_deposits d
    WHERE d.fund_closure_id = v_closure.id;

    RETURN jsonb_build_object(
        'fund_closure_id', v_closure.id,
        'closure_number', v_closure.closure_number,
        'status', v_closure.status,
        'cash_delivered', v_closure.cash_delivered,
        'total_check_received', v_closure.total_check_received,
        'total_fisico_recibido', v_closure.cash_delivered + v_closure.total_check_received,
        'total_depositado', v_deposited,
        'saldo_por_depositar', v_balance,
        'deposits', v_deposits
    );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Grants (patrón del resto del módulo)
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION adquisiciones.register_route_fund_closure_deposit(uuid, numeric, date, text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.register_route_fund_closure_deposit(uuid, numeric, date, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION adquisiciones.void_route_fund_closure_deposit(uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.void_route_fund_closure_deposit(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION adquisiciones.get_route_fund_closure_deposit_summary(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_route_fund_closure_deposit_summary(uuid) TO authenticated;
