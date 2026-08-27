-- Bulk TRANSFER review and explicit verification lifecycle.
-- PENDING transfer allocations are visible evidence, but are not financial coverage.

ALTER FUNCTION adquisiciones.get_route_settlement_detail(uuid)
    RENAME TO get_route_settlement_detail_transfer_base;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail_transfer_base(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION adquisiciones.get_route_settlement_detail(
    p_settlement_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, integraciones, core, portal
AS $$
DECLARE
    v_base jsonb;
    v_result jsonb;
BEGIN
    v_base := adquisiciones.get_route_settlement_detail_transfer_base(p_settlement_id);

    WITH client_rows AS (
        SELECT c.ordinality AS client_ordinality, c.value AS client,
            COALESCE((
                SELECT jsonb_agg(
                    i.value || jsonb_build_object(
                        'applied_amount', x.confirmed_amount,
                        'pending_amount', GREATEST((i.value->>'expected_amount')::numeric - x.confirmed_amount, 0),
                        'unapplied_amount', GREATEST((i.value->>'expected_amount')::numeric - x.confirmed_amount, 0),
                        'result', CASE WHEN x.confirmed_amount >= (i.value->>'expected_amount')::numeric THEN 'PAID'
                                       WHEN x.confirmed_amount > 0 THEN 'PARTIAL' ELSE 'PENDING' END,
                        'invoice_result', CASE
                            WHEN x.confirmed_amount >= (i.value->>'expected_amount')::numeric THEN 'PAID'
                            WHEN i.value->>'resolution_type' IS NOT NULL THEN i.value->>'invoice_result'
                            WHEN x.confirmed_amount > 0 THEN 'PENDING_PAYMENT' ELSE 'PENDING' END,
                        'remaining_amount', GREATEST((i.value->>'expected_amount')::numeric - x.confirmed_amount, 0),
                        'resolved_for_settlement', CASE
                            WHEN x.confirmed_amount >= (i.value->>'expected_amount')::numeric THEN true
                            WHEN i.value->>'resolution_type' IN ('PENDING_PAYMENT','CREDIT','NOT_DELIVERED') THEN true
                            WHEN i.value->>'resolution_type' IS NULL AND x.confirmed_amount > 0
                                 AND x.confirmed_amount < (i.value->>'expected_amount')::numeric THEN true
                            ELSE false END
                    ) ORDER BY i.ordinality
                )
                FROM jsonb_array_elements(c.value->'invoices') WITH ORDINALITY i(value, ordinality)
                LEFT JOIN LATERAL (
                    SELECT COALESCE(sum((a.value->>'amount_applied')::numeric), 0)::numeric(14,2) AS confirmed_amount
                    FROM jsonb_array_elements(c.value->'payments') p(value)
                    CROSS JOIN LATERAL jsonb_array_elements(p.value->'allocations') a(value)
                    WHERE p.value->>'verification_status' = 'CONFIRMED'
                      AND a.value->>'voided_at' IS NULL
                      AND a.value->>'settlement_item_id' = i.value->>'settlement_item_id'
                ) x ON true
            ), '[]'::jsonb) AS invoices,
            COALESCE((
                SELECT jsonb_agg(
                    p.value || jsonb_build_object(
                        'amount_applied', CASE WHEN p.value->>'verification_status' = 'CONFIRMED' THEN COALESCE((p.value->>'amount_applied')::numeric, 0) ELSE 0 END,
                        'unallocated_amount', CASE WHEN p.value->>'verification_status' = 'CONFIRMED' THEN COALESCE((p.value->>'unallocated_amount')::numeric, 0) ELSE (p.value->>'amount_received')::numeric END
                    ) ORDER BY p.ordinality
                )
                FROM jsonb_array_elements(c.value->'payments') WITH ORDINALITY p(value, ordinality)
            ), '[]'::jsonb) AS payments
        FROM jsonb_array_elements(v_base->'clients') WITH ORDINALITY c(value, ordinality)
    ), transformed_clients AS (
        SELECT client_ordinality, client || jsonb_build_object('invoices', invoices, 'payments', payments) AS client
        FROM client_rows
    ), client_rollup AS (
        SELECT client_ordinality, client,
            (SELECT COALESCE(sum((i->>'expected_amount')::numeric), 0) FROM jsonb_array_elements(client->'invoices') i) AS expected_amount,
            (SELECT COALESCE(sum((i->>'applied_amount')::numeric), 0) FROM jsonb_array_elements(client->'invoices') i) AS applied_amount,
            (SELECT COALESCE(sum((i->>'unapplied_amount')::numeric), 0) FROM jsonb_array_elements(client->'invoices') i) AS pending_amount,
            (SELECT count(*) FILTER (WHERE i->>'resolved_for_settlement' = 'true') FROM jsonb_array_elements(client->'invoices') i) AS resolved_count,
            (SELECT count(*) FILTER (WHERE COALESCE(i->>'resolved_for_settlement','false') <> 'true') FROM jsonb_array_elements(client->'invoices') i) AS unresolved_count,
            (SELECT count(*) FILTER (WHERE i->>'resolution_type' = 'REVIEW_REQUIRED') FROM jsonb_array_elements(client->'invoices') i) AS review_count
        FROM transformed_clients
    ), final_clients AS (
        SELECT jsonb_agg(
            client || jsonb_build_object(
                'expected_amount', expected_amount, 'applied_amount', applied_amount,
                'pending_amount', pending_amount, 'resolved_invoice_count', resolved_count,
                'unresolved_invoice_count', unresolved_count, 'review_required_count', review_count,
                'status', CASE WHEN applied_amount = 0 THEN 'PENDING'
                               WHEN applied_amount < expected_amount THEN 'PARTIAL' ELSE 'PAID' END
            ) ORDER BY client_ordinality
        ) AS clients,
        COALESCE(sum(expected_amount), 0) AS total_expected,
        COALESCE(sum(applied_amount), 0) AS total_applied,
        COALESCE(sum(pending_amount), 0) AS total_pending,
        COALESCE(sum(resolved_count), 0)::integer AS resolved_count,
        COALESCE(sum(unresolved_count), 0)::integer AS unresolved_count,
        COALESCE(sum(review_count), 0)::integer AS review_count
        FROM client_rollup
    )
    SELECT jsonb_set(
        jsonb_set(v_base, '{clients}', f.clients),
        '{settlement}',
        (v_base->'settlement') || jsonb_build_object(
            'total_expected', f.total_expected, 'total_applied_new', f.total_applied,
            'total_pending_new', f.total_pending, 'resolved_invoice_count', f.resolved_count,
            'unresolved_invoice_count', f.unresolved_count, 'review_required_count', f.review_count,
            'paid_count', (SELECT count(*) FROM jsonb_array_elements(f.clients) c CROSS JOIN LATERAL jsonb_array_elements(c->'invoices') i WHERE i->>'invoice_result' = 'PAID'),
            'partial_count', (SELECT count(*) FROM jsonb_array_elements(f.clients) c CROSS JOIN LATERAL jsonb_array_elements(c->'invoices') i WHERE i->>'invoice_result' = 'PARTIAL'),
            'pending_payment_count', (SELECT count(*) FROM jsonb_array_elements(f.clients) c CROSS JOIN LATERAL jsonb_array_elements(c->'invoices') i WHERE i->>'invoice_result' = 'PENDING_PAYMENT'),
            'can_close', f.unresolved_count = 0 AND COALESCE(v_base->'settlement'->>'workflow_status','') NOT IN ('CLOSED','CANCELLED'),
            'derived_workflow_status', CASE
                WHEN v_base->'settlement'->>'workflow_status' IN ('CLOSED','CANCELLED') THEN v_base->'settlement'->>'workflow_status'
                WHEN f.unresolved_count = 0 THEN 'READY_TO_CLOSE' ELSE 'IN_PROGRESS' END,
            'derived_financial_result', CASE WHEN f.total_pending > 0 THEN 'WITH_PENDING' ELSE 'BALANCED' END
        )
    ) INTO v_result
    FROM final_clients f;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail(uuid)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_route_settlement_detail(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION adquisiciones.mark_route_settlement_transfer_review(
    p_settlement_id uuid,
    p_customer_bsale_id bigint,
    p_settlement_item_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_company uuid;
    v_route_guide uuid;
    v_payment uuid;
    v_amount numeric(14,2);
    v_item uuid;
    v_expected numeric(14,2);
    v_existing numeric(14,2);
    v_created boolean := false;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE = '28000'; END IF;
    IF p_settlement_id IS NULL OR p_customer_bsale_id IS NULL OR cardinality(p_settlement_item_ids) IS NULL OR cardinality(p_settlement_item_ids) = 0 THEN
        RAISE EXCEPTION 'Rendición, cliente y facturas son obligatorios.';
    END IF;
    IF cardinality(p_settlement_item_ids) <> (SELECT count(DISTINCT id) FROM unnest(p_settlement_item_ids) x(id)) THEN
        RAISE EXCEPTION 'La selección contiene facturas repetidas.';
    END IF;
    SELECT s.company_id, s.route_guide_id INTO v_company, v_route_guide FROM adquisiciones.route_settlements s WHERE s.id = p_settlement_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Rendición no encontrada.'; END IF;
    IF NOT core.has_company_access(v_actor, v_company) OR NOT portal.user_has_permission(v_actor, 'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'No tiene permisos para actualizar rendiciones.'; END IF;
    IF EXISTS (SELECT 1 FROM adquisiciones.route_settlements s WHERE s.id = p_settlement_id AND (s.status IN ('CLOSED','CANCELLED') OR s.workflow_status IN ('CLOSED','CANCELLED'))) THEN RAISE EXCEPTION 'La rendición está cerrada o cancelada.'; END IF;
    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended('route-transfer-review:' || p_settlement_id::text || ':' || p_customer_bsale_id::text, 0));

    SELECT COALESCE(sum(a.amount_applied), 0) INTO v_existing
    FROM adquisiciones.route_settlement_payment_allocations a JOIN adquisiciones.route_settlement_payments p ON p.id = a.payment_id
    WHERE a.company_id = v_company AND a.settlement_id = p_settlement_id AND a.customer_bsale_id = p_customer_bsale_id
      AND a.settlement_item_id = ANY(p_settlement_item_ids) AND a.voided_at IS NULL AND p.payment_method_received = 'TRANSFER' AND p.verification_status = 'PENDING';

    SELECT COALESCE(sum(si.expected_amount - COALESCE(covered.confirmed,0) - COALESCE(pending.marked,0)), 0)::numeric(14,2)
    INTO v_amount
    FROM adquisiciones.route_settlement_items si
    LEFT JOIN LATERAL (SELECT sum(a.amount_applied) confirmed FROM adquisiciones.route_settlement_payment_allocations a JOIN adquisiciones.route_settlement_payments p ON p.id = a.payment_id WHERE a.settlement_item_id=si.id AND a.voided_at IS NULL AND p.verification_status='CONFIRMED') covered ON true
    LEFT JOIN LATERAL (SELECT sum(a.amount_applied) marked FROM adquisiciones.route_settlement_payment_allocations a JOIN adquisiciones.route_settlement_payments p ON p.id = a.payment_id WHERE a.settlement_item_id=si.id AND a.voided_at IS NULL AND p.payment_method_received='TRANSFER' AND p.verification_status='PENDING') pending ON true
    WHERE si.company_id=v_company AND si.settlement_id=p_settlement_id AND si.customer_bsale_id=p_customer_bsale_id AND si.id=ANY(p_settlement_item_ids)
      AND si.expected_payment_method='TRANSFER' AND si.resolution_type IS NULL
      AND si.expected_amount > COALESCE(covered.confirmed,0) + COALESCE(pending.marked,0);
    IF v_amount <= 0 THEN RETURN jsonb_build_object('success',true,'replayed',true,'created',false,'payment_id',NULL,'amount',0); END IF;

    SELECT p.id INTO v_payment FROM adquisiciones.route_settlement_payments p WHERE p.company_id=v_company AND p.settlement_id=p_settlement_id AND p.customer_bsale_id=p_customer_bsale_id AND p.payment_method_received='TRANSFER' AND p.verification_status='PENDING' AND p.voided_at IS NULL ORDER BY p.created_at LIMIT 1 FOR UPDATE;
    IF v_payment IS NULL THEN
        INSERT INTO adquisiciones.route_settlement_payments(company_id,settlement_id,customer_bsale_id,payment_method_received,amount_received,received_at,verification_status,notes,created_by)
        VALUES(v_company,p_settlement_id,p_customer_bsale_id,'TRANSFER',v_amount,now(),'PENDING','Transferencia por revisar',v_actor) RETURNING id INTO v_payment;
        v_created := true;
    ELSE
        UPDATE adquisiciones.route_settlement_payments SET amount_received=amount_received+v_amount, updated_by=v_actor WHERE id=v_payment;
    END IF;
    FOR v_item IN SELECT id FROM adquisiciones.route_settlement_items WHERE company_id=v_company AND settlement_id=p_settlement_id AND customer_bsale_id=p_customer_bsale_id AND id=ANY(p_settlement_item_ids) AND expected_payment_method='TRANSFER' AND resolution_type IS NULL LOOP
        SELECT expected_amount INTO v_expected FROM adquisiciones.route_settlement_items WHERE id=v_item;
        SELECT v_expected - COALESCE(sum(a.amount_applied),0) INTO v_expected FROM adquisiciones.route_settlement_payment_allocations a JOIN adquisiciones.route_settlement_payments p ON p.id=a.payment_id WHERE a.settlement_item_id=v_item AND a.voided_at IS NULL AND (p.verification_status='PENDING' AND p.id=v_payment OR p.verification_status='CONFIRMED');
        IF v_expected > 0 THEN INSERT INTO adquisiciones.route_settlement_payment_allocations(company_id,settlement_id,payment_id,settlement_item_id,customer_bsale_id,amount_applied,created_by) VALUES(v_company,p_settlement_id,v_payment,v_item,p_customer_bsale_id,v_expected,v_actor); END IF;
    END LOOP;
    RETURN jsonb_build_object('success',true,'replayed',NOT v_created,'created',v_created,'payment_id',v_payment,'amount',v_amount,'verification_status','PENDING');
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.mark_route_settlement_transfer_review(uuid,bigint,uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.mark_route_settlement_transfer_review(uuid,bigint,uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION adquisiciones.confirm_route_settlement_transfer(p_payment_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, adquisiciones, core, portal AS $$
DECLARE v_actor uuid:=auth.uid(); v_payment adquisiciones.route_settlement_payments%ROWTYPE;
BEGIN
 SELECT * INTO v_payment FROM adquisiciones.route_settlement_payments WHERE id=p_payment_id FOR UPDATE;
 IF NOT FOUND OR v_payment.payment_method_received <> 'TRANSFER' OR v_payment.verification_status <> 'PENDING' THEN RAISE EXCEPTION 'Sólo una transferencia PENDING puede confirmarse.'; END IF;
 IF NOT core.has_company_access(v_actor,v_payment.company_id) OR NOT portal.user_has_permission(v_actor,'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'No tiene permisos para confirmar la transferencia.'; END IF;
 UPDATE adquisiciones.route_settlement_payments SET verification_status='CONFIRMED',updated_by=v_actor WHERE id=p_payment_id;
 RETURN jsonb_build_object('success',true,'payment_id',p_payment_id,'verification_status','CONFIRMED');
END; $$;
REVOKE ALL ON FUNCTION adquisiciones.confirm_route_settlement_transfer(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.confirm_route_settlement_transfer(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION adquisiciones.reject_route_settlement_transfer(p_payment_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, adquisiciones, core, portal AS $$
DECLARE v_actor uuid:=auth.uid(); v_payment adquisiciones.route_settlement_payments%ROWTYPE;
BEGIN
 IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'El motivo de rechazo es obligatorio.'; END IF;
 SELECT * INTO v_payment FROM adquisiciones.route_settlement_payments WHERE id=p_payment_id FOR UPDATE;
 IF NOT FOUND OR v_payment.payment_method_received <> 'TRANSFER' OR v_payment.verification_status <> 'PENDING' THEN RAISE EXCEPTION 'Sólo una transferencia PENDING puede rechazarse.'; END IF;
 IF NOT core.has_company_access(v_actor,v_payment.company_id) OR NOT portal.user_has_permission(v_actor,'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'No tiene permisos para rechazar la transferencia.'; END IF;
 UPDATE adquisiciones.route_settlement_payment_allocations SET voided_at=now(),voided_by=v_actor,void_reason=btrim(p_reason) WHERE payment_id=p_payment_id AND voided_at IS NULL;
 UPDATE adquisiciones.route_settlement_payments SET verification_status='REJECTED',updated_by=v_actor,notes=btrim(p_reason) WHERE id=p_payment_id;
 RETURN jsonb_build_object('success',true,'payment_id',p_payment_id,'verification_status','REJECTED');
END; $$;
REVOKE ALL ON FUNCTION adquisiciones.reject_route_settlement_transfer(uuid,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.reject_route_settlement_transfer(uuid,text) TO authenticated;
