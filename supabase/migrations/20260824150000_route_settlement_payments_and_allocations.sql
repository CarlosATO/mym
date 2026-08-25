-- Route settlement payment facts and invoice allocations.
-- Additive only: legacy settlement rows and statuses are preserved.

ALTER TABLE logistica.route_guide_items
    ADD COLUMN IF NOT EXISTS customer_bsale_id bigint;

ALTER TABLE adquisiciones.route_settlement_items
    ADD COLUMN IF NOT EXISTS customer_bsale_id bigint;

ALTER TABLE adquisiciones.route_settlements
    ADD COLUMN IF NOT EXISTS workflow_status varchar(30),
    ADD COLUMN IF NOT EXISTS financial_result varchar(30);

ALTER TABLE adquisiciones.route_settlements
    DROP CONSTRAINT IF EXISTS chk_route_settlements_workflow_status;

ALTER TABLE adquisiciones.route_settlements
    ADD CONSTRAINT chk_route_settlements_workflow_status
    CHECK (workflow_status IS NULL OR workflow_status IN (
        'IN_PROGRESS', 'READY_TO_CLOSE', 'CLOSED', 'CANCELLED'
    ));

ALTER TABLE adquisiciones.route_settlements
    DROP CONSTRAINT IF EXISTS chk_route_settlements_financial_result;

ALTER TABLE adquisiciones.route_settlements
    ADD CONSTRAINT chk_route_settlements_financial_result
    CHECK (financial_result IS NULL OR financial_result IN (
        'BALANCED', 'WITH_PENDING', 'WITH_DIFFERENCE'
    ));

ALTER TABLE logistica.route_guide_items
    DROP CONSTRAINT IF EXISTS fk_route_guide_items_customer_bsale;

ALTER TABLE logistica.route_guide_items
    ADD CONSTRAINT fk_route_guide_items_customer_bsale
    FOREIGN KEY (company_id, customer_bsale_id)
    REFERENCES integraciones.bsale_clients (company_id, bsale_client_id);

ALTER TABLE adquisiciones.route_settlement_items
    DROP CONSTRAINT IF EXISTS fk_route_settlement_items_customer_bsale;

ALTER TABLE adquisiciones.route_settlement_items
    ADD CONSTRAINT fk_route_settlement_items_customer_bsale
    FOREIGN KEY (company_id, customer_bsale_id)
    REFERENCES integraciones.bsale_clients (company_id, bsale_client_id);

CREATE INDEX IF NOT EXISTS idx_route_guide_items_customer_bsale
    ON logistica.route_guide_items (company_id, customer_bsale_id)
    WHERE customer_bsale_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_route_settlement_items_customer_bsale
    ON adquisiciones.route_settlement_items (company_id, customer_bsale_id)
    WHERE customer_bsale_id IS NOT NULL;

-- Composite keys used by allocations to prove tenant and settlement ownership.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_route_settlements_company_id_id'
          AND conrelid = 'adquisiciones.route_settlements'::regclass
    ) THEN
        ALTER TABLE adquisiciones.route_settlements
            ADD CONSTRAINT uq_route_settlements_company_id_id
            UNIQUE (company_id, id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_route_settlement_items_scope'
          AND conrelid = 'adquisiciones.route_settlement_items'::regclass
    ) THEN
        ALTER TABLE adquisiciones.route_settlement_items
            ADD CONSTRAINT uq_route_settlement_items_scope
            UNIQUE (company_id, settlement_id, id, customer_bsale_id);
    END IF;
END;
$$;

CREATE TABLE adquisiciones.route_settlement_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    settlement_id uuid NOT NULL,
    customer_bsale_id bigint NOT NULL,

    payment_method_received varchar(30) NOT NULL
        CHECK (payment_method_received IN ('CASH', 'TRANSFER', 'CHECK')),
    amount_received numeric(14,2) NOT NULL CHECK (amount_received > 0),
    received_at timestamptz NOT NULL,
    verification_status varchar(20) NOT NULL DEFAULT 'PENDING'
        CHECK (verification_status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'VOIDED')),

    reference_number text,
    bank_name text,
    check_number text,
    check_date date,
    notes text,

    custody_user_id uuid REFERENCES portal.users(id),
    custody_received_at timestamptz,

    created_by uuid NOT NULL REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    voided_by uuid REFERENCES portal.users(id),
    voided_at timestamptz,
    void_reason text,

    CONSTRAINT fk_route_settlement_payments_settlement
        FOREIGN KEY (company_id, settlement_id)
        REFERENCES adquisiciones.route_settlements (company_id, id),
    CONSTRAINT fk_route_settlement_payments_customer_bsale
        FOREIGN KEY (company_id, customer_bsale_id)
        REFERENCES integraciones.bsale_clients (company_id, bsale_client_id),
    CONSTRAINT uq_route_settlement_payments_scope
        UNIQUE (company_id, settlement_id, id, customer_bsale_id),
    CONSTRAINT chk_route_settlement_payments_void_state
        CHECK (
            (verification_status = 'VOIDED' AND voided_at IS NOT NULL)
            OR (verification_status <> 'VOIDED' AND voided_at IS NULL)
        )
);

