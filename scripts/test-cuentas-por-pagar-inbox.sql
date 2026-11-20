-- Ejecutar exclusivamente en una base aislada llamada cxp_real_contract.
\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database() <> 'cxp_real_contract' OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet THEN RAISE EXCEPTION 'Solo permitido en base local aislada'; END IF; END $$;
BEGIN;
INSERT INTO auth.users(id) VALUES ('20000000-0000-0000-0000-000000000001'),('20000000-0000-0000-0000-000000000002');
INSERT INTO portal.roles(id,name) VALUES ('10000000-0000-0000-0000-000000000001','FINANZAS'),('10000000-0000-0000-0000-000000000002','BODEGA');
INSERT INTO portal.users(id,email,nombre,apellido,role_id) VALUES ('20000000-0000-0000-0000-000000000001','qa@example.invalid','QA','Test','10000000-0000-0000-0000-000000000001'),('20000000-0000-0000-0000-000000000002','qa2@example.invalid','QA','Test','10000000-0000-0000-0000-000000000002');
INSERT INTO core.companies(id,business_name) VALUES ('d1000000-0000-0000-0000-000000000001','QA');
INSERT INTO core.user_company_access(user_id,company_id,role) VALUES ('20000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001','FINANZAS'),('20000000-0000-0000-0000-000000000002','d1000000-0000-0000-0000-000000000001','BODEGA');
INSERT INTO adquisiciones.suppliers(id,rut,business_name) VALUES ('30000000-0000-0000-0000-000000000001','12.345.678-k','Proveedor QA'),('30000000-0000-0000-0000-000000000002',NULL,'Proveedor sin RUT');
INSERT INTO adquisiciones.purchase_orders(id,correlative,supplier_id,requested_by,company_id) VALUES
('40000000-0000-0000-0000-000000000001','OC1','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001'),
('40000000-0000-0000-0000-000000000002','OC2','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001'),
('40000000-0000-0000-0000-000000000003','OC3','30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001');
INSERT INTO logistica.purchase_receipts(id,company_id,purchase_order_id,receipt_number,receiving_type,status,document_type,document_number,document_date,receipt_total_gross) VALUES
('50000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','1','OFFICE','COMPLETED','FA','000123','2020-01-01',100),
('50000000-0000-0000-0000-000000000002','d1000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002','2','OFFICE','COMPLETED','FA','123','2020-01-01',200),
('50000000-0000-0000-0000-000000000003','d1000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000003','3','OFFICE','COMPLETED','FA','124','2020-01-01',50),
('50000000-0000-0000-0000-000000000004','d1000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','4','OFFICE','CANCELLED','FA','125','2020-01-01',50);
INSERT INTO logistica.receipt_documents(id,company_id,receipt_id,document_type,document_number,storage_path) VALUES ('70000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000003','FA','124','synthetic.pdf');
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',true);
SET LOCAL ROLE authenticated;
DO $$ DECLARE c record; BEGIN
 IF (SELECT count(*) FROM public.cxp_receipt_candidates()) <> 2 THEN RAISE EXCEPTION 'detección incorrecta'; END IF;
 SELECT * INTO c FROM public.cxp_receipt_candidates() WHERE folio='123';
 IF cardinality(c.receipt_ids) <> 2 OR cardinality(c.purchase_orders) <> 2 OR c.reference_amount <> 300 OR c.has_document OR c.blocked_reason IS NOT NULL THEN RAISE EXCEPTION 'agrupación incorrecta'; END IF;
 IF NOT EXISTS (SELECT FROM public.cxp_receipt_candidates() WHERE folio='124' AND blocked_reason IS NOT NULL AND has_document) THEN RAISE EXCEPTION 'RUT incompleto o adjunto incorrecto'; END IF;
 BEGIN PERFORM public.cxp_incorporate_receipts(ARRAY[c.candidate_id,'50000000-0000-0000-0000-000000000003'::uuid]); RAISE EXCEPTION 'selección inválida aceptada'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='selección inválida aceptada' THEN RAISE; END IF; END;
 IF EXISTS(SELECT FROM cuentas_por_pagar.invoices) THEN RAISE EXCEPTION 'inserción parcial'; END IF;
 PERFORM public.cxp_incorporate_receipts(ARRAY[c.candidate_id]);
 PERFORM public.cxp_incorporate_receipts(ARRAY[c.candidate_id]);
 IF (SELECT count(*) FROM cuentas_por_pagar.invoices) <> 1 OR (SELECT count(*) FROM cuentas_por_pagar.invoice_receipt_links) <> 2 THEN RAISE EXCEPTION 'idempotencia incorrecta'; END IF;
 IF NOT EXISTS (SELECT FROM cuentas_por_pagar.invoices WHERE validation_status='PENDING' AND origin='RECEIPT' AND net_amount IS NULL AND tax_amount IS NULL AND total_amount IS NULL) THEN RAISE EXCEPTION 'montos o estado incorrectos'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000002',true);
DO $$ BEGIN
 BEGIN PERFORM public.cxp_receipt_candidates(); RAISE EXCEPTION 'acceso no autorizado'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.cxp_incorporate_receipts(ARRAY['50000000-0000-0000-0000-000000000001'::uuid]); RAISE EXCEPTION 'escritura no autorizada'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
ROLLBACK;
