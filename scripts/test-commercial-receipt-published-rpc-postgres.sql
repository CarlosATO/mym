\set ON_ERROR_STOP on
-- Disposable database only. Load production receipt and Bsale migrations in
-- chronological order BEFORE applying 20261126130000_logistica_commercial_receipt_economics.sql.
CREATE SCHEMA adquisiciones; CREATE SCHEMA logistica; CREATE SCHEMA core; CREATE SCHEMA auth; CREATE SCHEMA portal; CREATE SCHEMA integraciones;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '40000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION core.has_company_access(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $2='10000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION core.has_permission_for_company(uuid,uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT $1 <> '40000000-0000-0000-0000-000000000099'::uuid $$;

CREATE TABLE adquisiciones.warehouses(id uuid PRIMARY KEY, company_id uuid, is_active boolean);
CREATE TABLE adquisiciones.products(id uuid PRIMARY KEY, company_id uuid, bsale_product_id bigint, bsale_variant_id bigint);
CREATE TABLE adquisiciones.purchase_orders(id uuid PRIMARY KEY, company_id uuid, correlative text, commercial_draft_revision bigint, status text, receipt_status text, warehouse_id uuid, updated_at timestamptz, updated_by uuid);
CREATE TABLE adquisiciones.purchase_order_items(id uuid PRIMARY KEY, po_id uuid, company_id uuid, item_type text, product_id uuid, product_description text, warehouse_id uuid, quantity numeric, quantity_received numeric DEFAULT 0, unit_price numeric, discount_amount numeric DEFAULT 0, discount_percent numeric DEFAULT 0, discount_unit_amount numeric DEFAULT 0, tax_rate numeric DEFAULT 19, purchase_unit_snapshot text, purchase_unit_factor_snapshot numeric, commercial_unit_price_snapshot numeric, commercial_gross_amount_snapshot numeric, updated_at timestamptz, updated_by uuid);
CREATE TABLE adquisiciones.purchase_order_snapshots(id uuid PRIMARY KEY, po_id uuid, company_id uuid, snapshot_type text, items_snapshot jsonb);
CREATE TABLE adquisiciones.commercial_draft_write_capabilities(transaction_id bigint, backend_pid integer, PRIMARY KEY(transaction_id, backend_pid));

CREATE TABLE logistica.locations(id uuid PRIMARY KEY, company_id uuid, is_active boolean, warehouse_id uuid);
CREATE TABLE logistica.purchase_receipt_correlatives(company_id uuid PRIMARY KEY, next_value bigint);
CREATE TABLE logistica.purchase_receipts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, purchase_order_id uuid, receipt_number text, receiving_type text, warehouse_id uuid, status text, notes text, document_type text, document_number text, document_date date, idempotency_key uuid, receipt_total_net numeric(14,4), receipt_total_tax numeric(14,4), receipt_total_gross numeric(14,4), created_by uuid, received_by uuid);
CREATE TABLE logistica.purchase_receipt_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, receipt_id uuid, purchase_order_item_id uuid, product_id uuid, service_description text, quantity_ordered numeric, quantity_previously_received numeric, quantity_received numeric, quantity_rejected numeric, quantity_missing numeric, quantity_pending_after numeric, condition text, rejection_reason text, difference_reason text, unit_cost numeric(14,4), net_amount numeric(14,4), tax_amount numeric(14,4), gross_amount numeric(14,4), warehouse_id uuid, location_id uuid, lot_number text, expiration_date date, notes text, created_by uuid);
CREATE TABLE logistica.kardex_movements(company_id uuid, product_id uuid, warehouse_id uuid, location_id uuid, movement_type text, source_type text, source_id uuid, source_line_id uuid, quantity numeric, unit_cost numeric(14,4), total_cost numeric(14,4), lot_number text, expiration_date date, notes text, created_by uuid);
CREATE TABLE logistica.receipt_documents(company_id uuid, receipt_id uuid, document_type text, document_number text, file_url text, storage_bucket text, storage_path text, document_date date, file_name text, file_size bigint, mime_type text, notes text, created_by uuid);

CREATE TABLE integraciones.bsale_products(company_id uuid, bsale_id bigint, stock_control boolean);
CREATE TABLE integraciones.bsale_variants(company_id uuid, bsale_id bigint, bsale_product_id bigint);
CREATE TABLE integraciones.bsale_purchase_receipt_settings(company_id uuid PRIMARY KEY, enabled boolean, office_id bigint, service_variant_id bigint);
CREATE TABLE integraciones.bsale_purchase_receipt_operations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, purchase_receipt_id uuid UNIQUE, correlation_code text, office_id bigint, status text NOT NULL DEFAULT 'PREPARED' CHECK (status IN ('PREPARED','SENDING','CONFIRMED','FAILED','RECONCILIATION_REQUIRED')), error_message text, attempt_count integer NOT NULL DEFAULT 0, created_by uuid, sending_at timestamptz, last_attempt_at timestamptz, confirmed_at timestamptz, bsale_reception_id bigint, payload_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb);

