-- Include confirmed physical post-settlement collections in pending funds and
-- mixed fund closures. No route settlement fact is updated by this contract.

DROP INDEX IF EXISTS adquisiciones.idx_route_fund_closure_items_active_post_payment;
DROP INDEX IF EXISTS adquisiciones.idx_route_fund_closures_active_legacy_item;
CREATE UNIQUE INDEX idx_route_fund_closures_active_legacy_item
    ON adquisiciones.route_fund_closure_items (route_settlement_item_id)
    WHERE released_at IS NULL AND payment_id IS NULL AND post_settlement_payment_id IS NULL;
ALTER TABLE adquisiciones.route_fund_closure_items
    ADD COLUMN IF NOT EXISTS source_type varchar(40);
UPDATE adquisiciones.route_fund_closure_items
SET source_type = CASE WHEN post_settlement_payment_id IS NULL THEN 'ROUTE_SETTLEMENT_PAYMENT' ELSE 'POST_SETTLEMENT_PAYMENT' END
WHERE source_type IS NULL;
ALTER TABLE adquisiciones.route_fund_closure_items
    DROP CONSTRAINT IF EXISTS chk_route_fund_closure_item_source_type;
ALTER TABLE adquisiciones.route_fund_closure_items
    ADD CONSTRAINT chk_route_fund_closure_item_source_type
    CHECK (source_type IS NULL OR source_type IN ('ROUTE_SETTLEMENT_PAYMENT','POST_SETTLEMENT_PAYMENT'));
CREATE OR REPLACE FUNCTION adquisiciones.set_route_fund_closure_item_source_type()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,adquisiciones AS $$
BEGIN
    IF NEW.source_type IS NULL THEN
        NEW.source_type := CASE WHEN NEW.post_settlement_payment_id IS NULL THEN 'ROUTE_SETTLEMENT_PAYMENT' ELSE 'POST_SETTLEMENT_PAYMENT' END;
    END IF;
    RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_set_route_fund_closure_item_source_type ON adquisiciones.route_fund_closure_items;
CREATE TRIGGER trg_set_route_fund_closure_item_source_type
BEFORE INSERT OR UPDATE OF payment_id, post_settlement_payment_id, source_type
ON adquisiciones.route_fund_closure_items FOR EACH ROW
EXECUTE FUNCTION adquisiciones.set_route_fund_closure_item_source_type();
CREATE INDEX IF NOT EXISTS idx_route_fund_closure_items_post_payment
    ON adquisiciones.route_fund_closure_items (post_settlement_payment_id)
    WHERE post_settlement_payment_id IS NOT NULL AND released_at IS NULL;

