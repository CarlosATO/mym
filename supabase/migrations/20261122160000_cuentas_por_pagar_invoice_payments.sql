-- Cuentas por Pagar | Bloque 1: Persistencia transaccional de pagos reales y abonos.

CREATE TABLE cuentas_por_pagar.invoice_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    payment_date date NOT NULL,
    amount numeric(18,2) NOT NULL,
    reference text,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id),
    FOREIGN KEY (invoice_id, company_id)
        REFERENCES cuentas_por_pagar.invoices(id, company_id)
        ON DELETE RESTRICT,
    UNIQUE (company_id, operation_id),
    CHECK (company_id = 'd1000000-0000-0000-0000-000000000001'::uuid),
    CHECK (amount > 0),
    CHECK (amount = round(amount, 2)),
    CHECK (reference IS NULL OR (length(btrim(reference)) > 0 AND length(reference) <= 500))
);

CREATE INDEX invoice_payments_invoice_idx
    ON cuentas_por_pagar.invoice_payments (company_id, invoice_id, payment_date, created_at, id);

ALTER TABLE cuentas_por_pagar.invoice_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cuentas_por_pagar.invoice_payments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON cuentas_por_pagar.invoice_payments TO service_role;

CREATE FUNCTION cuentas_por_pagar.prevent_payment_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'Los pagos registrados son inmutables y no pueden modificarse ni eliminarse'
        USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION cuentas_por_pagar.prevent_payment_mutation() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER prevent_invoice_payment_mutation
    BEFORE UPDATE OR DELETE ON cuentas_por_pagar.invoice_payments
    FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.prevent_payment_mutation();

CREATE TRIGGER audit_invoice_payment
    AFTER INSERT ON cuentas_por_pagar.invoice_payments
    FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.audit_change();

