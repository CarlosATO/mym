-- Route expenses can be recorded from a settlement before a fund closure exists.
-- Historical closure expenses remain valid without an artificial backfill.

ALTER TABLE adquisiciones.route_fund_closure_expenses
    ALTER COLUMN fund_closure_id DROP NOT NULL;

ALTER TABLE adquisiciones.route_fund_closure_expenses
    ADD COLUMN IF NOT EXISTS route_settlement_id uuid
        REFERENCES adquisiciones.route_settlements(id),
    ADD COLUMN IF NOT EXISTS custody_user_id uuid
        REFERENCES portal.users(id),
    ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN IF NOT EXISTS voided_at timestamptz,
    ADD COLUMN IF NOT EXISTS voided_by uuid REFERENCES portal.users(id),
    ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE adquisiciones.route_fund_closure_expenses
    ADD CONSTRAINT route_fund_closure_expenses_status_check
    CHECK (status IN ('ACTIVE', 'VOIDED')) NOT VALID;

ALTER TABLE adquisiciones.route_fund_closure_expenses
    ADD CONSTRAINT route_fund_closure_expenses_new_settlement_required
    CHECK (route_settlement_id IS NOT NULL) NOT VALID;

ALTER TABLE adquisiciones.route_fund_closure_expenses
    ADD CONSTRAINT route_fund_closure_expenses_new_custody_required
    CHECK (custody_user_id IS NOT NULL) NOT VALID;

ALTER TABLE adquisiciones.route_fund_closure_expenses
    ADD CONSTRAINT route_fund_closure_expenses_type_check
    CHECK (expense_type IN ('PEAJES', 'COMBUSTIBLE', 'VIATICOS', 'MANTENIMIENTO', 'OTROS')) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_route_fund_closure_expenses_settlement
    ON adquisiciones.route_fund_closure_expenses (company_id, route_settlement_id, status);

CREATE OR REPLACE FUNCTION adquisiciones.validate_route_fund_expense_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica
AS $$
DECLARE
    v_settlement_company uuid;
    v_settlement_guide uuid;
    v_closure_company uuid;
BEGIN
    IF NEW.route_settlement_id IS NULL THEN
        IF TG_OP = 'INSERT' THEN
            RAISE EXCEPTION 'El gasto nuevo debe pertenecer a una rendición.';
        END IF;
    ELSE
        SELECT company_id, route_guide_id
        INTO v_settlement_company, v_settlement_guide
        FROM adquisiciones.route_settlements
        WHERE id = NEW.route_settlement_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'La rendición del gasto no existe.';
        END IF;
        IF v_settlement_company <> NEW.company_id
           OR v_settlement_guide <> NEW.route_guide_id THEN
            RAISE EXCEPTION 'La rendición, guía y empresa del gasto no coinciden.';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' AND NEW.custody_user_id IS NULL THEN
        RAISE EXCEPTION 'El gasto nuevo debe tener un custodio responsable.';
    END IF;

    IF NEW.fund_closure_id IS NOT NULL THEN
        SELECT company_id
        INTO v_closure_company
        FROM adquisiciones.route_fund_closures
        WHERE id = NEW.fund_closure_id;

        IF NOT FOUND OR v_closure_company <> NEW.company_id THEN
            RAISE EXCEPTION 'El cierre del gasto no pertenece a la empresa.';
        END IF;
        IF NEW.route_settlement_id IS NOT NULL AND NOT EXISTS (
            SELECT 1
            FROM adquisiciones.route_fund_closure_items i
            WHERE i.fund_closure_id = NEW.fund_closure_id
              AND i.route_settlement_id = NEW.route_settlement_id
              AND i.route_guide_id = NEW.route_guide_id
              AND i.company_id = NEW.company_id
        ) THEN
            RAISE EXCEPTION 'El cierre no contiene la rendición y guía del gasto.';
        END IF;
    END IF;

    IF NEW.status = 'VOIDED' AND NEW.voided_at IS NULL THEN
        NEW.voided_at := now();
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_route_fund_expense_context
    ON adquisiciones.route_fund_closure_expenses;
CREATE TRIGGER trg_validate_route_fund_expense_context
    BEFORE INSERT OR UPDATE ON adquisiciones.route_fund_closure_expenses
    FOR EACH ROW
    EXECUTE FUNCTION adquisiciones.validate_route_fund_expense_context();

