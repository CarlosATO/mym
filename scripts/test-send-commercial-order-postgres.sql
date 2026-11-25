\set ON_ERROR_STOP on
-- Disposable database only: use the real prior status function and snapshot guard.
\ir test-emit-commercial-draft-postgres.sql
ALTER TABLE adquisiciones.suppliers ADD COLUMN business_name text, ADD COLUMN fantasy_name text, ADD COLUMN rut text;
ALTER TABLE adquisiciones.products ADD COLUMN sku text;
ALTER TABLE adquisiciones.warehouses ADD COLUMN name text;
ALTER TABLE adquisiciones.authorized_personnel ADD COLUMN full_name text;
ALTER TABLE adquisiciones.purchase_order_status_history ADD COLUMN reason text;
CREATE TABLE portal.users(id uuid PRIMARY KEY,nombre text,apellido text);
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE TABLE adquisiciones.purchase_order_snapshots(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,po_id uuid NOT NULL,snapshot_type text NOT NULL,version integer NOT NULL,header_snapshot jsonb NOT NULL,items_snapshot jsonb NOT NULL,created_by uuid,created_at timestamptz NOT NULL,UNIQUE(po_id,snapshot_type));
CREATE FUNCTION adquisiciones.reject_purchase_order_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Los snapshots de órdenes de compra son inmutables'; END $$;
CREATE TRIGGER trg_purchase_order_snapshots_immutable BEFORE UPDATE OR DELETE ON adquisiciones.purchase_order_snapshots FOR EACH ROW EXECUTE FUNCTION adquisiciones.reject_purchase_order_snapshot_mutation();
\ir ../supabase/migrations/20261118180000_adquisiciones_snapshots_include_discount_unit_amount.sql
\ir ../supabase/migrations/20261125130000_adquisiciones_send_commercial_order.sql
DO $$
DECLARE c uuid := '10000000-0000-0000-0000-000000000000'; u uuid := '40000000-0000-0000-0000-000000000001'; p uuid; r jsonb; orig jsonb; after_retry jsonb; product jsonb; service jsonb;
BEGIN
  r := adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","warehouse_id":"60000000-0000-0000-0000-000000000001","items":[{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000001","product_description":"display","quantity":600,"purchase_unit_snapshot":"DISPLAY","purchase_unit_factor_snapshot":6,"product_supplier_mapping_id":"30000000-0000-0000-0000-000000000001","commercial_unit_price":10000,"discount_percent":10,"tax_rate":19},{"item_type":"SERVICE","product_description":"servicio","quantity":2,"unit_price":100,"discount_unit_amount":10,"tax_rate":19}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000050',NULL);
  p := (r->>'po_id')::uuid;
  PERFORM adquisiciones.emit_commercial_purchase_draft(p,1,u,c);
  BEGIN PERFORM adquisiciones.send_commercial_purchase_order(p,'40000000-0000-0000-0000-000000000099',c); RAISE EXCEPTION 'unauthorized accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Sin acceso%' THEN RAISE; END IF; END;
  BEGIN PERFORM adquisiciones.send_commercial_purchase_order(p,u,'10000000-0000-0000-0000-000000000999'); RAISE EXCEPTION 'foreign company accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Orden comercial no encontrada%' THEN RAISE; END IF; END;
  BEGIN UPDATE adquisiciones.purchase_orders SET status='ENVIADA_PROVEEDOR' WHERE id=p; RAISE EXCEPTION 'direct send accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  r := adquisiciones.send_commercial_purchase_order(p,u,c);
  IF r->>'status'<>'ENVIADA_PROVEEDOR' OR (r->>'po_id')::uuid<>p THEN RAISE EXCEPTION 'bad result %',r; END IF;
  SELECT to_jsonb(s),items_snapshot->0,items_snapshot->1 INTO orig,product,service FROM adquisiciones.purchase_order_snapshots s WHERE po_id=p AND snapshot_type='ORIGINAL_SENT';
  IF orig IS NULL OR product->>'purchase_unit_snapshot'<>'DISPLAY' OR (product->>'purchase_unit_factor_snapshot')::numeric<>6 OR (product->>'quantity')::numeric<>600 OR (product->>'commercial_quantity')::numeric<>100 OR (product->>'commercial_unit_price_snapshot')::numeric<>10000 OR (product->>'commercial_gross_amount_snapshot')::numeric<>1000000 OR (product->>'unit_price')::numeric<>1666.6667 OR (product->>'discount_amount')::numeric<>100000 OR (product->>'tax_amount')::numeric<>171000 OR (product->>'line_total')::numeric<>1071000 OR product->>'product_supplier_mapping_id'<>'30000000-0000-0000-0000-000000000001' THEN RAISE EXCEPTION 'commercial snapshot mismatch %',product; END IF;
  IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE po_id=p AND id=(product->>'item_id')::uuid) OR service->>'commercial_quantity' IS NOT NULL OR (service->>'discount_unit_amount')::numeric<>10 THEN RAISE EXCEPTION 'identity or service snapshot mismatch'; END IF;
  PERFORM adquisiciones.send_commercial_purchase_order(p,u,c);
  SELECT to_jsonb(s) INTO after_retry FROM adquisiciones.purchase_order_snapshots s WHERE po_id=p AND snapshot_type='ORIGINAL_SENT';
  IF orig IS DISTINCT FROM after_retry OR (SELECT count(*) FROM adquisiciones.purchase_order_status_history WHERE po_id=p AND to_status='ENVIADA_PROVEEDOR')<>1 THEN RAISE EXCEPTION 'retry changed snapshot or history'; END IF;
  BEGIN UPDATE adquisiciones.purchase_order_snapshots SET items_snapshot='[]' WHERE po_id=p; RAISE EXCEPTION 'snapshot update accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%inmutables%' THEN RAISE; END IF; END;
  BEGIN DELETE FROM adquisiciones.purchase_order_items WHERE po_id=p; RAISE EXCEPTION 'sent item deletion accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE adquisiciones.purchase_orders SET status='CONFIRMADA' WHERE id=p; RAISE EXCEPTION 'confirmation accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SELECT 'commercial send tests passed' AS result;
