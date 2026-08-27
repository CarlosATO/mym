-- Atomic fast-path recording for multiple settlement invoices.
-- The detailed payment flow remains the source of truth for partial/special cases.

CREATE TABLE IF NOT EXISTS adquisiciones.route_settlement_bulk_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    settlement_id uuid NOT NULL REFERENCES adquisiciones.route_settlements(id) ON DELETE CASCADE,
    idempotency_key uuid NOT NULL,
    request_hash text NOT NULL,
    response jsonb,
    created_by uuid NOT NULL REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_route_settlement_bulk_operation UNIQUE (company_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION adquisiciones.record_route_settlement_bulk(
    p_settlement_id uuid,
    p_idempotency_key uuid,
    p_rows jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, integraciones, core, portal
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_company uuid;
    v_guide uuid;
    v_status text;
    v_workflow_status text;
    v_request_hash text;
    v_existing record;
    v_row jsonb;
    v_item_id uuid;
    v_result text;
    v_group_key text;
    v_amount numeric(14,2);
    v_expected numeric(14,2);
    v_confirmed numeric(14,2);
    v_pending numeric(14,2);
    v_customer bigint;
    v_payment_method text;
    v_bank text;
    v_check_number text;
    v_check_date date;
    v_payment_id uuid;
    v_group record;
    v_group_amount numeric(14,2);
    v_group_bank text;
    v_group_check_number text;
    v_group_check_date date;
    v_cash_count integer := 0;
    v_check_count integer := 0;
    v_transfer_count integer := 0;
    v_credit_count integer := 0;
    v_cash_amount numeric(14,2) := 0;
    v_check_amount numeric(14,2) := 0;
    v_transfer_amount numeric(14,2) := 0;
    v_credit_amount numeric(14,2) := 0;
    v_processed integer := 0;
    v_payment_ids uuid[] := ARRAY[]::uuid[];
    v_response jsonb;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE = '28000'; END IF;
    IF p_settlement_id IS NULL OR p_idempotency_key IS NULL THEN RAISE EXCEPTION 'settlement_id e idempotency_key son obligatorios.'; END IF;
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN RAISE EXCEPTION 'rows debe ser un arreglo no vacío.'; END IF;

    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended('route-settlement-bulk:' || p_settlement_id::text || ':' || p_idempotency_key::text, 0));
    v_request_hash := md5(p_rows::text);

    SELECT * INTO v_existing
    FROM adquisiciones.route_settlement_bulk_operations
    WHERE idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.request_hash <> v_request_hash OR v_existing.settlement_id <> p_settlement_id THEN
            RAISE EXCEPTION 'La idempotency_key ya fue usada con otro lote.';
        END IF;
        IF v_existing.response IS NULL THEN RAISE EXCEPTION 'El lote idempotente anterior no tiene respuesta.'; END IF;
        RETURN v_existing.response || jsonb_build_object('replayed', true);
    END IF;

    SELECT s.company_id, s.route_guide_id, s.status, s.workflow_status
    INTO v_company, v_guide, v_status, v_workflow_status
    FROM adquisiciones.route_settlements s
    WHERE s.id = p_settlement_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Rendición no encontrada.'; END IF;
    IF NOT core.has_company_access(v_actor, v_company) THEN RAISE EXCEPTION 'El usuario no tiene acceso a la empresa de la rendición.'; END IF;
    IF NOT portal.user_has_permission(v_actor, 'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'El usuario no tiene permiso para actualizar rendiciones.'; END IF;
    IF v_status IN ('CLOSED', 'CANCELLED') OR v_workflow_status IN ('CLOSED', 'CANCELLED') THEN RAISE EXCEPTION 'La rendición está cerrada o cancelada.'; END IF;

    CREATE TEMP TABLE bulk_rows (
        item_id uuid NOT NULL,
        result text NOT NULL,
        amount numeric(14,2) NOT NULL,
        group_key text NOT NULL,
        customer_id bigint NOT NULL,
        bank_name text,
        check_number text,
        check_date date
    ) ON COMMIT DROP;

    FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
        v_item_id := NULLIF(v_row->>'settlement_item_id', '')::uuid;
        v_result := upper(NULLIF(btrim(v_row->>'result'), ''));
        v_amount := NULLIF(v_row->>'amount', '')::numeric(14,2);
        IF v_item_id IS NULL OR v_result IS NULL OR v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'Cada fila requiere settlement_item_id, result y amount mayor que cero.'; END IF;
        IF v_result NOT IN ('CASH', 'CHECK', 'TRANSFER', 'CREDIT') THEN RAISE EXCEPTION 'Resultado no permitido: %.', v_result; END IF;
        v_group_key := COALESCE(NULLIF(btrim(v_row->>'payment_group_key'), ''), v_item_id::text);
        v_bank := NULLIF(btrim(COALESCE(v_row->'metadata'->>'bank_name', v_row->>'bank_name')), '');
        v_check_number := NULLIF(btrim(COALESCE(v_row->'metadata'->>'check_number', v_row->>'check_number')), '');
        v_check_date := NULLIF(COALESCE(v_row->'metadata'->>'check_date', v_row->>'check_date'), '')::date;
        SELECT si.customer_bsale_id INTO v_customer
        FROM adquisiciones.route_settlement_items si
        JOIN logistica.route_guide_items gi ON gi.id = si.route_guide_item_id AND gi.route_guide_id = v_guide AND gi.company_id = v_company
        WHERE si.id = v_item_id AND si.company_id = v_company AND si.settlement_id = p_settlement_id
        FOR UPDATE;
        IF NOT FOUND OR v_customer IS NULL THEN RAISE EXCEPTION 'La factura % no pertenece a la rendición.', v_item_id; END IF;
        INSERT INTO bulk_rows VALUES (v_item_id, v_result, v_amount, v_group_key, v_customer, v_bank, v_check_number, v_check_date);
    END LOOP;

    IF EXISTS (SELECT 1 FROM bulk_rows GROUP BY item_id HAVING count(*) > 1) THEN RAISE EXCEPTION 'La selección contiene facturas repetidas.'; END IF;
    IF EXISTS (SELECT 1 FROM bulk_rows a JOIN bulk_rows b ON a.group_key = b.group_key AND a.customer_id <> b.customer_id) THEN RAISE EXCEPTION 'Un payment_group_key no puede mezclar clientes.'; END IF;
    IF EXISTS (SELECT 1 FROM bulk_rows a JOIN bulk_rows b ON a.group_key = b.group_key AND a.result <> b.result) THEN RAISE EXCEPTION 'Un payment_group_key no puede mezclar resultados.'; END IF;
    IF EXISTS (SELECT 1 FROM bulk_rows WHERE result = 'CHECK' AND (bank_name IS NULL OR check_number IS NULL OR check_date IS NULL)) THEN RAISE EXCEPTION 'Cada grupo CHECK requiere banco, número y fecha de cheque.'; END IF;
    IF EXISTS (SELECT 1 FROM bulk_rows a JOIN bulk_rows b ON a.group_key=b.group_key AND (a.bank_name,b.check_number,b.check_date) IS DISTINCT FROM (b.bank_name,b.check_number,b.check_date)) THEN RAISE EXCEPTION 'Los datos del cheque deben coincidir dentro de un mismo grupo.'; END IF;

    FOR v_row IN SELECT to_jsonb(r) FROM bulk_rows r ORDER BY item_id LOOP
        v_item_id := (v_row->>'item_id')::uuid;
        v_result := v_row->>'result';
        v_amount := (v_row->>'amount')::numeric;
        SELECT si.expected_amount, si.customer_bsale_id, COALESCE(si.resolution_type, '')
        INTO v_expected, v_customer, v_payment_method
        FROM adquisiciones.route_settlement_items si WHERE si.id=v_item_id AND si.settlement_id=p_settlement_id FOR UPDATE;
        SELECT COALESCE(sum(a.amount_applied) FILTER (WHERE p.verification_status='CONFIRMED'),0), COALESCE(sum(a.amount_applied) FILTER (WHERE p.verification_status='PENDING' AND p.payment_method_received='TRANSFER'),0)
        INTO v_confirmed, v_pending
        FROM adquisiciones.route_settlement_payment_allocations a JOIN adquisiciones.route_settlement_payments p ON p.id=a.payment_id AND p.company_id=a.company_id
        WHERE a.company_id=v_company AND a.settlement_id=p_settlement_id AND a.settlement_item_id=v_item_id AND a.voided_at IS NULL;
        IF v_payment_method <> '' OR v_confirmed > 0 OR v_pending > 0 THEN RAISE EXCEPTION 'La factura % ya fue procesada.', v_item_id; END IF;
        IF v_amount > v_expected - v_confirmed THEN RAISE EXCEPTION 'El monto de la factura % supera su saldo vigente.', v_item_id; END IF;
        IF v_result = 'CREDIT' AND v_amount <> v_expected - v_confirmed THEN RAISE EXCEPTION 'CREDIT debe cubrir el saldo completo de la factura %.', v_item_id; END IF;
    END LOOP;

    FOR v_group IN SELECT group_key, customer_id, result, min(bank_name) bank_name, min(check_number) check_number, min(check_date) check_date, sum(amount) amount FROM bulk_rows GROUP BY group_key, customer_id, result LOOP
        IF v_group.result = 'CREDIT' THEN
            UPDATE adquisiciones.route_settlement_items SET resolution_type='CREDIT', resolution_notes='Aplicado mediante grabación masiva', resolved_by=v_actor, resolved_at=now() WHERE id IN (SELECT item_id FROM bulk_rows WHERE group_key=v_group.group_key);
            v_credit_count := v_credit_count + (SELECT count(*) FROM bulk_rows WHERE group_key=v_group.group_key); v_credit_amount := v_credit_amount + v_group.amount;
        ELSE
            v_payment_method := CASE WHEN v_group.result='TRANSFER' THEN 'TRANSFER' ELSE v_group.result END;
            INSERT INTO adquisiciones.route_settlement_payments(company_id, settlement_id, customer_bsale_id, payment_method_received, amount_received, received_at, verification_status, bank_name, check_number, check_date, notes, custody_user_id, custody_received_at, created_by)
            VALUES(v_company,p_settlement_id,v_group.customer_id,v_payment_method,v_group.amount,now(),CASE WHEN v_group.result='TRANSFER' THEN 'PENDING' ELSE 'CONFIRMED' END,v_group.bank_name,v_group.check_number,v_group.check_date,CASE WHEN v_group.result='TRANSFER' THEN 'Transferencia por revisar' ELSE 'Grabación masiva' END,CASE WHEN v_group.result IN ('CASH','CHECK') THEN v_actor END,CASE WHEN v_group.result IN ('CASH','CHECK') THEN now() END,v_actor) RETURNING id INTO v_payment_id;
            v_payment_ids := array_append(v_payment_ids, v_payment_id);
            FOR v_row IN SELECT to_jsonb(r) FROM bulk_rows r WHERE r.group_key=v_group.group_key ORDER BY item_id LOOP
                INSERT INTO adquisiciones.route_settlement_payment_allocations(company_id, settlement_id, payment_id, settlement_item_id, customer_bsale_id, amount_applied, created_by)
                VALUES(v_company,p_settlement_id,v_payment_id,(v_row->>'item_id')::uuid,v_group.customer_id,(v_row->>'amount')::numeric,v_actor);
            END LOOP;
            IF v_group.result='CASH' THEN v_cash_count := v_cash_count + (SELECT count(*) FROM bulk_rows WHERE group_key=v_group.group_key); v_cash_amount := v_cash_amount + v_group.amount;
            ELSIF v_group.result='CHECK' THEN v_check_count := v_check_count + (SELECT count(*) FROM bulk_rows WHERE group_key=v_group.group_key); v_check_amount := v_check_amount + v_group.amount;
            ELSE v_transfer_count := v_transfer_count + (SELECT count(*) FROM bulk_rows WHERE group_key=v_group.group_key); v_transfer_amount := v_transfer_amount + v_group.amount; END IF;
        END IF;
    END LOOP;
    v_processed := v_cash_count + v_check_count + v_transfer_count + v_credit_count;
    v_response := jsonb_build_object('success',true,'replayed',false,'processed_count',v_processed,'cash_count',v_cash_count,'cash_amount',v_cash_amount,'check_count',v_check_count,'check_amount',v_check_amount,'transfer_pending_count',v_transfer_count,'transfer_pending_amount',v_transfer_amount,'credit_count',v_credit_count,'credit_amount',v_credit_amount,'payment_ids',to_jsonb(v_payment_ids));
    INSERT INTO adquisiciones.route_settlement_bulk_operations(company_id,settlement_id,idempotency_key,request_hash,response,created_by) VALUES(v_company,p_settlement_id,p_idempotency_key,v_request_hash,v_response,v_actor);
    INSERT INTO portal.audit_logs(schema_name,module_code,table_name,record_id,action,new_data,performed_by,event_type,severity) VALUES('adquisiciones','ADQUISICIONES','route_settlements',p_settlement_id,'BULK_RECORD',v_response,v_actor,'ROUTE_SETTLEMENT_BULK_RECORDED','INFO');
    RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.record_route_settlement_bulk(uuid, uuid, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.record_route_settlement_bulk(uuid, uuid, jsonb) TO authenticated;
