\set ON_ERROR_STOP on
-- Disposable instance only.
CREATE SCHEMA adquisiciones; CREATE SCHEMA integraciones; CREATE SCHEMA core; CREATE SCHEMA portal;
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE FUNCTION core.has_company_access(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION core.has_permission_for_company(uuid,uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT CASE WHEN $1 = '40000000-0000-0000-0000-000000000099'::uuid THEN NULL ELSE true END $$;
CREATE FUNCTION portal.user_has_permission(uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION adquisiciones.generate_po_correlative(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'TEST-' || gen_random_uuid()::text $$;
CREATE TABLE adquisiciones.suppliers (id uuid PRIMARY KEY,company_id uuid,supplier_kind text,parent_supplier_id uuid,is_active boolean,status text);
CREATE TABLE adquisiciones.products (id uuid PRIMARY KEY,company_id uuid,is_active boolean,source text,bsale_brand_id bigint);
CREATE TABLE adquisiciones.warehouses(id uuid PRIMARY KEY,company_id uuid,is_active boolean,status text);
CREATE TABLE adquisiciones.authorized_personnel(id uuid PRIMARY KEY,company_id uuid,is_active boolean);
CREATE TABLE integraciones.bsale_brand_supplier_links(company_id uuid,bsale_brand_id bigint,supplier_id uuid);
CREATE TABLE adquisiciones.product_supplier_mappings(id uuid PRIMARY KEY,company_id uuid,product_id uuid,supplier_id uuid,is_active boolean,purchase_unit text,purchase_unit_factor integer);
CREATE TABLE adquisiciones.purchase_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,correlative text,issue_date date,required_date date,supplier_id uuid,warehouse_id uuid,po_type text,currency text,payment_terms text,requested_by uuid,authorized_by uuid,notes text,source_type text,net_total numeric(14,2),discount_total numeric(14,2),tax_total numeric(14,2),exempt_total numeric(14,2),grand_total numeric(14,2),status text,receipt_status text,invoice_status text,created_by uuid,updated_by uuid,updated_at timestamptz);
CREATE TABLE adquisiciones.purchase_order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,po_id uuid REFERENCES adquisiciones.purchase_orders(id),line_number integer,item_type text,product_id uuid,product_description text,unit text,quantity numeric(14,4),unit_price numeric(14,4),discount_percent numeric(5,2),discount_unit_amount numeric(14,4),discount_amount numeric(14,2),tax_rate numeric(5,2),tax_amount numeric(14,2),line_total numeric(14,2),warehouse_id uuid,cost_center text,required_date date,notes text,quantity_received numeric(14,4),quantity_pending numeric(14,4) GENERATED ALWAYS AS (quantity - quantity_received) STORED,created_by uuid,updated_by uuid,updated_at timestamptz,is_active boolean DEFAULT true);
CREATE TABLE adquisiciones.purchase_order_status_history(company_id uuid,po_id uuid,from_status text,to_status text,changed_by uuid);
\ir ../supabase/migrations/20261124170000_adquisiciones_po_commercial_snapshots.sql
\ir ../supabase/migrations/20261124180000_adquisiciones_po_commercial_price_guard.sql
\ir ../supabase/migrations/20261124190000_adquisiciones_save_commercial_draft.sql
\ir ../supabase/migrations/20261124210000_adquisiciones_commercial_draft_connection.sql
\ir ../supabase/migrations/20261124220000_adquisiciones_po_correlative_concurrency.sql
INSERT INTO adquisiciones.suppliers VALUES ('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000000','REAL',NULL,true,'ACTIVE'),('10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000000','BSALE_OPERATIVE',NULL,false,'INACTIVE');
INSERT INTO adquisiciones.products VALUES ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000000',true,'BSALE',48),('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000000',true,'LOCAL',NULL);
INSERT INTO integraciones.bsale_brand_supplier_links VALUES ('10000000-0000-0000-0000-000000000000',48,'10000000-0000-0000-0000-000000000001');
INSERT INTO adquisiciones.product_supplier_mappings VALUES ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000000','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',true,'DISPLAY',6);
INSERT INTO adquisiciones.warehouses VALUES ('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000000',true,'ACTIVE'),('60000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000000',true,'ACTIVE'),('60000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000000',false,'INACTIVE'),('60000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000999',true,'ACTIVE');
INSERT INTO adquisiciones.authorized_personnel VALUES ('70000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000000',true),('70000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000000',false),('70000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000999',true);
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['service_role','authenticated','anon'] LOOP
   IF has_function_privilege(r,'adquisiciones.save_commercial_purchase_draft(uuid,jsonb,uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'internal RPC accessible: %',r; END IF;
   IF has_table_privilege(r,'adquisiciones.commercial_draft_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege(r,'adquisiciones.commercial_draft_write_capabilities','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN RAISE EXCEPTION 'private table accessible: %',r; END IF;
 END LOOP;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='adquisiciones.commercial_draft_requests'::regclass) THEN RAISE EXCEPTION 'RLS disabled'; END IF;
END $$;
GRANT USAGE ON SCHEMA adquisiciones TO service_role;
SET ROLE service_role;
DO $$ BEGIN
 BEGIN PERFORM adquisiciones.save_commercial_purchase_draft(NULL,'{}'::jsonb,NULL,NULL); RAISE EXCEPTION 'internal RPC callable'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM * FROM adquisiciones.commercial_draft_requests; RAISE EXCEPTION 'request table readable'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO adquisiciones.commercial_draft_write_capabilities VALUES (txid_current(),pg_backend_pid()); RAISE EXCEPTION 'capability writable'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DO $$
DECLARE c uuid := '10000000-0000-0000-0000-000000000000'; u uuid := '40000000-0000-0000-0000-000000000001'; p uuid; i uuid; r jsonb; payload jsonb;
BEGIN
  INSERT INTO adquisiciones.commercial_draft_write_capabilities VALUES (txid_current(),pg_backend_pid());
  payload := '{"supplier_id":"10000000-0000-0000-0000-000000000001","items":[{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000001","product_description":"513135","quantity":600,"purchase_unit_snapshot":"DISPLAY","purchase_unit_factor_snapshot":6,"product_supplier_mapping_id":"30000000-0000-0000-0000-000000000001","commercial_unit_price":10000,"discount_percent":10,"tax_rate":19},{"item_type":"SERVICE","product_description":"Servicio","quantity":2,"unit_price":100,"discount_unit_amount":10,"tax_rate":19},{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000002","product_description":"Pendiente","quantity":1,"purchase_unit_snapshot":null,"purchase_unit_factor_snapshot":1,"product_supplier_mapping_id":null,"commercial_unit_price":5,"tax_rate":0}]}'::jsonb;
  payload := payload || '{"warehouse_id":"60000000-0000-0000-0000-000000000001","authorized_by":"70000000-0000-0000-0000-000000000001"}'::jsonb;
  payload := jsonb_set(payload,'{items,0}',(payload->'items'->0)||'{"warehouse_id":"60000000-0000-0000-0000-000000000002","unit":"UNIDAD","cost_center":"CC-01","required_date":"2026-12-01"}'::jsonb);
  BEGIN PERFORM adquisiciones.save_commercial_purchase_draft(NULL,jsonb_set(payload,'{items,0,purchase_unit_factor_snapshot}','12'),u,c); RAISE EXCEPTION 'mismatch accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'La configuración comercial cambió%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.save_commercial_purchase_draft(NULL,jsonb_set(payload,'{items,0,purchase_unit_snapshot}','"CAJA"'),u,c); RAISE EXCEPTION 'unit mismatch accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'La configuración comercial cambió%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.save_commercial_purchase_draft(NULL,jsonb_set(payload,'{items,0,product_supplier_mapping_id}','null'),u,c); RAISE EXCEPTION 'mapping mismatch accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'La configuración comercial cambió%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.save_commercial_purchase_draft(NULL,payload||'{"warehouse_id":"60000000-0000-0000-0000-000000000003"}'::jsonb,u,c); RAISE EXCEPTION 'inactive warehouse accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Bodega de cabecera%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.save_commercial_purchase_draft(NULL,payload||'{"warehouse_id":"60000000-0000-0000-0000-000000000004"}'::jsonb,u,c); RAISE EXCEPTION 'foreign warehouse accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Bodega de cabecera%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.save_commercial_purchase_draft(NULL,jsonb_set(payload,'{items,0,warehouse_id}','"60000000-0000-0000-0000-000000000003"'),u,c); RAISE EXCEPTION 'inactive line warehouse accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Bodega de línea%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.save_commercial_purchase_draft(NULL,jsonb_set(payload,'{items,0,warehouse_id}','"60000000-0000-0000-0000-000000000004"'),u,c); RAISE EXCEPTION 'foreign line warehouse accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Bodega de línea%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.save_commercial_purchase_draft(NULL,payload||'{"authorized_by":"70000000-0000-0000-0000-000000000002"}'::jsonb,u,c); RAISE EXCEPTION 'inactive approver accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Autorizador inválido%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.save_commercial_purchase_draft(NULL,payload||'{"authorized_by":"70000000-0000-0000-0000-000000000003"}'::jsonb,u,c); RAISE EXCEPTION 'foreign approver accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Autorizador inválido%' THEN RAISE; END IF; END;
  BEGIN
    PERFORM adquisiciones.save_commercial_purchase_draft(NULL,payload,'40000000-0000-0000-0000-000000000099',c);
    RAISE EXCEPTION 'null permission accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Sin acceso%' THEN RAISE; END IF; END;
  r := adquisiciones.save_commercial_purchase_draft(NULL,payload,u,c); p := (r->>'po_id')::uuid;
  IF (r->>'gross_total')::numeric<>1000205 OR (r->>'discount_total')::numeric<>100020 OR (r->>'net_total')::numeric<>900185 OR (r->>'tax_total')::numeric<>171034.20 OR (r->>'grand_total')::numeric<>1071219.20 THEN RAISE EXCEPTION 'bad totals %',r; END IF;
  SELECT id INTO i FROM adquisiciones.purchase_order_items WHERE po_id=p AND product_description='513135';
  IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=i AND quantity=600 AND unit_price=1666.6667 AND purchase_unit_snapshot='DISPLAY' AND purchase_unit_factor_snapshot=6 AND commercial_unit_price_snapshot=10000 AND commercial_gross_amount_snapshot=1000000 AND discount_amount=100000) THEN RAISE EXCEPTION 'bad persisted product'; END IF;
  IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE po_id=p AND product_description='Pendiente' AND purchase_unit_snapshot IS NULL AND purchase_unit_factor_snapshot=1 AND commercial_unit_price_snapshot=5) THEN RAISE EXCEPTION 'pending missing'; END IF;
  UPDATE adquisiciones.product_supplier_mappings SET purchase_unit='CAJA',purchase_unit_factor=12 WHERE id='30000000-0000-0000-0000-000000000001';
  payload := jsonb_build_object('supplier_id','10000000-0000-0000-0000-000000000001','items',jsonb_build_array(jsonb_build_object('item_id',i,'item_type','PRODUCT','product_id','20000000-0000-0000-0000-000000000001','product_description','513135','quantity',6,'commercial_unit_price',10000,'discount_unit_amount',100,'tax_rate',19)));
  r := adquisiciones.save_commercial_purchase_draft(p,payload,u,c);
  IF (r->>'gross_total')::numeric<>10000 OR (r->>'discount_total')::numeric<>600 OR (r->>'net_total')::numeric<>9400 OR (r->>'tax_total')::numeric<>1786 THEN RAISE EXCEPTION 'bad edit totals %',r; END IF;
  IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=i AND purchase_unit_snapshot='DISPLAY' AND purchase_unit_factor_snapshot=6 AND unit='UNIDAD' AND warehouse_id='60000000-0000-0000-0000-000000000002' AND cost_center='CC-01' AND required_date='2026-12-01') THEN RAISE EXCEPTION 'snapshot or line fields changed'; END IF;
  BEGIN
    PERFORM adquisiciones.save_commercial_purchase_draft(p,jsonb_set(payload,'{items,0,quantity}','7'),u,c);
    RAISE EXCEPTION 'invalid multiple accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Debe ser múltiplo%' THEN RAISE; END IF; END;
  IF (SELECT quantity FROM adquisiciones.purchase_order_items WHERE id=i)<>6 OR (SELECT net_total FROM adquisiciones.purchase_orders WHERE id=p)<>9400 THEN RAISE EXCEPTION 'rollback failed'; END IF;
  BEGIN
    PERFORM adquisiciones.save_commercial_purchase_draft(p, jsonb_set(payload,'{items}',jsonb_build_array((payload->'items'->0)||'{"quantity":12}'::jsonb,'{"item_type":"SERVICE","product_description":"invalido","quantity":1,"unit_price":10,"discount_percent":101}'::jsonb)),u,c);
    RAISE EXCEPTION 'invalid second line accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='invalid second line accepted' THEN RAISE; END IF; END;
  IF (SELECT quantity FROM adquisiciones.purchase_order_items WHERE id=i)<>6 OR (SELECT net_total FROM adquisiciones.purchase_orders WHERE id=p)<>9400 THEN RAISE EXCEPTION 'partial edit survived rollback'; END IF;
  BEGIN
    PERFORM adquisiciones.save_commercial_purchase_draft(NULL,jsonb_set(payload,'{items,0,item_id}','null'),u,c);
    RAISE EXCEPTION 'unexpected success';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='unexpected success' THEN RAISE; END IF; END;
  IF (SELECT count(*) FROM adquisiciones.purchase_orders)<>1 THEN RAISE EXCEPTION 'failed creation left header'; END IF;
  INSERT INTO adquisiciones.product_supplier_mappings VALUES ('30000000-0000-0000-0000-000000000002',c,'20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',true,'DISPLAY',6);
  BEGIN
    PERFORM adquisiciones.save_commercial_purchase_draft(NULL,jsonb_set(payload,'{items,0,item_id}','null'),u,c);
    RAISE EXCEPTION 'ambiguous mapping accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Mapeo comercial ambiguo%' THEN RAISE; END IF; END;
  IF (SELECT count(*) FROM adquisiciones.purchase_orders)<>1 THEN RAISE EXCEPTION 'ambiguous mapping left header'; END IF;
  BEGIN UPDATE adquisiciones.purchase_orders SET status='EMITIDA' WHERE id=p; RAISE EXCEPTION 'emission accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  DELETE FROM adquisiciones.product_supplier_mappings WHERE id='30000000-0000-0000-0000-000000000002';
  UPDATE adquisiciones.product_supplier_mappings SET purchase_unit='DISPLAY',purchase_unit_factor=6 WHERE id='30000000-0000-0000-0000-000000000001';
  DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
