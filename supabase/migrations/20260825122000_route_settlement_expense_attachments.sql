-- Allow expense receipts to be registered before a fund closure exists.
-- Historical closure, deposit and general attachments remain supported.

ALTER TABLE adquisiciones.route_fund_closure_attachments
    ALTER COLUMN fund_closure_id DROP NOT NULL;

ALTER TABLE adquisiciones.route_fund_closure_attachments
    DROP CONSTRAINT IF EXISTS chk_rfca_fund_closure_required_for_non_expense;

ALTER TABLE adquisiciones.route_fund_closure_attachments
    ADD CONSTRAINT chk_rfca_fund_closure_required_for_non_expense CHECK (
        attachment_type = 'EXPENSE' OR fund_closure_id IS NOT NULL
    ) NOT VALID;

ALTER TABLE adquisiciones.route_fund_closure_attachments
    DROP CONSTRAINT IF EXISTS chk_rfca_file_type;

ALTER TABLE adquisiciones.route_fund_closure_attachments
    ADD CONSTRAINT chk_rfca_file_type CHECK (
        file_mime_type IS NULL OR file_mime_type IN (
            'application/pdf', 'image/png', 'image/jpeg', 'image/webp'
        )
    ) NOT VALID;

ALTER TABLE adquisiciones.route_fund_closure_attachments
    DROP CONSTRAINT IF EXISTS chk_rfca_file_size;

ALTER TABLE adquisiciones.route_fund_closure_attachments
    ADD CONSTRAINT chk_rfca_file_size CHECK (
        file_size IS NULL OR (file_size > 0 AND file_size <= 10485760)
    ) NOT VALID;

CREATE OR REPLACE FUNCTION adquisiciones.validate_route_fund_closure_attachment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_expense adquisiciones.route_fund_closure_expenses;
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
    ELSIF NEW.fund_closure_id IS NULL THEN
        RAISE EXCEPTION 'Este tipo de comprobante requiere fund_closure_id';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_route_fund_closure_attachment
    ON adquisiciones.route_fund_closure_attachments;

CREATE TRIGGER validate_route_fund_closure_attachment
    BEFORE INSERT OR UPDATE ON adquisiciones.route_fund_closure_attachments
    FOR EACH ROW
    EXECUTE FUNCTION adquisiciones.validate_route_fund_closure_attachment();

COMMENT ON COLUMN adquisiciones.route_fund_closure_attachments.fund_closure_id IS
    'Nullable only for EXPENSE attachments created before the expense is assigned to a fund closure.';

