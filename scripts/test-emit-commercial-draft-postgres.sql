\set ON_ERROR_STOP on
-- Disposable database only; exercises the existing draft writer and guards.
\ir test-save-commercial-draft-postgres.sql
\ir ../supabase/migrations/20261125120000_adquisiciones_emit_commercial_draft.sql
DO $$
DECLARE c uuid := '10000000-0000-0000-0000-000000000000'; u uuid := '40000000-0000-0000-0000-000000000001'; p uuid; r jsonb; before_lines jsonb; after_lines jsonb; before_header jsonb; after_header jsonb;
BEGIN
  r := adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","warehouse_id":"60000000-0000-0000-0000-000000000001","items":[{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000001","product_description":"display","quantity":600,"purchase_unit_snapshot":"DISPLAY","purchase_unit_factor_snapshot":6,"product_supplier_mapping_id":"30000000-0000-0000-0000-000000000001","commercial_unit_price":10000,"discount_percent":10,"tax_rate":19},{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000002","product_description":"sin presentación","quantity":1,"purchase_unit_snapshot":null,"purchase_unit_factor_snapshot":1,"product_supplier_mapping_id":null,"commercial_unit_price":5,"tax_rate":0},{"item_type":"SERVICE","product_description":"servicio","quantity":2,"unit_price":100,"discount_unit_amount":10,"tax_rate":19}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000030',NULL);
  p := (r->>'po_id')::uuid;
  SELECT jsonb_agg(to_jsonb(i) ORDER BY line_number) INTO before_lines FROM adquisiciones.purchase_order_items i WHERE po_id=p;
  SELECT to_jsonb(po)-ARRAY['status','updated_at','updated_by'] INTO before_header FROM adquisiciones.purchase_orders po WHERE id=p;
  BEGIN PERFORM adquisiciones.emit_commercial_purchase_draft(p,0,u,c); RAISE EXCEPTION 'stale accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'El borrador cambió%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.emit_commercial_purchase_draft(p,1,'40000000-0000-0000-0000-000000000099',c); RAISE EXCEPTION 'unauthorized accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Sin acceso%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.emit_commercial_purchase_draft(p,1,u,'10000000-0000-0000-0000-000000000999'); RAISE EXCEPTION 'foreign company accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Borrador comercial no encontrado%' THEN RAISE; END IF; END;
  BEGIN UPDATE adquisiciones.purchase_orders SET status='EMITIDA' WHERE id=p; RAISE EXCEPTION 'uncontrolled emission accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  r := adquisiciones.emit_commercial_purchase_draft(p,1,u,c);
  IF r->>'status'<>'EMITIDA' OR (r->>'po_id')::uuid<>p THEN RAISE EXCEPTION 'bad emission result %',r; END IF;
  SELECT jsonb_agg(to_jsonb(i) ORDER BY line_number) INTO after_lines FROM adquisiciones.purchase_order_items i WHERE po_id=p;
  SELECT to_jsonb(po)-ARRAY['status','updated_at','updated_by'] INTO after_header FROM adquisiciones.purchase_orders po WHERE id=p;
  IF before_lines IS DISTINCT FROM after_lines OR before_header IS DISTINCT FROM after_header THEN RAISE EXCEPTION 'emission changed order economics or identities'; END IF;
  IF (SELECT count(*) FROM adquisiciones.purchase_order_status_history WHERE po_id=p AND from_status='BORRADOR' AND to_status='EMITIDA')<>1 THEN RAISE EXCEPTION 'missing history'; END IF;
  PERFORM adquisiciones.emit_commercial_purchase_draft(p,1,u,c);
  IF (SELECT count(*) FROM adquisiciones.purchase_order_status_history WHERE po_id=p AND to_status='EMITIDA')<>1 THEN RAISE EXCEPTION 'duplicate emission'; END IF;
  BEGIN UPDATE adquisiciones.purchase_orders SET status='ENVIADA_PROVEEDOR' WHERE id=p; RAISE EXCEPTION 'sending accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE adquisiciones.purchase_order_items SET quantity=12 WHERE po_id=p; RAISE EXCEPTION 'issued line editable'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
DO $$
DECLARE c uuid := '10000000-0000-0000-0000-000000000000'; u uuid := '40000000-0000-0000-0000-000000000001'; p uuid; r jsonb;
BEGIN
  r := adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","warehouse_id":"60000000-0000-0000-0000-000000000001","items":[{"item_type":"SERVICE","product_description":"sin precio","quantity":1,"unit_price":0,"tax_rate":19}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000031',NULL);
  p := (r->>'po_id')::uuid;
  BEGIN PERFORM adquisiciones.emit_commercial_purchase_draft(p,1,u,c); RAISE EXCEPTION 'zero price accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Revisa las cantidades%' THEN RAISE; END IF; END;
  IF (SELECT status FROM adquisiciones.purchase_orders WHERE id=p)<>'BORRADOR' OR EXISTS (SELECT 1 FROM adquisiciones.purchase_order_status_history WHERE po_id=p AND to_status='EMITIDA') THEN RAISE EXCEPTION 'invalid emission was not rolled back'; END IF;
  r := adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","items":[{"item_type":"SERVICE","product_description":"sin bodega","quantity":1,"unit_price":10,"tax_rate":19}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000032',NULL);
  BEGIN PERFORM adquisiciones.emit_commercial_purchase_draft((r->>'po_id')::uuid,1,u,c); RAISE EXCEPTION 'missing warehouse accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Selecciona un proveedor%' THEN RAISE; END IF; END;
END $$;
DO $$
DECLARE c uuid := '10000000-0000-0000-0000-000000000000'; p uuid;
BEGIN
  INSERT INTO adquisiciones.purchase_orders(company_id,correlative,status,source_type) VALUES (c,'TRADITIONAL-EMISSION','BORRADOR','MANUAL') RETURNING id INTO p;
  INSERT INTO adquisiciones.purchase_order_items(company_id,po_id,line_number,item_type,product_description,quantity,unit_price) VALUES (c,p,1,'SERVICE','tradicional',1,10);
  UPDATE adquisiciones.purchase_orders SET status='EMITIDA' WHERE id=p;
  UPDATE adquisiciones.purchase_orders SET status='ENVIADA_PROVEEDOR' WHERE id=p;
  IF (SELECT status FROM adquisiciones.purchase_orders WHERE id=p)<>'ENVIADA_PROVEEDOR' THEN RAISE EXCEPTION 'traditional workflow changed'; END IF;
END $$;
SELECT 'commercial emission tests passed' AS result;