END $$;
DO $$
DECLARE c uuid := '10000000-0000-0000-0000-000000000000'; u uuid := '40000000-0000-0000-0000-000000000001'; request uuid := '50000000-0000-0000-0000-000000000001'; payload jsonb; a jsonb; b jsonb; p uuid;
BEGIN
  payload := '{"supplier_id":"10000000-0000-0000-0000-000000000001","items":[{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000002","product_description":"Pendiente","quantity":1,"purchase_unit_snapshot":null,"purchase_unit_factor_snapshot":1,"product_supplier_mapping_id":null,"commercial_unit_price":"12.3456","tax_rate":19}]}'::jsonb;
  a := adquisiciones.save_commercial_draft_request(NULL,payload,u,c,request,NULL);
  b := adquisiciones.save_commercial_draft_request(NULL,payload,u,c,request,NULL);
  IF a IS DISTINCT FROM b OR (a->>'revision')::integer<>1 OR a->'lines'->0->>'commercial_unit_price_snapshot'<>'12.3456' THEN RAISE EXCEPTION 'idempotent create or precise price failed'; END IF;
  p := (a->>'po_id')::uuid;
  IF (SELECT count(*) FROM adquisiciones.commercial_draft_requests WHERE request_id=request)<>1 THEN RAISE EXCEPTION 'duplicate request'; END IF;
  IF adquisiciones.get_commercial_draft_snapshots(p,u,c)->'lines'->0->>'id' <> a->'lines'->0->>'id' THEN RAISE EXCEPTION 'recovery lost identity'; END IF;
  BEGIN PERFORM adquisiciones.save_commercial_draft_request(p,payload,u,c,'50000000-0000-0000-0000-000000000002',0); RAISE EXCEPTION 'stale edit accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'El borrador cambió%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.save_commercial_draft_request(NULL,payload || '{"notes":"other"}'::jsonb,u,c,request,NULL); RAISE EXCEPTION 'request reuse accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'La clave de guardado%' THEN RAISE; END IF; END;
  payload := jsonb_set(payload,'{items,0,item_id}',a->'lines'->0->'id');
  payload := jsonb_set(payload,'{items,0,commercial_unit_price}','"10000.0001"');
  b := adquisiciones.save_commercial_draft_request(p,payload,u,c,'50000000-0000-0000-0000-000000000003',1);
  IF (b->>'revision')::integer<>2 OR b->'lines'->0->>'id'<>a->'lines'->0->>'id' OR b->'lines'->0->>'commercial_unit_price_snapshot'<>'10000.0001' THEN RAISE EXCEPTION 'round trip lost identity or price'; END IF;
  BEGIN DELETE FROM adquisiciones.purchase_order_items WHERE po_id=p; RAISE EXCEPTION 'legacy delete accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE adquisiciones.purchase_orders SET commercial_draft_revision=0 WHERE id=p; RAISE EXCEPTION 'revision bypass accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE adquisiciones.purchase_order_items SET purchase_unit_factor_snapshot=NULL WHERE po_id=p; RAISE EXCEPTION 'legacy update accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO adquisiciones.purchase_order_items(company_id,po_id,line_number,item_type,product_description,quantity,unit_price) VALUES (c,p,99,'SERVICE','legacy',1,1); RAISE EXCEPTION 'legacy insert accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO adquisiciones.purchase_orders(id,company_id,status,source_type) VALUES ('80000000-0000-0000-0000-000000000001',c,'BORRADOR','MANUAL');
  INSERT INTO adquisiciones.purchase_order_items(id,company_id,po_id,line_number,item_type,product_description,quantity,unit_price) VALUES ('80000000-0000-0000-0000-000000000002',c,'80000000-0000-0000-0000-000000000001',1,'SERVICE','legacy',1,1);
  BEGIN UPDATE adquisiciones.purchase_order_items SET po_id=p WHERE id='80000000-0000-0000-0000-000000000002'; RAISE EXCEPTION 'legacy move accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO adquisiciones.purchase_order_items(company_id,po_id,line_number,item_type,product_id,product_description,quantity,unit_price,purchase_unit_snapshot,purchase_unit_factor_snapshot) VALUES (c,'80000000-0000-0000-0000-000000000001',2,'PRODUCT','20000000-0000-0000-0000-000000000001','direct',6,1,'DISPLAY',6); RAISE EXCEPTION 'direct commercial insert accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE adquisiciones.purchase_orders SET status='CANCELADA' WHERE id=p;
  BEGIN DELETE FROM adquisiciones.purchase_order_items WHERE po_id=p; RAISE EXCEPTION 'cancelled history deleted'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
