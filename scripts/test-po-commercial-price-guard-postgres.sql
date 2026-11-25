\set ON_ERROR_STOP on
-- Run only against a disposable PostgreSQL database.
CREATE SCHEMA adquisiciones;
CREATE TABLE adquisiciones.purchase_orders (id uuid PRIMARY KEY, company_id uuid NOT NULL, status text NOT NULL);
CREATE TABLE adquisiciones.product_supplier_mappings (id uuid PRIMARY KEY, company_id uuid NOT NULL, product_id uuid, purchase_unit text, purchase_unit_factor integer);
CREATE TABLE adquisiciones.purchase_order_items (
  id integer PRIMARY KEY, po_id uuid NOT NULL REFERENCES adquisiciones.purchase_orders(id),
  company_id uuid NOT NULL, item_type text NOT NULL, product_id uuid,
  quantity numeric(14,4) NOT NULL, unit_price numeric(14,4) NOT NULL
);
INSERT INTO adquisiciones.purchase_orders VALUES
 ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','BORRADOR'),
 ('00000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','EMITIDA');
INSERT INTO adquisiciones.product_supplier_mappings VALUES
 ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','DISPLAY',6);
INSERT INTO adquisiciones.purchase_order_items (id,po_id,company_id,item_type,product_id,quantity,unit_price)
VALUES (1,'00000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','PRODUCT','20000000-0000-0000-0000-000000000001',6,100);
\ir ../supabase/migrations/20261124170000_adquisiciones_po_commercial_snapshots.sql
\ir ../supabase/migrations/20261124180000_adquisiciones_po_commercial_price_guard.sql
DO $$ BEGIN
 IF (SELECT commercial_unit_price_snapshot FROM adquisiciones.purchase_order_items WHERE id=1) IS NOT NULL THEN RAISE EXCEPTION 'historical value inferred'; END IF;
END $$;
INSERT INTO adquisiciones.purchase_order_items (id,po_id,company_id,item_type,product_id,quantity,unit_price,purchase_unit_snapshot,purchase_unit_factor_snapshot,product_supplier_mapping_id,commercial_unit_price_snapshot)
VALUES (2,'00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','PRODUCT','20000000-0000-0000-0000-000000000001',600,1666.6667,'DISPLAY',6,'30000000-0000-0000-0000-000000000001',10000);
INSERT INTO adquisiciones.purchase_order_items (id,po_id,company_id,item_type,quantity,unit_price)
VALUES (3,'00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','SERVICE',1,10);
DO $$ BEGIN
 IF (SELECT quantity / purchase_unit_factor_snapshot * commercial_unit_price_snapshot FROM adquisiciones.purchase_order_items WHERE id=2) <> 1000000 THEN RAISE EXCEPTION 'commercial gross inaccurate'; END IF;
 BEGIN UPDATE adquisiciones.purchase_orders SET status='EMITIDA' WHERE id='00000000-0000-0000-0000-000000000001'; RAISE EXCEPTION 'emission accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE adquisiciones.purchase_order_items SET purchase_unit_factor_snapshot=1,commercial_unit_price_snapshot=10 WHERE id=1; RAISE EXCEPTION 'emitted order modified'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE adquisiciones.purchase_order_items SET commercial_unit_price_snapshot=-1 WHERE id=2; RAISE EXCEPTION 'negative commercial price accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE adquisiciones.purchase_order_items SET commercial_unit_price_snapshot=10 WHERE id=3; RAISE EXCEPTION 'service commercial price accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE adquisiciones.product_supplier_mappings SET purchase_unit='CAJA',purchase_unit_factor=12 WHERE id='30000000-0000-0000-0000-000000000001';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM adquisiciones.purchase_order_items WHERE id=2 AND purchase_unit_snapshot='DISPLAY' AND purchase_unit_factor_snapshot=6 AND commercial_unit_price_snapshot=10000) THEN RAISE EXCEPTION 'catalog changed captured values'; END IF;
END $$;
BEGIN;
UPDATE adquisiciones.purchase_order_items SET commercial_unit_price_snapshot=20000 WHERE id=2;
ROLLBACK;
DO $$ BEGIN
 IF (SELECT commercial_unit_price_snapshot FROM adquisiciones.purchase_order_items WHERE id=2) <> 10000 THEN RAISE EXCEPTION 'rollback failed'; END IF;
END $$;
SELECT 'commercial price and emission guard tests passed' AS result;
