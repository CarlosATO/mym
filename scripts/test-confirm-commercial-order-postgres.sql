\set ON_ERROR_STOP on
-- Run only in a disposable local database.
\if :{?fixture_loaded}
\else
\ir test-commercial-supplier-review-postgres.sql
CREATE OR REPLACE FUNCTION portal.user_has_permission(uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT $2='adquisiciones.po.update' AND $1<>'40000000-0000-0000-0000-000000000099'::uuid $$;
\ir ../supabase/migrations/20260930185030_adquisiciones_confirm_supplier_review.sql
\ir ../supabase/migrations/20261125150000_adquisiciones_confirm_commercial_order.sql
\endif
DO $$
DECLARE c uuid:='10000000-0000-0000-0000-000000000000'; u uuid:='40000000-0000-0000-0000-000000000001'; p uuid; i uuid; r jsonb; orig jsonb; confirmed jsonb; payload jsonb;
BEGIN
  INSERT INTO adquisiciones.product_supplier_mappings VALUES ('30000000-0000-0000-0000-000000000094',c,'20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',true,'DISPLAY',6);
  r:=adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","warehouse_id":"60000000-0000-0000-0000-000000000001","items":[{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000002","product_description":"producto","quantity":600,"purchase_unit_snapshot":"DISPLAY","purchase_unit_factor_snapshot":6,"product_supplier_mapping_id":"30000000-0000-0000-0000-000000000094","commercial_unit_price":10000,"tax_rate":19}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000101',NULL);
  p:=(r->>'po_id')::uuid; i:=(r->'lines'->0->>'id')::uuid;
  PERFORM adquisiciones.emit_commercial_purchase_draft(p,1,u,c); PERFORM adquisiciones.send_commercial_purchase_order(p,u,c);
  SELECT to_jsonb(s) INTO orig FROM adquisiciones.purchase_order_snapshots s WHERE po_id=p AND snapshot_type='ORIGINAL_SENT';
  DELETE FROM adquisiciones.product_supplier_mappings WHERE id='30000000-0000-0000-0000-000000000094';
  payload:=jsonb_build_object('items',jsonb_build_array(jsonb_build_object('item_id',i,'item_type','PRODUCT','product_id','20000000-0000-0000-0000-000000000002','quantity',600,'commercial_unit_price',10000,'discount_percent',10,'tax_rate',19)));
  PERFORM adquisiciones.save_commercial_supplier_review(p,payload,u,c,'50000000-0000-0000-0000-000000000102',1);
  BEGIN PERFORM adquisiciones.confirm_commercial_purchase_order(p,u,c,1); RAISE EXCEPTION 'stale accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'La revisión cambió%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.confirm_commercial_purchase_order(p,'40000000-0000-0000-0000-000000000099',c,2); RAISE EXCEPTION 'unauthorized accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Sin acceso%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.confirm_commercial_purchase_order(p,u,'10000000-0000-0000-0000-000000000999',2); RAISE EXCEPTION 'foreign accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Orden comercial no encontrada%' THEN RAISE; END IF; END;
  BEGIN INSERT INTO logistica.purchase_receipts(company_id,purchase_order_id) VALUES(c,p); RAISE EXCEPTION 'receipt accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  r:=adquisiciones.confirm_commercial_purchase_order(p,u,c,2);
  SELECT items_snapshot->0 INTO confirmed FROM adquisiciones.purchase_order_snapshots WHERE id=(r->>'snapshot_id')::uuid;
  IF r->>'status'<>'CONFIRMADA' OR confirmed->>'historical_product_supplier_mapping_id'<>'30000000-0000-0000-0000-000000000094' OR confirmed->>'product_supplier_mapping_id' IS NOT NULL OR (confirmed->>'quantity')::numeric<>600 OR (confirmed->>'commercial_quantity')::numeric<>100 OR (confirmed->>'commercial_unit_price_snapshot')::numeric<>10000 OR (confirmed->>'commercial_gross_amount_snapshot')::numeric<>1000000 OR (confirmed->>'discount_amount')::numeric<>100000 OR (confirmed->>'tax_amount')::numeric<>171000 THEN RAISE EXCEPTION 'incorrect confirmed snapshot % %',r,confirmed; END IF;
  IF orig IS DISTINCT FROM (SELECT to_jsonb(s) FROM adquisiciones.purchase_order_snapshots s WHERE po_id=p AND snapshot_type='ORIGINAL_SENT') THEN RAISE EXCEPTION 'original changed'; END IF;
  r:=adquisiciones.confirm_commercial_purchase_order(p,u,c,2);
  IF (r->>'already_confirmed')::boolean IS NOT TRUE OR (SELECT count(*) FROM adquisiciones.purchase_order_status_history WHERE po_id=p AND to_status='CONFIRMADA')<>1 OR (SELECT count(*) FROM adquisiciones.purchase_order_snapshots WHERE po_id=p AND snapshot_type='CONFIRMED')<>1 THEN RAISE EXCEPTION 'retry duplicated confirmation'; END IF;
  BEGIN INSERT INTO logistica.purchase_receipts(company_id,purchase_order_id) VALUES(c,p); RAISE EXCEPTION 'confirmed receipt accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  IF has_function_privilege('authenticated','adquisiciones.confirm_commercial_purchase_order(uuid,uuid,uuid,bigint)','EXECUTE') THEN RAISE EXCEPTION 'RPC exposed'; END IF;
