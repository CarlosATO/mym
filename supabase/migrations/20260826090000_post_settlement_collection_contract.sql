-- Collections received after a route settlement was closed.
-- These facts are deliberately separate from route_settlement_payments so a
-- historical settlement remains an immutable snapshot.

CREATE TABLE adquisiciones.post_settlement_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    route_guide_id uuid NOT NULL,
    route_settlement_id uuid NOT NULL,
    customer_bsale_id bigint NOT NULL,
    payment_method_received varchar(30) NOT NULL CHECK (payment_method_received IN ('CASH','TRANSFER','CHECK')),
    amount_received numeric(14,2) NOT NULL CHECK (amount_received > 0),
    received_at timestamptz NOT NULL,
    verification_status varchar(20) NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','CONFIRMED','REJECTED','VOIDED')),
    reference_number text,
    bank_name text,
    check_number text,
    check_date date,
    custody_user_id uuid REFERENCES portal.users(id),
    custody_received_at timestamptz,
    notes text,
    created_by uuid NOT NULL REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    voided_by uuid REFERENCES portal.users(id),
    voided_at timestamptz,
    void_reason text,
    FOREIGN KEY (company_id, route_settlement_id) REFERENCES adquisiciones.route_settlements(company_id, id),
    FOREIGN KEY (company_id, customer_bsale_id) REFERENCES integraciones.bsale_clients(company_id, bsale_client_id),
    CONSTRAINT uq_post_settlement_payment_scope UNIQUE (company_id, route_settlement_id, id, customer_bsale_id),
    CONSTRAINT chk_post_collection_void_state CHECK ((verification_status = 'VOIDED' AND voided_at IS NOT NULL) OR (verification_status <> 'VOIDED' AND voided_at IS NULL))
);

CREATE TABLE adquisiciones.post_settlement_payment_allocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    route_guide_id uuid NOT NULL,
    route_settlement_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    settlement_item_id uuid NOT NULL,
    guide_item_id uuid NOT NULL,
    customer_bsale_id bigint NOT NULL,
    amount_applied numeric(14,2) NOT NULL CHECK (amount_applied > 0),
    created_by uuid NOT NULL REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    voided_by uuid REFERENCES portal.users(id),
    voided_at timestamptz,
    void_reason text,
    FOREIGN KEY (company_id, route_settlement_id, payment_id, customer_bsale_id) REFERENCES adquisiciones.post_settlement_payments(company_id, route_settlement_id, id, customer_bsale_id),
    FOREIGN KEY (company_id, route_settlement_id, settlement_item_id, customer_bsale_id) REFERENCES adquisiciones.route_settlement_items(company_id, settlement_id, id, customer_bsale_id),
    CONSTRAINT chk_post_collection_allocation_void_state CHECK (voided_at IS NULL OR voided_by IS NOT NULL)
);

CREATE INDEX idx_post_settlement_payments_invoice ON adquisiciones.post_settlement_payment_allocations(company_id, settlement_item_id) WHERE voided_at IS NULL;
CREATE INDEX idx_post_settlement_payments_customer ON adquisiciones.post_settlement_payments(company_id, route_settlement_id, customer_bsale_id);
CREATE TRIGGER update_post_settlement_payments_updated_at BEFORE UPDATE ON adquisiciones.post_settlement_payments FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
ALTER TABLE adquisiciones.post_settlement_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE adquisiciones.post_settlement_payment_allocations ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON adquisiciones.post_settlement_payments, adquisiciones.post_settlement_payment_allocations TO authenticated;
GRANT ALL ON adquisiciones.post_settlement_payments, adquisiciones.post_settlement_payment_allocations TO service_role;
CREATE POLICY post_settlement_payments_select ON adquisiciones.post_settlement_payments FOR SELECT USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY post_settlement_allocations_select ON adquisiciones.post_settlement_payment_allocations FOR SELECT USING (core.has_company_access(auth.uid(), company_id));