CREATE FUNCTION adquisiciones.guard_commercial_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION adquisiciones.guard_commercial_po_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION adquisiciones.guard_commercial_po_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER guard_receipt BEFORE INSERT OR UPDATE OF purchase_order_id ON logistica.purchase_receipts FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_commercial_receipt();
CREATE TRIGGER guard_item BEFORE INSERT OR UPDATE OF purchase_order_item_id ON logistica.purchase_receipt_items FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_commercial_receipt();
CREATE TRIGGER guard_po_item BEFORE INSERT OR UPDATE ON adquisiciones.purchase_order_items FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_commercial_po_item();
CREATE TRIGGER guard_status BEFORE UPDATE OF status ON adquisiciones.purchase_orders FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_commercial_po_status();

-- 0. Load production Bsale claim, finish and zero-cost payload validator
CREATE OR REPLACE FUNCTION integraciones.claim_bsale_purchase_receipt_operation(p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, integraciones AS $$ DECLARE o integraciones.bsale_purchase_receipt_operations%ROWTYPE; BEGIN SELECT * INTO o FROM integraciones.bsale_purchase_receipt_operations WHERE id = p_operation_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Operación no encontrada'; END IF; IF o.status = 'PREPARED' THEN UPDATE integraciones.bsale_purchase_receipt_operations SET status='SENDING', attempt_count=attempt_count+1, sending_at=now(), last_attempt_at=now() WHERE id=o.id; RETURN jsonb_build_object('claimed',true,'status','SENDING'); END IF; RETURN jsonb_build_object('claimed',false,'status',o.status,'reception_id',o.bsale_reception_id,'error',o.error_message); END $$;

CREATE OR REPLACE FUNCTION integraciones.finish_bsale_purchase_receipt_operation(p_operation_id uuid, p_status text, p_reception_id bigint, p_error text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, integraciones AS $$ BEGIN IF p_status NOT IN ('CONFIRMED','FAILED','RECONCILIATION_REQUIRED') THEN RAISE EXCEPTION 'Estado inválido'; END IF; UPDATE integraciones.bsale_purchase_receipt_operations SET status=p_status, bsale_reception_id=p_reception_id, error_message=nullif(btrim(p_error),''), confirmed_at=CASE WHEN p_status='CONFIRMED' THEN now() ELSE confirmed_at END WHERE id=p_operation_id AND status='SENDING'; IF NOT FOUND THEN RAISE EXCEPTION 'La operación no está en SENDING'; END IF; RETURN (SELECT jsonb_build_object('operation_id',id,'status',status,'reception_id',bsale_reception_id,'error',error_message,'payload',payload_snapshot) FROM integraciones.bsale_purchase_receipt_operations WHERE id=p_operation_id); END $$;

\ir ../supabase/migrations/20261112100000_logistica_bsale_purchase_receipt_zero_cost_bonification.sql

-- 1. Load production non-stock-control + Bsale preparation implementation
\ir ../supabase/migrations/20261112110000_logistica_receipt_non_stock_control_products.sql

-- 2. Load production hotfix wrapper as logistica.create_purchase_receipt_db
CREATE OR REPLACE FUNCTION logistica.create_purchase_receipt_db(p_company_id uuid,p_purchase_order_id uuid,p_receiving_type text,p_warehouse_id uuid,p_notes text,p_document_type text,p_document_number text,p_document_date date,p_items jsonb,p_user_id uuid,p_idempotency_key uuid,p_attachment jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth,core,portal,logistica,adquisiciones AS $$
DECLARE w uuid;
BEGIN
 IF p_document_number IS NULL OR p_document_number !~ '^[0-9]+$' THEN RETURN jsonb_build_object('success',false,'error','invalid document'); END IF;
 IF p_receiving_type='WAREHOUSE' THEN
   SELECT coalesce(p_warehouse_id,warehouse_id) INTO w FROM adquisiciones.purchase_orders WHERE id=p_purchase_order_id AND company_id=p_company_id;
   IF w IS NULL OR NOT EXISTS(SELECT 1 FROM adquisiciones.warehouses WHERE id=w AND company_id=p_company_id AND is_active) THEN RETURN jsonb_build_object('success',false,'error','invalid warehouse'); END IF;
 END IF;
 RETURN logistica.create_purchase_receipt_db_pre_hotfix(p_company_id,p_purchase_order_id,p_receiving_type,w,p_notes,p_document_type,p_document_number,p_document_date,p_items,p_user_id,p_idempotency_key,p_attachment);
END $$;

-- 3. Apply COMPRAS 07D.1 migration on top of production baseline
\ir ../supabase/migrations/20261126130000_logistica_commercial_receipt_economics.sql

DO $$
DECLARE c uuid:='10000000-0000-0000-0000-000000000001'; u uuid:=auth.uid(); p uuid:=gen_random_uuid(); i uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); product uuid:=gen_random_uuid(); w uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); r jsonb; r_idem jsonb; x jsonb; j int; key1 uuid:=gen_random_uuid();
BEGIN
 INSERT INTO adquisiciones.warehouses VALUES(w,c,true);
 INSERT INTO logistica.locations VALUES(l,c,true,w);
 INSERT INTO adquisiciones.products VALUES(product,c,1001,2001);
 INSERT INTO integraciones.bsale_purchase_receipt_settings VALUES(c,true,1,4554);
 INSERT INTO adquisiciones.purchase_orders(id,company_id,correlative,commercial_draft_revision,status,receipt_status,warehouse_id) VALUES(p,c,'OC-SIM-001',1,'BORRADOR','PENDIENTE',w);
 INSERT INTO adquisiciones.purchase_order_items(id,po_id,company_id,quantity,quantity_received,purchase_unit_factor_snapshot,commercial_unit_price_snapshot,item_type,product_id,warehouse_id,unit_price,discount_amount,discount_percent,tax_rate) VALUES(i,p,c,900,0,6,9500,'PRODUCT',product,w,1583.3333,90000,0,19);
 INSERT INTO adquisiciones.commercial_draft_write_capabilities VALUES(txid_current(),pg_backend_pid());
 UPDATE adquisiciones.purchase_orders SET status='EMITIDA' WHERE id=p;
 UPDATE adquisiciones.purchase_orders SET status='ENVIADA_PROVEEDOR' WHERE id=p;
 UPDATE adquisiciones.purchase_orders SET status='CONFIRMADA' WHERE id=p;
 DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
 INSERT INTO adquisiciones.purchase_order_snapshots VALUES(s,p,c,'CONFIRMED',jsonb_build_array(jsonb_build_object('item_id',i,'quantity',900,'purchase_unit_snapshot','DISPLAY','purchase_unit_factor_snapshot',6,'commercial_unit_price_snapshot',9500,'commercial_gross_amount_snapshot',1425000,'discount_amount',90000,'tax_amount',253650,'line_total',1588650)));
 FOR j IN 1..2 LOOP
   x:=jsonb_build_array(jsonb_build_object('purchase_order_item_id',i,'condition','CONFORME','quantity_received',CASE j WHEN 1 THEN 1 ELSE 899 END,'location_id',l));
   r:=logistica.create_purchase_receipt_db(c,p,'WAREHOUSE',w,NULL,'FA',j::text,current_date,x,u,CASE WHEN j=1 THEN key1 ELSE gen_random_uuid() END,NULL);
   IF coalesce((r->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'published RPC failed: %',r; END IF;
   IF j=1 THEN
     r_idem:=logistica.create_purchase_receipt_db(c,p,'WAREHOUSE',w,NULL,'FA','1',current_date,x,u,key1,NULL);
     IF (r_idem->>'idempotent')::boolean IS NOT TRUE OR (r_idem->>'receipt_id')::uuid<>(r->>'receipt_id')::uuid THEN RAISE EXCEPTION 'published idempotency retry failed %',r_idem; END IF;
     BEGIN
       PERFORM logistica.create_purchase_receipt_db(c,p,'WAREHOUSE',w,NULL,'FA','99',current_date,x,u,key1,NULL);
       RAISE EXCEPTION 'incompatible document number accepted';
     EXCEPTION WHEN unique_violation THEN NULL; END;
   END IF;
 END LOOP;
 IF (SELECT sum(net_amount) FROM logistica.purchase_receipt_items WHERE purchase_order_item_id=i)<>1335000 OR (SELECT sum(tax_amount) FROM logistica.purchase_receipt_items WHERE purchase_order_item_id=i)<>253650 OR (SELECT sum(commercial_discount_amount) FROM logistica.purchase_receipt_items WHERE purchase_order_item_id=i)<>90000 THEN RAISE EXCEPTION 'published RPC economic mismatch'; END IF;
 IF (SELECT quantity_received FROM adquisiciones.purchase_order_items WHERE id=i)<>900 OR (SELECT sum(quantity) FROM logistica.kardex_movements WHERE product_id=product)<>900 OR (SELECT sum(total_cost) FROM logistica.kardex_movements WHERE product_id=product)<>1335000 OR (SELECT status FROM adquisiciones.purchase_orders WHERE id=p)<>'RECEPCION_TOTAL' THEN RAISE EXCEPTION 'published RPC stock mismatch'; END IF;
 IF has_function_privilege('service_role','logistica.create_purchase_receipt_db_pre_hotfix(uuid,uuid,text,uuid,text,text,text,date,jsonb,uuid,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'pre_hotfix exposed to service_role'; END IF;
END $$;

DO $$
DECLARE c uuid:='10000000-0000-0000-0000-000000000001'; u uuid:=auth.uid(); p uuid:=gen_random_uuid(); i uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); r jsonb; x jsonb;
BEGIN
 INSERT INTO adquisiciones.purchase_orders(id,company_id,correlative,commercial_draft_revision,status,receipt_status) VALUES(p,c,'OC-SIM-002',1,'CONFIRMADA','PENDIENTE');
 INSERT INTO adquisiciones.purchase_order_items(id,po_id,company_id,quantity,quantity_received,item_type,product_description,unit_price,discount_amount,discount_percent,tax_rate) VALUES(i,p,c,3,0,'SERVICE','Servicio',0.3333,0,0,19);
 INSERT INTO adquisiciones.purchase_order_snapshots VALUES(s,p,c,'CONFIRMED',jsonb_build_array(jsonb_build_object('item_id',i,'quantity',3,'commercial_gross_amount_snapshot',1,'discount_amount',0,'tax_amount',0.19,'line_total',1.19)));
 x:=jsonb_build_array(jsonb_build_object('purchase_order_item_id',i,'condition','CONFORME','quantity_received',3));
 r:=logistica.create_purchase_receipt_db(c,p,'OFFICE',NULL,NULL,'FA','123',current_date,x,u,gen_random_uuid(),jsonb_build_object('document_type','FA','storage_path','fixture.pdf'));
 IF coalesce((r->>'success')::boolean,false) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM logistica.purchase_receipts WHERE id=(r->>'receipt_id')::uuid AND receipt_total_net=1 AND receipt_total_tax=.19 AND document_type='FA') OR NOT EXISTS(SELECT 1 FROM logistica.receipt_documents WHERE receipt_id=(r->>'receipt_id')::uuid AND document_type='FA') OR EXISTS(SELECT 1 FROM logistica.kardex_movements WHERE source_id=(r->>'receipt_id')::uuid) THEN RAISE EXCEPTION 'commercial service or invoice mismatch %',r; END IF;
 p:=gen_random_uuid(); i:=gen_random_uuid();
 INSERT INTO adquisiciones.purchase_orders(id,company_id,correlative,commercial_draft_revision,status,receipt_status) VALUES(p,c,'OC-SIM-003',0,'CONFIRMADA','PENDIENTE');
 INSERT INTO adquisiciones.purchase_order_items(id,po_id,company_id,quantity,quantity_received,item_type,product_description,unit_price,discount_amount,discount_percent,tax_rate) VALUES(i,p,c,2,0,'SERVICE','Tradicional',100,20,0,19);
 x:=jsonb_build_array(jsonb_build_object('purchase_order_item_id',i,'condition','CONFORME','quantity_received',2));
 r:=logistica.create_purchase_receipt_db(c,p,'OFFICE',NULL,NULL,'GD','124',current_date,x,u,gen_random_uuid(),NULL);
 IF coalesce((r->>'success')::boolean,false) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM logistica.purchase_receipts WHERE id=(r->>'receipt_id')::uuid AND receipt_total_net=180 AND receipt_total_tax=34.2 AND receipt_total_gross=214.2) THEN RAISE EXCEPTION 'traditional RPC changed %',r; END IF;
END $$;

-- Validate Bsale zero-cost distinction:
-- 1) Commercial cumulative rounding zero -> RECONCILIATION_REQUIRED with physical qty & cost 0 preserved
-- 2) Legitimate supplier bonus -> PREPARED with cost 0
-- 3) Invalid unbonified zero / tampered commercial zero -> RAISE EXCEPTION
DO $$
DECLARE
  c uuid := '10000000-0000-0000-0000-000000000001';
  u uuid := auth.uid();
  w uuid;
  l uuid;
  prod uuid := gen_random_uuid();
  p_round uuid := gen_random_uuid();
  i_round uuid := gen_random_uuid();
  s_round uuid := gen_random_uuid();
  p_bonus uuid := gen_random_uuid();
  i_bonus uuid := gen_random_uuid();
  p_bad uuid := gen_random_uuid();
  i_bad uuid := gen_random_uuid();
  r1 jsonb;
  r2 jsonb;
  r_bonus jsonb;
  r_bad jsonb;
  prep1 jsonb;
  prep1_dup jsonb;
  prep2 jsonb;
  prep_bonus jsonb;