CREATE FUNCTION cuentas_por_pagar.compute_invoice_balance(
    p_invoice cuentas_por_pagar.invoices,
    p_module_paid numeric
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_module_paid numeric(18,2) := round(coalesce(p_module_paid, 0), 2);
    v_initial_balance numeric(18,2);
    v_prior_paid numeric(18,2);
    v_total_paid numeric(18,2);
    v_current_balance numeric(18,2);
    v_is_validated boolean := (p_invoice.validation_status = 'VALIDATED' AND p_invoice.total_amount IS NOT NULL AND p_invoice.total_amount > 0);
BEGIN
    IF NOT v_is_validated THEN
        RETURN jsonb_build_object(
            'invoice_id', p_invoice.id,
            'company_id', p_invoice.company_id,
            'validation_status', p_invoice.validation_status,
            'total_amount', p_invoice.total_amount,
            'prior_payment_status', p_invoice.prior_payment_status,
            'historical_initial_balance', p_invoice.historical_initial_balance,
            'historical_balance_cutoff_date', p_invoice.historical_balance_cutoff_date,
            'initial_balance', NULL,
            'prior_paid_amount', NULL,
            'module_paid_amount', v_module_paid,
            'total_paid_amount', NULL,
            'current_balance', NULL,
            'is_fully_paid', false,
            'can_register_payment', false
        );
    END IF;

    IF p_invoice.prior_payment_status = 'NO_PRIOR_PAYMENTS' THEN
        v_initial_balance := round(p_invoice.total_amount, 2);
    ELSIF p_invoice.prior_payment_status = 'PARTIAL_PRIOR_PAYMENTS' THEN
        IF p_invoice.historical_initial_balance IS NULL THEN
            RAISE EXCEPTION 'Factura con pago parcial previo sin saldo inicial histórico' USING ERRCODE = 'P0001';
        END IF;
        v_initial_balance := round(p_invoice.historical_initial_balance, 2);
    ELSIF p_invoice.prior_payment_status = 'FULLY_PAID_PRIOR' THEN
        v_initial_balance := 0.00::numeric(18,2);
    ELSE
        RAISE EXCEPTION 'Estado de pagos anteriores inválido para cálculo de saldo: %', p_invoice.prior_payment_status
            USING ERRCODE = 'P0001';
    END IF;

    v_prior_paid := round(p_invoice.total_amount - v_initial_balance, 2);
    v_total_paid := round(v_prior_paid + v_module_paid, 2);
    v_current_balance := round(v_initial_balance - v_module_paid, 2);

    RETURN jsonb_build_object(
        'invoice_id', p_invoice.id,
        'company_id', p_invoice.company_id,
        'validation_status', p_invoice.validation_status,
        'total_amount', round(p_invoice.total_amount, 2),
        'prior_payment_status', p_invoice.prior_payment_status,
        'historical_initial_balance', p_invoice.historical_initial_balance,
        'historical_balance_cutoff_date', p_invoice.historical_balance_cutoff_date,
        'initial_balance', v_initial_balance,
        'prior_paid_amount', v_prior_paid,
        'module_paid_amount', v_module_paid,
        'total_paid_amount', v_total_paid,
        'current_balance', v_current_balance,
        'is_fully_paid', (v_current_balance = 0),
        'can_register_payment', (v_current_balance > 0)
    );
END;
$$;
REVOKE ALL ON FUNCTION cuentas_por_pagar.compute_invoice_balance(cuentas_por_pagar.invoices, numeric) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.cxp_register_invoice_payment(
    p_invoice_id uuid,
    p_payment_date date,
    p_amount numeric,
    p_operation_id uuid,
    p_reference text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
    v_actor uuid := auth.uid();
    v_invoice cuentas_por_pagar.invoices%ROWTYPE;
    v_existing cuentas_por_pagar.invoice_payments%ROWTYPE;
    v_payment cuentas_por_pagar.invoice_payments%ROWTYPE;
    v_amount numeric(18,2);
    v_reference text;
    v_module_paid numeric(18,2) := 0;
    v_payment_count integer := 0;
    v_balance jsonb;
    v_current_balance numeric(18,2);
BEGIN
    IF v_actor IS NULL OR NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;

    IF p_invoice_id IS NULL THEN
        RAISE EXCEPTION 'Debe indicar la factura asociada al pago' USING ERRCODE = 'P0001';
    END IF;

    IF p_operation_id IS NULL THEN
        RAISE EXCEPTION 'El identificador único de operación es obligatorio' USING ERRCODE = 'P0001';
    END IF;

    IF p_payment_date IS NULL THEN
        RAISE EXCEPTION 'La fecha efectiva del pago es obligatoria' USING ERRCODE = 'P0001';
    END IF;

    IF p_payment_date > (now() AT TIME ZONE 'America/Santiago')::date THEN
        RAISE EXCEPTION 'La fecha efectiva del pago no puede ser futura respecto de Chile (America/Santiago)'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'El monto del pago debe ser mayor a 0' USING ERRCODE = 'P0001';
    END IF;

    IF p_amount <> round(p_amount, 2) THEN
        RAISE EXCEPTION 'El monto del pago no puede tener más de 2 decimales' USING ERRCODE = 'P0001';
    END IF;

    v_amount := round(p_amount, 2);
    v_reference := nullif(btrim(p_reference), '');

    IF v_reference IS NOT NULL AND length(v_reference) > 500 THEN
        RAISE EXCEPTION 'La referencia u observación no puede superar los 500 caracteres' USING ERRCODE = 'P0001';
    END IF;

    -- Serializa pagos simultáneos y cambios sobre la misma factura en Caylo.
    SELECT * INTO v_invoice
    FROM cuentas_por_pagar.invoices
    WHERE id = p_invoice_id
      AND company_id = v_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Factura no encontrada' USING ERRCODE = 'P0001';
    END IF;

    -- Verifica idempotencia por operation_id dentro de Caylo.
    SELECT * INTO v_existing
    FROM cuentas_por_pagar.invoice_payments
    WHERE company_id = v_company_id
      AND operation_id = p_operation_id;

    IF FOUND THEN
        IF v_existing.invoice_id <> p_invoice_id
           OR v_existing.payment_date <> p_payment_date
           OR v_existing.amount <> v_amount
           OR v_existing.reference IS DISTINCT FROM v_reference THEN
            RAISE EXCEPTION 'El identificador de operación ya fue utilizado con otros parámetros'
                USING ERRCODE = 'P0001';
        END IF;

        SELECT coalesce(sum(amount), 0)::numeric(18,2), count(*)::integer
        INTO v_module_paid, v_payment_count
        FROM cuentas_por_pagar.invoice_payments
        WHERE company_id = v_company_id
          AND invoice_id = v_invoice.id;

        v_balance := cuentas_por_pagar.compute_invoice_balance(v_invoice, v_module_paid)
            || jsonb_build_object('payment_count', v_payment_count);

        RETURN jsonb_build_object(
            'idempotent_replay', true,
            'payment', jsonb_build_object(
                'id', v_existing.id,
                'company_id', v_existing.company_id,
                'invoice_id', v_existing.invoice_id,
                'payment_date', v_existing.payment_date,
                'amount', v_existing.amount,
                'reference', v_existing.reference,
                'operation_id', v_existing.operation_id,
                'created_at', v_existing.created_at,
                'created_by', v_existing.created_by
            ),
            'balance', v_balance
        );
    END IF;

    IF v_invoice.validation_status <> 'VALIDATED' THEN
        RAISE EXCEPTION 'Solo se pueden registrar pagos sobre facturas validadas' USING ERRCODE = 'P0001';
    END IF;

    IF v_invoice.total_amount IS NULL OR v_invoice.total_amount <= 0 THEN
        RAISE EXCEPTION 'La factura no tiene un monto total válido' USING ERRCODE = 'P0001';
    END IF;

    IF v_invoice.prior_payment_status = 'PARTIAL_PRIOR_PAYMENTS'
       AND v_invoice.historical_balance_cutoff_date IS NOT NULL
       AND p_payment_date <= v_invoice.historical_balance_cutoff_date THEN
        RAISE EXCEPTION 'Para facturas con saldo inicial histórico parcial, la fecha del pago debe ser posterior a la fecha de corte (%)', v_invoice.historical_balance_cutoff_date
            USING ERRCODE = 'P0001';
    END IF;

    SELECT coalesce(sum(amount), 0)::numeric(18,2), count(*)::integer
    INTO v_module_paid, v_payment_count
    FROM cuentas_por_pagar.invoice_payments
    WHERE company_id = v_company_id
      AND invoice_id = v_invoice.id;

    v_balance := cuentas_por_pagar.compute_invoice_balance(v_invoice, v_module_paid);
    v_current_balance := (v_balance ->> 'current_balance')::numeric(18,2);

    IF v_current_balance <= 0 THEN
        RAISE EXCEPTION 'La factura no tiene saldo pendiente por pagar' USING ERRCODE = 'P0001';
    END IF;

    IF v_amount > v_current_balance THEN
        RAISE EXCEPTION 'El monto del pago (%) supera el saldo pendiente (%)', v_amount, v_current_balance
            USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO cuentas_por_pagar.invoice_payments (
        company_id,
        invoice_id,
        payment_date,
        amount,
        reference,
        operation_id,
        created_by
    ) VALUES (
        v_company_id,
        v_invoice.id,
        p_payment_date,
        v_amount,
        v_reference,
        p_operation_id,
        v_actor
    )
    RETURNING * INTO v_payment;

    v_balance := cuentas_por_pagar.compute_invoice_balance(v_invoice, round(v_module_paid + v_amount, 2))
        || jsonb_build_object('payment_count', v_payment_count + 1);

    RETURN jsonb_build_object(
        'idempotent_replay', false,
        'payment', jsonb_build_object(
            'id', v_payment.id,
            'company_id', v_payment.company_id,
            'invoice_id', v_payment.invoice_id,
            'payment_date', v_payment.payment_date,
            'amount', v_payment.amount,
            'reference', v_payment.reference,
            'operation_id', v_payment.operation_id,
            'created_at', v_payment.created_at,
            'created_by', v_payment.created_by
        ),
        'balance', v_balance
    );
END;
$$;

CREATE FUNCTION public.cxp_invoice_payments(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
    v_actor uuid := auth.uid();
    v_invoice cuentas_por_pagar.invoices%ROWTYPE;
    v_module_paid numeric(18,2) := 0;
    v_payment_count integer := 0;
    v_payments jsonb := '[]'::jsonb;
    v_balance jsonb;
BEGIN
    IF v_actor IS NULL OR NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;

    IF p_invoice_id IS NULL THEN
        RAISE EXCEPTION 'Debe indicar la factura a consultar' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_invoice
    FROM cuentas_por_pagar.invoices
    WHERE id = p_invoice_id
      AND company_id = v_company_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Factura no encontrada' USING ERRCODE = 'P0001';
    END IF;

    SELECT
        coalesce(sum(p.amount), 0)::numeric(18,2),
        count(*)::integer,
        coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'id', p.id,
                    'company_id', p.company_id,
                    'invoice_id', p.invoice_id,
                    'payment_date', p.payment_date,
                    'amount', p.amount,
                    'reference', p.reference,
                    'operation_id', p.operation_id,
                    'created_at', p.created_at,
                    'created_by', p.created_by,
                    'created_by_name', coalesce(
                        nullif(btrim(concat_ws(' ', u.nombre, u.apellido)), ''),
                        nullif(btrim(u.email), '')
                    )
                )
                ORDER BY p.payment_date ASC, p.created_at ASC, p.id ASC
            ),
            '[]'::jsonb
        )
    INTO v_module_paid, v_payment_count, v_payments
    FROM cuentas_por_pagar.invoice_payments p
    LEFT JOIN portal.users u ON u.id = p.created_by
    WHERE p.company_id = v_company_id
      AND p.invoice_id = v_invoice.id;

    v_balance := cuentas_por_pagar.compute_invoice_balance(v_invoice, v_module_paid);

    RETURN v_balance || jsonb_build_object(
        'payment_count', v_payment_count,
        'payments', v_payments
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cxp_register_invoice_payment(uuid, date, numeric, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cxp_register_invoice_payment(uuid, date, numeric, uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.cxp_invoice_payments(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cxp_invoice_payments(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
