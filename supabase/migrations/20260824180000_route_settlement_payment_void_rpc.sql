-- Atomic logical voiding of a route settlement payment and its active allocations.
-- Custody fields remain untouched as historical custody facts; VOIDED plus the
-- void audit fields represent that the payment is no longer an active fund.

-- An allocation may be updated to its voided state in the same transaction as
-- the payment. The deferred validator must not treat that historical row as an
-- active allocation when the payment is already VOIDED.
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

    IF NEW.voided_at IS NULL
       AND (v_payment_status IN ('REJECTED', 'VOIDED') OR v_payment_voided_at IS NOT NULL) THEN
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

CREATE OR REPLACE FUNCTION adquisiciones.void_route_settlement_payment(
    p_payment_id uuid,
    p_void_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_actor_user_id uuid := auth.uid();
    v_reason text := NULLIF(btrim(p_void_reason), '');
    v_company_id uuid;
    v_settlement_id uuid;
    v_settlement_number text;
    v_settlement_status varchar(30);
    v_workflow_status varchar(30);
    v_customer_bsale_id bigint;
    v_payment_status varchar(20);
    v_amount_received numeric(14,2);
    v_payment_method text;
    v_received_at timestamptz;
    v_custody_user_id uuid;
    v_custody_received_at timestamptz;
    v_active_allocations jsonb := '[]'::jsonb;
    v_old_payment jsonb;
    v_voided_allocations integer := 0;
BEGIN
    IF v_actor_user_id IS NULL THEN
        RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE = '28000';
    END IF;

    IF p_payment_id IS NULL THEN
        RAISE EXCEPTION 'payment_id es obligatorio.';
    END IF;

    IF v_reason IS NULL THEN
        RAISE EXCEPTION 'void_reason es obligatorio y no puede estar vacío.';
    END IF;

    -- Lock the settlement and payment together so edit/void operations cannot race.
    SELECT
        p.company_id,
        p.settlement_id,
        s.settlement_number,
        s.status,
        s.workflow_status,
        p.customer_bsale_id,
        p.verification_status,
        p.amount_received,
        p.payment_method_received,
        p.received_at,
        p.custody_user_id,
        p.custody_received_at,
        jsonb_build_object(
            'id', p.id,
            'company_id', p.company_id,
            'settlement_id', p.settlement_id,
            'customer_bsale_id', p.customer_bsale_id,
            'payment_method_received', p.payment_method_received,
            'amount_received', p.amount_received,
            'received_at', p.received_at,
            'verification_status', p.verification_status,
            'reference_number', p.reference_number,
            'bank_name', p.bank_name,
            'check_number', p.check_number,
            'check_date', p.check_date,
            'notes', p.notes,
            'custody_user_id', p.custody_user_id,
            'custody_received_at', p.custody_received_at,
            'created_by', p.created_by,
            'created_at', p.created_at,
            'updated_by', p.updated_by,
            'updated_at', p.updated_at,
            'voided_by', p.voided_by,
            'voided_at', p.voided_at,
            'void_reason', p.void_reason
        )
    INTO
        v_company_id,
        v_settlement_id,
        v_settlement_number,
        v_settlement_status,
        v_workflow_status,
        v_customer_bsale_id,
        v_payment_status,
        v_amount_received,
        v_payment_method,
        v_received_at,
        v_custody_user_id,
        v_custody_received_at,
        v_old_payment
    FROM adquisiciones.route_settlement_payments p
    JOIN adquisiciones.route_settlements s
      ON s.company_id = p.company_id
     AND s.id = p.settlement_id
    WHERE p.id = p_payment_id
    FOR UPDATE OF p, s;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment no encontrado.';
    END IF;

    IF NOT core.has_company_access(v_actor_user_id, v_company_id) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa del payment.';
    END IF;

    IF NOT portal.user_has_permission(v_actor_user_id, 'adquisiciones.route_settlements.update') THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para actualizar rendiciones.';
    END IF;

    IF v_settlement_status IN ('CLOSED', 'CANCELLED')
       OR v_workflow_status IN ('CLOSED', 'CANCELLED') THEN
        RAISE EXCEPTION 'La rendición está cerrada o cancelada y no permite anular pagos.';
    END IF;

    IF v_payment_status = 'VOIDED' THEN
        RAISE EXCEPTION 'El payment ya está anulado.';
    END IF;

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', a.id,
            'settlement_item_id', a.settlement_item_id,
            'customer_bsale_id', a.customer_bsale_id,
            'amount_applied', a.amount_applied,
            'created_by', a.created_by,
            'created_at', a.created_at
        ) ORDER BY a.created_at, a.id
    ), '[]'::jsonb)
    INTO v_active_allocations
    FROM adquisiciones.route_settlement_payment_allocations a
    WHERE a.company_id = v_company_id
      AND a.settlement_id = v_settlement_id
      AND a.payment_id = p_payment_id
      AND a.voided_at IS NULL;

    -- Void allocations first: the allocation validation trigger rejects active
    -- allocations once the payment status becomes VOIDED.
    UPDATE adquisiciones.route_settlement_payment_allocations
    SET
        voided_by = v_actor_user_id,
        voided_at = now(),
        void_reason = v_reason
    WHERE company_id = v_company_id
      AND settlement_id = v_settlement_id
      AND payment_id = p_payment_id
      AND voided_at IS NULL;

    GET DIAGNOSTICS v_voided_allocations = ROW_COUNT;

    UPDATE adquisiciones.route_settlement_payments
    SET
        verification_status = 'VOIDED',
        updated_by = v_actor_user_id,
        voided_by = v_actor_user_id,
        voided_at = now(),
        void_reason = v_reason
    WHERE id = p_payment_id
      AND company_id = v_company_id;

    INSERT INTO portal.audit_logs (
        schema_name,
        module_code,
        table_name,
        record_id,
        action,
        old_data,
        new_data,
        performed_by,
        event_type,
        severity
    ) VALUES (
        'adquisiciones',
        'ADQUISICIONES',
        'route_settlement_payments',
        p_payment_id,
        'UPDATE',
        v_old_payment,
        jsonb_build_object(
            'id', p_payment_id,
            'settlement_id', v_settlement_id,
            'settlement_number', v_settlement_number,
            'customer_bsale_id', v_customer_bsale_id,
            'amount_received', v_amount_received,
            'payment_method_received', v_payment_method,
            'received_at', v_received_at,
            'verification_status', 'VOIDED',
            'voided_by', v_actor_user_id,
            'void_reason', v_reason,
            'custody_user_id', v_custody_user_id,
            'custody_received_at', v_custody_received_at,
            'active_fund', false,
            'voided_allocations', v_active_allocations,
            'voided_allocations_count', v_voided_allocations
        ),
        v_actor_user_id,
        'ROUTE_SETTLEMENT_PAYMENT_VOIDED',
        'INFO'
    );

    RETURN jsonb_build_object(
        'payment', jsonb_build_object(
            'id', p_payment_id,
            'settlement_id', v_settlement_id,
            'customer_bsale_id', v_customer_bsale_id,
            'amount_received', v_amount_received,
            'payment_method_received', v_payment_method,
            'received_at', v_received_at,
            'verification_status', 'VOIDED',
            'voided_by', v_actor_user_id,
            'void_reason', v_reason,
            'custody_user_id', v_custody_user_id,
            'custody_received_at', v_custody_received_at,
            'active_fund', false
        ),
        'voided_allocations', v_active_allocations,
        'voided_allocations_count', v_voided_allocations
    );
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.void_route_settlement_payment(uuid, text)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION adquisiciones.void_route_settlement_payment(uuid, text)
    TO authenticated;
