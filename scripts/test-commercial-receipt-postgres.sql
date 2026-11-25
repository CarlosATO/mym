\set ON_ERROR_STOP on
-- Disposable database only. The receipt RPC below is a fixture, not the
-- published implementation; run integration tests against a production-schema
-- clone as a separate validation before deployment.
CREATE SCHEMA adquisiciones; CREATE SCHEMA logistica; CREATE SCHEMA core; CREATE SCHEMA auth; CREATE SCHEMA portal; CREATE SCHEMA integraciones;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '40000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION core.has_company_access(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $2='10000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION core.has_permission_for_company(uuid,uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE adquisiciones.products(id uuid PRIMARY KEY, company_id uuid, bsale_product_id bigint, bsale_variant_id bigint);
CREATE TABLE adquisiciones.purchase_orders(id uuid PRIMARY KEY, company_id uuid, commercial_draft_revision bigint, status text, receipt_status text, correlative text);
CREATE TABLE adquisiciones.purchase_order_items(id uuid PRIMARY KEY, po_id uuid, company_id uuid, item_type text DEFAULT 'PRODUCT', product_id uuid, quantity numeric, quantity_received numeric DEFAULT 0, unit_price numeric, discount_percent numeric DEFAULT 0, discount_unit_amount numeric DEFAULT 0, discount_amount numeric DEFAULT 0, purchase_unit_factor_snapshot numeric, commercial_unit_price_snapshot numeric, updated_at timestamptz, updated_by uuid);
CREATE TABLE adquisiciones.purchase_order_snapshots(id uuid PRIMARY KEY, po_id uuid, company_id uuid, snapshot_type text, items_snapshot jsonb);
CREATE TABLE adquisiciones.commercial_draft_write_capabilities(transaction_id bigint,backend_pid integer,PRIMARY KEY(transaction_id,backend_pid));
CREATE TABLE logistica.purchase_receipts(id uuid PRIMARY KEY, company_id uuid, purchase_order_id uuid, receipt_number text, receiving_type text, warehouse_id uuid, document_type text, document_number text, document_date date, notes text, status text, idempotency_key uuid, receipt_total_net numeric, receipt_total_tax numeric, receipt_total_gross numeric);
CREATE TABLE logistica.purchase_receipt_items(id uuid PRIMARY KEY, company_id uuid, receipt_id uuid, purchase_order_item_id uuid, product_id uuid, quantity_ordered numeric, quantity_received numeric, quantity_rejected numeric DEFAULT 0, quantity_missing numeric DEFAULT 0, condition text, rejection_reason text, difference_reason text, location_id uuid, lot_number text, expiration_date date, notes text, unit_cost numeric, net_amount numeric, tax_amount numeric, gross_amount numeric);
CREATE TABLE logistica.receipt_documents(company_id uuid, receipt_id uuid, document_type text, document_number text, file_url text, storage_bucket text, storage_path text, document_date date, file_name text, file_size bigint, mime_type text, notes text, created_by uuid);
CREATE TABLE logistica.kardex_movements(company_id uuid, source_type text, source_id uuid, source_line_id uuid, quantity numeric, unit_cost numeric, total_cost numeric);
CREATE TABLE integraciones.bsale_products(company_id uuid, bsale_id bigint, stock_control boolean);
CREATE TABLE integraciones.bsale_variants(company_id uuid, bsale_id bigint, bsale_product_id bigint);
CREATE TABLE integraciones.bsale_purchase_receipt_settings(company_id uuid PRIMARY KEY, enabled boolean, office_id bigint, service_variant_id bigint);
CREATE TABLE integraciones.bsale_purchase_receipt_operations(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, company_id uuid, purchase_receipt_id uuid UNIQUE, correlation_code text, office_id bigint, status text DEFAULT 'PREPARED', error_message text, created_by uuid, bsale_reception_id bigint, confirmed_at timestamptz, payload_snapshot jsonb DEFAULT '{}'::jsonb);
CREATE FUNCTION integraciones.purchase_receipt_payload_is_valid(jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_typeof($1) = 'object' AND jsonb_typeof($1->'details') = 'array' AND jsonb_array_length($1->'details') > 0 $$;
CREATE FUNCTION adquisiciones.guard_commercial_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION adquisiciones.guard_commercial_po_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION adquisiciones.guard_commercial_po_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER guard_receipt BEFORE INSERT OR UPDATE OF purchase_order_id ON logistica.purchase_receipts FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_commercial_receipt();
CREATE TRIGGER guard_item BEFORE INSERT OR UPDATE OF purchase_order_item_id ON logistica.purchase_receipt_items FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_commercial_receipt();
CREATE TRIGGER guard_po_item BEFORE INSERT OR UPDATE ON adquisiciones.purchase_order_items FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_commercial_po_item();
CREATE TRIGGER guard_status BEFORE UPDATE OF status ON adquisiciones.purchase_orders FOR EACH ROW EXECUTE FUNCTION adquisiciones.guard_commercial_po_status();
-- Simulate the legacy receipt's order lock, idempotency, amount calculation,
-- line insertion, Kardex and status update, using internal quantities.
CREATE FUNCTION logistica.create_purchase_receipt_db(uuid,uuid,text,uuid,text,text,text,date,jsonb,uuid,uuid,jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r uuid:=gen_random_uuid(); x jsonb; i adquisiciones.purchase_order_items%ROWTYPE; n numeric; q numeric; rid uuid;
BEGIN
 SELECT id INTO rid FROM logistica.purchase_receipts WHERE company_id=$1 AND idempotency_key=$11;
 IF FOUND THEN RETURN jsonb_build_object('success',true,'idempotent',true,'receipt_id',rid); END IF;
 INSERT INTO logistica.purchase_receipts(id,company_id,purchase_order_id,receipt_number,document_type,document_number,notes,status,idempotency_key) VALUES(r,$1,$2,'REC-'||left(r::text,6),$6,$7,$5,'COMPLETED',$11);
 FOR x IN SELECT value FROM jsonb_array_elements($9) LOOP
   SELECT * INTO i FROM adquisiciones.purchase_order_items WHERE id=(x->>'id')::uuid AND po_id=$2 FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'item missing'; END IF;
   q:=(x->>'quantity')::numeric;
   IF q<=0 OR i.quantity_received+q>i.quantity THEN RAISE EXCEPTION 'invalid quantity'; END IF;
   n:=q*10; rid:=gen_random_uuid();
   INSERT INTO logistica.purchase_receipt_items(id,company_id,receipt_id,purchase_order_item_id,product_id,quantity_ordered,quantity_received,condition,unit_cost,net_amount,tax_amount,gross_amount) VALUES(rid,$1,r,i.id,i.product_id,i.quantity,q,'CONFORME',10,n,n*.19,n*1.19);
   UPDATE adquisiciones.purchase_order_items SET quantity_received=quantity_received+q WHERE id=i.id;
   INSERT INTO logistica.kardex_movements VALUES($1,'PURCHASE_RECEIPT',r,rid,q,10,n);
 END LOOP;
 UPDATE logistica.purchase_receipts SET receipt_total_net=999,receipt_total_tax=999,receipt_total_gross=999 WHERE id=r;
 UPDATE adquisiciones.purchase_orders SET status=CASE WHEN EXISTS(SELECT 1 FROM adquisiciones.purchase_order_items WHERE po_id=$2 AND quantity_received<quantity) THEN 'RECEPCION_PARCIAL' ELSE 'RECEPCION_TOTAL' END WHERE id=$2;
 RETURN jsonb_build_object('success',true,'receipt_id',r);
END $$;
\ir ../supabase/migrations/20261126130000_logistica_commercial_receipt_economics.sql

DO $$
DECLARE c uuid:='10000000-0000-0000-0000-000000000001'; u uuid:=auth.uid(); p uuid:=gen_random_uuid(); p2 uuid:=gen_random_uuid(); i uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); r jsonb; r_idem jsonb; key uuid; j integer; n numeric; t numeric; d numeric; g numeric; items_payload jsonb;
BEGIN
 INSERT INTO adquisiciones.purchase_orders VALUES(p,c,1,'BORRADOR','PENDIENTE','OC-TEST-001');
 INSERT INTO adquisiciones.purchase_orders VALUES(p2,c,0,'CONFIRMADA','PENDIENTE','OC-TEST-002');
 INSERT INTO adquisiciones.purchase_order_items(id,po_id,company_id,quantity,purchase_unit_factor_snapshot,commercial_unit_price_snapshot) VALUES(i,p,c,900,6,9500);
 INSERT INTO adquisiciones.commercial_draft_write_capabilities VALUES(txid_current(),pg_backend_pid());
 UPDATE adquisiciones.purchase_orders SET status='EMITIDA' WHERE id=p;
 UPDATE adquisiciones.purchase_orders SET status='ENVIADA_PROVEEDOR' WHERE id=p;
 UPDATE adquisiciones.purchase_orders SET status='CONFIRMADA' WHERE id=p;
 DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
 INSERT INTO adquisiciones.purchase_order_snapshots VALUES(s,p,c,'CONFIRMED',jsonb_build_array(jsonb_build_object('item_id',i,'quantity',900,'purchase_unit_snapshot','DISPLAY','purchase_unit_factor_snapshot',6,'commercial_unit_price_snapshot',9500,'commercial_gross_amount_snapshot',1425000,'discount_amount',90000,'tax_amount',253650,'line_total',1588650)));
 BEGIN INSERT INTO logistica.purchase_receipts(id,company_id,purchase_order_id) VALUES(gen_random_uuid(),c,p); RAISE EXCEPTION 'direct receipt accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 FOR j IN 1..3 LOOP
   key:=gen_random_uuid();
   items_payload:=jsonb_build_array(jsonb_build_object('id',i,'quantity',CASE j WHEN 1 THEN 1 WHEN 2 THEN 7 ELSE 892 END));
   r:=logistica.create_purchase_receipt_db(c,p,'WAREHOUSE',NULL,NULL,'FA','1',current_date,items_payload,u,key,NULL);
   IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'receipt failed %',r; END IF;
   IF j=1 THEN
     -- Exact retry returns existing receipt without duplicating data
     r_idem:=logistica.create_purchase_receipt_db(c,p,'WAREHOUSE',NULL,NULL,'FA','1',current_date,items_payload,u,key,NULL);
     IF (r_idem->>'idempotent')::boolean IS NOT TRUE OR (r_idem->>'receipt_id')::uuid<>(r->>'receipt_id')::uuid THEN RAISE EXCEPTION 'idempotency failed %',r_idem; END IF;
     -- Incompatible payload with same key is rejected
     BEGIN
       PERFORM logistica.create_purchase_receipt_db(c,p,'WAREHOUSE',NULL,NULL,'FA','1',current_date,'[]'::jsonb,u,key,NULL);
       RAISE EXCEPTION 'empty incompatible retry accepted';
     EXCEPTION WHEN unique_violation THEN NULL; END;
     BEGIN
       PERFORM logistica.create_purchase_receipt_db(c,p,'WAREHOUSE',NULL,NULL,'FA','1',current_date,jsonb_build_array(jsonb_build_object('id',i,'quantity',2)),u,key,NULL);
       RAISE EXCEPTION 'changed quantity retry accepted';
     EXCEPTION WHEN unique_violation THEN NULL; END;
     -- Reusing key on another PO is rejected
     BEGIN
       PERFORM logistica.create_purchase_receipt_db(c,p2,'WAREHOUSE',NULL,NULL,'FA','1',current_date,items_payload,u,key,NULL);
       RAISE EXCEPTION 'cross-PO key reuse accepted';
     EXCEPTION WHEN unique_violation THEN NULL; END;
   END IF;
 END LOOP;
 SELECT sum(net_amount),sum(tax_amount),sum(commercial_discount_amount),sum(commercial_gross_before_discount) INTO n,t,d,g FROM logistica.purchase_receipt_items WHERE purchase_order_item_id=i;
 IF (n,t,d,g) IS DISTINCT FROM (1335000::numeric,253650::numeric,90000::numeric,1425000::numeric) THEN RAISE EXCEPTION 'wrong totals %,%,%,%',n,t,d,g; END IF;
 IF (SELECT count(*) FROM logistica.purchase_receipts WHERE purchase_order_id=p)<>3 THEN RAISE EXCEPTION 'unexpected receipt count'; END IF;
 IF (SELECT sum(quantity) FROM logistica.kardex_movements WHERE company_id=c)<>900 OR (SELECT sum(total_cost) FROM logistica.kardex_movements WHERE company_id=c)<>n THEN RAISE EXCEPTION 'kardex mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM logistica.purchase_receipt_items x JOIN logistica.purchase_receipts y ON y.id=x.receipt_id WHERE x.purchase_order_item_id=i AND (x.commercial_confirmed_snapshot_id<>s OR x.commercial_confirmed_item->>'purchase_unit_snapshot'<>'DISPLAY' OR y.receipt_total_net<>x.net_amount OR y.receipt_total_tax<>x.tax_amount)) THEN RAISE EXCEPTION 'snapshot or receipt totals mismatch'; END IF;
 IF logistica.commercial_receipt_amount(0.01,0,1,3)+logistica.commercial_receipt_amount(0.01,1,2,3)+logistica.commercial_receipt_amount(0.01,2,3,3)<>0.01 THEN RAISE EXCEPTION 'rounding failed'; END IF;
 IF has_table_privilege('authenticated','logistica.commercial_receipt_capabilities','INSERT') OR has_function_privilege('service_role','logistica.create_purchase_receipt_db_before_commercial(uuid,uuid,text,uuid,text,text,text,date,jsonb,uuid,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'private capability exposed'; END IF;
END $$;
DO $$
DECLARE c uuid:='10000000-0000-0000-0000-000000000001'; u uuid:=auth.uid(); p uuid:=gen_random_uuid(); i uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); r jsonb; k uuid:=gen_random_uuid(); kt uuid:=gen_random_uuid();
BEGIN
 INSERT INTO adquisiciones.purchase_orders VALUES(p,c,1,'BORRADOR','PENDIENTE','OC-TEST-003');
 INSERT INTO adquisiciones.purchase_order_items(id,po_id,company_id,quantity,purchase_unit_factor_snapshot,commercial_unit_price_snapshot) VALUES(i,p,c,6,6,1);
 INSERT INTO adquisiciones.commercial_draft_write_capabilities VALUES(txid_current(),pg_backend_pid());
 UPDATE adquisiciones.purchase_orders SET status='EMITIDA' WHERE id=p;
 UPDATE adquisiciones.purchase_orders SET status='ENVIADA_PROVEEDOR' WHERE id=p;
 UPDATE adquisiciones.purchase_orders SET status='CONFIRMADA' WHERE id=p;
 DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
 INSERT INTO adquisiciones.purchase_order_snapshots VALUES(s,p,c,'CONFIRMED',jsonb_build_array(jsonb_build_object('item_id',i,'quantity',6,'commercial_gross_amount_snapshot',1,'discount_amount',0.33,'tax_amount',0.13,'line_total',0.80)));
 BEGIN
   PERFORM logistica.create_purchase_receipt_db(c,p,'WAREHOUSE',NULL,NULL,'FA','1',current_date,jsonb_build_array(jsonb_build_object('id',i,'quantity',1),jsonb_build_object('id',i,'quantity',6)),u,k,NULL);
   RAISE EXCEPTION 'overflow accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'invalid quantity' THEN RAISE; END IF; END;
 IF EXISTS(SELECT 1 FROM logistica.purchase_receipts WHERE purchase_order_id=p) OR (SELECT quantity_received FROM adquisiciones.purchase_order_items WHERE id=i)<>0 THEN RAISE EXCEPTION 'rollback failed'; END IF;
 r:=logistica.create_purchase_receipt_db(c,p,'WAREHOUSE',NULL,NULL,'FA','1',current_date,jsonb_build_array(jsonb_build_object('id',i,'quantity',6)),u,k,NULL);
 IF NOT EXISTS(SELECT 1 FROM logistica.purchase_receipt_items WHERE receipt_id=(r->>'receipt_id')::uuid AND net_amount=0.67 AND tax_amount=0.13 AND gross_amount=0.80 AND commercial_discount_amount=0.33) THEN RAISE EXCEPTION 'full receipt mismatch'; END IF;
 -- Traditional receipts retain the simulated legacy amounts, do not require a snapshot, and enforce idempotency.
 p:=gen_random_uuid(); i:=gen_random_uuid();
 INSERT INTO adquisiciones.purchase_orders VALUES(p,c,0,'CONFIRMADA','PENDIENTE','OC-TRAD-001');
 INSERT INTO adquisiciones.purchase_order_items(id,po_id,company_id,quantity) VALUES(i,p,c,3);
 r:=logistica.create_purchase_receipt_db(c,p,'WAREHOUSE',NULL,NULL,'FA','1',current_date,jsonb_build_array(jsonb_build_object('id',i,'quantity',3)),u,kt,NULL);
 IF NOT EXISTS(SELECT 1 FROM logistica.purchase_receipt_items WHERE receipt_id=(r->>'receipt_id')::uuid AND net_amount=30 AND tax_amount=5.7 AND commercial_confirmed_snapshot_id IS NULL) OR (SELECT receipt_total_net FROM logistica.purchase_receipts WHERE id=(r->>'receipt_id')::uuid)<>999 THEN RAISE EXCEPTION 'traditional receipt changed'; END IF;
 IF (logistica.create_purchase_receipt_db(c,p,'WAREHOUSE',NULL,NULL,'FA','1',current_date,jsonb_build_array(jsonb_build_object('id',i,'quantity',3)),u,kt,NULL)->>'idempotent')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'traditional idempotency retry failed'; END IF;
 IF (logistica.create_purchase_receipt_db(c,p,'WAREHOUSE',NULL,NULL,'FA','1',current_date,'[]','40000000-0000-0000-0000-000000000099',gen_random_uuid(),NULL)->>'success')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'unauthorized accepted'; END IF;
END $$;
SELECT 'commercial receipt fixture tests passed' AS result;