CREATE OR REPLACE FUNCTION adquisiciones.get_pending_route_fund_groups(p_company_id uuid)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, adquisiciones, logistica, integraciones AS $$
WITH physical AS (
    SELECT p.id payment_id, NULL::uuid post_payment_id, p.settlement_id, p.customer_bsale_id, p.payment_method_received, p.amount_received, p.custody_user_id, p.custody_received_at, p.received_at
    FROM adquisiciones.route_settlement_payments p JOIN adquisiciones.route_settlements s ON s.id=p.settlement_id AND s.company_id=p.company_id AND s.workflow_status='CLOSED'
    WHERE p.company_id=p_company_id AND p.verification_status='CONFIRMED' AND p.voided_at IS NULL AND p.payment_method_received IN ('CASH','CHECK')
      AND NOT EXISTS (SELECT 1 FROM adquisiciones.route_fund_closure_items i JOIN adquisiciones.route_fund_closures f ON f.id=i.fund_closure_id WHERE i.payment_id=p.id AND i.released_at IS NULL AND f.status<>'CANCELLED')
    UNION ALL
    SELECT NULL::uuid, p.id, p.route_settlement_id, p.customer_bsale_id, p.payment_method_received, p.amount_received, p.custody_user_id, p.custody_received_at, p.received_at
    FROM adquisiciones.post_settlement_payments p JOIN adquisiciones.route_settlements s ON s.id=p.route_settlement_id AND s.company_id=p.company_id AND s.workflow_status='CLOSED'
    WHERE p.company_id=p_company_id AND p.verification_status='CONFIRMED' AND p.voided_at IS NULL AND p.payment_method_received IN ('CASH','CHECK')
      AND NOT EXISTS (SELECT 1 FROM adquisiciones.route_fund_closure_items i JOIN adquisiciones.route_fund_closures f ON f.id=i.fund_closure_id WHERE i.post_settlement_payment_id=p.id AND i.released_at IS NULL AND f.status<>'CANCELLED')
), grouped AS (
    SELECT p.settlement_id,s.settlement_number,s.settlement_date,s.route_guide_id,g.guide_number,p.custody_user_id,max(p.custody_received_at) custody_received_at,
      sum(p.amount_received) FILTER(WHERE p.payment_method_received='CASH') cash_received,sum(p.amount_received) FILTER(WHERE p.payment_method_received='CHECK') checks_received,count(*) FILTER(WHERE p.payment_method_received='CHECK')::integer check_count,
      jsonb_agg(p.payment_id) FILTER(WHERE p.payment_id IS NOT NULL) payment_ids,jsonb_agg(p.post_payment_id) FILTER(WHERE p.post_payment_id IS NOT NULL) post_settlement_payment_ids,
      jsonb_agg(jsonb_build_object('source_type',CASE WHEN p.post_payment_id IS NULL THEN 'ROUTE_SETTLEMENT_PAYMENT' ELSE 'POST_SETTLEMENT_PAYMENT' END,'payment_id',p.payment_id,'post_settlement_payment_id',p.post_payment_id,'customer_bsale_id',p.customer_bsale_id,'received_at',p.received_at,'amount',p.amount_received,'payment_method',p.payment_method_received) ORDER BY p.received_at,p.payment_id,p.post_payment_id) physical_items
    FROM physical p JOIN adquisiciones.route_settlements s ON s.id=p.settlement_id JOIN logistica.route_guides g ON g.id=s.route_guide_id AND g.company_id=s.company_id
    GROUP BY p.settlement_id,s.settlement_number,s.settlement_date,s.route_guide_id,g.guide_number,p.custody_user_id
)
SELECT jsonb_build_object('route_settlement_id',settlement_id,'settlement_number',settlement_number,'settlement_date',settlement_date,'route_guide_id',route_guide_id,'guide_number',guide_number,'custody_user_id',custody_user_id,'custody_received_at',custody_received_at,'cash_received',COALESCE(cash_received,0),'checks_received',COALESCE(checks_received,0),'check_count',check_count,'net_cash_pending',COALESCE(cash_received,0),'payment_ids',COALESCE(payment_ids,'[]'::jsonb),'post_settlement_payment_ids',COALESCE(post_settlement_payment_ids,'[]'::jsonb),'physical_items',physical_items) FROM grouped ORDER BY settlement_date,settlement_number,custody_user_id;
$$;

