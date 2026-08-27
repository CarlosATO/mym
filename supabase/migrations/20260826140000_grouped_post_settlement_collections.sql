-- One post-settlement receipt may settle several invoices for the same customer.
-- The payment header keeps a deterministic anchor RR/GR for legacy consumers;
-- every allocation remains authoritative for its own RR, GR and invoice.

ALTER TABLE adquisiciones.post_settlement_payments
    ADD CONSTRAINT uq_post_settlement_payment_company_customer
    UNIQUE (company_id, id, customer_bsale_id);

ALTER TABLE adquisiciones.post_settlement_payment_allocations
    DROP CONSTRAINT post_settlement_payment_alloc_company_id_route_settlement__fkey;
ALTER TABLE adquisiciones.post_settlement_payment_allocations
    ADD CONSTRAINT fk_post_settlement_allocation_payment_customer
    FOREIGN KEY (company_id, payment_id, customer_bsale_id)
    REFERENCES adquisiciones.post_settlement_payments(company_id, id, customer_bsale_id);

CREATE UNIQUE INDEX uq_post_settlement_allocation_active_payment_item
    ON adquisiciones.post_settlement_payment_allocations(payment_id, settlement_item_id)
    WHERE voided_at IS NULL;

CREATE TABLE adquisiciones.post_settlement_grouped_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    customer_bsale_id bigint NOT NULL,
    idempotency_key uuid NOT NULL,
    request_hash text NOT NULL,
    payment_id uuid REFERENCES adquisiciones.post_settlement_payments(id),
    response jsonb,
    created_by uuid NOT NULL REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_post_settlement_grouped_operation UNIQUE (company_id, idempotency_key),
    FOREIGN KEY (company_id, customer_bsale_id)
        REFERENCES integraciones.bsale_clients(company_id, bsale_client_id)
);

REVOKE ALL ON adquisiciones.post_settlement_grouped_operations FROM PUBLIC, anon, authenticated;
GRANT ALL ON adquisiciones.post_settlement_grouped_operations TO service_role;