BEGIN
  SELECT id INTO w FROM adquisiciones.warehouses WHERE company_id = c LIMIT 1;
  SELECT id INTO l FROM logistica.locations WHERE company_id = c AND warehouse_id = w LIMIT 1;
  INSERT INTO adquisiciones.products VALUES(prod, c, 3001, 4001);

  -- Case 1: Commercial PO where 1 internal unit out of 600 rounds net to 0.00 (confirmed net = 2.00)
  INSERT INTO adquisiciones.purchase_orders(id,company_id,correlative,commercial_draft_revision,status,receipt_status,warehouse_id)
  VALUES(p_round,c,'OC-ROUND-001',1,'BORRADOR','PENDIENTE',w);
  INSERT INTO adquisiciones.purchase_order_items(id,po_id,company_id,quantity,quantity_received,purchase_unit_factor_snapshot,commercial_unit_price_snapshot,item_type,product_id,warehouse_id,unit_price,discount_amount,discount_percent,tax_rate)
  VALUES(i_round,p_round,c,600,0,6,0.02,'PRODUCT',prod,w,0.0033,0,0,19);
  INSERT INTO adquisiciones.commercial_draft_write_capabilities VALUES(txid_current(),pg_backend_pid());
  UPDATE adquisiciones.purchase_orders SET status='EMITIDA' WHERE id=p_round;
  UPDATE adquisiciones.purchase_orders SET status='ENVIADA_PROVEEDOR' WHERE id=p_round;
  UPDATE adquisiciones.purchase_orders SET status='CONFIRMADA' WHERE id=p_round;
  DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
  INSERT INTO adquisiciones.purchase_order_snapshots VALUES(s_round,p_round,c,'CONFIRMED',jsonb_build_array(jsonb_build_object(
    'item_id',i_round,'quantity',600,'purchase_unit_snapshot','DISPLAY','purchase_unit_factor_snapshot',6,
    'commercial_unit_price_snapshot',0.02,'commercial_gross_amount_snapshot',2.00,'discount_amount',0,'tax_amount',0.38,'line_total',2.38
  )));

  r1 := logistica.create_purchase_receipt_db(c,p_round,'WAREHOUSE',w,NULL,'FA','5001',current_date,
    jsonb_build_array(jsonb_build_object('purchase_order_item_id',i_round,'condition','CONFORME','quantity_received',1,'location_id',l)),
    u,gen_random_uuid(),NULL);
  IF (r1->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'rounding zero receipt failed %',r1; END IF;
  IF (SELECT net_amount FROM logistica.purchase_receipt_items WHERE receipt_id=(r1->>'receipt_id')::uuid) <> 0 THEN
    RAISE EXCEPTION 'expected cumulative rounding zero net';
  END IF;

  prep1 := integraciones.prepare_bsale_purchase_receipt_operation((r1->>'receipt_id')::uuid, u);
  prep1_dup := integraciones.prepare_bsale_purchase_receipt_operation((r1->>'receipt_id')::uuid, u);
  IF prep1->>'status' <> 'RECONCILIATION_REQUIRED'
     OR prep1->>'operation_id' <> prep1_dup->>'operation_id'
     OR (prep1->'payload'->'details'->0->>'quantity')::numeric <> 1
     OR (prep1->'payload'->'details'->0->>'cost')::numeric <> 0 THEN
    RAISE EXCEPTION 'unexpected Bsale preparation for commercial rounding zero: %', prep1;
  END IF;

  r2 := logistica.create_purchase_receipt_db(c,p_round,'WAREHOUSE',w,NULL,'FA','5002',current_date,
    jsonb_build_array(jsonb_build_object('purchase_order_item_id',i_round,'condition','CONFORME','quantity_received',599,'location_id',l)),
    u,gen_random_uuid(),NULL);
  prep2 := integraciones.prepare_bsale_purchase_receipt_operation((r2->>'receipt_id')::uuid, u);
  IF prep2->>'status' <> 'PREPARED' OR (SELECT sum(net_amount) FROM logistica.purchase_receipt_items WHERE purchase_order_item_id=i_round) <> 2.00 THEN
    RAISE EXCEPTION 'subsequent positive commercial slice mismatch: %', prep2;
  END IF;

  -- Case 2: Legitimate 100% supplier bonus -> PREPARED
  INSERT INTO adquisiciones.purchase_orders(id,company_id,correlative,commercial_draft_revision,status,receipt_status,warehouse_id)
  VALUES(p_bonus,c,'OC-BONUS-001',0,'CONFIRMADA','PENDIENTE',w);
  INSERT INTO adquisiciones.purchase_order_items(id,po_id,company_id,quantity,quantity_received,item_type,product_id,warehouse_id,unit_price,discount_amount,discount_percent,tax_rate)
  VALUES(i_bonus,p_bonus,c,2,0,'PRODUCT',prod,w,7911,0,100,19);
  r_bonus := logistica.create_purchase_receipt_db(c,p_bonus,'WAREHOUSE',w,NULL,'FA','5003',current_date,
    jsonb_build_array(jsonb_build_object('purchase_order_item_id',i_bonus,'condition','CONFORME','quantity_received',2,'location_id',l)),
    u,gen_random_uuid(),NULL);
  prep_bonus := integraciones.prepare_bsale_purchase_receipt_operation((r_bonus->>'receipt_id')::uuid, u);
  IF prep_bonus->>'status' <> 'PREPARED' OR (prep_bonus->'payload'->'details'->0->>'cost')::numeric <> 0 THEN
    RAISE EXCEPTION 'legitimate bonus preparation changed: %', prep_bonus;
  END IF;

  -- Case 3: Invalid zero cost (unit_price = 0, not a bonus) -> RAISE EXCEPTION
  INSERT INTO adquisiciones.purchase_orders(id,company_id,correlative,commercial_draft_revision,status,receipt_status,warehouse_id)
  VALUES(p_bad,c,'OC-BAD-001',0,'CONFIRMADA','PENDIENTE',w);
  INSERT INTO adquisiciones.purchase_order_items(id,po_id,company_id,quantity,quantity_received,item_type,product_id,warehouse_id,unit_price,discount_amount,discount_percent,tax_rate)
  VALUES(i_bad,p_bad,c,2,0,'PRODUCT',prod,w,0,0,100,19);
  r_bad := logistica.create_purchase_receipt_db(c,p_bad,'WAREHOUSE',w,NULL,'FA','5004',current_date,
    jsonb_build_array(jsonb_build_object('purchase_order_item_id',i_bad,'condition','CONFORME','quantity_received',2,'location_id',l)),
    u,gen_random_uuid(),NULL);
  BEGIN
    PERFORM integraciones.prepare_bsale_purchase_receipt_operation((r_bad->>'receipt_id')::uuid, u);
    RAISE EXCEPTION 'invalid zero cost accepted by Bsale prepare';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%Línea PRODUCT sin cantidad o costo neto válido%' THEN RAISE; END IF;
  END;

  -- Finding 2 verification in SQL:
  -- a) claim does NOT claim RECONCILIATION_REQUIRED (no automatic POST possible)
  IF ((integraciones.claim_bsale_purchase_receipt_operation((prep1->>'operation_id')::uuid))->>'claimed')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'RECONCILIATION_REQUIRED operation must never be claimed for automatic POST';
  END IF;
  -- b) finish_bsale_purchase_receipt_operation remains strictly SENDING-only
  BEGIN
    PERFORM integraciones.finish_bsale_purchase_receipt_operation((prep1->>'operation_id')::uuid, 'CONFIRMED', 99001, NULL);
    RAISE EXCEPTION 'finish accepted non-SENDING operation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%no está en SENDING%' THEN RAISE; END IF;
  END;
  -- c) confirm_reconciled rejects PREPARED operations, unauthorized users, wrong company and invalid IDs
  BEGIN
    PERFORM integraciones.confirm_reconciled_bsale_purchase_receipt_operation((prep_bonus->>'operation_id')::uuid, c, u, 99002);
    RAISE EXCEPTION 'confirm_reconciled accepted PREPARED operation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%RECONCILIATION_REQUIRED%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM integraciones.confirm_reconciled_bsale_purchase_receipt_operation((prep1->>'operation_id')::uuid, c, '40000000-0000-0000-0000-000000000099'::uuid, 99001);
    RAISE EXCEPTION 'confirm_reconciled accepted unauthorized user';
  EXCEPTION WHEN raise_exception THEN NULL; END;
  BEGIN
    PERFORM integraciones.confirm_reconciled_bsale_purchase_receipt_operation((prep1->>'operation_id')::uuid, gen_random_uuid(), u, 99001);
    RAISE EXCEPTION 'confirm_reconciled accepted wrong company';
  EXCEPTION WHEN raise_exception THEN NULL; END;
  BEGIN
    PERFORM integraciones.confirm_reconciled_bsale_purchase_receipt_operation((prep1->>'operation_id')::uuid, c, u, 0);
    RAISE EXCEPTION 'confirm_reconciled accepted non-positive reception id';
  EXCEPTION WHEN raise_exception THEN NULL; END;
  -- d) confirm_reconciled transitions RECONCILIATION_REQUIRED -> CONFIRMED and is idempotent for same ID, rejecting different ID
  prep1 := integraciones.confirm_reconciled_bsale_purchase_receipt_operation((prep1->>'operation_id')::uuid, c, u, 99001);
  IF prep1->>'status' <> 'CONFIRMED' OR (prep1->>'reception_id')::bigint <> 99001 OR prep1->>'error' IS NOT NULL THEN
    RAISE EXCEPTION 'confirm_reconciled failed: %', prep1;
  END IF;
  IF (integraciones.confirm_reconciled_bsale_purchase_receipt_operation((prep1->>'operation_id')::uuid, c, u, 99001))->>'status' <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'confirm_reconciled idempotent retry failed';
  END IF;
  BEGIN
    PERFORM integraciones.confirm_reconciled_bsale_purchase_receipt_operation((prep1->>'operation_id')::uuid, c, u, 99099);
    RAISE EXCEPTION 'confirm_reconciled accepted conflicting reception id after confirmation';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;

