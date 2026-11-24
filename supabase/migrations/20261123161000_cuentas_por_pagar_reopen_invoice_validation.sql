-- Cuentas por Pagar | Bloque 4B: Reapertura administrativa auditada de validación de facturas.
-- Permite devolver una factura VALIDATED a PENDING / UNREVIEWED únicamente cuando tiene
-- cero pagos activos vigentes (los pagos reversados no bloquean la reapertura),
-- conservando el historial inmutable de validaciones, pagos y reversas.

CREATE TABLE cuentas_por_pagar.invoice_validation_reopenings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    reason text NOT NULL,
    operation_id uuid NOT NULL,
    previous_validation_status text NOT NULL,
    previous_prior_payment_status text NOT NULL,
    previous_total_amount numeric(18,2),
    previous_historical_initial_balance numeric(18,2),
    previous_historical_balance_cutoff_date date,
    previous_discrepancy_status text NOT NULL,
    previous_discrepancy_resolution_note text,
    previous_validated_at timestamptz,
    previous_validated_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id),
    FOREIGN KEY (invoice_id, company_id)
        REFERENCES cuentas_por_pagar.invoices(id, company_id)
        ON DELETE RESTRICT,
    UNIQUE (company_id, operation_id),
    CHECK (company_id = 'd1000000-0000-0000-0000-000000000001'::uuid),
    CHECK (length(btrim(reason)) >= 3 AND length(btrim(reason)) <= 500)
);

CREATE INDEX invoice_validation_reopenings_invoice_idx
    ON cuentas_por_pagar.invoice_validation_reopenings (company_id, invoice_id, created_at, id);

ALTER TABLE cuentas_por_pagar.invoice_validation_reopenings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cuentas_por_pagar.invoice_validation_reopenings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON cuentas_por_pagar.invoice_validation_reopenings TO service_role;

CREATE TRIGGER prevent_invoice_validation_reopening_mutation
    BEFORE UPDATE OR DELETE ON cuentas_por_pagar.invoice_validation_reopenings
    FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.prevent_payment_mutation();

CREATE TRIGGER audit_invoice_validation_reopening
    AFTER INSERT ON cuentas_por_pagar.invoice_validation_reopenings
    FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.audit_change();

