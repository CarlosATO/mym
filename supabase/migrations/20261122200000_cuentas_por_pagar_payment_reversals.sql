-- Cuentas por Pagar | Bloque 3: Reversa auditada e inmutable de pagos registrados.

ALTER TABLE cuentas_por_pagar.invoice_payments
    ADD CONSTRAINT invoice_payments_id_company_invoice_uidx
    UNIQUE (id, company_id, invoice_id);

CREATE TABLE cuentas_por_pagar.invoice_payment_reversals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    reason text NOT NULL,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id),
    FOREIGN KEY (invoice_id, company_id)
        REFERENCES cuentas_por_pagar.invoices(id, company_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (payment_id, company_id, invoice_id)
        REFERENCES cuentas_por_pagar.invoice_payments(id, company_id, invoice_id)
        ON DELETE RESTRICT,
    UNIQUE (company_id, payment_id),
    UNIQUE (company_id, operation_id),
    CHECK (company_id = 'd1000000-0000-0000-0000-000000000001'::uuid),
    CHECK (length(btrim(reason)) >= 3 AND length(btrim(reason)) <= 500)
);

CREATE INDEX invoice_payment_reversals_invoice_idx
    ON cuentas_por_pagar.invoice_payment_reversals (company_id, invoice_id, created_at, id);

ALTER TABLE cuentas_por_pagar.invoice_payment_reversals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cuentas_por_pagar.invoice_payment_reversals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON cuentas_por_pagar.invoice_payment_reversals TO service_role;

CREATE TRIGGER prevent_invoice_payment_reversal_mutation
    BEFORE UPDATE OR DELETE ON cuentas_por_pagar.invoice_payment_reversals
    FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.prevent_payment_mutation();

CREATE TRIGGER audit_invoice_payment_reversal
    AFTER INSERT ON cuentas_por_pagar.invoice_payment_reversals
    FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.audit_change();

