\set ON_ERROR_STOP on
-- Only for a disposable database.
\ir test-send-commercial-order-postgres.sql
CREATE SCHEMA logistica;
CREATE TABLE logistica.purchase_receipts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,purchase_order_id uuid NOT NULL REFERENCES adquisiciones.purchase_orders(id) ON DELETE CASCADE);
CREATE TABLE logistica.purchase_receipt_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,receipt_id uuid NOT NULL REFERENCES logistica.purchase_receipts(id) ON DELETE CASCADE,purchase_order_item_id uuid NOT NULL REFERENCES adquisiciones.purchase_order_items(id) ON DELETE CASCADE,quantity_received numeric NOT NULL);
ALTER TABLE adquisiciones.products ADD COLUMN description text, ADD COLUMN unit_of_measure text;
UPDATE adquisiciones.products SET description='Descripción del catálogo',unit_of_measure='UNIDAD-CATÁLOGO' WHERE id='20000000-0000-0000-0000-000000000001';
\ir ../supabase/migrations/20261125140000_adquisiciones_commercial_supplier_review.sql
DO $$
DECLARE c uuid:='10000000-0000-0000-0000-000000000000'; u uuid:='40000000-0000-0000-0000-000000000001'; p uuid; i uuid; s uuid; r jsonb; again jsonb; original jsonb; payload jsonb; before_order jsonb;
BEGIN
  INSERT INTO adquisiciones.product_supplier_mappings VALUES ('30000000-0000-0000-0000-000000000099',c,'20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',true,'DISPLAY',6);
  r:=adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","warehouse_id":"60000000-0000-0000-0000-000000000001","items":[{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000002","product_description":"display","quantity":600,"purchase_unit_snapshot":"DISPLAY","purchase_unit_factor_snapshot":6,"product_supplier_mapping_id":"30000000-0000-0000-0000-000000000099","commercial_unit_price":10000,"tax_rate":19},{"item_type":"SERVICE","product_description":"servicio","quantity":1,"unit_price":100,"tax_rate":0}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000070',NULL);
  p:=(r->>'po_id')::uuid; i:=(r->'lines'->0->>'id')::uuid; s:=(r->'lines'->1->>'id')::uuid;
  PERFORM adquisiciones.emit_commercial_purchase_draft(p,1,u,c); PERFORM adquisiciones.send_commercial_purchase_order(p,u,c);
  SELECT to_jsonb(x) INTO original FROM adquisiciones.purchase_order_snapshots x WHERE po_id=p AND snapshot_type='ORIGINAL_SENT';
  payload:=jsonb_build_object('items',jsonb_build_array(jsonb_build_object('item_id',i,'item_type','PRODUCT','product_id','20000000-0000-0000-0000-000000000002','quantity',600,'commercial_unit_price','10000','discount_percent',10,'tax_rate',19),jsonb_build_object('item_id',s,'item_type','SERVICE','quantity',1,'unit_price',100,'tax_rate',0)));
  r:=adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000071',1);
  IF (r->>'net_total')::numeric<>900100 OR (r->>'tax_total')::numeric<>171000 OR (r->>'grand_total')::numeric<>1071100 OR (r->>'revision')::int<>2 THEN RAISE EXCEPTION 'incorrect economics %',r; END IF;
  IF NOT EXISTS(SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=i AND commercial_gross_amount_snapshot=1000000 AND unit_price=1666.6667 AND historical_product_supplier_mapping_id='30000000-0000-0000-0000-000000000099') THEN RAISE EXCEPTION 'lost exact price or mapping'; END IF;
  again:=adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000071',1); IF again IS DISTINCT FROM r THEN RAISE EXCEPTION 'retry changed'; END IF;
  BEGIN PERFORM adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000072',1); RAISE EXCEPTION 'stale accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'La revisión cambió%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.save_commercial_supplier_review(p,payload,'40000000-0000-0000-0000-000000000099',c,'50000000-0000-0000-0000-000000000073',2); RAISE EXCEPTION 'unauthorized accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Sin acceso%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.save_commercial_supplier_review(p,payload,u,'10000000-0000-0000-0000-000000000999','50000000-0000-0000-0000-000000000074',2); RAISE EXCEPTION 'foreign accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Orden comercial enviada%' THEN RAISE; END IF; END;
  SELECT to_jsonb(x) INTO before_order FROM adquisiciones.purchase_orders x WHERE id=p;
  BEGIN PERFORM adquisiciones.save_commercial_supplier_review(p,jsonb_set(payload,'{items,0,quantity}','605'),u,c,'50000000-0000-0000-0000-000000000075',2); RAISE EXCEPTION 'invalid accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Debe ser múltiplo%' THEN RAISE; END IF; END;
  IF before_order IS DISTINCT FROM (SELECT to_jsonb(x) FROM adquisiciones.purchase_orders x WHERE id=p) THEN RAISE EXCEPTION 'partial update survived'; END IF;
  payload:=jsonb_build_object('items',jsonb_build_array(jsonb_build_object('item_id',s,'item_type','SERVICE','quantity',1,'unit_price',100,'tax_rate',0)));
  PERFORM adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000076',2);
  DELETE FROM adquisiciones.product_supplier_mappings WHERE id='30000000-0000-0000-0000-000000000099';
  payload:=jsonb_build_object('items',jsonb_build_array(jsonb_build_object('item_id',i,'item_type','PRODUCT','product_id','20000000-0000-0000-0000-000000000002'),jsonb_build_object('item_id',s,'item_type','SERVICE','quantity',1,'unit_price',100,'tax_rate',0)));
  r:=adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000077',3);
  IF NOT EXISTS(SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=i AND quantity=600 AND purchase_unit_snapshot='DISPLAY' AND purchase_unit_factor_snapshot=6 AND product_supplier_mapping_id IS NULL AND historical_product_supplier_mapping_id='30000000-0000-0000-0000-000000000099' AND commercial_unit_price_snapshot=10000 AND commercial_gross_amount_snapshot=1000000) THEN RAISE EXCEPTION 'restore lost historical commercial values'; END IF;
  IF (SELECT to_jsonb(x) FROM adquisiciones.purchase_order_snapshots x WHERE po_id=p AND snapshot_type='ORIGINAL_SENT') IS DISTINCT FROM original THEN RAISE EXCEPTION 'original snapshot changed'; END IF;
  IF (SELECT status FROM adquisiciones.purchase_orders WHERE id=p)<>'ENVIADA_PROVEEDOR' THEN RAISE EXCEPTION 'status changed'; END IF;
  BEGIN UPDATE adquisiciones.purchase_orders SET status='CONFIRMADA' WHERE id=p; RAISE EXCEPTION 'confirmation accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  IF (adquisiciones.get_commercial_supplier_review_state(p,u,c)->>'revision')::int<>4 THEN RAISE EXCEPTION 'read revision mismatch'; END IF;
  payload:=jsonb_build_object('items',jsonb_build_array(jsonb_build_object('item_id',i,'item_type','PRODUCT','product_id','20000000-0000-0000-0000-000000000002','quantity',600,'commercial_unit_price',10000,'tax_rate',19),jsonb_build_object('item_id',s,'item_type','SERVICE','quantity',1,'unit_price',100,'tax_rate',0),'{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000001","product_description":"nuevo","quantity":6,"purchase_unit_snapshot":"DISPLAY","purchase_unit_factor_snapshot":6,"product_supplier_mapping_id":"30000000-0000-0000-0000-000000000001","commercial_unit_price":10000,"tax_rate":19}'::jsonb));
  r:=adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000078',4);
  IF (r->>'revision')::int<>5 OR NOT EXISTS(SELECT 1 FROM adquisiciones.purchase_order_items WHERE po_id=p AND product_description='Descripción del catálogo' AND unit='UNIDAD-CATÁLOGO' AND quantity=6 AND commercial_gross_amount_snapshot=10000 AND historical_product_supplier_mapping_id='30000000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'new commercial product did not use validated catalog'; END IF;
  BEGIN PERFORM adquisiciones.save_commercial_supplier_review(p,jsonb_set(payload,'{items,0,quantity}','606'),u,c,'50000000-0000-0000-0000-000000000078',4); RAISE EXCEPTION 'request reuse accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'La clave de guardado%' THEN RAISE; END IF; END;
  SELECT to_jsonb(x) INTO before_order FROM adquisiciones.purchase_orders x WHERE id=p;
  INSERT INTO adquisiciones.product_supplier_mappings VALUES ('30000000-0000-0000-0000-000000000098',c,'20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',true,'CAJA',12);
  BEGIN PERFORM adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000079',5); RAISE EXCEPTION 'ambiguous mapping accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Mapeo comercial ambiguo%' THEN RAISE; END IF; END;
  IF before_order IS DISTINCT FROM (SELECT to_jsonb(x) FROM adquisiciones.purchase_orders x WHERE id=p) OR (SELECT count(*) FROM adquisiciones.purchase_order_items WHERE po_id=p)<>3 THEN RAISE EXCEPTION 'failed second-line update was not atomic'; END IF;
  IF has_function_privilege('authenticated','adquisiciones.save_commercial_supplier_review(uuid,jsonb,uuid,uuid,uuid,bigint)','EXECUTE') OR has_table_privilege('service_role','adquisiciones.commercial_review_requests','SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'review capability exposed'; END IF;
END $$;
DO $$
DECLARE c uuid:='10000000-0000-0000-0000-000000000000'; u uuid:='40000000-0000-0000-0000-000000000001'; p uuid; i uuid; r jsonb; original jsonb; payload jsonb;
BEGIN
  INSERT INTO adquisiciones.product_supplier_mappings VALUES ('30000000-0000-0000-0000-000000000097',c,'20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',true,'DISPLAY',6);
  r:=adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","warehouse_id":"60000000-0000-0000-0000-000000000001","items":[{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000002","product_description":"histórico","quantity":6,"purchase_unit_snapshot":"DISPLAY","purchase_unit_factor_snapshot":6,"product_supplier_mapping_id":"30000000-0000-0000-0000-000000000097","commercial_unit_price":10000,"tax_rate":19}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000090',NULL);
  p:=(r->>'po_id')::uuid; i:=(r->'lines'->0->>'id')::uuid;
  PERFORM adquisiciones.emit_commercial_purchase_draft(p,1,u,c); PERFORM adquisiciones.send_commercial_purchase_order(p,u,c);
  SELECT to_jsonb(x) INTO original FROM adquisiciones.purchase_order_snapshots x WHERE po_id=p AND snapshot_type='ORIGINAL_SENT';
  BEGIN UPDATE adquisiciones.purchase_order_items SET product_supplier_mapping_id=NULL WHERE id=i; RAISE EXCEPTION 'direct detach accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  DELETE FROM adquisiciones.product_supplier_mappings WHERE id='30000000-0000-0000-0000-000000000097';
  IF NOT EXISTS(SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=i AND product_supplier_mapping_id IS NULL AND historical_product_supplier_mapping_id='30000000-0000-0000-0000-000000000097' AND quantity=6 AND commercial_unit_price_snapshot=10000) THEN RAISE EXCEPTION 'FK deletion lost historical identity or line values'; END IF;
  payload:=jsonb_build_object('items',jsonb_build_array(jsonb_build_object('item_id',i,'item_type','PRODUCT','product_id','20000000-0000-0000-0000-000000000002','quantity',12,'commercial_unit_price',10000,'tax_rate',19)));
  PERFORM adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000091',1);
  IF NOT EXISTS(SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=i AND product_supplier_mapping_id IS NULL AND historical_product_supplier_mapping_id='30000000-0000-0000-0000-000000000097' AND quantity=12) OR original IS DISTINCT FROM (SELECT to_jsonb(x) FROM adquisiciones.purchase_order_snapshots x WHERE po_id=p AND snapshot_type='ORIGINAL_SENT') THEN RAISE EXCEPTION 'subsequent review lost history'; END IF;
END $$;
DO $$
DECLARE c uuid:='10000000-0000-0000-0000-000000000000'; u uuid:='40000000-0000-0000-0000-000000000001'; p uuid; i uuid; other_po uuid; receipt uuid; r jsonb; payload jsonb;
BEGIN
  r:=adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","warehouse_id":"60000000-0000-0000-0000-000000000001","items":[{"item_type":"SERVICE","product_description":"servicio","quantity":1,"unit_price":10,"tax_rate":19}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000092',NULL);
  p:=(r->>'po_id')::uuid; i:=(r->'lines'->0->>'id')::uuid;
  PERFORM adquisiciones.emit_commercial_purchase_draft(p,1,u,c); PERFORM adquisiciones.send_commercial_purchase_order(p,u,c);
  payload:=jsonb_build_object('items',jsonb_build_array(jsonb_build_object('item_type','SERVICE','product_description','reemplazo','quantity',1,'unit_price',10,'tax_rate',19)));
  INSERT INTO logistica.purchase_receipts(company_id,purchase_order_id) VALUES(c,p) RETURNING id INTO receipt;
  BEGIN PERFORM adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000093',1); RAISE EXCEPTION 'zero receipt header accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'La orden tiene recepciones%' THEN RAISE; END IF; END;
  IF NOT EXISTS(SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=i) OR NOT EXISTS(SELECT 1 FROM logistica.purchase_receipts WHERE id=receipt) THEN RAISE EXCEPTION 'receipt header or line lost'; END IF;
  DELETE FROM logistica.purchase_receipts WHERE id=receipt;
  INSERT INTO adquisiciones.purchase_orders(company_id,correlative,status,source_type) VALUES(c,'RECEIPT-OTHER','BORRADOR','MANUAL') RETURNING id INTO other_po;
  INSERT INTO logistica.purchase_receipts(company_id,purchase_order_id) VALUES(c,other_po) RETURNING id INTO receipt;
  INSERT INTO logistica.purchase_receipt_items(company_id,receipt_id,purchase_order_item_id,quantity_received) VALUES(c,receipt,i,0);
  BEGIN PERFORM adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000094',1); RAISE EXCEPTION 'zero receipt item accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'La orden tiene recepciones%' THEN RAISE; END IF; END;
  IF NOT EXISTS(SELECT 1 FROM logistica.purchase_receipt_items WHERE purchase_order_item_id=i AND quantity_received=0) OR NOT EXISTS(SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=i) THEN RAISE EXCEPTION 'receipt item was cascaded'; END IF;
END $$;
-- A nested FK update must not be allowed to change a generated column's inputs.
CREATE FUNCTION adquisiciones.test_mutate_fk_quantity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.product_supplier_mapping_id='30000000-0000-0000-0000-000000000095'::uuid AND NEW.product_supplier_mapping_id IS NULL THEN NEW.quantity:=NEW.quantity+6; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_aaa_test_mutate_fk_quantity BEFORE UPDATE OF product_supplier_mapping_id ON adquisiciones.purchase_order_items FOR EACH ROW EXECUTE FUNCTION adquisiciones.test_mutate_fk_quantity();
DO $$
DECLARE c uuid:='10000000-0000-0000-0000-000000000000'; u uuid:='40000000-0000-0000-0000-000000000001'; i uuid; r jsonb;
BEGIN
  INSERT INTO adquisiciones.product_supplier_mappings VALUES ('30000000-0000-0000-0000-000000000095',c,'20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',true,'DISPLAY',6);
  r:=adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","warehouse_id":"60000000-0000-0000-0000-000000000001","items":[{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000002","product_description":"protegido","quantity":6,"purchase_unit_snapshot":"DISPLAY","purchase_unit_factor_snapshot":6,"product_supplier_mapping_id":"30000000-0000-0000-0000-000000000095","commercial_unit_price":10000,"tax_rate":19}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000098',NULL);
  i:=(r->'lines'->0->>'id')::uuid;
  BEGIN DELETE FROM adquisiciones.product_supplier_mappings WHERE id='30000000-0000-0000-0000-000000000095'; RAISE EXCEPTION 'nested quantity change accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  IF NOT EXISTS(SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=i AND quantity=6 AND quantity_pending=6 AND product_supplier_mapping_id='30000000-0000-0000-0000-000000000095' AND historical_product_supplier_mapping_id IS NULL) OR NOT EXISTS(SELECT 1 FROM adquisiciones.product_supplier_mappings WHERE id='30000000-0000-0000-0000-000000000095') THEN RAISE EXCEPTION 'rejected FK update did not roll back'; END IF;