CREATE FUNCTION public.cxp_reopen_invoice_validation(
    p_invoice_id uuid,
    p_operation_id uuid,
    p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
    v_actor uuid := auth.uid();
    v_reason text;
    v_invoice cuentas_por_pagar.invoices%ROWTYPE;
    v_updated cuentas_por_pagar.invoices%ROWTYPE;
    v_existing_reopening cuentas_por_pagar.invoice_validation_reopenings%ROWTYPE;
    v_reopening cuentas_por_pagar.invoice_validation_reopenings%ROWTYPE;
    v_module_paid numeric(18,2) := 0;
    v_reversed_amount numeric(18,2) := 0;
    v_payment_count integer := 0;
    v_reversed_count integer := 0;
    v_next_discrepancy_status text;
    v_balance jsonb;
BEGIN
    IF v_actor IS NULL OR NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;

    IF p_invoice_id IS NULL THEN
        RAISE EXCEPTION 'Debe indicar la factura cuya validación desea reabrir' USING ERRCODE = 'P0001';
    END IF;

    IF p_operation_id IS NULL THEN
        RAISE EXCEPTION 'El identificador único de operación es obligatorio' USING ERRCODE = 'P0001';
    END IF;

    v_reason := nullif(btrim(p_reason), '');
    IF v_reason IS NULL OR length(v_reason) < 3 OR length(v_reason) > 500 THEN
        RAISE EXCEPTION 'El motivo de reapertura es obligatorio y debe tener entre 3 y 500 caracteres'
            USING ERRCODE = 'P0001';
    END IF;

    -- Serializa contra pagos, reversas y ediciones simultáneas sobre la misma factura.
    SELECT * INTO v_invoice
    FROM cuentas_por_pagar.invoices
    WHERE id = p_invoice_id
      AND company_id = v_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Factura no encontrada' USING ERRCODE = 'P0001';
    END IF;

    -- Idempotencia por operation_id dentro de Caylo.
    SELECT * INTO v_existing_reopening
    FROM cuentas_por_pagar.invoice_validation_reopenings
    WHERE company_id = v_company_id
      AND operation_id = p_operation_id;

    IF FOUND THEN
        IF v_existing_reopening.invoice_id <> p_invoice_id
           OR v_existing_reopening.reason IS DISTINCT FROM v_reason THEN
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
            'reopening', jsonb_build_object(
                'id', v_existing_reopening.id,
                'company_id', v_existing_reopening.company_id,
                'invoice_id', v_existing_reopening.invoice_id,
                'reason', v_existing_reopening.reason,
                'operation_id', v_existing_reopening.operation_id,
                'previous_validation_status', v_existing_reopening.previous_validation_status,
                'previous_prior_payment_status', v_existing_reopening.previous_prior_payment_status,
                'previous_total_amount', v_existing_reopening.previous_total_amount,
                'previous_validated_at', v_existing_reopening.previous_validated_at,
                'previous_validated_by', v_existing_reopening.previous_validated_by,
                'created_at', v_existing_reopening.created_at,
                'created_by', v_existing_reopening.created_by
            ),
            'invoice', jsonb_build_object(
                'id', v_invoice.id,
                'company_id', v_invoice.company_id,
                'validation_status', v_invoice.validation_status,
                'prior_payment_status', v_invoice.prior_payment_status,
                'issue_date', v_invoice.issue_date,
                'due_date', v_invoice.due_date,
                'net_amount', v_invoice.net_amount,
                'tax_amount', v_invoice.tax_amount,
                'total_amount', v_invoice.total_amount,
                'historical_initial_balance', v_invoice.historical_initial_balance,
                'historical_balance_cutoff_date', v_invoice.historical_balance_cutoff_date,
                'discrepancy_status', v_invoice.discrepancy_status,
                'discrepancy_resolution_note', v_invoice.discrepancy_resolution_note,
                'validated_at', v_invoice.validated_at,
                'validated_by', v_invoice.validated_by
            ),
            'balance', v_balance
        );
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

    -- Exigir cero pagos activos; los pagos reversados (r.id IS NOT NULL) no bloquean la reapertura.
    IF v_payment_count > 0 THEN
        RAISE EXCEPTION 'No se puede reabrir la validación mientras existan pagos activos vigentes (%). Anule primero los pagos activos.', v_payment_count
            USING ERRCODE = 'P0001';
    END IF;

    IF v_invoice.validation_status <> 'VALIDATED' THEN
        RAISE EXCEPTION 'Solo se puede reabrir la validación de facturas que se encuentren en estado VALIDATED'
            USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO cuentas_por_pagar.invoice_validation_reopenings (
        company_id,
        invoice_id,
        reason,
        operation_id,
        previous_validation_status,
        previous_prior_payment_status,
        previous_total_amount,
        previous_historical_initial_balance,
        previous_historical_balance_cutoff_date,
        previous_discrepancy_status,
        previous_discrepancy_resolution_note,
        previous_validated_at,
        previous_validated_by,
        created_by
    ) VALUES (
        v_company_id,
        v_invoice.id,
        v_reason,
        p_operation_id,
        v_invoice.validation_status,
        v_invoice.prior_payment_status,
        v_invoice.total_amount,
        v_invoice.historical_initial_balance,
        v_invoice.historical_balance_cutoff_date,
        v_invoice.discrepancy_status,
        v_invoice.discrepancy_resolution_note,
        v_invoice.validated_at,
        v_invoice.validated_by,
        v_actor
    )
    RETURNING * INTO v_reopening;

    v_next_discrepancy_status := CASE
        WHEN v_invoice.discrepancy_status = 'RESOLVED' THEN 'UNRESOLVED'
        ELSE v_invoice.discrepancy_status
    END;

    UPDATE cuentas_por_pagar.invoices
    SET
        validation_status = 'PENDING',
        prior_payment_status = 'UNREVIEWED',
        historical_initial_balance = NULL,
        historical_balance_cutoff_date = NULL,
        discrepancy_status = v_next_discrepancy_status,
        discrepancy_resolution_note = CASE
            WHEN v_next_discrepancy_status = 'RESOLVED' THEN discrepancy_resolution_note
            ELSE NULL
        END
    WHERE id = v_invoice.id
      AND company_id = v_company_id
    RETURNING * INTO v_updated;

    v_balance := cuentas_por_pagar.compute_invoice_balance(v_updated, 0)
        || jsonb_build_object(
            'payment_count', 0,
            'reversed_payment_count', v_reversed_count,
            'reversed_amount', v_reversed_amount
        );

    RETURN jsonb_build_object(
        'idempotent_replay', false,
        'reopening', jsonb_build_object(
            'id', v_reopening.id,
            'company_id', v_reopening.company_id,
            'invoice_id', v_reopening.invoice_id,
            'reason', v_reopening.reason,
            'operation_id', v_reopening.operation_id,
            'previous_validation_status', v_reopening.previous_validation_status,
            'previous_prior_payment_status', v_reopening.previous_prior_payment_status,
            'previous_total_amount', v_reopening.previous_total_amount,
            'previous_validated_at', v_reopening.previous_validated_at,
            'previous_validated_by', v_reopening.previous_validated_by,
            'created_at', v_reopening.created_at,
            'created_by', v_reopening.created_by
        ),
        'invoice', jsonb_build_object(
            'id', v_updated.id,
            'company_id', v_updated.company_id,
            'validation_status', v_updated.validation_status,
            'prior_payment_status', v_updated.prior_payment_status,
            'issue_date', v_updated.issue_date,
            'due_date', v_updated.due_date,
            'net_amount', v_updated.net_amount,
            'tax_amount', v_updated.tax_amount,
            'total_amount', v_updated.total_amount,
            'historical_initial_balance', v_updated.historical_initial_balance,
            'historical_balance_cutoff_date', v_updated.historical_balance_cutoff_date,
            'discrepancy_status', v_updated.discrepancy_status,
            'discrepancy_resolution_note', v_updated.discrepancy_resolution_note,
            'validated_at', v_updated.validated_at,
            'validated_by', v_updated.validated_by
        ),
        'balance', v_balance
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cxp_reopen_invoice_validation(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cxp_reopen_invoice_validation(uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
