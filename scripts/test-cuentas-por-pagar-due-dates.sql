-- Exclusivamente en PostgreSQL local descartable, con datos sintéticos.
\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database() <> 'cxp_due_date_test' OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet THEN RAISE EXCEPTION 'Solo permitido en base local aislada'; END IF; END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;
CREATE SCHEMA cuentas_por_pagar;
CREATE SCHEMA adquisiciones;
CREATE SCHEMA logistica;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor', true), '')::uuid $$;
CREATE FUNCTION cuentas_por_pagar.can_access(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.access', true) = 'yes' $$;
CREATE TABLE adquisiciones.suppliers (id uuid, company_id uuid, credit_days integer);
CREATE TABLE adquisiciones.purchase_orders (id uuid, company_id uuid, supplier_id uuid, payment_terms text);
CREATE TABLE logistica.purchase_receipts (id uuid, company_id uuid, purchase_order_id uuid);
CREATE TABLE cuentas_por_pagar.invoices (
 id uuid PRIMARY KEY, company_id uuid, supplier_id uuid, issuer_rut text, document_type text,
 document_folio text, issue_date date, due_date date, origin text, validation_status text, net_amount numeric
);
-- Columnas y tablas adicionales usadas por la versión real de prepare_invoice.
ALTER TABLE adquisiciones.suppliers ADD COLUMN rut text, ADD COLUMN rut_normalized text;
CREATE TABLE adquisiciones.purchase_order_documents (id uuid, po_id uuid, company_id uuid, document_type text, document_number text);
CREATE TABLE logistica.receipt_documents (id uuid, receipt_id uuid, company_id uuid, document_type text, document_number text);
CREATE TABLE cuentas_por_pagar.invoice_receipt_links (invoice_id uuid, receipt_id uuid);
ALTER TABLE logistica.purchase_receipts ADD COLUMN document_type text, ADD COLUMN document_number text;
ALTER TABLE cuentas_por_pagar.invoices
 ADD COLUMN receipt_document_id uuid, ADD COLUMN purchase_order_document_id uuid,
 ADD COLUMN purchase_type text DEFAULT 'PRODUCTS', ADD COLUMN attachment_storage_path text,
 ADD COLUMN attachment_storage_bucket text, ADD COLUMN attachment_file_name text, ADD COLUMN attachment_mime_type text,
 ADD COLUMN tax_amount numeric, ADD COLUMN total_amount numeric, ADD COLUMN historical_initial_balance numeric,
 ADD COLUMN historical_balance_cutoff_date date, ADD COLUMN prior_payment_status text,
 ADD COLUMN discrepancy_status text, ADD COLUMN discrepancy_resolution_note text,
 ADD COLUMN service_description text, ADD COLUMN service_delivery_status text,
 ADD COLUMN created_at timestamptz, ADD COLUMN created_by uuid, ADD COLUMN updated_at timestamptz,
 ADD COLUMN updated_by uuid, ADD COLUMN validated_at timestamptz, ADD COLUMN validated_by uuid;
CREATE FUNCTION cuentas_por_pagar.prepare_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF OLD.validation_status = 'VALIDATED' AND
     (NEW.due_date, NEW.net_amount) IS DISTINCT FROM (OLD.due_date, OLD.net_amount)
  THEN NEW.validation_status := 'PENDING'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER prepare_invoice BEFORE INSERT OR UPDATE ON cuentas_por_pagar.invoices FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.prepare_invoice();
CREATE TABLE public.test_candidates (candidate_id uuid, issuer_rut text, supplier_id uuid, folio text, issue_date date, receipt_ids uuid[], invoice_id uuid, blocked_reason text);
CREATE FUNCTION public.cxp_receipt_candidates() RETURNS SETOF public.test_candidates LANGUAGE sql AS $$ SELECT * FROM public.test_candidates $$;
\i supabase/migrations/20261120170000_cuentas_por_pagar_due_dates.sql
SELECT set_config('test.actor', '20000000-0000-0000-0000-000000000001', false);
SELECT set_config('test.access', 'yes', false);
INSERT INTO adquisiciones.suppliers(id, company_id, credit_days, rut) VALUES ('10000000-0000-0000-0000-000000000001', NULL, 45, '76.086.428-5');
INSERT INTO adquisiciones.purchase_orders VALUES
 ('40000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '30 días'),
 ('40000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '60 días');
INSERT INTO logistica.purchase_receipts(id, company_id, purchase_order_id) VALUES
 ('30000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001'),
 ('30000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002');
INSERT INTO public.test_candidates VALUES ('30000000-0000-0000-0000-000000000001', '760864285', '10000000-0000-0000-0000-000000000001', '42', '2024-02-01', ARRAY['30000000-0000-0000-0000-000000000001'::uuid], NULL, NULL);
DO $$ BEGIN
 IF (SELECT due_date FROM public.cxp_receipt_due_dates()) <> '2024-03-02'::date THEN RAISE EXCEPTION 'Sugerencia OC incorrecta'; END IF;
 IF cuentas_por_pagar.explicit_credit_days('PRE PAGO') IS NOT NULL THEN RAISE EXCEPTION 'PRE PAGO interpretado como plazo'; END IF;
END $$;
UPDATE adquisiciones.purchase_orders SET payment_terms = 'PRE PAGO' WHERE id = '40000000-0000-0000-0000-000000000001';
DO $$ BEGIN IF (SELECT due_date FROM public.cxp_receipt_due_dates()) IS NOT NULL THEN RAISE EXCEPTION 'Condición ambigua produjo fecha'; END IF; END $$;
UPDATE adquisiciones.purchase_orders SET payment_terms = NULL WHERE id = '40000000-0000-0000-0000-000000000001';
DO $$ BEGIN IF (SELECT due_date FROM public.cxp_receipt_due_dates()) <> '2024-03-17'::date THEN RAISE EXCEPTION 'Sugerencia proveedor incorrecta'; END IF; END $$;
UPDATE adquisiciones.purchase_orders SET payment_terms = '30 días' WHERE id = '40000000-0000-0000-0000-000000000001';
UPDATE public.test_candidates SET receipt_ids = ARRAY['30000000-0000-0000-0000-000000000001'::uuid, '30000000-0000-0000-0000-000000000002'::uuid];
DO $$ BEGIN IF (SELECT due_date FROM public.cxp_receipt_due_dates()) IS NOT NULL THEN RAISE EXCEPTION 'Condiciones contradictorias produjeron fecha'; END IF; END $$;
SELECT public.cxp_set_due_date('30000000-0000-0000-0000-000000000001', NULL, '2024-04-01');
DO $$ BEGIN IF (SELECT due_date FROM public.cxp_receipt_due_dates()) <> '2024-04-01'::date THEN RAISE EXCEPTION 'Corrección previa no conservada'; END IF; END $$;
UPDATE adquisiciones.purchase_orders SET payment_terms = '15 días';
DO $$ BEGIN IF (SELECT due_date FROM public.cxp_receipt_due_dates()) <> '2024-04-01'::date THEN RAISE EXCEPTION 'Sugerencia sobrescribió corrección manual'; END IF; END $$;
INSERT INTO cuentas_por_pagar.invoices(id, company_id, supplier_id, issuer_rut, document_type, document_folio, issue_date, due_date, origin, validation_status, net_amount) VALUES ('50000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '760864285', 'FA', '42', '2024-02-01', NULL, 'RECEIPT', 'PENDING', 100);
UPDATE public.test_candidates SET invoice_id = '50000000-0000-0000-0000-000000000001';
DO $$ BEGIN IF (SELECT due_date FROM cuentas_por_pagar.invoices) <> '2024-04-01'::date THEN RAISE EXCEPTION 'Incorporación perdió vencimiento'; END IF; END $$;
DO $$ BEGIN
 IF (SELECT due_date FROM public.cxp_receipt_due_dates() WHERE candidate_id = '30000000-0000-0000-0000-000000000001') IS DISTINCT FROM '2024-04-01'::date OR
    (SELECT due_date_source FROM public.cxp_receipt_due_dates() WHERE candidate_id = '30000000-0000-0000-0000-000000000001') IS DISTINCT FROM 'SAVED' THEN
  RAISE EXCEPTION 'La bandeja no conserva el vencimiento después de incorporar'; END IF;
END $$;
UPDATE cuentas_por_pagar.invoices SET validation_status = 'VALIDATED';
SELECT public.cxp_set_due_date(NULL, '50000000-0000-0000-0000-000000000001', '2024-05-01');
DO $$ BEGIN
 IF (SELECT validation_status FROM cuentas_por_pagar.invoices) <> 'VALIDATED' THEN RAISE EXCEPTION 'Edición autorizada invalidó factura'; END IF;
 IF NOT EXISTS (SELECT 1 FROM cuentas_por_pagar.due_date_audit WHERE old_due_date = '2024-04-01' AND new_due_date = '2024-05-01' AND actor_id = auth.uid() AND changed_at IS NOT NULL) THEN RAISE EXCEPTION 'Auditoría incompleta'; END IF;
 IF (SELECT count(*) FROM cuentas_por_pagar.due_date_audit WHERE old_due_date = '2024-04-01' AND new_due_date = '2024-05-01') <> 1 THEN RAISE EXCEPTION 'Auditoría duplicada'; END IF;
 IF NOT (SELECT authorization_used FROM cuentas_por_pagar.due_date_audit WHERE old_due_date = '2024-04-01' AND new_due_date = '2024-05-01') THEN RAISE EXCEPTION 'Autorización no consumida'; END IF;
END $$;
DO $$ BEGIN
 BEGIN
  PERFORM public.cxp_set_due_date(NULL, '50000000-0000-0000-0000-000000000001', NULL);
  RAISE EXCEPTION 'Se permitió borrar el vencimiento de una factura validada';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'Una factura validada requiere vencimiento' THEN RAISE; END IF;
 END;
 IF (SELECT due_date FROM cuentas_por_pagar.invoices WHERE id = '50000000-0000-0000-0000-000000000001') IS DISTINCT FROM '2024-05-01'::date OR
    (SELECT validation_status FROM cuentas_por_pagar.invoices WHERE id = '50000000-0000-0000-0000-000000000001') IS DISTINCT FROM 'VALIDATED' THEN
  RAISE EXCEPTION 'Se alteró la factura validada'; END IF;
END $$;
BEGIN;
SELECT public.cxp_set_due_date(NULL, '50000000-0000-0000-0000-000000000001', '2024-06-01');
UPDATE cuentas_por_pagar.invoices SET due_date = '2024-05-01';
UPDATE cuentas_por_pagar.invoices SET validation_status = 'VALIDATED';
UPDATE cuentas_por_pagar.invoices SET due_date = '2024-06-01';
DO $$ BEGIN IF (SELECT validation_status FROM cuentas_por_pagar.invoices) <> 'PENDING' THEN RAISE EXCEPTION 'Autorización reutilizada'; END IF; END $$;
ROLLBACK;
UPDATE cuentas_por_pagar.invoices SET due_date = '2024-06-01';
DO $$ BEGIN IF (SELECT validation_status FROM cuentas_por_pagar.invoices) <> 'PENDING' THEN RAISE EXCEPTION 'Edición no autorizada no invalidó factura'; END IF; END $$;
UPDATE cuentas_por_pagar.invoices SET validation_status = 'VALIDATED';
UPDATE cuentas_por_pagar.invoices SET net_amount = 101;
DO $$ BEGIN IF (SELECT validation_status FROM cuentas_por_pagar.invoices) <> 'PENDING' THEN RAISE EXCEPTION 'Cambio sensible no invalidó factura'; END IF; END $$;
UPDATE cuentas_por_pagar.invoices SET due_date = NULL;
DO $$ BEGIN
 IF (SELECT due_date FROM public.cxp_receipt_due_dates()) IS NOT NULL OR (SELECT due_date_source FROM public.cxp_receipt_due_dates()) <> 'MANUAL' THEN
  RAISE EXCEPTION 'Fecha manual vacía sustituida por sugerencia';
 END IF;
END $$;
INSERT INTO public.test_candidates VALUES ('30000000-0000-0000-0000-000000000002', '760864285', '10000000-0000-0000-0000-000000000001', '43', '2024-02-01', ARRAY['30000000-0000-0000-0000-000000000002'::uuid], NULL, NULL);
SELECT public.cxp_set_due_date('30000000-0000-0000-0000-000000000002', NULL, NULL);
INSERT INTO cuentas_por_pagar.invoices(id, company_id, supplier_id, issuer_rut, document_type, document_folio, issue_date, due_date, origin, validation_status, net_amount) VALUES ('50000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '760864285', 'FA', '43', '2024-02-01', NULL, 'RECEIPT', 'PENDING', 100);
UPDATE public.test_candidates SET invoice_id = '50000000-0000-0000-0000-000000000002' WHERE folio = '43';
DO $$ BEGIN
 IF (SELECT due_date FROM public.cxp_receipt_due_dates() WHERE candidate_id = '30000000-0000-0000-0000-000000000002') IS NOT NULL OR
    (SELECT due_date_source FROM public.cxp_receipt_due_dates() WHERE candidate_id = '30000000-0000-0000-0000-000000000002') <> 'MANUAL' THEN
  RAISE EXCEPTION 'Vacío manual no conservado al incorporar'; END IF;
END $$;
INSERT INTO public.test_candidates VALUES ('30000000-0000-0000-0000-000000000003', '760864285', '10000000-0000-0000-0000-000000000001', '44', '2024-02-01', ARRAY['30000000-0000-0000-0000-000000000002'::uuid], '50000000-0000-0000-0000-000000000003', NULL);
INSERT INTO cuentas_por_pagar.invoices(id, company_id, supplier_id, issuer_rut, document_type, document_folio, issue_date, due_date, origin, validation_status, net_amount) VALUES ('50000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '760864285', 'FA', '44', '2024-02-01', NULL, 'RECEIPT', 'PENDING', 100);
SELECT public.cxp_set_due_date(NULL, '50000000-0000-0000-0000-000000000003', NULL);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM cuentas_por_pagar.due_date_audit WHERE invoice_id = '50000000-0000-0000-0000-000000000003' AND old_due_date = '2024-02-16' AND new_due_date IS NULL AND actor_id = auth.uid()) THEN
  RAISE EXCEPTION 'No se auditó el rechazo explícito de la sugerencia'; END IF;
 IF has_table_privilege('authenticated', 'cuentas_por_pagar.pending_due_dates', 'UPDATE') OR
    has_table_privilege('authenticated', 'cuentas_por_pagar.due_date_audit', 'INSERT') THEN
  RAISE EXCEPTION 'Tablas internas editables directamente'; END IF;
END $$;
-- Factura ya incorporada sin fecha, con corrección manual preexistente.
INSERT INTO cuentas_por_pagar.invoices(id, company_id, supplier_id, issuer_rut, document_type, document_folio, issue_date, due_date, origin, validation_status, net_amount) VALUES ('50000000-0000-0000-0000-000000000005', 'd1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '760864285', 'FA', '46', '2024-02-01', NULL, 'RECEIPT', 'PENDING', 100);
INSERT INTO public.test_candidates VALUES ('30000000-0000-0000-0000-000000000004', '760864285', '10000000-0000-0000-0000-000000000001', '46', '2024-02-01', ARRAY['30000000-0000-0000-0000-000000000002'::uuid], '50000000-0000-0000-0000-000000000005', NULL);
DO $$ BEGIN
 IF (SELECT due_date FROM public.cxp_receipt_due_dates() WHERE candidate_id = '30000000-0000-0000-0000-000000000004') IS DISTINCT FROM '2024-02-16'::date THEN
  RAISE EXCEPTION 'Sin corrección debe utilizarse la sugerencia'; END IF;
END $$;
INSERT INTO cuentas_por_pagar.pending_due_dates(company_id, issuer_rut, document_type, document_folio, supplier_id, due_date, updated_by)
VALUES ('d1000000-0000-0000-0000-000000000001', '760864285', 'FA', '46', '10000000-0000-0000-0000-000000000001', '2024-04-25', auth.uid());
DO $$ BEGIN
 IF (SELECT due_date FROM public.cxp_receipt_due_dates() WHERE candidate_id = '30000000-0000-0000-0000-000000000004') IS DISTINCT FROM '2024-04-25'::date OR
    (SELECT due_date_source FROM public.cxp_receipt_due_dates() WHERE candidate_id = '30000000-0000-0000-0000-000000000004') IS DISTINCT FROM 'MANUAL' OR
    (SELECT suggested_due_date FROM public.cxp_receipt_due_dates() WHERE candidate_id = '30000000-0000-0000-0000-000000000004') IS DISTINCT FROM '2024-02-16'::date THEN
  RAISE EXCEPTION 'Corrección manual positiva reemplazada por sugerencia'; END IF;
END $$;
UPDATE cuentas_por_pagar.pending_due_dates SET due_date = NULL WHERE document_folio = '46';
DO $$ BEGIN
 IF (SELECT due_date FROM public.cxp_receipt_due_dates() WHERE candidate_id = '30000000-0000-0000-0000-000000000004') IS NOT NULL OR
    (SELECT due_date_source FROM public.cxp_receipt_due_dates() WHERE candidate_id = '30000000-0000-0000-0000-000000000004') IS DISTINCT FROM 'MANUAL' THEN
  RAISE EXCEPTION 'Vacío manual reemplazado por sugerencia'; END IF;
END $$;
UPDATE cuentas_por_pagar.invoices SET due_date = '2024-05-05' WHERE id = '50000000-0000-0000-0000-000000000005';
UPDATE cuentas_por_pagar.pending_due_dates SET due_date = '2024-04-25' WHERE document_folio = '46';
DO $$ BEGIN
 IF (SELECT due_date FROM public.cxp_receipt_due_dates() WHERE candidate_id = '30000000-0000-0000-0000-000000000004') IS DISTINCT FROM '2024-05-05'::date OR
    (SELECT due_date_source FROM public.cxp_receipt_due_dates() WHERE candidate_id = '30000000-0000-0000-0000-000000000004') IS DISTINCT FROM 'SAVED' THEN
  RAISE EXCEPTION 'No se respetó el vencimiento guardado en la factura'; END IF;
END $$;
UPDATE public.test_candidates SET supplier_id = '10000000-0000-0000-0000-000000000099' WHERE folio = '44';
DO $$ BEGIN
 BEGIN PERFORM public.cxp_set_due_date('30000000-0000-0000-0000-000000000003', NULL, '2024-04-01'); RAISE EXCEPTION 'Proveedor incorrecto aceptado';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM = 'Proveedor incorrecto aceptado' THEN RAISE; END IF; END;
END $$;
INSERT INTO cuentas_por_pagar.invoices(id, company_id, supplier_id, issuer_rut, document_type, document_folio, issue_date, due_date, origin, validation_status, net_amount) VALUES ('50000000-0000-0000-0000-000000000004', 'd1000000-0000-0000-0000-000000000099', '10000000-0000-0000-0000-000000000001', '760864285', 'FA', '45', '2024-02-01', NULL, 'MANUAL', 'PENDING', 100);
DO $$ BEGIN
 BEGIN PERFORM public.cxp_set_due_date(NULL, '50000000-0000-0000-0000-000000000004', '2024-04-01'); RAISE EXCEPTION 'Factura de otra empresa aceptada';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM = 'Factura de otra empresa aceptada' THEN RAISE; END IF; END;
END $$;
SELECT set_config('test.access', 'no', false);
DO $$ BEGIN
 BEGIN PERFORM public.cxp_set_due_date(NULL, '50000000-0000-0000-0000-000000000001', '2024-07-01'); RAISE EXCEPTION 'Acceso indebido';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