-- Recreate the already deployed settlement read model with expense receipts.
CREATE OR REPLACE FUNCTION adquisiciones.get_route_settlement_detail(
    p_settlement_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_base jsonb;
    v_result jsonb;
    v_expenses jsonb;
    v_total_route_expenses numeric(14,2);
    v_company_id uuid;
    v_workflow_status text;
    v_unresolved integer;
    v_review_required integer;
    v_pending_payment integer;
    v_credit integer;
    v_not_delivered integer;
    v_paid integer;
    v_partial integer;
BEGIN
    v_base := adquisiciones.get_route_settlement_detail_base(p_settlement_id);

    SELECT settlement_row.s->>'workflow_status',
        count(*) FILTER (WHERE COALESCE(i->>'resolved_for_settlement', 'false') <> 'true')::integer,
        count(*) FILTER (WHERE i->>'resolution_type' = 'REVIEW_REQUIRED')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'PENDING_PAYMENT')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'CREDIT')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'NOT_DELIVERED')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'PAID')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'PARTIAL')::integer
    INTO v_workflow_status, v_unresolved, v_review_required, v_pending_payment,
        v_credit, v_not_delivered, v_paid, v_partial
    FROM jsonb_array_elements(v_base->'clients') c
    CROSS JOIN LATERAL jsonb_array_elements(c->'invoices') i
    CROSS JOIN LATERAL (SELECT v_base->'settlement' AS s) settlement_row
    GROUP BY settlement_row.s->>'workflow_status';

    v_unresolved := COALESCE(v_unresolved, 0);
    v_review_required := COALESCE(v_review_required, 0);
    v_pending_payment := COALESCE(v_pending_payment, 0);
    v_credit := COALESCE(v_credit, 0);
    v_not_delivered := COALESCE(v_not_delivered, 0);
    v_paid := COALESCE(v_paid, 0);
    v_partial := COALESCE(v_partial, 0);

    SELECT s.company_id INTO v_company_id
    FROM adquisiciones.route_settlements s WHERE s.id = p_settlement_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', e.id, 'expense_type', e.expense_type, 'amount', e.amount,
        'expense_date', e.expense_date, 'notes', e.notes,
        'custody_user_id', e.custody_user_id, 'custody', e.custody_user_id,
        'created_by', e.created_by, 'status', e.status, 'created_at', e.created_at,
        'voided_at', e.voided_at, 'voided_by', e.voided_by,
        'void_reason', e.void_reason, 'fund_closure_id', e.fund_closure_id,
        'attachments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', a.id, 'attachment_type', a.attachment_type,
                'file_name', a.file_name, 'storage_path', a.storage_path,
                'file_mime_type', a.file_mime_type, 'file_size', a.file_size,
                'uploaded_by', a.uploaded_by, 'uploaded_at', a.uploaded_at,
                'fund_closure_id', a.fund_closure_id
            ) ORDER BY a.uploaded_at, a.id)
            FROM adquisiciones.route_fund_closure_attachments a
            WHERE a.expense_id = e.id AND a.company_id = e.company_id
        ), '[]'::jsonb)
    ) ORDER BY e.expense_date, e.created_at, e.id), '[]'::jsonb),
    COALESCE(sum(e.amount) FILTER (WHERE e.status = 'ACTIVE'), 0)::numeric(14,2)
    INTO v_expenses, v_total_route_expenses
    FROM adquisiciones.route_fund_closure_expenses e
    WHERE e.route_settlement_id = p_settlement_id AND e.company_id = v_company_id;

    v_result := jsonb_set(v_base, '{settlement}', (v_base->'settlement') || jsonb_build_object(
        'can_close', v_unresolved = 0 AND COALESCE(v_workflow_status, '') NOT IN ('CLOSED', 'CANCELLED'),
        'unresolved_invoice_count', v_unresolved, 'review_required_count', v_review_required,
        'pending_payment_count', v_pending_payment, 'credit_count', v_credit,
        'not_delivered_count', v_not_delivered, 'paid_count', v_paid, 'partial_count', v_partial,
        'derived_workflow_status', CASE WHEN v_workflow_status IN ('CLOSED', 'CANCELLED') THEN v_workflow_status
            WHEN v_unresolved = 0 THEN 'READY_TO_CLOSE' ELSE 'IN_PROGRESS' END,
        'derived_financial_result', CASE WHEN v_pending_payment > 0 THEN 'WITH_PENDING' ELSE 'BALANCED' END,
        'blocking_invoices', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'settlement_item_id', (i->>'settlement_item_id')::uuid,
                'invoice_number', i->>'invoice_number',
                'customer_bsale_id', (i->>'customer_bsale_id')::bigint,
                'customer_name', c->>'customer_name',
                'reason', CASE WHEN i->>'resolution_type' = 'REVIEW_REQUIRED' THEN 'Requiere revisión'
                    WHEN i->>'resolution_type' IS NULL THEN 'Factura sin resolución operacional'
                    ELSE 'Factura no resuelta para cierre' END
            ) ORDER BY i->>'invoice_number', i->>'settlement_item_id')
            FROM jsonb_array_elements(v_base->'clients') c
            CROSS JOIN LATERAL jsonb_array_elements(c->'invoices') i
            WHERE COALESCE(i->>'resolved_for_settlement', 'false') <> 'true'
        ), '[]'::jsonb), 'total_route_expenses', v_total_route_expenses
    ));
    v_result := jsonb_set(v_result, '{expenses}', v_expenses);
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_route_settlement_detail(uuid) TO authenticated;