CREATE OR REPLACE FUNCTION public.cxp_register_invoice_payment(
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
    v_existing_reversal cuentas_por_pagar.invoice_payment_reversals%ROWTYPE;
    v_payment cuentas_por_pagar.invoice_payments%ROWTYPE;
    v_amount numeric(18,2);
    v_reference text;
    v_module_paid numeric(18,2) := 0;
    v_reversed_amount numeric(18,2) := 0;
    v_payment_count integer := 0;
    v_reversed_count integer := 0;
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

    -- Serializa pagos y reversas simultáneas sobre la misma factura en Caylo.
    SELECT * INTO v_invoice
    FROM cuentas_por_pagar.invoices
    WHERE id = p_invoice_id
      AND company_id = v_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Factura no encontrada' USING ERRCODE = 'P0001';
    END IF;

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

        -- Un reintento tardío de un pago ya reversado no puede reactivarlo ni presentarlo como vigente.
        SELECT * INTO v_existing_reversal
        FROM cuentas_por_pagar.invoice_payment_reversals
        WHERE company_id = v_company_id
          AND payment_id = v_existing.id;

        IF FOUND THEN
            RAISE EXCEPTION 'La operación corresponde a un pago que ya fue reversado; registre una nueva operación si desea pagar nuevamente'
                USING ERRCODE = 'P0001';
        END IF;

        SELECT
            coalesce(sum(p.amount) FILTER (WHERE r.id IS NULL), 0)::numeric(18,2),
            coalesce(sum(p.amount) FILTER (WHERE r.id IS NOT NULL), 0)::numeric(18,2),
            count(*) FILTER (WHERE r.id IS NULL)::integer,
            count(*) FILTER (WHERE r.id IS NOT NULL)::integer
        INTO v_module_paid, v_reversed_amount, v_payment_count, v_reversed_count
        FROM cuentas_por_pagar.invoice_payments p
        LEFT JOIN cuentas_por_pagar.invoice_payment_reversals r
            ON r.company_id = p.company_id AND r.payment_id = p.id
        WHERE p.company_id = v_company_id
          AND p.invoice_id = v_invoice.id;

        v_balance := cuentas_por_pagar.compute_invoice_balance(v_invoice, v_module_paid)
            || jsonb_build_object(
                'payment_count', v_payment_count,
                'reversed_payment_count', v_reversed_count,
                'reversed_amount', v_reversed_amount
            );

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
                'created_by', v_existing.created_by,
                'is_reversed', false,
                'status', 'ACTIVE'
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
        RAISE EXCEPTION 'Para facturas con saldo inicial histórico parcial, la fecha del pago debe ser posterior a la fecha de corte (%)',
            v_invoice.historical_balance_cutoff_date
            USING ERRCODE = 'P0001';
    END IF;

    SELECT
        coalesce(sum(p.amount) FILTER (WHERE r.id IS NULL), 0)::numeric(18,2),
        coalesce(sum(p.amount) FILTER (WHERE r.id IS NOT NULL), 0)::numeric(18,2),
        count(*) FILTER (WHERE r.id IS NULL)::integer,
        count(*) FILTER (WHERE r.id IS NOT NULL)::integer
    INTO v_module_paid, v_reversed_amount, v_payment_count, v_reversed_count
    FROM cuentas_por_pagar.invoice_payments p
    LEFT JOIN cuentas_por_pagar.invoice_payment_reversals r
        ON r.company_id = p.company_id AND r.payment_id = p.id
    WHERE p.company_id = v_company_id
      AND p.invoice_id = v_invoice.id;

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
        || jsonb_build_object(
            'payment_count', v_payment_count + 1,
            'reversed_payment_count', v_reversed_count,
            'reversed_amount', v_reversed_amount
        );

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
            'created_by', v_payment.created_by,
            'is_reversed', false,
            'status', 'ACTIVE'
        ),
        'balance', v_balance
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.cxp_invoice_payments(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
    v_actor uuid := auth.uid();
    v_invoice cuentas_por_pagar.invoices%ROWTYPE;
    v_module_paid numeric(18,2) := 0;
    v_reversed_amount numeric(18,2) := 0;
    v_payment_count integer := 0;
    v_reversed_count integer := 0;
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
        coalesce(sum(p.amount) FILTER (WHERE r.id IS NULL), 0)::numeric(18,2),
        coalesce(sum(p.amount) FILTER (WHERE r.id IS NOT NULL), 0)::numeric(18,2),
        count(*) FILTER (WHERE r.id IS NULL)::integer,
        count(*) FILTER (WHERE r.id IS NOT NULL)::integer,
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
                    ),
                    'is_reversed', (r.id IS NOT NULL),
                    'status', CASE WHEN r.id IS NOT NULL THEN 'REVERSED' ELSE 'ACTIVE' END,
                    'reversal', CASE WHEN r.id IS NOT NULL THEN jsonb_build_object(
                        'id', r.id,
                        'reason', r.reason,
                        'operation_id', r.operation_id,
                        'created_at', r.created_at,
                        'created_by', r.created_by,
                        'created_by_name', coalesce(
                            nullif(btrim(concat_ws(' ', ru.nombre, ru.apellido)), ''),
                            nullif(btrim(ru.email), '')
                        )
                    ) ELSE NULL END
                )
                ORDER BY p.payment_date ASC, p.created_at ASC, p.id ASC
            ),
            '[]'::jsonb
        )
    INTO v_module_paid, v_reversed_amount, v_payment_count, v_reversed_count, v_payments
    FROM cuentas_por_pagar.invoice_payments p
    LEFT JOIN portal.users u
        ON u.id = p.created_by
    LEFT JOIN cuentas_por_pagar.invoice_payment_reversals r
        ON r.company_id = p.company_id AND r.payment_id = p.id
    LEFT JOIN portal.users ru
        ON ru.id = r.created_by
    WHERE p.company_id = v_company_id
      AND p.invoice_id = v_invoice.id;

    v_balance := cuentas_por_pagar.compute_invoice_balance(v_invoice, v_module_paid);

    RETURN v_balance || jsonb_build_object(
        'payment_count', v_payment_count,
        'reversed_payment_count', v_reversed_count,
        'reversed_amount', v_reversed_amount,
        'payments', v_payments
    );