CREATE INDEX idx_route_settlement_payments_settlement
    ON adquisiciones.route_settlement_payments (company_id, settlement_id);

CREATE INDEX idx_route_settlement_payments_customer
    ON adquisiciones.route_settlement_payments (company_id, settlement_id, customer_bsale_id);

CREATE INDEX idx_route_settlement_payments_method_status
    ON adquisiciones.route_settlement_payments
       (company_id, payment_method_received, verification_status);

CREATE TABLE adquisiciones.route_settlement_payment_allocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    settlement_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    settlement_item_id uuid NOT NULL,
    customer_bsale_id bigint NOT NULL,
    amount_applied numeric(14,2) NOT NULL CHECK (amount_applied > 0),

    created_by uuid NOT NULL REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    voided_by uuid REFERENCES portal.users(id),
    voided_at timestamptz,
    void_reason text,

    CONSTRAINT fk_route_settlement_payment_allocations_payment
        FOREIGN KEY (company_id, settlement_id, payment_id, customer_bsale_id)
        REFERENCES adquisiciones.route_settlement_payments
            (company_id, settlement_id, id, customer_bsale_id),
    CONSTRAINT fk_route_settlement_payment_allocations_item
        FOREIGN KEY (company_id, settlement_id, settlement_item_id, customer_bsale_id)
        REFERENCES adquisiciones.route_settlement_items
            (company_id, settlement_id, id, customer_bsale_id),
    CONSTRAINT chk_route_settlement_payment_allocations_void_state
        CHECK (voided_at IS NULL OR voided_by IS NOT NULL)
);

CREATE INDEX idx_route_settlement_payment_allocations_payment
    ON adquisiciones.route_settlement_payment_allocations
       (company_id, settlement_id, payment_id);

CREATE INDEX idx_route_settlement_payment_allocations_item
    ON adquisiciones.route_settlement_payment_allocations
       (company_id, settlement_id, settlement_item_id);

CREATE INDEX idx_route_settlement_payment_allocations_active_payment
    ON adquisiciones.route_settlement_payment_allocations (payment_id)
    WHERE voided_at IS NULL;

CREATE INDEX idx_route_settlement_payment_allocations_active_item
    ON adquisiciones.route_settlement_payment_allocations (settlement_item_id)
    WHERE voided_at IS NULL;

CREATE TRIGGER update_route_settlement_payments_updated_at
    BEFORE UPDATE ON adquisiciones.route_settlement_payments
    FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();

CREATE TRIGGER update_route_settlement_payment_allocations_updated_at
    BEFORE UPDATE ON adquisiciones.route_settlement_payment_allocations
    FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();

ALTER TABLE adquisiciones.route_settlement_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE adquisiciones.route_settlement_payment_allocations ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON adquisiciones.route_settlement_payments TO authenticated;
GRANT SELECT ON adquisiciones.route_settlement_payment_allocations TO authenticated;
GRANT ALL ON adquisiciones.route_settlement_payments TO service_role;
GRANT ALL ON adquisiciones.route_settlement_payment_allocations TO service_role;

CREATE POLICY route_settlement_payments_select
    ON adquisiciones.route_settlement_payments
    FOR SELECT
    USING (core.has_company_access(auth.uid(), company_id));

CREATE POLICY route_settlement_payment_allocations_select
    ON adquisiciones.route_settlement_payment_allocations
    FOR SELECT
    USING (core.has_company_access(auth.uid(), company_id));

CREATE OR REPLACE FUNCTION adquisiciones.prevent_route_settlement_payment_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones
AS $$
BEGIN
    RAISE EXCEPTION 'Los pagos y sus aplicaciones deben anularse lógicamente; no se permite DELETE.';
END;
$$;

CREATE TRIGGER prevent_route_settlement_payment_delete
    BEFORE DELETE ON adquisiciones.route_settlement_payments
    FOR EACH ROW EXECUTE FUNCTION adquisiciones.prevent_route_settlement_payment_delete();

CREATE TRIGGER prevent_route_settlement_payment_allocation_delete
    BEFORE DELETE ON adquisiciones.route_settlement_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION adquisiciones.prevent_route_settlement_payment_delete();

CREATE OR REPLACE FUNCTION adquisiciones.validate_route_settlement_payment_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones
AS $$
DECLARE
    v_payment_amount numeric(14,2);
    v_payment_status varchar(20);
    v_payment_voided_at timestamptz;
    v_item_expected numeric(14,2);
    v_payment_allocated numeric(14,2);
    v_item_allocated numeric(14,2);