CREATE OR REPLACE FUNCTION adquisiciones.current_outstanding_amount(p_settlement_item_id uuid)
RETURNS numeric(14,2) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones AS $$
    SELECT GREATEST(si.expected_amount
        - COALESCE((SELECT sum(a.amount_applied) FROM adquisiciones.route_settlement_payment_allocations a JOIN adquisiciones.route_settlement_payments p ON p.id=a.payment_id AND p.company_id=a.company_id WHERE a.settlement_item_id=si.id AND a.voided_at IS NULL AND p.verification_status='CONFIRMED' AND p.voided_at IS NULL),0)
        - COALESCE((SELECT sum(a.amount_applied) FROM adquisiciones.post_settlement_payment_allocations a JOIN adquisiciones.post_settlement_payments p ON p.id=a.payment_id AND p.company_id=a.company_id WHERE a.settlement_item_id=si.id AND a.voided_at IS NULL AND p.verification_status='CONFIRMED' AND p.voided_at IS NULL),0), 0)::numeric(14,2)
    FROM adquisiciones.route_settlement_items si WHERE si.id=p_settlement_item_id;
$$;

CREATE OR REPLACE FUNCTION adquisiciones.register_post_settlement_payment(
    p_route_settlement_id uuid, p_customer_bsale_id bigint, p_payment_method_received text,
    p_amount_received numeric, p_received_at timestamptz, p_verification_status text DEFAULT 'CONFIRMED',
    p_reference_number text DEFAULT NULL, p_bank_name text DEFAULT NULL, p_check_number text DEFAULT NULL,
    p_check_date date DEFAULT NULL, p_custody_user_id uuid DEFAULT NULL, p_notes text DEFAULT NULL,
    p_allocations jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, integraciones, core, portal AS $$
DECLARE
    v_actor uuid:=auth.uid(); v_company uuid; v_guide uuid; v_status text; v_item uuid; v_amount numeric(14,2); v_available numeric(14,2); v_total numeric(14,2):=0; v_payment uuid; v_alloc jsonb;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE='28000'; END IF;
    IF p_payment_method_received NOT IN ('CASH','TRANSFER','CHECK') OR p_verification_status NOT IN ('PENDING','CONFIRMED') OR p_amount_received <= 0 OR jsonb_typeof(p_allocations)<>'array' THEN RAISE EXCEPTION 'Datos de cobro posterior inválidos.'; END IF;
    SELECT s.company_id,s.route_guide_id,s.workflow_status INTO v_company,v_guide,v_status FROM adquisiciones.route_settlements s WHERE s.id=p_route_settlement_id FOR UPDATE;
    IF NOT FOUND OR v_status <> 'CLOSED' THEN RAISE EXCEPTION 'Sólo una Rendición CLOSED acepta cobros posteriores.'; END IF;
    IF NOT core.has_company_access(v_actor,v_company) OR NOT portal.user_has_permission(v_actor,'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'No tiene permisos para registrar cobros posteriores.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM integraciones.bsale_clients WHERE company_id=v_company AND bsale_client_id=p_customer_bsale_id) THEN RAISE EXCEPTION 'Cliente inválido para la empresa.'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_allocations) x(settlement_item_id uuid,amount_applied numeric) GROUP BY settlement_item_id HAVING settlement_item_id IS NULL OR count(*)>1) THEN RAISE EXCEPTION 'Allocations repetidas o inválidas.'; END IF;
    FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations) LOOP
        v_item:=(v_alloc->>'settlement_item_id')::uuid; v_amount:=(v_alloc->>'amount_applied')::numeric;
        SELECT adquisiciones.current_outstanding_amount(si.id) INTO v_available FROM adquisiciones.route_settlement_items si WHERE si.id=v_item AND si.company_id=v_company AND si.settlement_id=p_route_settlement_id AND si.customer_bsale_id=p_customer_bsale_id FOR UPDATE;
        IF v_available IS NULL THEN RAISE EXCEPTION 'Factura no pertenece a la Rendición, empresa o cliente.'; END IF;
        IF v_amount IS NULL OR v_amount<=0 OR v_amount>v_available THEN RAISE EXCEPTION 'El cobro supera el saldo actual de la factura.'; END IF;
        v_total:=v_total+v_amount;
    END LOOP;
    IF v_total<>p_amount_received THEN RAISE EXCEPTION 'La suma de allocations debe igualar el monto recibido.'; END IF;
    INSERT INTO adquisiciones.post_settlement_payments(company_id,route_guide_id,route_settlement_id,customer_bsale_id,payment_method_received,amount_received,received_at,verification_status,reference_number,bank_name,check_number,check_date,custody_user_id,custody_received_at,notes,created_by)
    VALUES(v_company,v_guide,p_route_settlement_id,p_customer_bsale_id,p_payment_method_received,p_amount_received,p_received_at,p_verification_status,NULLIF(p_reference_number,''),NULLIF(p_bank_name,''),NULLIF(p_check_number,''),p_check_date,CASE WHEN p_payment_method_received IN ('CASH','CHECK') THEN COALESCE(p_custody_user_id,v_actor) END,CASE WHEN p_payment_method_received IN ('CASH','CHECK') THEN now() END,p_notes,v_actor) RETURNING id INTO v_payment;
    FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations) LOOP
        v_item:=(v_alloc->>'settlement_item_id')::uuid; v_amount:=(v_alloc->>'amount_applied')::numeric;
        INSERT INTO adquisiciones.post_settlement_payment_allocations(company_id,route_guide_id,route_settlement_id,payment_id,settlement_item_id,guide_item_id,customer_bsale_id,amount_applied,created_by)
        SELECT v_company,v_guide,p_route_settlement_id,v_payment,si.id,si.route_guide_item_id,p_customer_bsale_id,v_amount,v_actor FROM adquisiciones.route_settlement_items si WHERE si.id=v_item;
    END LOOP;
    INSERT INTO portal.audit_logs(schema_name,module_code,table_name,record_id,action,new_data,performed_by,event_type,severity) VALUES('adquisiciones','ADQUISICIONES','post_settlement_payments',v_payment,'INSERT',jsonb_build_object('route_settlement_id',p_route_settlement_id,'customer_bsale_id',p_customer_bsale_id,'amount_received',p_amount_received,'verification_status',p_verification_status),v_actor,'POST_SETTLEMENT_PAYMENT_REGISTERED','INFO');
    RETURN jsonb_build_object('success',true,'payment_id',v_payment,'verification_status',p_verification_status,'amount_received',p_amount_received);