END $$;
DO $$
DECLARE c uuid:='10000000-0000-0000-0000-000000000000'; u uuid:='40000000-0000-0000-0000-000000000001'; p uuid; r jsonb; i uuid;
BEGIN
  r:=adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","warehouse_id":"60000000-0000-0000-0000-000000000001","items":[{"item_type":"SERVICE","product_description":"servicio","quantity":2,"unit_price":100,"discount_unit_amount":10,"tax_rate":19}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000103',NULL);
  p:=(r->>'po_id')::uuid; i:=(r->'lines'->0->>'id')::uuid;
  PERFORM adquisiciones.emit_commercial_purchase_draft(p,1,u,c); PERFORM adquisiciones.send_commercial_purchase_order(p,u,c);
  INSERT INTO adquisiciones.commercial_draft_write_capabilities VALUES(txid_current(),pg_backend_pid());
  UPDATE adquisiciones.purchase_order_items SET tax_amount=99 WHERE id=i;
  DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
  BEGIN PERFORM adquisiciones.confirm_commercial_purchase_order(p,u,c,1); RAISE EXCEPTION 'invalid economics accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Datos comerciales o económicos inválidos%' THEN RAISE; END IF; END;
  IF (SELECT status FROM adquisiciones.purchase_orders WHERE id=p)<>'ENVIADA_PROVEEDOR' OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_snapshots WHERE po_id=p AND snapshot_type='CONFIRMED') THEN RAISE EXCEPTION 'invalid confirmation was not atomic'; END IF;
  INSERT INTO adquisiciones.commercial_draft_write_capabilities VALUES(txid_current(),pg_backend_pid());
  UPDATE adquisiciones.purchase_order_items SET tax_amount=34.20 WHERE id=i;
  DELETE FROM adquisiciones.commercial_draft_write_capabilities WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid();
  r:=adquisiciones.confirm_commercial_purchase_order(p,u,c,1);
  IF (SELECT (items_snapshot->0->>'discount_unit_amount')::numeric FROM adquisiciones.purchase_order_snapshots WHERE id=(r->>'snapshot_id')::uuid)<>10 THEN RAISE EXCEPTION 'fixed discount missing'; END IF;
  INSERT INTO adquisiciones.purchase_orders(company_id,correlative,status,source_type,receipt_status) VALUES(c,'TRADITIONAL-CONFIRM','EMITIDA','MANUAL','PENDIENTE') RETURNING id INTO p;
  INSERT INTO adquisiciones.purchase_order_items(company_id,po_id,line_number,item_type,product_description,quantity,unit_price) VALUES(c,p,1,'SERVICE','tradicional',1,10);
  PERFORM adquisiciones.update_purchase_order_status(p,'ENVIADA_PROVEEDOR',NULL,u);
  r:=adquisiciones.confirm_purchase_order_supplier_review(p,u,c);
  IF r->>'status'<>'CONFIRMADA' OR (SELECT items_snapshot->0 ? 'purchase_unit_factor_snapshot' FROM adquisiciones.purchase_order_snapshots WHERE id=(r->>'snapshot_id')::uuid) THEN RAISE EXCEPTION 'traditional confirmation changed'; END IF;
END $$;
SELECT 'commercial confirmation tests passed' AS result;
