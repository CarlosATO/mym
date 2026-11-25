\set ON_ERROR_STOP on
-- Run only in a disposable database: this fixture creates the adquisiciones schema.
CREATE SCHEMA adquisiciones;
CREATE TABLE adquisiciones.product_supplier_mappings (
  id uuid PRIMARY KEY, company_id uuid NOT NULL, product_id uuid,
  purchase_unit text, purchase_unit_factor integer
);
CREATE TABLE adquisiciones.purchase_order_items (
  id integer PRIMARY KEY, company_id uuid NOT NULL, item_type text NOT NULL,
  product_id uuid, quantity numeric(14,4) NOT NULL, unit_price numeric(14,4) NOT NULL,
  discount_percent numeric(5,2), discount_unit_amount numeric(14,4),
  quantity_received numeric(14,4) DEFAULT 0,
  quantity_pending numeric(14,4) GENERATED ALWAYS AS (quantity - quantity_received) STORED
);
INSERT INTO adquisiciones.product_supplier_mappings VALUES
 ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','DISPLAY',6),
 ('00000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','CAJA',12);
INSERT INTO adquisiciones.purchase_order_items (id, company_id, item_type, product_id, quantity, unit_price, discount_percent, discount_unit_amount, quantity_received) VALUES
 (1,'10000000-0000-0000-0000-000000000001','PRODUCT','20000000-0000-0000-0000-000000000001',12,2.50,10,0,3),
 (2,'10000000-0000-0000-0000-000000000001','SERVICE',NULL,1,100,0,0,0);
\ir ../supabase/migrations/20261124170000_adquisiciones_po_commercial_snapshots.sql
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE purchase_unit_snapshot IS NOT NULL OR purchase_unit_factor_snapshot IS NOT NULL OR product_supplier_mapping_id IS NOT NULL) THEN RAISE EXCEPTION 'retroactive configuration'; END IF;
 IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=1 AND quantity=12 AND unit_price=2.50 AND discount_percent=10 AND discount_unit_amount=0 AND quantity_received=3 AND quantity_pending=9) THEN RAISE EXCEPTION 'legacy values changed'; END IF;
END $$;
-- Existing writers remain compatible; new pending and configured lines are explicit.
INSERT INTO adquisiciones.purchase_order_items (id, company_id, item_type, product_id, quantity, unit_price) VALUES (3,'10000000-0000-0000-0000-000000000001','PRODUCT','20000000-0000-0000-0000-000000000001',7,3);
INSERT INTO adquisiciones.purchase_order_items (id, company_id, item_type, product_id, quantity, unit_price, purchase_unit_factor_snapshot, product_supplier_mapping_id) VALUES (4,'10000000-0000-0000-0000-000000000001','PRODUCT','20000000-0000-0000-0000-000000000001',7,3,1,'00000000-0000-0000-0000-000000000001');
INSERT INTO adquisiciones.purchase_order_items (id, company_id, item_type, product_id, quantity, unit_price, purchase_unit_snapshot, purchase_unit_factor_snapshot, product_supplier_mapping_id) VALUES (5,'10000000-0000-0000-0000-000000000001','PRODUCT','20000000-0000-0000-0000-000000000001',12,3,'DISPLAY',6,'00000000-0000-0000-0000-000000000001');
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=3 AND purchase_unit_factor_snapshot IS NULL) OR NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=4 AND purchase_unit_snapshot IS NULL AND purchase_unit_factor_snapshot=1) THEN RAISE EXCEPTION 'legacy and pending indistinguishable'; END IF;
 IF (SELECT quantity / purchase_unit_factor_snapshot FROM adquisiciones.purchase_order_items WHERE id=5) <> 2 THEN RAISE EXCEPTION 'incorrect commercial quantity'; END IF;
 IF (SELECT quantity / purchase_unit_factor_snapshot FROM adquisiciones.purchase_order_items WHERE id=3) IS NOT NULL THEN RAISE EXCEPTION 'unknown quantity invented'; END IF;
END $$;
DO $$ BEGIN
 BEGIN UPDATE adquisiciones.purchase_order_items SET purchase_unit_factor_snapshot=0 WHERE id=5; RAISE EXCEPTION 'factor zero accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE adquisiciones.purchase_order_items SET purchase_unit_factor_snapshot=NULL WHERE id=5; RAISE EXCEPTION 'unit without factor accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE adquisiciones.purchase_order_items SET purchase_unit_snapshot=NULL, purchase_unit_factor_snapshot=6 WHERE id=5; RAISE EXCEPTION 'factor without unit accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE adquisiciones.purchase_order_items SET purchase_unit_snapshot='  ' WHERE id=5; RAISE EXCEPTION 'blank unit accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE adquisiciones.purchase_order_items SET purchase_unit_factor_snapshot=1 WHERE id=2; RAISE EXCEPTION 'service configuration accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE adquisiciones.purchase_order_items SET product_supplier_mapping_id='00000000-0000-0000-0000-000000000002' WHERE id=5; RAISE EXCEPTION 'cross-company mapping accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE adquisiciones.purchase_order_items SET product_id='20000000-0000-0000-0000-000000000002' WHERE id=5; RAISE EXCEPTION 'wrong product mapping accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE adquisiciones.purchase_order_items SET product_supplier_mapping_id='00000000-0000-0000-0000-000000000099' WHERE id=5; RAISE EXCEPTION 'missing mapping accepted'; EXCEPTION WHEN check_violation OR foreign_key_violation THEN NULL; END;
END $$;
UPDATE adquisiciones.product_supplier_mappings SET purchase_unit='CAJA', purchase_unit_factor=24 WHERE id='00000000-0000-0000-0000-000000000001';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=5 AND purchase_unit_snapshot='DISPLAY' AND purchase_unit_factor_snapshot=6) THEN RAISE EXCEPTION 'catalog change modified snapshot'; END IF;
END $$;
DELETE FROM adquisiciones.product_supplier_mappings WHERE id='00000000-0000-0000-0000-000000000001';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=5 AND product_supplier_mapping_id IS NULL AND purchase_unit_snapshot='DISPLAY' AND purchase_unit_factor_snapshot=6) THEN RAISE EXCEPTION 'mapping deletion damaged snapshot'; END IF;
END $$;
SELECT 'commercial snapshot tests passed' AS result;