END $$;
DROP TRIGGER trg_aaa_test_mutate_fk_quantity ON adquisiciones.purchase_order_items;
DROP FUNCTION adquisiciones.test_mutate_fk_quantity();
DELETE FROM adquisiciones.product_supplier_mappings WHERE id='30000000-0000-0000-0000-000000000095';
-- Deletion before send: the immutable snapshot must preserve the historical
-- identity separately from the now-null relational link, including restoration.
DO $$
DECLARE c uuid:='10000000-0000-0000-0000-000000000000'; u uuid:='40000000-0000-0000-0000-000000000001'; p uuid; i uuid; s uuid; r jsonb; original jsonb; payload jsonb;
BEGIN
  INSERT INTO adquisiciones.product_supplier_mappings VALUES ('30000000-0000-0000-0000-000000000096',c,'20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',true,'DISPLAY',6);
  r:=adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","warehouse_id":"60000000-0000-0000-0000-000000000001","items":[{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000002","product_description":"histórico","quantity":6,"purchase_unit_snapshot":"DISPLAY","purchase_unit_factor_snapshot":6,"product_supplier_mapping_id":"30000000-0000-0000-0000-000000000096","commercial_unit_price":10000,"tax_rate":19},{"item_type":"SERVICE","product_description":"servicio","quantity":1,"unit_price":10,"tax_rate":0}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000095',NULL);
  p:=(r->>'po_id')::uuid; i:=(r->'lines'->0->>'id')::uuid; s:=(r->'lines'->1->>'id')::uuid;
  PERFORM adquisiciones.emit_commercial_purchase_draft(p,1,u,c);
  DELETE FROM adquisiciones.product_supplier_mappings WHERE id='30000000-0000-0000-0000-000000000096';
  IF NOT EXISTS(SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=i AND quantity_pending=6 AND product_supplier_mapping_id IS NULL AND historical_product_supplier_mapping_id='30000000-0000-0000-0000-000000000096') THEN RAISE EXCEPTION 'pre-send unlink failed'; END IF;
  PERFORM adquisiciones.send_commercial_purchase_order(p,u,c);
  SELECT to_jsonb(x) INTO original FROM adquisiciones.purchase_order_snapshots x WHERE po_id=p AND snapshot_type='ORIGINAL_SENT';
  IF original->'items_snapshot'->0->>'product_supplier_mapping_id' IS NOT NULL OR original->'items_snapshot'->0->>'historical_product_supplier_mapping_id' IS DISTINCT FROM '30000000-0000-0000-0000-000000000096' THEN RAISE EXCEPTION 'pre-send history missing from snapshot %',original; END IF;
  payload:=jsonb_build_object('items',jsonb_build_array(jsonb_build_object('item_id',s,'item_type','SERVICE','quantity',1,'unit_price',10,'tax_rate',0)));
  PERFORM adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000096',1);
  payload:=jsonb_build_object('items',jsonb_build_array(jsonb_build_object('item_id',i,'item_type','PRODUCT','product_id','20000000-0000-0000-0000-000000000002'),jsonb_build_object('item_id',s,'item_type','SERVICE','quantity',1,'unit_price',10,'tax_rate',0)));
  PERFORM adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000097',2);
  IF NOT EXISTS(SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=i AND quantity_pending=6 AND product_supplier_mapping_id IS NULL AND historical_product_supplier_mapping_id='30000000-0000-0000-0000-000000000096') OR original IS DISTINCT FROM (SELECT to_jsonb(x) FROM adquisiciones.purchase_order_snapshots x WHERE po_id=p AND snapshot_type='ORIGINAL_SENT') THEN RAISE EXCEPTION 'pre-send history lost on restore'; END IF;
END $$;
DO $$
DECLARE p uuid;
BEGIN
  SELECT id INTO p FROM adquisiciones.purchase_orders WHERE correlative='TRADITIONAL-SEND';
  UPDATE adquisiciones.purchase_order_items SET quantity=3 WHERE po_id=p;
  IF (SELECT quantity FROM adquisiciones.purchase_order_items WHERE po_id=p)<>3 THEN RAISE EXCEPTION 'traditional item update blocked'; END IF;
  UPDATE adquisiciones.purchase_orders SET status='CONFIRMADA' WHERE id=p;
  IF (SELECT status FROM adquisiciones.purchase_orders WHERE id=p)<>'CONFIRMADA' THEN RAISE EXCEPTION 'traditional status blocked'; END IF;
END $$;
SELECT 'commercial supplier review tests passed' AS result;