DO $$
DECLARE c uuid := '10000000-0000-0000-0000-000000000000'; u uuid := '40000000-0000-0000-0000-000000000001'; p uuid; r jsonb; line jsonb;
BEGIN
  r := adquisiciones.save_commercial_draft_request(NULL,'{"supplier_id":"10000000-0000-0000-0000-000000000001","warehouse_id":"60000000-0000-0000-0000-000000000001","items":[{"item_type":"PRODUCT","product_id":"20000000-0000-0000-0000-000000000002","product_description":"pendiente","quantity":2,"purchase_unit_snapshot":null,"purchase_unit_factor_snapshot":1,"product_supplier_mapping_id":null,"commercial_unit_price":5,"tax_rate":0}]}'::jsonb,u,c,'50000000-0000-0000-0000-000000000051',NULL);
  p := (r->>'po_id')::uuid;
  PERFORM adquisiciones.emit_commercial_purchase_draft(p,1,u,c);
  PERFORM adquisiciones.send_commercial_purchase_order(p,u,c);
  SELECT items_snapshot->0 INTO line FROM adquisiciones.purchase_order_snapshots WHERE po_id=p;
  IF line->>'purchase_unit_snapshot' IS NOT NULL OR (line->>'purchase_unit_factor_snapshot')::numeric<>1 OR (line->>'commercial_quantity')::numeric<>2 OR (line->>'tax_amount')::numeric<>0 THEN RAISE EXCEPTION 'pending unit or exempt mismatch'; END IF;
  INSERT INTO adquisiciones.purchase_orders(company_id,correlative,status,source_type) VALUES (c,'TRADITIONAL-SEND','EMITIDA','MANUAL') RETURNING id INTO p;
  INSERT INTO adquisiciones.purchase_order_items(company_id,po_id,line_number,item_type,product_description,quantity,unit_price) VALUES (c,p,1,'SERVICE','tradicional',1,10);
  r := adquisiciones.update_purchase_order_status(p,'ENVIADA_PROVEEDOR',NULL,u);
  IF (r->>'success')::boolean IS NOT TRUE OR (SELECT items_snapshot->0 ? 'purchase_unit_factor_snapshot' FROM adquisiciones.purchase_order_snapshots WHERE po_id=p) THEN RAISE EXCEPTION 'traditional snapshot changed'; END IF;
END $$;
