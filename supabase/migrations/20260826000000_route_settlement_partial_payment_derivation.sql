-- Derive an operational pending-payment state for partially paid invoices.
-- Manual resolutions remain stored on route_settlement_items and are never
-- replaced by this read-model derivation.

ALTER FUNCTION adquisiciones.get_route_settlement_detail(uuid)
    RENAME TO get_route_settlement_detail_with_expenses_base;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail_with_expenses_base(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION adquisiciones.derive_route_settlement_invoice_states(p_base jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
    SELECT jsonb_set(
        p_base,
        '{clients}',
        COALESCE(jsonb_agg(
            c.value || jsonb_build_object(
                'invoices', COALESCE((
                    SELECT jsonb_agg(
                        i.value || jsonb_build_object(
                            'invoice_result', CASE
                                WHEN COALESCE((i.value->>'applied_amount')::numeric, 0) >= COALESCE((i.value->>'expected_amount')::numeric, 0) THEN 'PAID'
                                WHEN NULLIF(i.value->>'resolution_type', '') IS NOT NULL THEN i.value->>'invoice_result'
                                WHEN COALESCE((i.value->>'applied_amount')::numeric, 0) > 0
                                 AND COALESCE((i.value->>'unapplied_amount')::numeric, 0) > 0 THEN 'PENDING_PAYMENT'
                                ELSE i.value->>'invoice_result'
                            END,
                            'resolution_type', CASE
                                WHEN NULLIF(i.value->>'resolution_type', '') IS NOT NULL THEN i.value->>'resolution_type'
                                WHEN COALESCE((i.value->>'applied_amount')::numeric, 0) > 0
                                 AND COALESCE((i.value->>'unapplied_amount')::numeric, 0) > 0 THEN 'PENDING_PAYMENT'
                                ELSE NULL
                            END,
                            'remaining_amount', COALESCE((i.value->>'unapplied_amount')::numeric, 0),
                            'resolution_source', CASE
                                WHEN NULLIF(i.value->>'resolution_type', '') IS NOT NULL THEN 'MANUAL'
                                WHEN COALESCE((i.value->>'applied_amount')::numeric, 0) > 0
                                 AND COALESCE((i.value->>'unapplied_amount')::numeric, 0) > 0 THEN 'DERIVED'
                                ELSE NULL
                            END,
                            'resolved_for_settlement', CASE
                                WHEN COALESCE((i.value->>'applied_amount')::numeric, 0) >= COALESCE((i.value->>'expected_amount')::numeric, 0) THEN true
                                WHEN NULLIF(i.value->>'resolution_type', '') IN ('PENDING_PAYMENT', 'CREDIT', 'NOT_DELIVERED') THEN true
                                WHEN NULLIF(i.value->>'resolution_type', '') IS NULL
                                 AND COALESCE((i.value->>'applied_amount')::numeric, 0) > 0
                                 AND COALESCE((i.value->>'unapplied_amount')::numeric, 0) > 0 THEN true
                                ELSE false
                            END
                        ) ORDER BY i.ordinality
                    )
                    FROM jsonb_array_elements(c.value->'invoices') WITH ORDINALITY AS i(value, ordinality)
                ), '[]'::jsonb)
            ) ORDER BY c.ordinality
        ), '[]'::jsonb)
    )
    FROM jsonb_array_elements(p_base->'clients') WITH ORDINALITY AS c(value, ordinality);
$$;

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
    v_base := adquisiciones.derive_route_settlement_invoice_states(
        adquisiciones.get_route_settlement_detail_with_expenses_base(p_settlement_id)
    );

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

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail(uuid)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_route_settlement_detail(uuid) TO authenticated;

-- Close uses the same derived read-model facts, so a partial payment is a
-- resolved operational situation and does not require a redundant manual step.
CREATE OR REPLACE FUNCTION adquisiciones.close_route_settlement(
    p_settlement_id uuid,
    p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_actor_user_id uuid := auth.uid();
    v_company_id uuid;
    v_workflow_status varchar(30);
    v_legacy_status varchar(30);
    v_settlement_number text;
    v_detail jsonb;
    v_unresolved integer;
    v_review_required integer;
    v_pending_payment integer;
    v_credit integer;
    v_not_delivered integer;
    v_paid integer;
    v_partial integer;
    v_financial_result varchar(30);
    v_old_data jsonb;
BEGIN
    IF v_actor_user_id IS NULL THEN RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE = '28000'; END IF;
    IF p_settlement_id IS NULL OR p_user_id IS NULL THEN RAISE EXCEPTION 'settlement_id y user_id son obligatorios.'; END IF;
    IF p_user_id <> v_actor_user_id THEN RAISE EXCEPTION 'Usuario no coincide.'; END IF;

    SELECT s.company_id, s.workflow_status, s.status, s.settlement_number,
        jsonb_build_object('workflow_status', s.workflow_status, 'financial_result', s.financial_result,
            'closed_by', s.closed_by, 'closed_at', s.closed_at)
    INTO v_company_id, v_workflow_status, v_legacy_status, v_settlement_number, v_old_data
    FROM adquisiciones.route_settlements s WHERE s.id = p_settlement_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Rendición no encontrada.'; END IF;
    IF NOT core.has_company_access(v_actor_user_id, v_company_id) THEN RAISE EXCEPTION 'El usuario no tiene acceso a la empresa de la rendición.'; END IF;
    IF NOT portal.user_has_permission(v_actor_user_id, 'adquisiciones.route_settlements.close') THEN RAISE EXCEPTION 'El usuario no tiene permiso para cerrar rendiciones.'; END IF;
    IF v_workflow_status IN ('CLOSED', 'CANCELLED') OR v_legacy_status IN ('CLOSED', 'CANCELLED') THEN RAISE EXCEPTION 'La rendición ya está cerrada o cancelada.'; END IF;

    v_detail := adquisiciones.get_route_settlement_detail(p_settlement_id);
    SELECT count(*) FILTER (WHERE COALESCE(i->>'resolved_for_settlement', 'false') <> 'true')::integer,
        count(*) FILTER (WHERE i->>'resolution_type' = 'REVIEW_REQUIRED')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'PENDING_PAYMENT')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'CREDIT')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'NOT_DELIVERED')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'PAID')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'PARTIAL')::integer
    INTO v_unresolved, v_review_required, v_pending_payment, v_credit, v_not_delivered, v_paid, v_partial
    FROM jsonb_array_elements(v_detail->'clients') c
    CROSS JOIN LATERAL jsonb_array_elements(c->'invoices') i;
    v_unresolved := COALESCE(v_unresolved, 0);
    v_review_required := COALESCE(v_review_required, 0);
    v_pending_payment := COALESCE(v_pending_payment, 0);
    v_credit := COALESCE(v_credit, 0);
    v_not_delivered := COALESCE(v_not_delivered, 0);
    v_paid := COALESCE(v_paid, 0);
    v_partial := COALESCE(v_partial, 0);
    IF v_unresolved > 0 THEN
        RAISE EXCEPTION 'No se puede cerrar: hay % facturas sin resolver.', v_unresolved
            USING DETAIL = jsonb_build_object('unresolved_invoice_count', v_unresolved, 'review_required_count', v_review_required)::text;
    END IF;
    IF v_review_required > 0 THEN RAISE EXCEPTION 'No se puede cerrar: hay facturas que requieren revisión.'; END IF;

    v_financial_result := CASE WHEN v_pending_payment > 0 THEN 'WITH_PENDING' ELSE 'BALANCED' END;
    UPDATE adquisiciones.route_settlements
    SET workflow_status = 'CLOSED', financial_result = v_financial_result,
        closed_by = v_actor_user_id, closed_at = now(), updated_at = now()
    WHERE id = p_settlement_id AND company_id = v_company_id;
    INSERT INTO portal.audit_logs (
        schema_name, module_code, table_name, record_id, action, old_data, new_data,
        performed_by, event_type, severity
    ) VALUES (
        'adquisiciones', 'ADQUISICIONES', 'route_settlements', p_settlement_id, 'UPDATE', v_old_data,
        jsonb_build_object('workflow_status', 'CLOSED', 'financial_result', v_financial_result,
            'closed_by', v_actor_user_id, 'closed_at', now(), 'unresolved_invoice_count', v_unresolved,
            'review_required_count', v_review_required, 'pending_payment_count', v_pending_payment,
            'credit_count', v_credit, 'not_delivered_count', v_not_delivered, 'paid_count', v_paid,
            'partial_count', v_partial), v_actor_user_id, 'ROUTE_SETTLEMENT_CLOSED', 'INFO'
    );
    RETURN jsonb_build_object('success', true, 'settlement_id', p_settlement_id,
        'settlement_number', v_settlement_number, 'workflow_status', 'CLOSED',
        'financial_result', v_financial_result, 'closed_by', v_actor_user_id,
        'unresolved_invoice_count', v_unresolved, 'review_required_count', v_review_required,
        'pending_payment_count', v_pending_payment, 'credit_count', v_credit,
        'not_delivered_count', v_not_delivered, 'paid_count', v_paid, 'partial_count', v_partial);
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.close_route_settlement(uuid, uuid)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.close_route_settlement(uuid, uuid) TO authenticated;