DO $$
DECLARE c uuid := '10000000-0000-0000-0000-000000000000'; u uuid := '40000000-0000-0000-0000-000000000001'; r jsonb;
BEGIN
 r := adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","items":[{"item_type":"SERVICE","product_description":"a","quantity":1,"unit_price":0.025,"tax_rate":19},{"item_type":"SERVICE","product_description":"b","quantity":1,"unit_price":0.025,"tax_rate":19}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000004',NULL);
 IF (r->>'net_total')::numeric <> 0.06 OR (r->>'tax_total')::numeric <> 0.02 OR (r->>'grand_total')::numeric <> 0.08 THEN RAISE EXCEPTION 'line rounding mismatch: %',r; END IF;
 IF EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE po_id=(r->>'po_id')::uuid AND (commercial_gross_amount_snapshot<>0.03 OR discount_amount<>0 OR tax_amount<>0.01 OR line_total<>0.04)) THEN RAISE EXCEPTION 'persisted line mismatch'; END IF;
 IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_orders p WHERE p.id=(r->>'po_id')::uuid AND p.net_total=0.06 AND p.tax_total=0.02 AND p.grand_total=0.08 AND p.grand_total=(SELECT sum(line_total) FROM adquisiciones.purchase_order_items WHERE po_id=p.id)) THEN RAISE EXCEPTION 'header mismatch'; END IF;
 r := adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","items":[{"item_type":"SERVICE","product_description":"percent","quantity":1,"unit_price":0.055,"discount_percent":50,"tax_rate":0},{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000002","product_description":"traditional","quantity":2,"purchase_unit_snapshot":null,"purchase_unit_factor_snapshot":1,"product_supplier_mapping_id":null,"commercial_unit_price":0.025,"discount_unit_amount":0.01,"tax_rate":19}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000005',NULL);
 IF (r->>'gross_total')::numeric<>0.11 OR (r->>'discount_total')::numeric<>0.05 OR (r->>'net_total')::numeric<>0.06 OR (r->>'tax_total')::numeric<>0.01 OR (r->>'grand_total')::numeric<>0.07 THEN RAISE EXCEPTION 'discount rounding mismatch: %',r; END IF;
 IF EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE po_id=(r->>'po_id')::uuid AND line_total<>commercial_gross_amount_snapshot-discount_amount+tax_amount) THEN RAISE EXCEPTION 'discount line mismatch'; END IF;
END $$;
SELECT 'atomic commercial draft tests passed' AS result;