-- Finding 1 verification in SQL: historical receipts (idempotency_request_fingerprint IS NULL)
-- must verify ALL persisted fields (received/rejected/missing, condition, location, lot,
-- expiration, reasons, notes and attachments) and fail closed when equivalence cannot be proven.
DO $$
DECLARE
  c uuid := '10000000-0000-0000-0000-000000000001';
  u uuid := auth.uid();
  w uuid;
  l1 uuid;
  l2 uuid := gen_random_uuid();
  prod uuid := gen_random_uuid();
  po_hist uuid := gen_random_uuid();
  item_a uuid := gen_random_uuid();
  item_b uuid := gen_random_uuid();
  item_c uuid := gen_random_uuid();
  hist_key uuid := gen_random_uuid();
  base_items jsonb;
  base_att jsonb;
  created_res jsonb;
  retry_res jsonb;
  mutated_items jsonb;
BEGIN
  SELECT id INTO w FROM adquisiciones.warehouses WHERE company_id = c LIMIT 1;
  SELECT id INTO l1 FROM logistica.locations WHERE company_id = c AND warehouse_id = w LIMIT 1;
  INSERT INTO logistica.locations VALUES(l2, c, true, w);
  INSERT INTO adquisiciones.products VALUES(prod, c, 7001, 8001);

  INSERT INTO adquisiciones.purchase_orders(id,company_id,correlative,commercial_draft_revision,status,receipt_status,warehouse_id)
  VALUES(po_hist, c, 'OC-HIST-072', 0, 'CONFIRMADA', 'PENDIENTE', w);

  INSERT INTO adquisiciones.purchase_order_items(id,po_id,company_id,item_type,product_id,warehouse_id,quantity,quantity_received,unit_price,discount_amount,discount_percent,tax_rate)
  VALUES
    (item_a, po_hist, c, 'PRODUCT', prod, w, 20, 0, 1000, 0, 0, 19),
    (item_b, po_hist, c, 'PRODUCT', prod, w, 10, 0, 1000, 0, 0, 19),
    (item_c, po_hist, c, 'PRODUCT', prod, w, 10, 0, 1000, 0, 0, 19);

  base_items := jsonb_build_array(
    jsonb_build_object(
      'purchase_order_item_id', item_a,
      'condition', 'CONFORME',
      'quantity_received', 12,
      'quantity_rejected', 0,
      'quantity_missing', 0,
      'location_id', l1,
      'lot_number', 'LOTE-2026-A',
      'expiration_date', '2027-06-30',
      'notes', 'Caja sellada'
    ),
    jsonb_build_object(
      'purchase_order_item_id', item_b,
      'condition', 'RECHAZADO',
      'quantity_received', 0,
      'quantity_rejected', 3,
      'quantity_missing', 0,
      'rejection_reason', 'Envase roto',
      'notes', 'Separado en anden'
    ),
    jsonb_build_object(
      'purchase_order_item_id', item_c,
      'condition', 'FALTANTE',
      'quantity_received', 0,
      'quantity_rejected', 0,
      'quantity_missing', 2,
      'difference_reason', 'No llego en camion',
      'notes', 'Reclamado a proveedor'
    )
  );

  base_att := jsonb_build_object(
    'document_type', 'FA',
    'storage_bucket', 'recepciones',
    'storage_path', '2026/11/factura-8801.pdf',
    'file_name', 'factura-8801.pdf',
    'file_size', 204800,
    'mime_type', 'application/pdf',
    'notes', 'Escaneo original'
  );

  created_res := logistica.create_purchase_receipt_db(
    c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', base_items, u, hist_key, base_att
  );
  IF (created_res->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'historical fixture creation failed: %', created_res; END IF;

  -- Simulate one of the 72 pre-migration production receipts by clearing idempotency_request_fingerprint
  UPDATE logistica.purchase_receipts SET idempotency_request_fingerprint = NULL WHERE id = (created_res->>'receipt_id')::uuid;

  -- 1. Exact retry of the historical receipt succeeds idempotently
  retry_res := logistica.create_purchase_receipt_db(
    c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', base_items, u, hist_key, base_att
  );
  IF (retry_res->>'idempotent')::boolean IS NOT TRUE OR (retry_res->>'receipt_id')::uuid <> (created_res->>'receipt_id')::uuid THEN
    RAISE EXCEPTION 'exact legacy retry failed: %', retry_res;
  END IF;

  -- 2. Every field mismatch must be rejected on legacy receipt
  -- 2a. quantity_rejected mismatch
  mutated_items := jsonb_set(base_items, '{1,quantity_rejected}', '4'::jsonb);
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', mutated_items, u, hist_key, base_att); RAISE EXCEPTION 'legacy quantity_rejected mismatch accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

  -- 2b. quantity_missing mismatch
  mutated_items := jsonb_set(base_items, '{2,quantity_missing}', '5'::jsonb);
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', mutated_items, u, hist_key, base_att); RAISE EXCEPTION 'legacy quantity_missing mismatch accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

  -- 2c. condition mismatch
  mutated_items := jsonb_set(base_items, '{0,condition}', '"DANADO"'::jsonb);
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', mutated_items, u, hist_key, base_att); RAISE EXCEPTION 'legacy condition mismatch accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

  -- 2d. location_id mismatch (different location or unpersisted location on RECHAZADO)
  mutated_items := jsonb_set(base_items, '{0,location_id}', to_jsonb(l2::text));
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', mutated_items, u, hist_key, base_att); RAISE EXCEPTION 'legacy location_id mismatch accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
  mutated_items := jsonb_set(base_items, '{1,location_id}', to_jsonb(l1::text));
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', mutated_items, u, hist_key, base_att); RAISE EXCEPTION 'legacy unprovable location_id on RECHAZADO accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

  -- 2e. lot_number mismatch
  mutated_items := jsonb_set(base_items, '{0,lot_number}', '"LOTE-OTRO"'::jsonb);
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', mutated_items, u, hist_key, base_att); RAISE EXCEPTION 'legacy lot_number mismatch accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

  -- 2f. expiration_date mismatch
  mutated_items := jsonb_set(base_items, '{0,expiration_date}', '"2027-07-01"'::jsonb);
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', mutated_items, u, hist_key, base_att); RAISE EXCEPTION 'legacy expiration_date mismatch accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

  -- 2g. rejection_reason & difference_reason mismatch
  mutated_items := jsonb_set(base_items, '{1,rejection_reason}', '"Otro motivo"'::jsonb);
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', mutated_items, u, hist_key, base_att); RAISE EXCEPTION 'legacy rejection_reason mismatch accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
  mutated_items := jsonb_set(base_items, '{2,difference_reason}', '"Otra diferencia"'::jsonb);
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', mutated_items, u, hist_key, base_att); RAISE EXCEPTION 'legacy difference_reason mismatch accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

  -- 2h. line notes & header notes mismatch
  mutated_items := jsonb_set(base_items, '{0,notes}', '"Nota alterada"'::jsonb);
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', mutated_items, u, hist_key, base_att); RAISE EXCEPTION 'legacy line notes mismatch accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Cabecera alterada', 'FA', '8801', DATE '2026-11-20', base_items, u, hist_key, base_att); RAISE EXCEPTION 'legacy header notes mismatch accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

  -- 2i. attachment mismatch (omitted, altered path/size/notes, or non-object attachment)
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', base_items, u, hist_key, NULL); RAISE EXCEPTION 'legacy missing attachment accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', base_items, u, hist_key, jsonb_set(base_att, '{storage_path}', '"2026/11/otro.pdf"'::jsonb)); RAISE EXCEPTION 'legacy altered attachment path accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', base_items, u, hist_key, jsonb_set(base_att, '{file_size}', '999'::jsonb)); RAISE EXCEPTION 'legacy altered attachment size accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', base_items, u, hist_key, '[]'::jsonb); RAISE EXCEPTION 'legacy invalid attachment type accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;

  -- 2j. If post-creation documents were attached (>1 receipt_documents), equivalence cannot be proven -> fail closed
  INSERT INTO logistica.receipt_documents(company_id, receipt_id, document_type, document_number, storage_bucket, storage_path, document_date, file_name, file_size, mime_type, notes, created_by)
  VALUES(c, (created_res->>'receipt_id')::uuid, 'EVIDENCIA', '8801', 'recepciones', '2026/11/foto.jpg', DATE '2026-11-20', 'foto.jpg', 1024, 'image/jpeg', 'Post-creacion', u);
  BEGIN PERFORM logistica.create_purchase_receipt_db(c, po_hist, 'WAREHOUSE', w, 'Observacion cabecera historica', 'FA', '8801', DATE '2026-11-20', base_items, u, hist_key, base_att); RAISE EXCEPTION 'legacy multi-document ambiguity accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;

SELECT 'published receipt RPC integration passed' AS result;
