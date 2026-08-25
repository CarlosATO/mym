-- Definitive close contract for the payment/allocation/resolution model.
-- Legacy status, received amounts and difference columns are not close facts.

-- Keep the existing detail computation as an internal base and expose the
-- readiness facts from one read RPC without duplicating the invoice joins.
ALTER FUNCTION adquisiciones.get_route_settlement_detail(uuid)
    RENAME TO get_route_settlement_detail_base;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail_base(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

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
    v_workflow_status text;
    v_financial_result text;
    v_unresolved integer;
    v_review_required integer;
    v_pending_payment integer;
    v_credit integer;
    v_not_delivered integer;
    v_paid integer;
    v_partial integer;
BEGIN
    v_base := adquisiciones.get_route_settlement_detail_base(p_settlement_id);

    SELECT
        settlement_row.s->>'workflow_status',
        count(*) FILTER (WHERE COALESCE(i->>'resolved_for_settlement', 'false') <> 'true')::integer,
        count(*) FILTER (WHERE i->>'resolution_type' = 'REVIEW_REQUIRED')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'PENDING_PAYMENT')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'CREDIT')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'NOT_DELIVERED')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'PAID')::integer,
        count(*) FILTER (WHERE i->>'invoice_result' = 'PARTIAL')::integer
    INTO
        v_workflow_status,
        v_unresolved,
        v_review_required,
        v_pending_payment,
        v_credit,
        v_not_delivered,
        v_paid,
        v_partial
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
    v_financial_result := CASE WHEN v_pending_payment > 0 THEN 'WITH_PENDING' ELSE 'BALANCED' END;

    v_result := jsonb_set(
        v_base,
        '{settlement}',
        (v_base->'settlement') || jsonb_build_object(
            'can_close', v_unresolved = 0
                AND COALESCE(v_workflow_status, '') NOT IN ('CLOSED', 'CANCELLED'),
            'unresolved_invoice_count', v_unresolved,
            'review_required_count', v_review_required,
            'pending_payment_count', v_pending_payment,
            'credit_count', v_credit,
            'not_delivered_count', v_not_delivered,
            'paid_count', v_paid,
            'partial_count', v_partial,
            'derived_workflow_status', CASE
                WHEN v_workflow_status IN ('CLOSED', 'CANCELLED') THEN v_workflow_status
                WHEN v_unresolved = 0 THEN 'READY_TO_CLOSE'
                ELSE 'IN_PROGRESS'
            END,
            'derived_financial_result', v_financial_result,
            'blocking_invoices', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'settlement_item_id', (i->>'settlement_item_id')::uuid,
                    'invoice_number', i->>'invoice_number',
                    'customer_bsale_id', (i->>'customer_bsale_id')::bigint,
                    'customer_name', c->>'customer_name',
                    'reason', CASE
                        WHEN i->>'resolution_type' = 'REVIEW_REQUIRED' THEN 'Requiere revisión'
                        WHEN i->>'resolution_type' IS NULL THEN 'Factura sin resolución operacional'
                        ELSE 'Factura no resuelta para cierre'
                    END
                ) ORDER BY i->>'invoice_number', i->>'settlement_item_id')
                FROM jsonb_array_elements(v_base->'clients') c
                CROSS JOIN LATERAL jsonb_array_elements(c->'invoices') i
                WHERE COALESCE(i->>'resolved_for_settlement', 'false') <> 'true'
            ), '[]'::jsonb)
        )
    );

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail(uuid)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_route_settlement_detail(uuid) TO authenticated;