CREATE OR REPLACE FUNCTION adquisiciones.register_grouped_post_settlement_payment(
    p_customer_bsale_id bigint,
    p_settlement_item_ids uuid[],
    p_payment_method text,
    p_received_at timestamptz,
    p_reference_number text DEFAULT NULL,
    p_bank_name text DEFAULT NULL,
    p_check_number text DEFAULT NULL,
    p_check_date date DEFAULT NULL,
    p_notes text DEFAULT NULL,
    p_idempotency_key uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, integraciones, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_company_ids uuid[];
    v_customer_ids bigint[];
    v_company uuid;
    v_anchor_settlement uuid;
    v_anchor_guide uuid;
    v_item_count integer;
    v_all_closed boolean;
    v_method text := upper(btrim(COALESCE(p_payment_method, '')));
    v_canonical_ids uuid[];
    v_request_hash text;
    v_existing record;
    v_item record;
    v_balance numeric(14,2);
    v_total numeric(14,2) := 0;
    v_payment uuid;
    v_status text := 'CONFIRMED';
    v_response jsonb;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE = '28000';
    END IF;
    IF p_customer_bsale_id IS NULL OR p_idempotency_key IS NULL OR p_received_at IS NULL THEN
        RAISE EXCEPTION 'customer_bsale_id, received_at e idempotency_key son obligatorios.';
    END IF;
    IF p_settlement_item_ids IS NULL OR cardinality(p_settlement_item_ids) = 0 OR array_position(p_settlement_item_ids, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'settlement_item_ids debe ser un arreglo no vacío y sin nulos.';
    END IF;
    IF cardinality(p_settlement_item_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_settlement_item_ids))) THEN
        RAISE EXCEPTION 'settlement_item_ids contiene facturas repetidas.';
    END IF;
    IF v_method NOT IN ('CASH', 'CHECK', 'TRANSFER') THEN
        RAISE EXCEPTION 'Medio de pago no permitido: %.', v_method;
    END IF;
    IF v_method = 'CHECK' AND (NULLIF(btrim(p_bank_name), '') IS NULL OR NULLIF(btrim(p_check_number), '') IS NULL OR p_check_date IS NULL) THEN
        RAISE EXCEPTION 'CHECK requiere banco, número y fecha de cheque.';
    END IF;

    v_canonical_ids := ARRAY(SELECT unnest(p_settlement_item_ids) ORDER BY 1);

    -- Serialize every balance-changing operation for the selected invoices.
    PERFORM 1
    FROM adquisiciones.route_settlement_items si
    WHERE si.id = ANY(v_canonical_ids)
    ORDER BY si.id
    FOR UPDATE;

    SELECT
        count(*)::integer,
        array_agg(DISTINCT si.company_id),
        array_agg(DISTINCT si.customer_bsale_id),
        bool_and(rs.workflow_status = 'CLOSED'),
        (array_agg(si.settlement_id ORDER BY si.id))[1],
        (array_agg(rs.route_guide_id ORDER BY si.id))[1]
    INTO v_item_count, v_company_ids, v_customer_ids, v_all_closed, v_anchor_settlement, v_anchor_guide
    FROM adquisiciones.route_settlement_items si
    JOIN adquisiciones.route_settlements rs
      ON rs.id = si.settlement_id
     AND rs.company_id = si.company_id
    WHERE si.id = ANY(v_canonical_ids);

    IF v_item_count <> cardinality(v_canonical_ids) THEN
        RAISE EXCEPTION 'Una o más facturas no existen.';
    END IF;
    IF cardinality(v_company_ids) <> 1 THEN
        RAISE EXCEPTION 'Las facturas deben pertenecer a la misma empresa.';
    END IF;
    IF cardinality(v_customer_ids) <> 1 OR v_customer_ids[1] IS DISTINCT FROM p_customer_bsale_id THEN
        RAISE EXCEPTION 'Las facturas deben pertenecer al mismo cliente indicado.';
    END IF;
    IF NOT COALESCE(v_all_closed, false) THEN
        RAISE EXCEPTION 'Todas las facturas deben provenir de Rendiciones CLOSED.';
    END IF;

    v_company := v_company_ids[1];
    IF NOT core.has_company_access(v_actor, v_company)
       OR NOT portal.user_has_permission(v_actor, 'adquisiciones.route_settlements.update') THEN
        RAISE EXCEPTION 'No tiene permisos para registrar cobros posteriores.';
    END IF;

    v_request_hash := md5(jsonb_build_object(
        'customer_bsale_id', p_customer_bsale_id,
        'settlement_item_ids', to_jsonb(v_canonical_ids),
        'payment_method', v_method,
        'received_at', p_received_at,
        'reference_number', NULLIF(btrim(p_reference_number), ''),
        'bank_name', NULLIF(btrim(p_bank_name), ''),
        'check_number', NULLIF(btrim(p_check_number), ''),
        'check_date', p_check_date,
        'notes', NULLIF(btrim(p_notes), '')
    )::text);

    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'post-settlement-grouped:' || v_company::text || ':' || p_idempotency_key::text,
        0
    ));

    SELECT * INTO v_existing
    FROM adquisiciones.post_settlement_grouped_operations
    WHERE company_id = v_company AND idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.request_hash <> v_request_hash OR v_existing.customer_bsale_id <> p_customer_bsale_id THEN
            RAISE EXCEPTION 'La idempotency_key ya fue usada con otra solicitud.';
        END IF;
        IF v_existing.response IS NULL THEN
            RAISE EXCEPTION 'La operación idempotente anterior no tiene respuesta.';
        END IF;
        RETURN v_existing.response || jsonb_build_object('replayed', true);
    END IF;

    FOR v_item IN
        SELECT si.id
        FROM adquisiciones.route_settlement_items si
        WHERE si.id = ANY(v_canonical_ids)
        ORDER BY si.id
    LOOP
        v_balance := adquisiciones.current_outstanding_amount(v_item.id);
        IF v_balance IS NULL OR v_balance <= 0 THEN
            RAISE EXCEPTION 'La factura % ya no tiene saldo cobrable.', v_item.id;
        END IF;
        v_total := v_total + v_balance;
    END LOOP;

    INSERT INTO adquisiciones.post_settlement_payments(
        company_id, route_guide_id, route_settlement_id, customer_bsale_id,
        payment_method_received, amount_received, received_at, verification_status,
        reference_number, bank_name, check_number, check_date,
        custody_user_id, custody_received_at, notes, created_by
    ) VALUES (
        v_company, v_anchor_guide, v_anchor_settlement, p_customer_bsale_id,
        v_method, v_total, p_received_at, v_status,
        NULLIF(btrim(p_reference_number), ''), NULLIF(btrim(p_bank_name), ''),
        NULLIF(btrim(p_check_number), ''), p_check_date,
        CASE WHEN v_method IN ('CASH', 'CHECK') THEN v_actor END,
        CASE WHEN v_method IN ('CASH', 'CHECK') THEN now() END,
        NULLIF(btrim(p_notes), ''), v_actor
    ) RETURNING id INTO v_payment;

    INSERT INTO adquisiciones.post_settlement_payment_allocations(
        company_id, route_guide_id, route_settlement_id, payment_id,
        settlement_item_id, guide_item_id, customer_bsale_id,
        amount_applied, created_by
    )
    SELECT
        si.company_id, rs.route_guide_id, si.settlement_id, v_payment,
        si.id, si.route_guide_item_id, si.customer_bsale_id,
        adquisiciones.current_outstanding_amount(si.id), v_actor
    FROM adquisiciones.route_settlement_items si
    JOIN adquisiciones.route_settlements rs ON rs.id = si.settlement_id AND rs.company_id = si.company_id
    WHERE si.id = ANY(v_canonical_ids)
    ORDER BY si.id;

    v_response := jsonb_build_object(
        'success', true,
        'replayed', false,
        'payment_id', v_payment,
        'verification_status', v_status,
        'payment_method', v_method,
        'invoice_count', cardinality(v_canonical_ids),
        'amount_received', v_total,
        'settlement_item_ids', to_jsonb(v_canonical_ids)
    );

    INSERT INTO adquisiciones.post_settlement_grouped_operations(
        company_id, customer_bsale_id, idempotency_key, request_hash,
        payment_id, response, created_by
    ) VALUES (
        v_company, p_customer_bsale_id, p_idempotency_key, v_request_hash,
        v_payment, v_response, v_actor
    );

    INSERT INTO portal.audit_logs(
        schema_name, module_code, table_name, record_id, action, new_data,
        performed_by, event_type, severity
    ) VALUES (
        'adquisiciones', 'ADQUISICIONES', 'post_settlement_payments', v_payment,
        'INSERT', v_response || jsonb_build_object('anchor_settlement_id', v_anchor_settlement),
        v_actor, 'POST_SETTLEMENT_GROUPED_PAYMENT_REGISTERED', 'INFO'
    );

    RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.register_grouped_post_settlement_payment(
    bigint, uuid[], text, timestamptz, text, text, text, date, text, uuid
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.register_grouped_post_settlement_payment(
    bigint, uuid[], text, timestamptz, text, text, text, date, text, uuid
) TO authenticated;

-- A physical payment is claimed once by Fund Closure, regardless of allocations.
DROP INDEX IF EXISTS adquisiciones.idx_route_fund_closure_items_post_payment;
CREATE UNIQUE INDEX idx_route_fund_closure_items_active_post_payment
    ON adquisiciones.route_fund_closure_items(post_settlement_payment_id)
    WHERE post_settlement_payment_id IS NOT NULL AND released_at IS NULL;

CREATE OR REPLACE FUNCTION adquisiciones.create_route_fund_closure_from_mixed_payments(
    p_company_id uuid,
    p_payment_ids uuid[],
    p_post_settlement_payment_ids uuid[],
    p_check_payment_ids uuid[],
    p_cash_delivered numeric,
    p_notes text,
    p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, core, portal
AS $$
DECLARE
    v_route record; v_post record; v_first_custody uuid;
    v_cash numeric := 0; v_checks numeric := 0; v_expenses numeric := 0;
    v_expected numeric; v_difference numeric; v_closure uuid; v_number text;
    v_year integer := extract(year from current_date)::integer; v_sequence integer;
BEGIN
    IF p_user_id IS DISTINCT FROM auth.uid() OR NOT core.has_company_access(auth.uid(), p_company_id) THEN RAISE EXCEPTION 'Usuario o empresa inválidos.'; END IF;
    IF NOT portal.user_has_permission(auth.uid(), 'adquisiciones.route_fund_closures.create') OR NOT portal.user_has_permission(auth.uid(), 'adquisiciones.route_fund_closures.close') THEN RAISE EXCEPTION 'No tiene permisos para crear el Cierre de Fondos.'; END IF;
    IF cardinality(p_payment_ids) IS NULL AND cardinality(p_post_settlement_payment_ids) IS NULL THEN RAISE EXCEPTION 'Debe seleccionar fondos.'; END IF;

    FOR v_route IN SELECT p.*, s.workflow_status FROM adquisiciones.route_settlement_payments p JOIN adquisiciones.route_settlements s ON s.id=p.settlement_id AND s.company_id=p.company_id WHERE p.company_id=p_company_id AND p.id=ANY(COALESCE(p_payment_ids,ARRAY[]::uuid[])) FOR UPDATE OF p LOOP
        IF v_route.verification_status<>'CONFIRMED' OR v_route.voided_at IS NOT NULL OR v_route.payment_method_received NOT IN('CASH','CHECK') OR v_route.workflow_status<>'CLOSED' THEN RAISE EXCEPTION 'Payment de Rendición no elegible.'; END IF;
        IF EXISTS(SELECT 1 FROM adquisiciones.route_fund_closure_items i JOIN adquisiciones.route_fund_closures f ON f.id=i.fund_closure_id WHERE i.payment_id=v_route.id AND i.released_at IS NULL AND f.status<>'CANCELLED') THEN RAISE EXCEPTION 'Payment ya pertenece a un Cierre activo.'; END IF;
        IF v_first_custody IS NULL THEN v_first_custody:=v_route.custody_user_id; ELSIF v_first_custody IS DISTINCT FROM v_route.custody_user_id THEN RAISE EXCEPTION 'No se pueden mezclar custodios.'; END IF;
        IF v_route.custody_user_id IS NULL THEN RAISE EXCEPTION 'Payment sin custodio.'; END IF;
        IF v_route.payment_method_received='CASH' THEN v_cash:=v_cash+v_route.amount_received; ELSE v_checks:=v_checks+v_route.amount_received; END IF;
    END LOOP;

    FOR v_post IN SELECT p.*, s.workflow_status FROM adquisiciones.post_settlement_payments p JOIN adquisiciones.route_settlements s ON s.id=p.route_settlement_id AND s.company_id=p.company_id WHERE p.company_id=p_company_id AND p.id=ANY(COALESCE(p_post_settlement_payment_ids,ARRAY[]::uuid[])) FOR UPDATE OF p LOOP
        IF v_post.verification_status<>'CONFIRMED' OR v_post.voided_at IS NOT NULL OR v_post.payment_method_received NOT IN('CASH','CHECK') OR v_post.workflow_status<>'CLOSED' THEN RAISE EXCEPTION 'Cobro posterior no elegible.'; END IF;
        IF EXISTS(SELECT 1 FROM adquisiciones.route_fund_closure_items i JOIN adquisiciones.route_fund_closures f ON f.id=i.fund_closure_id WHERE i.post_settlement_payment_id=v_post.id AND i.released_at IS NULL AND f.status<>'CANCELLED') THEN RAISE EXCEPTION 'Cobro posterior ya pertenece a un Cierre activo.'; END IF;
        IF v_first_custody IS NULL THEN v_first_custody:=v_post.custody_user_id; ELSIF v_first_custody IS DISTINCT FROM v_post.custody_user_id THEN RAISE EXCEPTION 'No se pueden mezclar custodios.'; END IF;
        IF v_post.custody_user_id IS NULL THEN RAISE EXCEPTION 'Cobro posterior sin custodio.'; END IF;
        IF v_post.payment_method_received='CASH' THEN v_cash:=v_cash+v_post.amount_received; ELSE v_checks:=v_checks+v_post.amount_received; END IF;
    END LOOP;

    IF v_first_custody IS NULL THEN RAISE EXCEPTION 'No se pudo determinar el custodio.'; END IF;
    IF EXISTS(SELECT 1 FROM unnest(COALESCE(p_check_payment_ids,ARRAY[]::uuid[])) x(id) WHERE NOT EXISTS(SELECT 1 FROM adquisiciones.route_settlement_payments p WHERE p.id=x.id AND p.payment_method_received='CHECK' AND p.id=ANY(COALESCE(p_payment_ids,ARRAY[]::uuid[]))) AND NOT EXISTS(SELECT 1 FROM adquisiciones.post_settlement_payments p WHERE p.id=x.id AND p.payment_method_received='CHECK' AND p.id=ANY(COALESCE(p_post_settlement_payment_ids,ARRAY[]::uuid[])))) THEN RAISE EXCEPTION 'Selección de cheques inválida.'; END IF;

    SELECT COALESCE(sum(e.amount),0) INTO v_expenses FROM adquisiciones.route_fund_closure_expenses e WHERE e.company_id=p_company_id AND e.route_settlement_id IN(SELECT settlement_id FROM adquisiciones.route_settlement_payments WHERE id=ANY(COALESCE(p_payment_ids,ARRAY[]::uuid[])) UNION SELECT route_settlement_id FROM adquisiciones.post_settlement_payments WHERE id=ANY(COALESCE(p_post_settlement_payment_ids,ARRAY[]::uuid[]))) AND e.status='ACTIVE' AND e.voided_at IS NULL AND e.fund_closure_id IS NULL;
    v_expected:=v_cash-v_expenses; v_difference:=p_cash_delivered-v_expected;
    IF v_difference<>0 AND COALESCE(length(btrim(p_notes)),0)=0 THEN RAISE EXCEPTION 'Debe explicar la diferencia física.'; END IF;
    v_sequence:=adquisiciones.get_next_route_fund_closure_number(p_company_id,v_year); v_number:='CFC-'||v_year||'-'||lpad(v_sequence::text,6,'0');
    INSERT INTO adquisiciones.route_fund_closures(company_id,closure_number,closure_year,closure_sequence,status,total_cash_received,total_check_received,total_expenses,total_pending,cash_delivered,physical_difference,notes,created_by,closed_by,closed_at,custody_user_id) VALUES(p_company_id,v_number,v_year,v_sequence,CASE WHEN v_difference=0 THEN 'CLOSED' ELSE 'WITH_DIFFERENCE' END,v_cash,v_checks,v_expenses,v_expected+v_checks,p_cash_delivered,v_difference,p_notes,p_user_id,p_user_id,now(),v_first_custody) RETURNING id INTO v_closure;

    FOR v_route IN SELECT p.*, a.settlement_item_id FROM adquisiciones.route_settlement_payments p JOIN LATERAL (SELECT x.settlement_item_id FROM adquisiciones.route_settlement_payment_allocations x WHERE x.payment_id=p.id AND x.voided_at IS NULL ORDER BY x.settlement_item_id LIMIT 1) a ON true WHERE p.id=ANY(COALESCE(p_payment_ids,ARRAY[]::uuid[])) LOOP
        INSERT INTO adquisiciones.route_fund_closure_items(company_id,fund_closure_id,payment_id,source_type,route_settlement_item_id,route_settlement_id,route_guide_id,invoice_number,customer_name,payment_method,amount,custody_user_id,custody_received_at) SELECT p_company_id,v_closure,v_route.id,'ROUTE_SETTLEMENT_PAYMENT',si.id,si.settlement_id,rs.route_guide_id,si.invoice_number,si.customer_name,v_route.payment_method_received,v_route.amount_received,v_route.custody_user_id,v_route.custody_received_at FROM adquisiciones.route_settlement_items si JOIN adquisiciones.route_settlements rs ON rs.id=si.settlement_id WHERE si.id=v_route.settlement_item_id;
    END LOOP;
    FOR v_post IN SELECT p.*, a.settlement_item_id FROM adquisiciones.post_settlement_payments p JOIN LATERAL (SELECT x.settlement_item_id FROM adquisiciones.post_settlement_payment_allocations x WHERE x.payment_id=p.id AND x.voided_at IS NULL ORDER BY x.settlement_item_id LIMIT 1) a ON true WHERE p.id=ANY(COALESCE(p_post_settlement_payment_ids,ARRAY[]::uuid[])) LOOP
        INSERT INTO adquisiciones.route_fund_closure_items(company_id,fund_closure_id,post_settlement_payment_id,source_type,route_settlement_item_id,route_settlement_id,route_guide_id,invoice_number,customer_name,payment_method,amount,custody_user_id,custody_received_at) SELECT p_company_id,v_closure,v_post.id,'POST_SETTLEMENT_PAYMENT',si.id,si.settlement_id,rs.route_guide_id,si.invoice_number,si.customer_name,v_post.payment_method_received,v_post.amount_received,v_post.custody_user_id,v_post.custody_received_at FROM adquisiciones.route_settlement_items si JOIN adquisiciones.route_settlements rs ON rs.id=si.settlement_id WHERE si.id=v_post.settlement_item_id;
    END LOOP;

    UPDATE adquisiciones.route_fund_closure_expenses SET fund_closure_id=v_closure WHERE company_id=p_company_id AND route_settlement_id IN(SELECT settlement_id FROM adquisiciones.route_settlement_payments WHERE id=ANY(COALESCE(p_payment_ids,ARRAY[]::uuid[])) UNION SELECT route_settlement_id FROM adquisiciones.post_settlement_payments WHERE id=ANY(COALESCE(p_post_settlement_payment_ids,ARRAY[]::uuid[]))) AND status='ACTIVE' AND voided_at IS NULL AND fund_closure_id IS NULL;
    RETURN jsonb_build_object('closure_id',v_closure,'closure_number',v_number,'status',CASE WHEN v_difference=0 THEN 'CLOSED' ELSE 'WITH_DIFFERENCE' END,'cash_received',v_cash,'checks_received',v_checks,'expenses',v_expenses);
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.create_route_fund_closure_from_mixed_payments(uuid,uuid[],uuid[],uuid[],numeric,text,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.create_route_fund_closure_from_mixed_payments(uuid,uuid[],uuid[],uuid[],numeric,text,uuid) TO authenticated;