BEGIN
    PERFORM pg_advisory_xact_lock(
        pg_catalog.hashtextextended('route-settlement-payment:' || NEW.payment_id::text, 0)
    );
    PERFORM pg_advisory_xact_lock(
        pg_catalog.hashtextextended('route-settlement-item:' || NEW.settlement_item_id::text, 0)
    );

    SELECT amount_received, verification_status, voided_at
    INTO v_payment_amount, v_payment_status, v_payment_voided_at
    FROM adquisiciones.route_settlement_payments
    WHERE id = NEW.payment_id;

    IF v_payment_status IN ('REJECTED', 'VOIDED') OR v_payment_voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'No se puede mantener una aplicación activa para un pago rechazado o anulado.';
    END IF;

    SELECT expected_amount
    INTO v_item_expected
    FROM adquisiciones.route_settlement_items
    WHERE id = NEW.settlement_item_id;

    SELECT COALESCE(sum(amount_applied), 0)
    INTO v_payment_allocated
    FROM adquisiciones.route_settlement_payment_allocations
    WHERE payment_id = NEW.payment_id
      AND voided_at IS NULL;

    IF v_payment_allocated > v_payment_amount THEN
        RAISE EXCEPTION 'Las aplicaciones (%) superan el monto recibido del pago (%).',
            v_payment_allocated, v_payment_amount;
    END IF;

    SELECT COALESCE(sum(amount_applied), 0)
    INTO v_item_allocated
    FROM adquisiciones.route_settlement_payment_allocations
    WHERE settlement_item_id = NEW.settlement_item_id
      AND voided_at IS NULL;

    IF v_item_allocated > v_item_expected THEN
        RAISE EXCEPTION 'Las aplicaciones (%) superan el monto esperado de la factura (%).',
            v_item_allocated, v_item_expected;
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER validate_route_settlement_payment_allocation_totals
    AFTER INSERT OR UPDATE ON adquisiciones.route_settlement_payment_allocations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION adquisiciones.validate_route_settlement_payment_totals();

CREATE OR REPLACE FUNCTION adquisiciones.validate_route_settlement_payment_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones
AS $$
DECLARE
    v_allocated numeric(14,2);
BEGIN
    PERFORM pg_advisory_xact_lock(
        pg_catalog.hashtextextended('route-settlement-payment:' || NEW.id::text, 0)
    );

    IF NEW.verification_status IN ('REJECTED', 'VOIDED') OR NEW.voided_at IS NOT NULL THEN
        SELECT COALESCE(sum(amount_applied), 0)
        INTO v_allocated
        FROM adquisiciones.route_settlement_payment_allocations
        WHERE payment_id = NEW.id
          AND voided_at IS NULL;

        IF v_allocated > 0 THEN
            RAISE EXCEPTION 'No se puede rechazar o anular un pago con aplicaciones activas.';
        END IF;
    END IF;

    SELECT COALESCE(sum(amount_applied), 0)
    INTO v_allocated
    FROM adquisiciones.route_settlement_payment_allocations
    WHERE payment_id = NEW.id
      AND voided_at IS NULL;

    IF v_allocated > NEW.amount_received THEN
        RAISE EXCEPTION 'Las aplicaciones (%) superan el monto recibido del pago (%).',
            v_allocated, NEW.amount_received;
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER validate_route_settlement_payment_update
    AFTER UPDATE ON adquisiciones.route_settlement_payments
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION adquisiciones.validate_route_settlement_payment_update();