COMMENT ON FUNCTION adquisiciones.get_route_settlement_detail(uuid) IS
    'Read model for route settlement facts, operational close readiness and blocking invoices.';

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
    IF v_actor_user_id IS NULL THEN
        RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE = '28000';
    END IF;
    IF p_settlement_id IS NULL OR p_user_id IS NULL THEN
        RAISE EXCEPTION 'settlement_id y user_id son obligatorios.';
    END IF;
    IF p_user_id <> v_actor_user_id THEN
        RAISE EXCEPTION 'Usuario no coincide.';
    END IF;

    -- This row lock serializes close against payment/resolution RPCs.
    SELECT s.company_id, s.workflow_status, s.status, s.settlement_number,
           jsonb_build_object(
               'workflow_status', s.workflow_status,
               'financial_result', s.financial_result,
               'closed_by', s.closed_by,
               'closed_at', s.closed_at
           )
    INTO v_company_id, v_workflow_status, v_legacy_status, v_settlement_number, v_old_data
    FROM adquisiciones.route_settlements s
    WHERE s.id = p_settlement_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rendición no encontrada.';
    END IF;
    IF NOT core.has_company_access(v_actor_user_id, v_company_id) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa de la rendición.';
    END IF;
    IF NOT portal.user_has_permission(v_actor_user_id, 'adquisiciones.route_settlements.close') THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para cerrar rendiciones.';
    END IF;
    IF v_workflow_status IN ('CLOSED', 'CANCELLED') OR v_legacy_status IN ('CLOSED', 'CANCELLED') THEN
        RAISE EXCEPTION 'La rendición ya está cerrada o cancelada.';
    END IF;

    SELECT
        count(*) FILTER (WHERE NOT f.resolved_for_settlement)::integer,
        count(*) FILTER (WHERE f.resolution_type = 'REVIEW_REQUIRED')::integer,
        count(*) FILTER (WHERE f.invoice_result = 'PENDING_PAYMENT')::integer,
        count(*) FILTER (WHERE f.invoice_result = 'CREDIT')::integer,
        count(*) FILTER (WHERE f.invoice_result = 'NOT_DELIVERED')::integer,
        count(*) FILTER (WHERE f.invoice_result = 'PAID')::integer,
        count(*) FILTER (WHERE f.invoice_result = 'PARTIAL')::integer
    INTO
        v_unresolved,
        v_review_required,
        v_pending_payment,
        v_credit,
        v_not_delivered,
        v_paid,
        v_partial
    FROM (
        SELECT si.resolution_type,
               COALESCE(active.applied_amount, 0)::numeric(14,2) AS applied_amount,
               si.expected_amount,
               CASE
                   WHEN COALESCE(active.applied_amount, 0) >= si.expected_amount THEN 'PAID'
                   WHEN si.resolution_type = 'PENDING_PAYMENT' THEN 'PENDING_PAYMENT'
                   WHEN si.resolution_type = 'CREDIT' THEN 'CREDIT'
                   WHEN si.resolution_type = 'NOT_DELIVERED' THEN 'NOT_DELIVERED'
                   WHEN si.resolution_type = 'REVIEW_REQUIRED' THEN 'REVIEW_REQUIRED'
                   WHEN COALESCE(active.applied_amount, 0) > 0 THEN 'PARTIAL'
                   ELSE 'PENDING'
               END AS invoice_result,
               CASE
                   WHEN COALESCE(active.applied_amount, 0) >= si.expected_amount THEN true
                   WHEN si.resolution_type IN ('PENDING_PAYMENT', 'CREDIT', 'NOT_DELIVERED') THEN true
                   ELSE false
               END AS resolved_for_settlement
        FROM adquisiciones.route_settlement_items si
        LEFT JOIN LATERAL (
            SELECT sum(a.amount_applied) AS applied_amount
            FROM adquisiciones.route_settlement_payment_allocations a
            JOIN adquisiciones.route_settlement_payments p
              ON p.id = a.payment_id
             AND p.company_id = a.company_id
             AND p.settlement_id = a.settlement_id
             AND p.customer_bsale_id = a.customer_bsale_id
            WHERE a.company_id = si.company_id
              AND a.settlement_id = si.settlement_id
              AND a.settlement_item_id = si.id
              AND a.voided_at IS NULL
              AND p.verification_status <> 'VOIDED'
        ) active ON true
        WHERE si.company_id = v_company_id
          AND si.settlement_id = p_settlement_id
    ) f;

    v_unresolved := COALESCE(v_unresolved, 0);
    v_review_required := COALESCE(v_review_required, 0);
    v_pending_payment := COALESCE(v_pending_payment, 0);
    v_credit := COALESCE(v_credit, 0);
    v_not_delivered := COALESCE(v_not_delivered, 0);
    v_paid := COALESCE(v_paid, 0);
    v_partial := COALESCE(v_partial, 0);

    IF v_unresolved > 0 THEN
        RAISE EXCEPTION 'No se puede cerrar: hay % facturas sin resolver.', v_unresolved
            USING DETAIL = jsonb_build_object(
                'unresolved_invoice_count', v_unresolved,
                'review_required_count', v_review_required
            )::text;
    END IF;
    IF v_review_required > 0 THEN
        RAISE EXCEPTION 'No se puede cerrar: hay facturas que requieren revisión.';
    END IF;

    -- WITH_DIFFERENCE is intentionally not produced: the new model has no
    -- explicit non-pending difference fact independent of legacy columns.
    v_financial_result := CASE WHEN v_pending_payment > 0 THEN 'WITH_PENDING' ELSE 'BALANCED' END;

    UPDATE adquisiciones.route_settlements
    SET workflow_status = 'CLOSED',
        financial_result = v_financial_result,
        closed_by = v_actor_user_id,
        closed_at = now(),
        updated_at = now()
    WHERE id = p_settlement_id
      AND company_id = v_company_id;

    INSERT INTO portal.audit_logs (
        schema_name, module_code, table_name, record_id, action,
        old_data, new_data, performed_by, event_type, severity
    ) VALUES (
        'adquisiciones', 'ADQUISICIONES', 'route_settlements', p_settlement_id, 'UPDATE',
        v_old_data,
        jsonb_build_object(
            'workflow_status', 'CLOSED',
            'financial_result', v_financial_result,
            'closed_by', v_actor_user_id,
            'closed_at', now(),
            'unresolved_invoice_count', v_unresolved,
            'review_required_count', v_review_required,
            'pending_payment_count', v_pending_payment,
            'credit_count', v_credit,
            'not_delivered_count', v_not_delivered,
            'paid_count', v_paid,
            'partial_count', v_partial
        ),
        v_actor_user_id, 'ROUTE_SETTLEMENT_CLOSED', 'INFO'
    );

    RETURN jsonb_build_object(
        'success', true,
        'settlement_id', p_settlement_id,
        'settlement_number', v_settlement_number,
        'workflow_status', 'CLOSED',
        'financial_result', v_financial_result,
        'closed_by', v_actor_user_id,
        'unresolved_invoice_count', v_unresolved,
        'review_required_count', v_review_required,
        'pending_payment_count', v_pending_payment,
        'credit_count', v_credit,
        'not_delivered_count', v_not_delivered,
        'paid_count', v_paid,
        'partial_count', v_partial
    );
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.close_route_settlement(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.close_route_settlement(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION adquisiciones.close_route_settlement(uuid, uuid) IS
    'Atomically closes a route settlement only when every invoice is resolved by active payment or explicit operational resolution.';

-- Prevent legacy item edits after a formal new-model close. Payment and
-- resolution RPCs already reject CLOSED; this closes the remaining ordinary
-- update path without introducing an admin bypass or a reopen path.
CREATE OR REPLACE FUNCTION adquisiciones.prevent_closed_route_settlement_item_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM adquisiciones.route_settlements s
        WHERE s.id = COALESCE(NEW.settlement_id, OLD.settlement_id)
          AND s.workflow_status = 'CLOSED'
    ) THEN
        RAISE EXCEPTION 'La rendición está cerrada y no permite modificaciones ordinarias.';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_closed_route_settlement_item_mutation
    ON adquisiciones.route_settlement_items;
CREATE TRIGGER trg_prevent_closed_route_settlement_item_mutation
    BEFORE UPDATE OR DELETE ON adquisiciones.route_settlement_items
    FOR EACH ROW
    EXECUTE FUNCTION adquisiciones.prevent_closed_route_settlement_item_mutation();

REVOKE ALL ON FUNCTION adquisiciones.prevent_closed_route_settlement_item_mutation()
    FROM PUBLIC, anon, authenticated, service_role;