REVOKE ALL ON FUNCTION adquisiciones.validate_route_fund_expense_context()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION adquisiciones.upsert_route_settlement_expense(
    p_settlement_id uuid,
    p_expense_id uuid,
    p_expense_type text,
    p_amount numeric,
    p_expense_date date,
    p_notes text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_company_id uuid;
    v_guide_id uuid;
    v_workflow_status text;
    v_legacy_status text;
    v_expense adquisiciones.route_fund_closure_expenses;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE = '28000';
    END IF;
    IF p_settlement_id IS NULL OR p_expense_type IS NULL OR p_amount IS NULL
       OR p_expense_date IS NULL THEN
        RAISE EXCEPTION 'Rendición, tipo, monto y fecha son obligatorios.';
    END IF;
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'El monto del gasto debe ser mayor que cero.';
    END IF;
    IF p_expense_type NOT IN ('PEAJES', 'COMBUSTIBLE', 'VIATICOS', 'MANTENIMIENTO', 'OTROS') THEN
        RAISE EXCEPTION 'Tipo de gasto no válido.';
    END IF;
    IF NOT portal.user_has_permission(v_actor, 'adquisiciones.route_settlements.update') THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para modificar la rendición.';
    END IF;

    SELECT company_id, route_guide_id, workflow_status, status
    INTO v_company_id, v_guide_id, v_workflow_status, v_legacy_status
    FROM adquisiciones.route_settlements
    WHERE id = p_settlement_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rendición no encontrada.';
    END IF;
    IF NOT core.has_company_access(v_actor, v_company_id) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa de la rendición.';
    END IF;
    IF v_workflow_status IN ('CLOSED', 'CANCELLED')
       OR v_legacy_status IN ('CLOSED', 'CANCELLED') THEN
        RAISE EXCEPTION 'La rendición está cerrada o cancelada.';
    END IF;

    IF p_expense_id IS NULL THEN
        INSERT INTO adquisiciones.route_fund_closure_expenses (
            company_id, fund_closure_id, route_settlement_id, route_guide_id,
            custody_user_id, expense_scope, expense_type, amount, expense_date,
            notes, created_by
        ) VALUES (
            v_company_id, NULL, p_settlement_id, v_guide_id, v_actor, 'GUIDE',
            p_expense_type, p_amount, p_expense_date, NULLIF(trim(p_notes), ''), v_actor
        )
        RETURNING * INTO v_expense;
    ELSE
        SELECT * INTO v_expense
        FROM adquisiciones.route_fund_closure_expenses
        WHERE id = p_expense_id
          AND company_id = v_company_id
          AND route_settlement_id = p_settlement_id
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Gasto no encontrado en la rendición.';
        END IF;
        IF v_expense.status = 'VOIDED' THEN
            RAISE EXCEPTION 'No se puede editar un gasto anulado.';
        END IF;
        IF v_expense.fund_closure_id IS NOT NULL AND EXISTS (
            SELECT 1
            FROM adquisiciones.route_fund_closures fc
            WHERE fc.id = v_expense.fund_closure_id
              AND fc.status IN ('CLOSED', 'CANCELLED')
        ) THEN
            RAISE EXCEPTION 'No se puede editar un gasto de un cierre finalizado.';
        END IF;

        UPDATE adquisiciones.route_fund_closure_expenses
        SET expense_type = p_expense_type,
            amount = p_amount,
            expense_date = p_expense_date,
            notes = NULLIF(trim(p_notes), ''),
            updated_at = now()
        WHERE id = p_expense_id
        RETURNING * INTO v_expense;
    END IF;

    RETURN to_jsonb(v_expense);
END;
$$;

CREATE OR REPLACE FUNCTION adquisiciones.void_route_settlement_expense(
    p_expense_id uuid,
    p_void_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_company_id uuid;
    v_expense adquisiciones.route_fund_closure_expenses;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE = '28000';
    END IF;
    IF p_expense_id IS NULL OR p_void_reason IS NULL OR length(trim(p_void_reason)) < 5 THEN
        RAISE EXCEPTION 'El gasto y un motivo de anulación válido son obligatorios.';
    END IF;
    IF NOT portal.user_has_permission(v_actor, 'adquisiciones.route_settlements.update') THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para modificar la rendición.';
    END IF;

    SELECT e.* INTO v_expense
    FROM adquisiciones.route_fund_closure_expenses e
    WHERE e.id = p_expense_id
      AND e.route_settlement_id IS NOT NULL
      AND e.status = 'ACTIVE'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Gasto activo no encontrado.';
    END IF;

    IF v_expense.fund_closure_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM adquisiciones.route_fund_closures fc
        WHERE fc.id = v_expense.fund_closure_id
          AND fc.status IN ('CLOSED', 'CANCELLED')
    ) THEN
        RAISE EXCEPTION 'No se puede anular un gasto de un cierre finalizado.';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM adquisiciones.route_settlements s
        WHERE s.id = v_expense.route_settlement_id
          AND (s.workflow_status IN ('CLOSED', 'CANCELLED') OR s.status IN ('CLOSED', 'CANCELLED'))
    ) THEN
        RAISE EXCEPTION 'No se puede anular un gasto de una rendición finalizada.';
    END IF;

    v_company_id := v_expense.company_id;
    IF NOT core.has_company_access(v_actor, v_company_id) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa del gasto.';
    END IF;

    UPDATE adquisiciones.route_fund_closure_expenses
    SET status = 'VOIDED',
        voided_at = now(),
        voided_by = v_actor,
        void_reason = trim(p_void_reason),
        updated_at = now()
    WHERE id = p_expense_id
    RETURNING * INTO v_expense;

    RETURN to_jsonb(v_expense);
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.upsert_route_settlement_expense(uuid, uuid, text, numeric, date, text)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.upsert_route_settlement_expense(uuid, uuid, text, numeric, date, text)
    TO authenticated;

REVOKE ALL ON FUNCTION adquisiciones.void_route_settlement_expense(uuid, text)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.void_route_settlement_expense(uuid, text)
    TO authenticated;

COMMENT ON FUNCTION adquisiciones.upsert_route_settlement_expense(uuid, uuid, text, numeric, date, text) IS
    'Creates or edits a route expense before or after fund closure without changing settlement payments or allocations.';

COMMENT ON FUNCTION adquisiciones.void_route_settlement_expense(uuid, text) IS
    'Voids a route expense logically with a mandatory reason.';