-- Keep settlement creation compatible with the new nullable guide identity.
CREATE OR REPLACE FUNCTION adquisiciones.create_route_settlement_from_guide(
    p_route_guide_id uuid,
    p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_company_id uuid;
    v_status varchar;
    v_year integer;
    v_seq integer;
    v_number text;
    v_settlement_id uuid;
    v_existing_id uuid;
    v_existing_number text;
    v_existing_status varchar;
    v_constraint_name text;
BEGIN
    SELECT company_id, status INTO v_company_id, v_status
    FROM logistica.route_guides
    WHERE id = p_route_guide_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'Guía de ruta no encontrada'; END IF;
    IF auth.uid() != p_user_id THEN RAISE EXCEPTION 'Usuario no coincide con la sesión'; END IF;
    IF NOT core.has_company_access(p_user_id, v_company_id) THEN RAISE EXCEPTION 'No tiene acceso a la empresa de esta guía'; END IF;
    IF NOT portal.user_has_permission(p_user_id, 'adquisiciones.route_settlements.create') THEN RAISE EXCEPTION 'No tiene permiso para crear rendiciones'; END IF;

    SELECT id, settlement_number, status
    INTO v_existing_id, v_existing_number, v_existing_status
    FROM adquisiciones.route_settlements
    WHERE route_guide_id = p_route_guide_id;

    IF FOUND THEN
        IF v_existing_status = 'CANCELLED' THEN RAISE EXCEPTION 'La guía ya tiene una rendición anulada y no puede reutilizarse.'; END IF;
        RETURN jsonb_build_object('success', true, 'created', false, 'replayed', true,
            'id', v_existing_id, 'settlement_id', v_existing_id, 'route_guide_id', p_route_guide_id,
            'settlement_number', v_existing_number, 'status', v_existing_status);
    END IF;

    IF v_status != 'DISPATCHED' THEN RAISE EXCEPTION 'Solo se pueden rendir guías despachadas'; END IF;

    v_year := extract(year from current_date);
    INSERT INTO adquisiciones.route_settlement_counters (company_id, settlement_year, last_sequence)
    VALUES (v_company_id, v_year, 1)
    ON CONFLICT (company_id, settlement_year)
    DO UPDATE SET last_sequence = adquisiciones.route_settlement_counters.last_sequence + 1
    RETURNING last_sequence INTO v_seq;

    v_number := 'RR-' || v_year::text || '-' || lpad(v_seq::text, 6, '0');

    BEGIN
        INSERT INTO adquisiciones.route_settlements (
            company_id, route_guide_id, settlement_number, settlement_year, settlement_sequence,
            settlement_date, status, received_by, created_by
        ) VALUES (
            v_company_id, p_route_guide_id, v_number, v_year, v_seq,
            current_date, 'IN_REVIEW', p_user_id, p_user_id
        ) RETURNING id INTO v_settlement_id;
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
        IF v_constraint_name <> 'route_settlements_route_guide_id_key' THEN RAISE; END IF;
        SELECT id, settlement_number, status INTO v_existing_id, v_existing_number, v_existing_status
        FROM adquisiciones.route_settlements WHERE route_guide_id = p_route_guide_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'No se pudo iniciar la rendición porque la guía fue procesada simultáneamente.'; END IF;
        IF v_existing_status = 'CANCELLED' THEN RAISE EXCEPTION 'La guía ya tiene una rendición anulada y no puede reutilizarse.'; END IF;
        RETURN jsonb_build_object('success', true, 'created', false, 'replayed', true,
            'id', v_existing_id, 'settlement_id', v_existing_id, 'route_guide_id', p_route_guide_id,
            'settlement_number', v_existing_number, 'status', v_existing_status);
    END;

    INSERT INTO adquisiciones.route_settlement_items (
        company_id, settlement_id, route_guide_item_id, customer_bsale_id,
        invoice_number, customer_name, expected_payment_method, expected_amount,
        status, received_amount, difference_amount, is_pending
    )
    SELECT
        v_company_id, v_settlement_id, i.id, i.customer_bsale_id,
        i.invoice_number, i.customer_name, i.payment_method_normalized, i.amount,
        CASE
            WHEN i.payment_method_normalized IN ('CASH', 'CHECK') THEN 'PENDING_PAYMENT'
            WHEN i.payment_method_normalized = 'TRANSFER' THEN 'TRANSFER_PENDING'
            WHEN i.payment_method_normalized = 'CREDIT' THEN 'CREDIT_REGISTERED'
            ELSE 'REVIEW_REQUIRED'
        END,
        0,
        CASE WHEN i.payment_method_normalized IN ('CASH', 'CHECK') THEN i.amount ELSE 0 END,
        CASE WHEN i.payment_method_normalized IN ('CASH', 'CHECK') THEN true ELSE false END
    FROM logistica.route_guide_items i
    WHERE i.route_guide_id = p_route_guide_id
      AND i.invoice_number != '';

    UPDATE adquisiciones.route_settlements s
    SET
        total_invoices = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id),
        total_route_amount = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id),
        total_cash_expected = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CASH'),
        total_check_expected = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_expected = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'TRANSFER'),
        total_credit_amount = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CREDIT'),
        total_cash_difference = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CASH'),
        total_check_difference = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_pending = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'TRANSFER'),
        pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method IN ('CASH', 'CHECK')),
        transfer_pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'TRANSFER'),
        total_difference = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method IN ('CASH', 'CHECK'))
    WHERE s.id = v_settlement_id;

    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, new_data, performed_by, event_type, severity)
    VALUES ('adquisiciones', 'ADQUISICIONES', 'route_settlements', v_settlement_id, 'INSERT',
        jsonb_build_object('settlement_number', v_number, 'route_guide_id', p_route_guide_id),
        p_user_id, 'ROUTE_SETTLEMENT_CREATED', 'INFO');

    RETURN jsonb_build_object('success', true, 'created', true, 'replayed', false,
        'id', v_settlement_id, 'settlement_id', v_settlement_id, 'route_guide_id', p_route_guide_id,
        'settlement_number', v_number, 'status', 'IN_REVIEW');
END;
$$;