CREATE OR REPLACE FUNCTION adquisiciones.create_route_fund_closure_from_mixed_payments(
    p_company_id uuid, p_payment_ids uuid[], p_post_settlement_payment_ids uuid[], p_check_payment_ids uuid[], p_cash_delivered numeric, p_notes text, p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,adquisiciones,logistica,core,portal AS $$
DECLARE v_route record; v_post record; v_first_custody uuid; v_cash numeric:=0; v_checks numeric:=0; v_expenses numeric:=0; v_expected numeric; v_difference numeric; v_closure uuid; v_number text; v_year integer:=extract(year from current_date)::integer; v_sequence integer; v_item record;
BEGIN
 IF p_user_id IS DISTINCT FROM auth.uid() OR NOT core.has_company_access(auth.uid(),p_company_id) THEN RAISE EXCEPTION 'Usuario o empresa inválidos.'; END IF;
 IF NOT portal.user_has_permission(auth.uid(),'adquisiciones.route_fund_closures.create') OR NOT portal.user_has_permission(auth.uid(),'adquisiciones.route_fund_closures.close') THEN RAISE EXCEPTION 'No tiene permisos para crear el Cierre de Fondos.'; END IF;
 IF cardinality(p_payment_ids) IS NULL AND cardinality(p_post_settlement_payment_ids) IS NULL THEN RAISE EXCEPTION 'Debe seleccionar fondos.'; END IF;
 FOR v_route IN SELECT p.*,s.workflow_status FROM adquisiciones.route_settlement_payments p JOIN adquisiciones.route_settlements s ON s.id=p.settlement_id AND s.company_id=p.company_id WHERE p.company_id=p_company_id AND p.id=ANY(COALESCE(p_payment_ids,ARRAY[]::uuid[])) FOR UPDATE OF p LOOP
   IF v_route.verification_status<>'CONFIRMED' OR v_route.voided_at IS NOT NULL OR v_route.payment_method_received NOT IN('CASH','CHECK') OR v_route.workflow_status<>'CLOSED' THEN RAISE EXCEPTION 'Payment de Rendición no elegible.'; END IF;
   IF EXISTS(SELECT 1 FROM adquisiciones.route_fund_closure_items i JOIN adquisiciones.route_fund_closures f ON f.id=i.fund_closure_id WHERE i.payment_id=v_route.id AND i.released_at IS NULL AND f.status<>'CANCELLED') THEN RAISE EXCEPTION 'Payment ya pertenece a un Cierre activo.'; END IF;
   IF v_first_custody IS NULL THEN v_first_custody:=v_route.custody_user_id; ELSIF v_first_custody IS DISTINCT FROM v_route.custody_user_id THEN RAISE EXCEPTION 'No se pueden mezclar custodios.'; END IF;
   IF v_route.custody_user_id IS NULL THEN RAISE EXCEPTION 'Payment sin custodio.'; END IF;
   IF v_route.payment_method_received='CASH' THEN v_cash:=v_cash+v_route.amount_received; ELSE v_checks:=v_checks+v_route.amount_received; END IF;
 END LOOP;
 FOR v_post IN SELECT p.*,s.workflow_status FROM adquisiciones.post_settlement_payments p JOIN adquisiciones.route_settlements s ON s.id=p.route_settlement_id AND s.company_id=p.company_id WHERE p.company_id=p_company_id AND p.id=ANY(COALESCE(p_post_settlement_payment_ids,ARRAY[]::uuid[])) FOR UPDATE OF p LOOP
   IF v_post.verification_status<>'CONFIRMED' OR v_post.voided_at IS NOT NULL OR v_post.payment_method_received NOT IN('CASH','CHECK') OR v_post.workflow_status<>'CLOSED' THEN RAISE EXCEPTION 'Cobro posterior no elegible.'; END IF;
   IF EXISTS(SELECT 1 FROM adquisiciones.route_fund_closure_items i JOIN adquisiciones.route_fund_closures f ON f.id=i.fund_closure_id WHERE i.post_settlement_payment_id=v_post.id AND i.released_at IS NULL AND f.status<>'CANCELLED') THEN RAISE EXCEPTION 'Cobro posterior ya pertenece a un Cierre activo.'; END IF;
   IF v_first_custody IS NULL THEN v_first_custody:=v_post.custody_user_id; ELSIF v_first_custody IS DISTINCT FROM v_post.custody_user_id THEN RAISE EXCEPTION 'No se pueden mezclar custodios.'; END IF;
   IF v_post.custody_user_id IS NULL THEN RAISE EXCEPTION 'Cobro posterior sin custodio.'; END IF;
   IF v_post.payment_method_received='CASH' THEN v_cash:=v_cash+v_post.amount_received; ELSE v_checks:=v_checks+v_post.amount_received; END IF;
 END LOOP;
 IF v_first_custody IS NULL THEN RAISE EXCEPTION 'No se pudo determinar el custodio.'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(COALESCE(p_check_payment_ids,ARRAY[]::uuid[])) x(id) WHERE NOT EXISTS(SELECT 1 FROM adquisiciones.route_settlement_payments p WHERE p.id=x.id AND p.payment_method_received='CHECK' AND p.id=ANY(COALESCE(p_payment_ids,ARRAY[]::uuid[]))) AND NOT EXISTS(SELECT 1 FROM adquisiciones.post_settlement_payments p WHERE p.id=x.id AND p.payment_method_received='CHECK' AND p.id=ANY(COALESCE(p_post_settlement_payment_ids,ARRAY[]::uuid[])))) THEN RAISE EXCEPTION 'Selección de cheques inválida.'; END IF;
 SELECT COALESCE(sum(e.amount),0) INTO v_expenses FROM adquisiciones.route_fund_closure_expenses e WHERE e.company_id=p_company_id AND e.route_settlement_id IN(SELECT settlement_id FROM adquisiciones.route_settlement_payments WHERE id=ANY(COALESCE(p_payment_ids,ARRAY[]::uuid[])) UNION SELECT route_settlement_id FROM adquisiciones.post_settlement_payments WHERE id=ANY(COALESCE(p_post_settlement_payment_ids,ARRAY[]::uuid[]))) AND e.status='ACTIVE' AND e.voided_at IS NULL AND e.fund_closure_id IS NULL;
 v_expected:=v_cash-v_expenses; v_difference:=p_cash_delivered-v_expected; IF v_difference<>0 AND COALESCE(length(btrim(p_notes)),0)=0 THEN RAISE EXCEPTION 'Debe explicar la diferencia física.'; END IF;
 v_sequence:=adquisiciones.get_next_route_fund_closure_number(p_company_id,v_year); v_number:='CFC-'||v_year||'-'||lpad(v_sequence::text,6,'0');
 INSERT INTO adquisiciones.route_fund_closures(company_id,closure_number,closure_year,closure_sequence,status,total_cash_received,total_check_received,total_expenses,total_pending,cash_delivered,physical_difference,notes,created_by,closed_by,closed_at,custody_user_id) VALUES(p_company_id,v_number,v_year,v_sequence,CASE WHEN v_difference=0 THEN 'CLOSED' ELSE 'WITH_DIFFERENCE' END,v_cash,v_checks,v_expenses,v_expected+v_checks,p_cash_delivered,v_difference,p_notes,p_user_id,p_user_id,now(),v_first_custody) RETURNING id INTO v_closure;
 FOR v_route IN SELECT p.*,a.settlement_item_id FROM adquisiciones.route_settlement_payments p JOIN adquisiciones.route_settlement_payment_allocations a ON a.payment_id=p.id AND a.voided_at IS NULL WHERE p.id=ANY(COALESCE(p_payment_ids,ARRAY[]::uuid[])) LOOP
   INSERT INTO adquisiciones.route_fund_closure_items(company_id,fund_closure_id,payment_id,source_type,route_settlement_item_id,route_settlement_id,route_guide_id,invoice_number,customer_name,payment_method,amount,custody_user_id,custody_received_at) SELECT p_company_id,v_closure,v_route.id,'ROUTE_SETTLEMENT_PAYMENT',si.id,si.settlement_id,rs.route_guide_id,si.invoice_number,si.customer_name,v_route.payment_method_received,v_route.amount_received,v_route.custody_user_id,v_route.custody_received_at FROM adquisiciones.route_settlement_items si JOIN adquisiciones.route_settlements rs ON rs.id=si.settlement_id WHERE si.id=v_route.settlement_item_id;
 END LOOP;
 FOR v_post IN SELECT p.*,a.settlement_item_id FROM adquisiciones.post_settlement_payments p JOIN adquisiciones.post_settlement_payment_allocations a ON a.payment_id=p.id AND a.voided_at IS NULL WHERE p.id=ANY(COALESCE(p_post_settlement_payment_ids,ARRAY[]::uuid[])) LOOP
   INSERT INTO adquisiciones.route_fund_closure_items(company_id,fund_closure_id,post_settlement_payment_id,source_type,route_settlement_item_id,route_settlement_id,route_guide_id,invoice_number,customer_name,payment_method,amount,custody_user_id,custody_received_at) SELECT p_company_id,v_closure,v_post.id,'POST_SETTLEMENT_PAYMENT',si.id,si.settlement_id,rs.route_guide_id,si.invoice_number,si.customer_name,v_post.payment_method_received,v_post.amount_received,v_post.custody_user_id,v_post.custody_received_at FROM adquisiciones.route_settlement_items si JOIN adquisiciones.route_settlements rs ON rs.id=si.settlement_id WHERE si.id=v_post.settlement_item_id;
 END LOOP;
 UPDATE adquisiciones.route_fund_closure_expenses SET fund_closure_id=v_closure WHERE company_id=p_company_id AND route_settlement_id IN(SELECT settlement_id FROM adquisiciones.route_settlement_payments WHERE id=ANY(COALESCE(p_payment_ids,ARRAY[]::uuid[]))) AND status='ACTIVE' AND voided_at IS NULL AND fund_closure_id IS NULL;
 RETURN jsonb_build_object('closure_id',v_closure,'closure_number',v_number,'status',CASE WHEN v_difference=0 THEN 'CLOSED' ELSE 'WITH_DIFFERENCE' END,'cash_received',v_cash,'checks_received',v_checks,'expenses',v_expenses);
END; $$;

REVOKE ALL ON FUNCTION adquisiciones.create_route_fund_closure_from_mixed_payments(uuid,uuid[],uuid[],uuid[],numeric,text,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.create_route_fund_closure_from_mixed_payments(uuid,uuid[],uuid[],uuid[],numeric,text,uuid) TO authenticated;