END; $$;

CREATE OR REPLACE FUNCTION adquisiciones.confirm_post_settlement_payment(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,adquisiciones,core,portal AS $$
DECLARE v_actor uuid:=auth.uid(); v_payment record; v_item record; v_balance numeric; v_applied numeric;
BEGIN
    SELECT p.*,s.workflow_status INTO v_payment FROM adquisiciones.post_settlement_payments p JOIN adquisiciones.route_settlements s ON s.id=p.route_settlement_id AND s.company_id=p.company_id WHERE p.id=p_payment_id FOR UPDATE;
    IF NOT FOUND OR v_payment.verification_status<>'PENDING' THEN RAISE EXCEPTION 'Sólo un cobro posterior PENDING puede confirmarse.'; END IF;
    IF NOT core.has_company_access(v_actor,v_payment.company_id) OR NOT portal.user_has_permission(v_actor,'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'No tiene permisos.'; END IF;
    FOR v_item IN SELECT settlement_item_id,amount_applied FROM adquisiciones.post_settlement_payment_allocations WHERE payment_id=p_payment_id AND voided_at IS NULL FOR UPDATE LOOP
        v_balance:=adquisiciones.current_outstanding_amount(v_item.settlement_item_id);
        IF v_item.amount_applied>v_balance THEN RAISE EXCEPTION 'La confirmación supera el saldo financiero actual; requiere revisión.'; END IF;
    END LOOP;
    UPDATE adquisiciones.post_settlement_payments SET verification_status='CONFIRMED',updated_by=v_actor WHERE id=p_payment_id;
    RETURN jsonb_build_object('success',true,'payment_id',p_payment_id,'verification_status','CONFIRMED');
END; $$;

CREATE OR REPLACE FUNCTION adquisiciones.void_post_settlement_payment(p_payment_id uuid,p_void_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,adquisiciones,core,portal AS $$
DECLARE v_actor uuid:=auth.uid(); v_payment record;
BEGIN
    IF NULLIF(btrim(p_void_reason),'') IS NULL THEN RAISE EXCEPTION 'El motivo de anulación es obligatorio.'; END IF;
    SELECT * INTO v_payment FROM adquisiciones.post_settlement_payments WHERE id=p_payment_id FOR UPDATE;
    IF NOT FOUND OR v_payment.verification_status='VOIDED' THEN RAISE EXCEPTION 'Cobro posterior inválido o ya anulado.'; END IF;
    IF NOT core.has_company_access(v_actor,v_payment.company_id) OR NOT portal.user_has_permission(v_actor,'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'No tiene permisos.'; END IF;
    UPDATE adquisiciones.post_settlement_payment_allocations SET voided_at=now(),voided_by=v_actor,void_reason=btrim(p_void_reason) WHERE payment_id=p_payment_id AND voided_at IS NULL;
    UPDATE adquisiciones.post_settlement_payments SET verification_status='VOIDED',voided_at=now(),voided_by=v_actor,void_reason=btrim(p_void_reason),updated_by=v_actor WHERE id=p_payment_id;
    RETURN jsonb_build_object('success',true,'payment_id',p_payment_id,'verification_status','VOIDED');
END; $$;

CREATE OR REPLACE FUNCTION adquisiciones.get_current_receivable_by_invoice(p_settlement_item_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,adquisiciones AS $$
WITH item AS (SELECT si.id,si.expected_amount,si.invoice_number,si.customer_bsale_id,si.settlement_id,si.route_guide_item_id FROM adquisiciones.route_settlement_items si WHERE si.id=$1),
rr AS (SELECT COALESCE(sum(a.amount_applied),0) amount FROM item i LEFT JOIN adquisiciones.route_settlement_payment_allocations a ON a.settlement_item_id=i.id AND a.voided_at IS NULL LEFT JOIN adquisiciones.route_settlement_payments p ON p.id=a.payment_id AND p.verification_status='CONFIRMED' AND p.voided_at IS NULL),
post AS (SELECT COALESCE(sum(a.amount_applied),0) amount FROM item i LEFT JOIN adquisiciones.post_settlement_payment_allocations a ON a.settlement_item_id=i.id AND a.voided_at IS NULL LEFT JOIN adquisiciones.post_settlement_payments p ON p.id=a.payment_id AND p.verification_status='CONFIRMED' AND p.voided_at IS NULL),
history AS (SELECT COALESCE(jsonb_agg(jsonb_build_object('payment_id',p.id,'payment_method_received',p.payment_method_received,'amount_received',p.amount_received,'amount_applied',a.amount_applied,'received_at',p.received_at,'custody_user_id',p.custody_user_id,'verification_status',p.verification_status,'voided_at',p.voided_at) ORDER BY p.received_at,p.id),'[]'::jsonb) payments FROM adquisiciones.post_settlement_payment_allocations a JOIN adquisiciones.post_settlement_payments p ON p.id=a.payment_id WHERE a.settlement_item_id=$1)
SELECT jsonb_build_object('settlement_item_id',i.id,'invoice_number',i.invoice_number,'original_amount',i.expected_amount,'during_settlement_confirmed',rr.amount,'post_settlement_confirmed',post.amount,'current_outstanding_amount',GREATEST(i.expected_amount-rr.amount-post.amount,0),'post_settlement_history',history.payments) FROM item i CROSS JOIN rr CROSS JOIN post CROSS JOIN history;
$$;

REVOKE ALL ON FUNCTION adquisiciones.current_outstanding_amount(uuid),adquisiciones.register_post_settlement_payment(uuid,bigint,text,numeric,timestamptz,text,text,text,text,date,uuid,text,jsonb),adquisiciones.confirm_post_settlement_payment(uuid),adquisiciones.void_post_settlement_payment(uuid,text),adquisiciones.get_current_receivable_by_invoice(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.current_outstanding_amount(uuid),adquisiciones.register_post_settlement_payment(uuid,bigint,text,numeric,timestamptz,text,text,text,text,date,uuid,text,jsonb),adquisiciones.confirm_post_settlement_payment(uuid),adquisiciones.void_post_settlement_payment(uuid,text),adquisiciones.get_current_receivable_by_invoice(uuid) TO authenticated;

-- A pending in-route transfer cannot be confirmed after a later collection has
-- consumed the balance.
CREATE OR REPLACE FUNCTION adquisiciones.confirm_route_settlement_transfer(p_payment_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,adquisiciones,core,portal AS $$
DECLARE v_actor uuid:=auth.uid(); v_payment record; v_item record; v_expected numeric; v_confirmed numeric;
BEGIN
    SELECT p.* INTO v_payment FROM adquisiciones.route_settlement_payments p WHERE p.id=p_payment_id FOR UPDATE;
    IF NOT FOUND OR v_payment.payment_method_received<>'TRANSFER' OR v_payment.verification_status<>'PENDING' THEN RAISE EXCEPTION 'Sólo una transferencia PENDING puede confirmarse.'; END IF;
    IF NOT core.has_company_access(v_actor,v_payment.company_id) OR NOT portal.user_has_permission(v_actor,'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'No tiene permisos para confirmar la transferencia.'; END IF;
    FOR v_item IN SELECT settlement_item_id,amount_applied FROM adquisiciones.route_settlement_payment_allocations WHERE payment_id=p_payment_id AND voided_at IS NULL FOR UPDATE LOOP
        SELECT si.expected_amount INTO v_expected FROM adquisiciones.route_settlement_items si WHERE si.id=v_item.settlement_item_id FOR UPDATE;
        SELECT COALESCE(sum(a.amount_applied),0) INTO v_confirmed FROM adquisiciones.route_settlement_payment_allocations a JOIN adquisiciones.route_settlement_payments p ON p.id=a.payment_id WHERE a.settlement_item_id=v_item.settlement_item_id AND a.voided_at IS NULL AND p.verification_status='CONFIRMED' AND p.voided_at IS NULL AND p.id<>p_payment_id;
        SELECT v_confirmed + COALESCE(sum(a.amount_applied),0) INTO v_confirmed FROM adquisiciones.post_settlement_payment_allocations a JOIN adquisiciones.post_settlement_payments p ON p.id=a.payment_id WHERE a.settlement_item_id=v_item.settlement_item_id AND a.voided_at IS NULL AND p.verification_status='CONFIRMED' AND p.voided_at IS NULL;
        IF v_confirmed + v_item.amount_applied > v_expected THEN RAISE EXCEPTION 'La confirmación supera el saldo financiero actual; requiere revisión.'; END IF;
    END LOOP;
    UPDATE adquisiciones.route_settlement_payments SET verification_status='CONFIRMED',updated_by=v_actor WHERE id=p_payment_id;
    RETURN jsonb_build_object('success',true,'payment_id',p_payment_id,'verification_status','CONFIRMED');
END; $$;
GRANT EXECUTE ON FUNCTION adquisiciones.confirm_route_settlement_transfer(uuid) TO authenticated;
