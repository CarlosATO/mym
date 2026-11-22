-- Solo para una base de prueba local vacía y descartable.
\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database() <> 'cxp_document_test' OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet THEN RAISE EXCEPTION 'Solo permitido en base local aislada'; END IF; END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;
CREATE SCHEMA cuentas_por_pagar;
CREATE SCHEMA adquisiciones;
CREATE SCHEMA logistica;
CREATE SCHEMA storage;
CREATE TABLE storage.objects (bucket_id text, name text);
CREATE FUNCTION cuentas_por_pagar.can_access(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.access', true) = 'yes' $$;
CREATE TABLE adquisiciones.suppliers (id uuid, company_id uuid, rut text, rut_normalized text);
CREATE TABLE adquisiciones.purchase_orders (id uuid, company_id uuid, supplier_id uuid);
CREATE TABLE logistica.purchase_receipts (id uuid, company_id uuid, purchase_order_id uuid, status text, document_type text, receiving_type text, document_number text);
CREATE TABLE logistica.receipt_documents (id uuid, company_id uuid, receipt_id uuid, document_type text, document_number text, file_name text, mime_type text, storage_bucket text, storage_path text);
CREATE TABLE cuentas_por_pagar.invoices (id uuid, company_id uuid, supplier_id uuid, issuer_rut text, document_folio text, document_type text, purchase_type text, attachment_file_name text, attachment_mime_type text, attachment_storage_bucket text, attachment_storage_path text, receipt_document_id uuid);
CREATE TABLE cuentas_por_pagar.invoice_receipt_links (invoice_id uuid, company_id uuid, receipt_id uuid);
CREATE TABLE public.test_candidates (candidate_id uuid, supplier_id uuid, issuer_rut text, folio text, receipt_ids uuid[], invoice_id uuid);
CREATE FUNCTION public.cxp_receipt_candidates() RETURNS SETOF public.test_candidates LANGUAGE sql AS $$ SELECT * FROM public.test_candidates $$;
\i supabase/migrations/20261120160000_cuentas_por_pagar_inbox_documents.sql

INSERT INTO adquisiciones.suppliers VALUES ('10000000-0000-0000-0000-000000000001', NULL, '76.086.428-5', NULL);
INSERT INTO adquisiciones.purchase_orders VALUES ('20000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001');
INSERT INTO logistica.purchase_receipts VALUES
 ('30000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'COMPLETED', 'FA', 'WAREHOUSE', '0042'),
 ('30000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'COMPLETED', 'FA', 'WAREHOUSE', '42');
INSERT INTO public.test_candidates VALUES ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '760864285', '42', ARRAY['30000000-0000-0000-0000-000000000001'::uuid,'30000000-0000-0000-0000-000000000002'::uuid], NULL);
INSERT INTO logistica.receipt_documents VALUES
 ('40000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'FA', '42', 'a.pdf', 'application/pdf', 'recepciones', 'd1000000-0000-0000-0000-000000000001/a.pdf'),
 ('40000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'FA', '42', 'b.pdf', 'application/pdf', 'recepciones', 'd1000000-0000-0000-0000-000000000001/b.pdf'),
 ('40000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'FA', '99', 'otro.pdf', 'application/pdf', 'recepciones', 'd1000000-0000-0000-0000-000000000001/otro.pdf');
INSERT INTO storage.objects VALUES
 ('recepciones', 'd1000000-0000-0000-0000-000000000001/a.pdf'),
 ('recepciones', 'd1000000-0000-0000-0000-000000000001/b.pdf'),
 ('cuentas-por-pagar', 'd1000000-0000-0000-0000-000000000001/services/s.pdf');
SELECT set_config('test.access', 'yes', false);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.cxp_inbox_documents('30000000-0000-0000-0000-000000000001', NULL)) <> 2 THEN RAISE EXCEPTION 'Deben verse dos respaldos antes de incorporar'; END IF;
 IF EXISTS (SELECT 1 FROM public.cxp_inbox_documents('30000000-0000-0000-0000-000000000002', NULL)) THEN RAISE EXCEPTION 'Candidato ajeno aceptado'; END IF;
 IF EXISTS (SELECT 1 FROM public.cxp_inbox_documents(NULL, NULL)) THEN RAISE EXCEPTION 'Listado sin identidad revela documentos'; END IF;
 IF EXISTS (SELECT 1 FROM public.cxp_inbox_document_storage(NULL, NULL, '40000000-0000-0000-0000-000000000001')) THEN RAISE EXCEPTION 'Ruta sin identidad'; END IF;
 IF EXISTS (SELECT 1 FROM public.cxp_inbox_document_storage('30000000-0000-0000-0000-000000000001', NULL, '40000000-0000-0000-0000-000000000003')) THEN RAISE EXCEPTION 'Ruta de otra factura'; END IF;
 IF NOT (SELECT has_file FROM public.cxp_inbox_document_status() WHERE candidate_key = '30000000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'Archivo disponible no detectado'; END IF;
 IF has_function_privilege('authenticated', 'cuentas_por_pagar.inbox_documents(uuid,uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'Función interna accesible'; END IF;
END $$;
UPDATE adquisiciones.purchase_orders SET supplier_id = '10000000-0000-0000-0000-000000000099';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.cxp_inbox_documents('30000000-0000-0000-0000-000000000001', NULL)) THEN RAISE EXCEPTION 'Documento de otro proveedor'; END IF;
END $$;
UPDATE adquisiciones.purchase_orders SET supplier_id = '10000000-0000-0000-0000-000000000001';
UPDATE logistica.receipt_documents SET company_id = 'd1000000-0000-0000-0000-000000000099';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.cxp_inbox_documents('30000000-0000-0000-0000-000000000001', NULL)) THEN RAISE EXCEPTION 'Documento de otra empresa'; END IF;
END $$;
UPDATE logistica.receipt_documents SET company_id = 'd1000000-0000-0000-0000-000000000001';
INSERT INTO cuentas_por_pagar.invoices VALUES
 ('50000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '760864285', '42', 'FA', 'PRODUCTS', NULL, NULL, NULL, NULL, NULL),
 ('50000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '760864285', '55', 'FA', 'SERVICES', 'servicio.pdf', 'application/pdf', 'cuentas-por-pagar', 'd1000000-0000-0000-0000-000000000001/services/s.pdf', NULL);
UPDATE public.test_candidates SET invoice_id = '50000000-0000-0000-0000-000000000001';
INSERT INTO cuentas_por_pagar.invoice_receipt_links VALUES ('50000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001');
DO $$ BEGIN
 IF (SELECT count(*) FROM public.cxp_inbox_documents('30000000-0000-0000-0000-000000000001', NULL)) <> 1 THEN RAISE EXCEPTION 'Solo deben verse respaldos vinculados'; END IF;
 IF (SELECT count(*) FROM public.cxp_inbox_documents(NULL, '50000000-0000-0000-0000-000000000002')) <> 1 THEN RAISE EXCEPTION 'Falta respaldo de servicio'; END IF;
 IF EXISTS (SELECT 1 FROM public.cxp_inbox_documents(NULL, '50000000-0000-0000-0000-000000000001')) THEN RAISE EXCEPTION 'Factura de productos presentada como servicio'; END IF;
END $$;
UPDATE cuentas_por_pagar.invoices SET receipt_document_id = '40000000-0000-0000-0000-000000000002' WHERE id = '50000000-0000-0000-0000-000000000001';
DO $$ BEGIN
 IF (SELECT count(*) FROM public.cxp_inbox_documents('30000000-0000-0000-0000-000000000001', NULL)) <> 2 THEN RAISE EXCEPTION 'Falta documento vinculado directamente'; END IF;
END $$;
DELETE FROM storage.objects WHERE bucket_id = 'recepciones';
DO $$ BEGIN
 IF (SELECT has_file FROM public.cxp_inbox_document_status() WHERE candidate_key = '30000000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'Archivo ausente marcado como disponible'; END IF;
 IF EXISTS (SELECT 1 FROM public.cxp_inbox_document_storage('30000000-0000-0000-0000-000000000001', NULL, '40000000-0000-0000-0000-000000000001')) THEN RAISE EXCEPTION 'Ruta de archivo ausente'; END IF;
END $$;
SELECT set_config('test.access', 'no', false);
DO $$ BEGIN
 BEGIN PERFORM * FROM public.cxp_inbox_document_status(); RAISE EXCEPTION 'Acceso indebido';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