END;
$$;

CREATE FUNCTION public.cxp_reverse_invoice_payment(
    p_payment_id uuid,
    p_operation_id uuid,
    p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
    v_actor uuid := auth.uid();
    v_reason text;
    v_payment cuentas_por_pagar.invoice_payments%ROWTYPE;
    v_invoice cuentas_por_pagar.invoices%ROWTYPE;
    v_existing_reversal cuentas_por_pagar.invoice_payment_reversals%ROWTYPE;
    v_reversal cuentas_por_pagar.invoice_payment_reversals%ROWTYPE;
    v_module_paid numeric(18,2) := 0;
    v_reversed_amount numeric(18,2) := 0;
    v_payment_count integer := 0;
    v_reversed_count integer := 0;
    v_balance jsonb;
BEGIN
    IF v_actor IS NULL OR NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;

    IF p_payment_id IS NULL THEN
        RAISE EXCEPTION 'Debe indicar el pago a reversar' USING ERRCODE = 'P0001';
    END IF;

    IF p_operation_id IS NULL THEN
        RAISE EXCEPTION 'El identificador único de operación es obligatorio' USING ERRCODE = 'P0001';
    END IF;

    v_reason := nullif(btrim(p_reason), '');
    IF v_reason IS NULL OR length(v_reason) < 3 OR length(v_reason) > 500 THEN
        RAISE EXCEPTION 'El motivo de reversa es obligatorio y debe tener entre 3 y 500 caracteres'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_payment
    FROM cuentas_por_pagar.invoice_payments
    WHERE id = p_payment_id
      AND company_id = v_company_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Pago no encontrado' USING ERRCODE = 'P0001';
    END IF;

    -- Serializa en el mismo orden de bloqueo que cxp_register_invoice_payment (factura primero).
    SELECT * INTO v_invoice
    FROM cuentas_por_pagar.invoices
    WHERE id = v_payment.invoice_id
      AND company_id = v_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Factura asociada al pago no encontrada' USING ERRCODE = 'P0001';
    END IF;

    -- Idempotencia por operation_id dentro de Caylo.
    SELECT * INTO v_existing_reversal
    FROM cuentas_por_pagar.invoice_payment_reversals
    WHERE company_id = v_company_id
      AND operation_id = p_operation_id;

    IF FOUND THEN
        IF v_existing_reversal.payment_id <> p_payment_id
           OR v_existing_reversal.reason IS DISTINCT FROM v_reason THEN
            RAISE EXCEPTION 'El identificador de operación ya fue utilizado con otros parámetros'
                USING ERRCODE = 'P0001';
        END IF;

        SELECT
            coalesce(sum(p.amount) FILTER (WHERE r.id IS NULL), 0)::numeric(18,2),
            coalesce(sum(p.amount) FILTER (WHERE r.id IS NOT NULL), 0)::numeric(18,2),
            count(*) FILTER (WHERE r.id IS NULL)::integer,
            count(*) FILTER (WHERE r.id IS NOT NULL)::integer
        INTO v_module_paid, v_reversed_amount, v_payment_count, v_reversed_count
        FROM cuentas_por_pagar.invoice_payments p
        LEFT JOIN cuentas_por_pagar.invoice_payment_reversals r
            ON r.company_id = p.company_id AND r.payment_id = p.id
        WHERE p.company_id = v_company_id
          AND p.invoice_id = v_invoice.id;

        v_balance := cuentas_por_pagar.compute_invoice_balance(v_invoice, v_module_paid)
            || jsonb_build_object(
                'payment_count', v_payment_count,
                'reversed_payment_count', v_reversed_count,
                'reversed_amount', v_reversed_amount
            );

        RETURN jsonb_build_object(
            'idempotent_replay', true,
            'reversal', jsonb_build_object(
                'id', v_existing_reversal.id,
                'company_id', v_existing_reversal.company_id,
                'invoice_id', v_existing_reversal.invoice_id,
                'payment_id', v_existing_reversal.payment_id,
                'reason', v_existing_reversal.reason,
                'operation_id', v_existing_reversal.operation_id,
                'created_at', v_existing_reversal.created_at,
                'created_by', v_existing_reversal.created_by
            ),
            'payment', jsonb_build_object(
                'id', v_payment.id,
                'company_id', v_payment.company_id,
                'invoice_id', v_payment.invoice_id,
                'payment_date', v_payment.payment_date,
                'amount', v_payment.amount,
                'reference', v_payment.reference,
                'operation_id', v_payment.operation_id,
                'created_at', v_payment.created_at,
                'created_by', v_payment.created_by,
                'is_reversed', true,
                'status', 'REVERSED'
            ),
            'balance', v_balance
        );
    END IF;

    IF EXISTS (
        SELECT 1
        FROM cuentas_por_pagar.invoice_payment_reversals
        WHERE company_id = v_company_id
          AND payment_id = v_payment.id
    ) THEN
        RAISE EXCEPTION 'El pago ya fue reversado previamente' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO cuentas_por_pagar.invoice_payment_reversals (
        company_id,
        invoice_id,
        payment_id,
        reason,
        operation_id,
        created_by
    ) VALUES (
        v_company_id,
        v_invoice.id,
        v_payment.id,
        v_reason,
        p_operation_id,
        v_actor
    )
    RETURNING * INTO v_reversal;

    SELECT
        coalesce(sum(p.amount) FILTER (WHERE r.id IS NULL), 0)::numeric(18,2),
        coalesce(sum(p.amount) FILTER (WHERE r.id IS NOT NULL), 0)::numeric(18,2),
        count(*) FILTER (WHERE r.id IS NULL)::integer,
        count(*) FILTER (WHERE r.id IS NOT NULL)::integer
    INTO v_module_paid, v_reversed_amount, v_payment_count, v_reversed_count
    FROM cuentas_por_pagar.invoice_payments p
    LEFT JOIN cuentas_por_pagar.invoice_payment_reversals r
        ON r.company_id = p.company_id AND r.payment_id = p.id
    WHERE p.company_id = v_company_id
      AND p.invoice_id = v_invoice.id;

    v_balance := cuentas_por_pagar.compute_invoice_balance(v_invoice, v_module_paid)
        || jsonb_build_object(
            'payment_count', v_payment_count,
            'reversed_payment_count', v_reversed_count,
            'reversed_amount', v_reversed_amount
        );

    RETURN jsonb_build_object(
        'idempotent_replay', false,
        'reversal', jsonb_build_object(
            'id', v_reversal.id,
            'company_id', v_reversal.company_id,
            'invoice_id', v_reversal.invoice_id,
            'payment_id', v_reversal.payment_id,
            'reason', v_reversal.reason,
            'operation_id', v_reversal.operation_id,
            'created_at', v_reversal.created_at,
            'created_by', v_reversal.created_by
        ),
        'payment', jsonb_build_object(
            'id', v_payment.id,
            'company_id', v_payment.company_id,
            'invoice_id', v_payment.invoice_id,
            'payment_date', v_payment.payment_date,
            'amount', v_payment.amount,
            'reference', v_payment.reference,
            'operation_id', v_payment.operation_id,
            'created_at', v_payment.created_at,
            'created_by', v_payment.created_by,
            'is_reversed', true,
            'status', 'REVERSED'
        ),
        'balance', v_balance
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cxp_reverse_invoice_payment(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cxp_reverse_invoice_payment(uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
